import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { buildRichAnswer, readRichAnswer, richAnswerSchema } from "./answer-blocks";
import { createWebSearch } from "./tools/webSearch";
import { createTavilyProvider } from "./tools/providers/tavily";
import { createExaProvider } from "./tools/providers/exa";
import { clock, FakeModel, recall, turn } from "../test/agent-fixtures";
import { assemble } from "./agent/prompt";
import { runAgent } from "./agent/loop";
import { createEventParser } from "./chat-stream";
import { sse, type AgentEvents, type SendEvent } from "./agent/events";
import { chatReducer, initialChat } from "./chat-state";
import { groupHistory } from "./history";
import { sessionMessages } from "./workspace";
import { ImageGallery } from "../components/image-gallery";
import { MarkdownMessage } from "../components/markdown-message";

const source = { url: "https://example.com/movie", title: "Movie post credits", domain: "example.com", publishedDate: null, isOfficial: false };
const asset = { url: "https://media.example.com/movie.jpg", alt: "Movie poster" };
const candidates = { [source.url]: [asset] };
const answer = () => buildRichAnswer([source], candidates);

describe("rich answers", () => {
  it("retains citation order and appends provider images without reordering", () => {
    const first = buildRichAnswer([source], {});
    expect(first.blocks).toEqual([]);
    const next = buildRichAnswer([source, { ...source, url: "https://example.com/other" }], candidates, first);
    expect(next.sources.map(source => source.id)).toEqual(["s1", "s2"]);
    expect(next.images).toHaveLength(1);
    expect(buildRichAnswer([source], candidates).images[0]).toMatchObject({ thumbnailUrl: asset.url, alt: asset.alt });
    expect(buildRichAnswer([source], {}, next).images).toEqual(next.images);
  });

  it("skips invalid and duplicate candidates while accepting new media hosts", () => {
    const images = buildRichAnswer([source, { ...source, url: "https://other.example/page" }], {
      [source.url]: [{ url: "javascript:alert(1)" }, { url: "https://user:password@media.example/x" }, asset],
      "https://other.example/page": [asset, { url: "https://another-media.example/picture.jpg" }],
    }).images;
    expect(images.map(image => image.thumbnailUrl)).toEqual([asset.url, "https://another-media.example/picture.jpg"]);
    expect(images[1].alt).toBe(`Image from ${source.title}`);
  });

  it("rejects invalid references, duplicate IDs, unsafe media, and oversized snapshots", () => {
    const valid = answer();
    expect(readRichAnswer({ ...valid, version: 2 })).toBeUndefined();
    expect(readRichAnswer({ ...valid, images: [{ ...valid.images[0], sourceId: "missing" }] })).toBeUndefined();
    expect(readRichAnswer({ ...valid, sources: [...valid.sources, valid.sources[0]] })).toBeUndefined();
    expect(readRichAnswer({ ...valid, images: [{ ...valid.images[0], thumbnailUrl: "http://media.example.com/x" }] })).toBeUndefined();
    expect(readRichAnswer({ ...valid, sources: [{ ...valid.sources[0], publishedDate: "x".repeat(65_000) }] })).toBeUndefined();
    expect(richAnswerSchema.parse(valid)).toEqual(valid);
  });

  it.each(["tavily", "exa"] as const)("keeps %s image metadata out of model evidence and restores it from cache", async provider => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      images: ["https://wrong.example.com/unrelated.jpg"],
      results: [{ title: source.title, url: source.url, content: "Scene description", highlights: ["Scene description"],
        images: [asset.url], extras: { richImageLinks: [{ url: asset.url, alt: asset.alt }] } }],
    })));
    const primary = provider === "tavily" ? createTavilyProvider("fixture", fetcher) : createExaProvider("fixture", fetcher);
    const search = createWebSearch({ primary, clock: () => clock });
    const input = { queries: ["movie post credits"], include_images: true };
    const first = await search(input);
    expect(first.images?.[source.url]?.[0].url).toBe(asset.url);
    expect(first.content).not.toContain(asset.url);
    expect(first.content).not.toContain("images");
    expect((await search(input)).images).toEqual(first.images);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(buildRichAnswer([source], first.images ?? {}).images).toHaveLength(1);
    const events: string[] = [];
    const model = new FakeModel([{ tools: [{ input: { queries: input.queries } }] }, { text: ["Movie answer."] }]);
    await runAgent({ ...assemble({ clock, recall: recall(), message: "movie post credits" }), model, time: () => 0,
      search, send: (event, data) => { events.push(sse(event, data)); } });
    const snapshot = createEventParser().push(events.join("")).find(event => event.type === "answer_ui");
    expect(snapshot?.type).toBe("answer_ui");
    if (snapshot?.type !== "answer_ui") throw new Error("Missing gallery snapshot");
    expect(snapshot.data.images[0].thumbnailUrl).toBe(asset.url);
    const restored = sessionMessages(groupHistory([turn(1, { role: "assistant", answerUi: snapshot.data })], "UTC")[0])[0];
    const html = renderToStaticMarkup(createElement(ImageGallery, { answer: restored.answerUi! }));
    expect(html).toContain(`src="${asset.url}"`);
    expect(html).toContain(`href="${source.url}"`);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("streams sources even without images and excludes candidates pruned by the final source budget", async () => {
    const model = new FakeModel([{ tools: [{ input: { queries: ["movie post credits"], include_images: true } }] }, { text: ["Read the movie source."] }]);
    const events: string[] = [];
    const send: SendEvent = (event, data) => events.push(sse(event, data));
    await runAgent({ ...assemble({ clock, recall: recall(), message: "movie post credits" }), model, send, time: () => 0, effort: "instant", search: async () => ({
      queries: [{ query: "movie post credits", results: [1, 2, 3].map(i => ({ title: `Page ${i}`, url: `https://example.com/${i}`, snippet: "Scene", published_date: null, is_official: false })) }],
      images: { "https://example.com/3": [{ url: asset.url }] }, is_error: false, truncated: false, content: "unused",
    }) });
    const parsed = createEventParser().push(events.join(""));
    const snapshot = parsed.find(event => event.type === "answer_ui");
    expect(snapshot?.data).toMatchObject({ sources: [{ id: "s1" }, { id: "s2" }], images: [], blocks: [] });
    expect(JSON.stringify(snapshot)).not.toContain("https://example.com/3");
    expect(parsed.at(-1)?.type).toBe("done");
  });

  it("replays split frames and ignores late snapshots after a new turn starts", () => {
    const data = answer();
    const wire = sse("answer_ui", data);
    const parser = createEventParser();
    expect(parser.push(wire.slice(0, 27))).toEqual([]);
    const event = parser.push(wire.slice(27))[0];
    let state = chatReducer(initialChat, { type: "start", userId: "u", assistantId: "a", text: "Movie?" });
    state = chatReducer(state, { type: "event", assistantId: "a", event });
    expect(chatReducer(state, { type: "event", assistantId: "a", event })).toEqual(state);
    state = chatReducer(state, { type: "finish", assistantId: "a", outcome: "stopped" });
    state = chatReducer(state, { type: "start", userId: "u2", assistantId: "a2", text: "Next?" });
    expect(chatReducer(state, { type: "event", assistantId: "a", event })).toBe(state);
  });

  it("restores sources through history and preserves readable link text and raw Markdown", () => {
    const content = "See [the interview](https://example.com/movie?utm_source=test).";
    const saved = turn(1, { role: "assistant", content, answerUi: answer() });
    const restored = sessionMessages(groupHistory([saved], "UTC")[0])[0];
    expect(restored.answerUi).toEqual(answer());
    expect(restored.content).toBe(content);
    const html = renderToStaticMarkup(createElement(MarkdownMessage, { content, answerUi: restored.answerUi }));
    expect(html).toContain("the interview");
    expect(html).toContain("Source 1");
    expect(sessionMessages(groupHistory([{ ...saved, answerUi: { version: 2 } as unknown as AgentEvents["answer_ui"] }], "UTC")[0])[0].answerUi).toBeUndefined();
  });
});
