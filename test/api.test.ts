import { buildRichAnswer } from "../lib/answer-blocks";
import { readChatStream } from "../lib/chat-stream";
import { createTestStore } from "./database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createChatHandler } from "../lib/chat";
import { createHistoryHandler } from "../lib/historyHandler";
import { runAgent } from "../lib/agent/loop";
import { ModelProviderError } from "../lib/agent/errors";
import type { Store } from "../lib/store";
import { createRequestLimit } from "../lib/requestLimit";
import { clock, FakeModel } from "./agent-fixtures";
import { decodeCursor } from "../lib/history";
import { curate } from "../lib/curator/curate";
import { dateFrom } from "../lib/clock";
import type { RecallModel, RecallPlan } from "../lib/recall/plan";
import { threads } from "../lib/store/schema";
import { resolveDates } from "../lib/recall/temporal";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerBody } from "../components/answer-body";
import { groupHistory } from "../lib/history";
import { sessionMessages } from "../lib/workspace";
import type { SearchResult } from "../lib/tools/results";
import type { ImageCandidates } from "../lib/tools/webSearch";
import type { ChatEvent } from "../lib/chat-stream";

const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const cookie = `user_id=${userId}; session_id=${sessionId}`;
const post = (value: unknown, options: RequestInit = {}) => new Request("http://localhost/api/chat", {
  method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(value), ...options,
});

describe("chat and history backend with real Postgres and fake model", () => {
  let store: Store;
  beforeAll(async () => { store = await createTestStore({ clock: () => clock }); }, 30_000);
  beforeEach(async () => { await store.db.execute(sql`TRUNCATE claims, memory, threads, turns RESTART IDENTITY CASCADE`); });
  afterAll(async () => { await store?.close(); });

  function harness(overrides: Partial<Parameters<typeof createChatHandler>[0]> = {}) {
    const tasks: (() => Promise<void>)[] = [];
    const logger = { info: vi.fn(), error: vi.fn() };
    const models: FakeModel[] = [];
    const handler = createChatHandler({
      after: (task) => { tasks.push(task); }, store: async () => store,
      clock: () => clock, time: () => 0, trace: () => logger,
      acquire: createRequestLimit(() => 0),
      resolveSelection: async requested => requested ?? { provider: "gemini", model: "test-model" },
      recallModel: async () => ({ plan: async () => ({ intent: "general", operation: "list", collection: "none", queries: [], dateText: null, scope: "all", usePreviousEvidence: false, researchQuestion: null }), select: vi.fn(), summarize: vi.fn() }),
      curate: async () => ({ completed: 0, failed: 0, deferred: false }),
      run: (options) => {
        const model = new FakeModel([{ text: ["A short ", "answer."] }]);
        models.push(model);
        return runAgent({ ...options, model });
      }, ...overrides,
    });
    return { handler, tasks, logger, models, flush: async () => { for (const task of tasks.splice(0)) await task(); } };
  }

  it("streams the SSE contract, persists the user immediately and the assistant only in after", async () => {
    const app = harness();
    const response = await app.handler(post({ message: "CRM pricing", tz: "UTC" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(response.headers.get("x-session-id")).toBe(sessionId);
    const body = await response.text();
    expect(body).toContain('event: delta\ndata: {"text":"A short "}');
    expect(body.match(/event: done/g)).toHaveLength(1);
    expect(body).toContain(response.headers.get("X-Turn-Id"));
    expect((await store.historyFor(userId)).map((turn) => turn.role)).toEqual(["user"]);
    expect(app.models[0].requests[0].messages).toEqual([{ role: "user", content: "CRM pricing" }]);
    expect(JSON.stringify(app.models[0].requests[0].system)).toContain("No matching turns found");
    expect(app.logger.info).not.toHaveBeenCalled();
    await app.flush();
    expect((await store.historyFor(userId)).map((turn) => turn.role)).toEqual(["assistant", "user"]);
    expect(app.logger.info).toHaveBeenCalledOnce();
    expect(app.logger.info.mock.calls[0][0]).toMatchObject({ recallMs: 0, ttftMs: 0, searchCount: 0, totalMs: 0, userPersisted: true, assistantPersisted: true });
  });
  it("publishes and persists a sourced presentation before done", async () => {
    const answerUi = buildRichAnswer([{ url: "https://example.com/movie", domain: "example.com", title: "Movie", publishedDate: null, isOfficial: false }], {});
    const app = harness({ run: options => {
      options.send("answer_ui", answerUi);
      return runAgent({ ...options, model: new FakeModel([{ text: ["See [the interview](https://example.com/movie)."] }]) });
    } });
    const response = await app.handler(post({ message: "Explain a movie", tz: "UTC" }));
    const body = await response.text();
    expect(body.indexOf("event: answer_ui")).toBeLessThan(body.indexOf("event: done"));
    await app.flush();
    expect((await store.historyFor(userId))[0].answerUi).toEqual(answerUi);
    expect(app.logger.info.mock.calls[0][0]).toMatchObject({ snapshotBytes: Buffer.byteLength(JSON.stringify(answerUi)), ttftMs: 0 });
  });

  it.each([true, false])("uses Deep follow-ups to check conflicting evidence (primary source available: %s)", async primaryAvailable => {
    const source = (url: string, snippet: string, is_official = false): SearchResult =>
      ({ title: url, url, snippet, is_official, published_date: null });
    const first = [source("https://example.com/estimate", "Sample 2025 throughput is 42 requests/s."),
      source("https://example.org/estimate", "Sample 2025 throughput is 58 requests/s.")];
    const primary = source("https://example.net/measurement", "The methodology confirms 42 requests/s in 2025. The 58 figure was a peak.", true);
    const initialQuery = "Sample 2025 throughput estimates";
    const followUp = "Sample primary benchmark 2025 sustained versus peak";
    const model = new FakeModel([
      { tools: [{ input: { queries: [initialQuery] } }] },
      { tools: [{ input: { queries: [followUp], verification_focus: "Resolve 42 versus 58 requests/s", depth: "deep", prefer_official: true } }] },
      primaryAvailable ? { text: ["The sustained 2025 figure was 42 requests/s according to the [benchmark methodology](https://example.net/measurement)."] }
        : { text: ["Sources report 42 and 58 requests/s. The difference remains unverified."] },
    ]);
    const search = vi.fn(async (input: unknown) => ({
      queries: (input as { queries: string[] }).queries.map(query => ({ query,
        results: query === initialQuery ? first : primaryAvailable ? [primary] : first })),
      truncated: false, content: "", is_error: false,
    }));
    const app = harness({ run: options => runAgent({ ...options, model, search }) });
    const response = await app.handler(post({ effort: "deep", answerDetail: "brief", message: "Investigate the reported sustained 2025 throughput for Sample." }));
    const events: ChatEvent[] = [];
    await readChatStream(response.body!, event => events.push(event), new AbortController().signal);
    await app.flush();
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1][0]).toMatchObject({ queries: [followUp], depth: "deep", prefer_official: true });
    expect(JSON.stringify(model.requests[1].system)).toContain("58 requests/s");
    expect(JSON.stringify(model.requests[1].system)).toContain("42 requests/s");
    expect(JSON.stringify(model.requests[2].system)).toContain("Resolve 42 versus 58");
    if (!primaryAvailable) expect(model.requests[2].tool_choice).toEqual({ type: "none" });
    expect(events.some(event => event.type === "research_phase" && event.data.stage === "checking")).toBe(true);
    const [saved] = await store.historyFor(userId);
    expect(saved.content).toContain(primaryAvailable ? primary.url : "remains unverified");
  });

  const chartUrl = "https://example.net/benchmarks";
  const imageUrl = "https://example.org/drivetrain";
  const alphaMeasurement = "In 2025 Alpha sustained 42 requests/s.";
  const betaMeasurement = "In 2025 Beta sustained 58 requests/s.";
  const measurements = `${alphaMeasurement} ${betaMeasurement}`;
  const relevant = "https://media.example.org/drivetrain.jpg";
  const unrelated = "https://media.example.org/handlebar.jpg";
  const fixtureSource = (url: string, title: string, snippet: string): SearchResult =>
    ({ title, url, snippet, published_date: null, is_official: true });
  const chart = {
    kind: "chart", style: "bar", anchor: "a0", title: "Sustained throughput", unit: "requests/s", period: "2025",
    points: [{ label: "Alpha", value: 42, citation: { sourceId: "s1", quote: alphaMeasurement } }, { label: "Beta", value: 58, citation: { sourceId: "s1", quote: betaMeasurement } }],
  };
  it.each([
    {
      name: "conceptual flow", question: "How does a bicycle drivetrain work?", query: "",
      answer: "The pedals turn the chainring, which pulls the chain.\n\nGearing changes how this motion feels.",
      blocks: [{ kind: "flow", anchor: "a0", title: "How the drivetrain transfers motion", nodes: ["Pedals", "Chainring", "Chain"],
        edges: [{ from: 0, to: 1 }, { from: 1, to: 2 }] }],
      expected: "How the drivetrain transfers motion", before: "Gearing changes", sources: [], images: {},
    },
    {
      name: "measured chart", question: "Compare measured Alpha and Beta throughput with a chart.", query: "Alpha Beta 2025 measured sustained throughput",
      answer: `### Results\n\n[Measurements](${chartUrl}) show that Beta was faster.\n\n### Method\n\nBoth used the same setup.`,
      blocks: [{ ...chart, title: "Invalid percentage", unit: "%" }, chart],
      expected: "Sustained throughput", before: "<h3>Method", sources: [fixtureSource(chartUrl, "Benchmarks", measurements)], images: {},
    },
    {
      name: "publisher image", question: "Find a publisher image that shows how the rear derailleur moves.", query: "rear derailleur shifts chain image",
      answer: `### Rear derailleur\n\nThe [derailleur](${imageUrl}) moves the chain across the cassette.\n\n### Shifter\n\nThe cable controls the movement.`,
      blocks: [{ kind: "image", anchor: "a0", imageId: "is1-1" }],
      expected: relevant, before: "<h3>Shifter", sources: [fixtureSource(imageUrl, "Bicycle drivetrain", "The derailleur shifts the chain across the cassette.")],
      images: { [imageUrl]: [{ url: unrelated, description: "A bicycle handlebar with a brake lever" }, { url: relevant, alt: "Rear derailleur and cassette showing the chain path" }] },
    },
  ])("streams and restores a section-anchored $name", async ({ question, query, answer, blocks, expected, before, sources, images }) => {
    let elapsed = 0;
    const model = new FakeModel([
      ...(query ? [{ tools: [{ input: { queries: [query] } }], after: () => { elapsed += 10; } }] : []),
      { text: [answer], beforeText: () => { elapsed += 20; } },
      { text: [JSON.stringify({ blocks })], beforeText: () => { elapsed += 30; } },
    ]);
    const app = harness({ time: () => elapsed, run: options => runAgent({ ...options, model,
      search: async () => ({ queries: [{ query, results: sources }], images: images as ImageCandidates, truncated: false, content: "", is_error: false }),
    }) });
    const response = await app.handler(post({ message: question }));
    const events: ChatEvent[] = [];
    await readChatStream(response.body!, event => events.push(event), new AbortController().signal);
    await app.flush();
    const visualAt = events.findIndex(event => event.type === "answer_ui" && event.data.version === 2);
    expect(visualAt).toBeGreaterThan(events.findIndex(event => event.type === "delta"));
    expect(visualAt).toBeLessThan(events.findIndex(event => event.type === "done"));
    expect(model.requests.at(-1)?.tools).toBeUndefined();
    expect(model.requests.at(-1)?.tool_choice).toBeUndefined();
    const session = groupHistory(await store.historyFor(userId), "UTC")[0];
    const restored = sessionMessages(session).find(message => message.role === "assistant")!;
    expect(restored.answerUi).toEqual(events[visualAt].data);
    const html = renderToStaticMarkup(createElement(AnswerBody, { content: restored.content, answerUi: restored.answerUi }));
    expect(html).toContain(expected);
    expect(html.indexOf(expected)).toBeLessThan(html.indexOf(before));
    expect(html).not.toContain("Invalid percentage");
    expect(html).not.toContain(unrelated);
    expect(app.logger.info.mock.calls[0][0]).toMatchObject({ ttftMs: query ? 30 : 20, firstVisualMs: query ? 60 : 50, totalMs: query ? 60 : 50 });
  });

  it("passes answer detail through the API and safely streams and saves a long Unicode answer", async () => {
    const text = `${"x".repeat(4095)}🙂${"\"\n".repeat(80_000)}`;
    const model = new FakeModel([{ text: [text] }]);
    const run = vi.fn((options: Parameters<typeof runAgent>[0]) => runAgent({ ...options, model }));
    const app = harness({ run });
    const response = await app.handler(post({ message: "Give a thorough explanation in 2000 words", answerDetail: "detailed", effort: "instant", selection: { provider: "gemini", model: "gemini-3.5-flash-lite" } }));
    let received = "";
    await readChatStream(response.body!, event => { if (event.type === "delta") received += event.data.text; }, new AbortController().signal);
    expect(received).toBe(text);
    expect(run.mock.calls[0][0]).toMatchObject({ answerDetail: "detailed", effort: "instant" });
    expect(model.requests[0].max_tokens).toBe(65_536);
    expect(JSON.stringify(model.requests[0].system)).toContain("saved preference is Detailed");
    await app.flush();
    expect((await store.historyFor(userId)).find(turn => turn.role === "assistant")?.content).toBe(text);
    expect((await app.handler(post({ message: "Hello", answerDetail: "unlimited" }))).status).toBe(400);
  });

  it("carries the selected model to answers and curation and rejects unavailable providers before saving", async () => {
    const model = new FakeModel([{ text: ["Selected provider answer."] }]);
    const run = vi.fn((options: Parameters<typeof runAgent>[0]) => runAgent({ ...options, model }));
    const background = vi.fn(async () => ({ completed: 0, failed: 0, deferred: false }));
    const app = harness({ run, curate: background });
    const selection = { provider: "gemini", model: "gemini-3.5-flash-lite" };
    await (await app.handler(post({ message: "Hello", selection }))).text();
    expect(run.mock.calls[0][0].selection).toEqual(selection);
    await app.flush();
    expect(background).toHaveBeenCalledWith(userId, expect.objectContaining({ selection }));
    const blocked = harness({ resolveSelection: async () => { throw new Error("Add GEMINI_API_KEY to the server environment to use this provider."); } });
    const before = (await store.historyFor(userId)).length;
    expect((await blocked.handler(post({ message: "Hello", selection }))).status).toBe(400);
    expect((await store.historyFor(userId)).length).toBe(before);
  });

  it.each(["instant", "medium", "high"] as const)("passes %s research effort to the agent and safe trace", async effort => {
    const run = vi.fn((options: Parameters<typeof runAgent>[0]) => runAgent({ ...options, model: new FakeModel([{ text: ["Effort answer."] }]) }));
    const app = harness({ run });
    await (await app.handler(post({ message: "Hello", effort }))).text();
    expect(run.mock.calls[0][0].effort).toBe(effort);
    await app.flush();
    expect(app.logger.info.mock.calls[0][0]).toMatchObject({ effort });
  });

  it("defaults to medium effort and rejects unsupported effort before persisting", async () => {
    const run = vi.fn((options: Parameters<typeof runAgent>[0]) => runAgent({ ...options, model: new FakeModel([{ text: ["Default effort."] }]) }));
    const app = harness({ run });
    expect((await app.handler(post({ message: "Hello", effort: "unlimited" }))).status).toBe(400);
    expect(await store.historyFor(userId)).toHaveLength(0);
    await (await app.handler(post({ message: "Hello" }))).text();
    expect(run.mock.calls[0][0].effort).toBe("medium");
    await app.flush();
  });

  it("continues the current session with previous turns and keeps other users out", async () => {
    await store.saveTurn({ userId, sessionId, role: "user", content: "My team has 20 people" });
    await store.saveTurn({ userId, sessionId, role: "assistant", content: "I will use that team size" });
    await store.saveTurn({ userId: "bob", sessionId, role: "user", content: "Private secret" });
    const app = harness();
    await (await app.handler(post({ message: "What about pricing?" }))).text();
    expect(app.models[0].requests[0].messages).toEqual([
      { role: "user", content: "My team has 20 people" },
      { role: "assistant", content: "I will use that team size" },
      { role: "user", content: "What about pricing?" },
    ]);
    expect(JSON.stringify(app.models[0].requests)).not.toContain("Private secret");
    await app.flush();
  });

  const historyPlan = (overrides: Partial<RecallPlan> = {}): RecallPlan => ({ intent: "history", operation: "exists", collection: "none", queries: ["neon pricing"], dateText: null, scope: "all", usePreviousEvidence: false, researchQuestion: null, ...overrides });
  const historyCases = (["gemini", "anthropic"] as const).flatMap(provider => (["instant", "medium", "high"] as const).map(effort => ({ provider, effort })));
  it.each([
    { iso: "2026-11-15T23:19:28Z", tz: "Asia/Calcutta", topic: "Explain post credit scenes connecting the upcoming films" },
    { iso: "2032-03-01T05:30:00Z", tz: "America/New_York", topic: "Explain the sorting algorithm tradeoffs" },
  ])("preserves a cross-midnight summary's exact collection through follow-ups ($tz/$iso)", async ({ iso, tz, topic }) => {
    let calendar = { ...clock, instant: dateFrom(iso), iso, tz };
    const [today] = resolveDates("today", calendar.instant, tz);
    const old = await store.saveTurn({ userId, sessionId: "cross-midnight", role: "user", content: topic, ts: dateFrom(today.startUtc.getTime() - 120_000), tz });
    await store.saveTurn({ userId, sessionId: old.sessionId, role: "user", content: "Explain the latest details deeply", ts: dateFrom(today.startUtc.getTime() - 60_000), tz });
    const continuation = await store.saveTurn({ userId, sessionId: old.sessionId, role: "user", content: "recheck again for today", ts: dateFrom(today.startUtc.getTime() + 60_000), tz });
    for (let index = 0; index < 5; index++) await store.saveTurn({ userId, sessionId: `other-${index}`, role: "user", content: `Selected-day message ${index + 1}`, ts: dateFrom(today.startUtc.getTime() + (index + 2) * 60_000), tz });
    await store.saveTurn({ userId: "bob", sessionId: old.sessionId, role: "user", content: "Foreign context", ts: dateFrom(today.startUtc.getTime() - 30_000), tz });
    const plan = vi.fn<RecallModel["plan"]>()
      .mockResolvedValueOnce(historyPlan({ operation: "summarize", collection: "new", queries: [], dateText: "today" }))
      .mockResolvedValueOnce(historyPlan({ operation: "list", collection: "previous", queries: [], dateText: null }));
    const summarize = vi.fn<RecallModel["summarize"]>().mockImplementation(async input => {
      expect(input.messages).toHaveLength(6);
      const followup = input.messages.find(row => row.id === continuation.id)!;
      expect(followup.context?.map(row => row.content)).toEqual([topic, "Explain the latest details deeply"]);
      expect(JSON.stringify(input)).not.toContain("Foreign context");
      return { items: input.messages.map(row => ({ turnId: row.id, summary: row.id === continuation.id ? `Requested a fresh recheck of: ${topic}` : row.content })) };
    });
    const select = vi.fn(), run = vi.fn();
    const app = harness({ clock: () => calendar, recallModel: async () => ({ plan, select, summarize }), run });
    const first = await (await app.handler(post({ message: "Briefly recap my messages today", tz }))).text();
    expect(first).toContain("Summary of **6**");
    expect(first).toContain(`Requested a fresh recheck of: ${topic}`);
    expect(first).not.toContain("Explain the latest details deeply");
    await app.flush();
    const reference = await store.previousRecall(userId, sessionId, { ts: dateFrom(calendar.instant.getTime() + 1), id: 99999 });
    expect(reference?.collection?.sourceTurnIds).toHaveLength(6);
    expect(reference?.collection?.sourceTurnIds).toContain(continuation.id);
    expect(reference?.collection?.sourceTurnIds).not.toContain(old.id);
    await store.saveTurn({ userId, sessionId: "later", role: "user", content: "New message after the summary", ts: calendar.instant, tz });
    const nextInstant = dateFrom(calendar.instant.getTime() + 86_400_000);
    calendar = { ...calendar, instant: nextInstant, iso: nextInstant.toISOString() }; // reference survives a new local day
    const second = await (await app.handler(post({ message: "lemme know the 6 messages", tz }))).text();
    expect(second).toContain("**6** earlier");
    expect(second).toContain("recheck again for today");
    expect(second).not.toContain(topic);
    expect(second).not.toContain("New message after the summary");
    expect(second).not.toContain("Briefly recap my messages today");
    expect(second).not.toContain("Foreign context");
    expect(plan.mock.calls[1][0].previousCollection).toMatchObject({ count: 6, timezone: tz });
    expect(select).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    await app.flush();
    expect((await store.previousRecall(userId, sessionId, { ts: dateFrom(calendar.instant.getTime() + 1), id: 99999 }))?.collection?.sourceTurnIds.sort()).toEqual(reference?.collection?.sourceTurnIds.sort());
  });

  it("keeps a literal date when the plan mistakenly chooses all history, filtering each message across session dates", async () => {
    const local = { ...clock, instant: dateFrom("2026-11-16T03:00:00Z"), tz: "Asia/Calcutta" };
    const boundary = resolveDates("today", local.instant, local.tz)[0].startUtc;
    await store.saveTurn({ userId, sessionId: "started-yesterday", role: "user", content: "Yesterday topic", ts: dateFrom(boundary.getTime() - 1) });
    await store.saveTurn({ userId, sessionId: "started-yesterday", role: "user", content: "Today continuation", ts: boundary });
    const app = harness({ clock: () => local, recallModel: async () => ({ plan: async () => historyPlan({ operation: "list", collection: "all", queries: [], dateText: null }), select: vi.fn(), summarize: vi.fn() }) });
    const text = await (await app.handler(post({ message: "List my messages for 16 nov", tz: local.tz }))).text();
    expect(text).toContain("**1** earlier"); expect(text).toContain("Today continuation"); expect(text).not.toContain("Yesterday topic");
    await app.flush();
  });

  it("does not widen legacy or deleted collection references to all history", async () => {
    const request = await store.saveTurn({ userId, sessionId, role: "user", content: "Summarize my messages today", ts: dateFrom(clock.instant.getTime() - 2000) });
    await store.saveTurn({ userId, sessionId, role: "assistant", content: "Summary of six messages", ts: dateFrom(clock.instant.getTime() - 1000), recall: { userTurnId: request.id, sourceTurnIds: [], historyOnly: true } });
    const app = harness({ recallModel: async () => ({ plan: async () => historyPlan({ operation: "list", collection: "previous", queries: [] }), select: vi.fn(), summarize: vi.fn() }) });
    const text = await (await app.handler(post({ message: "Show those six messages" }))).text();
    expect(text).toContain("couldn't verify the exact messages"); expect(text).not.toContain("Your **");
    await app.flush();
  });
  it("fails closed when a selected collection message is deleted before the follow-up", async () => {
    await store.saveTurn({ userId, sessionId: "source-session", role: "user", content: "Selected original", ts: dateFrom(clock.instant.getTime() - 1000) });
    const plan = vi.fn<RecallModel["plan"]>()
      .mockResolvedValueOnce(historyPlan({ operation: "list", collection: "new", queries: [], dateText: "today" }))
      .mockResolvedValueOnce(historyPlan({ operation: "list", collection: "previous", queries: [] }));
    const app = harness({ recallModel: async () => ({ plan, select: vi.fn(), summarize: vi.fn() }) });
    expect(await (await app.handler(post({ message: "List my messages today" }))).text()).toContain("Selected original");
    await app.flush();
    await store.deleteConversation(userId, "source-session");
    const text = await (await app.handler(post({ message: "Show those messages again" }))).text();
    expect(text).toContain("couldn't verify the exact messages");
    expect(text).not.toContain("Your **");
    await app.flush();
  });
  it.each([
    { provider: "gemini" as const, instant: "2030-12-31T19:00:00Z", tz: "Asia/Calcutta" },
    { provider: "anthropic" as const, instant: "2032-03-01T05:30:00Z", tz: "America/New_York" },
  ])("summarizes yesterday then today's messages with $provider using the fresh local calendar", async ({ provider, instant, tz }) => {
    const calendar = { ...clock, instant: dateFrom(instant), iso: instant, tz };
    const [today] = resolveDates("today", calendar.instant, tz);
    const [yesterday] = resolveDates("yesterday", calendar.instant, tz);
    const save = (content: string, ts: Date, overrides: Partial<Parameters<Store["saveTurn"]>[0]> = {}) => store.saveTurn({ userId, sessionId, role: "user", content, ts, tz, ...overrides });
    await save("Compare hosting plans", dateFrom(yesterday.startUtc.getTime() + 1000));
    await save("Compare hosting plans", dateFrom(yesterday.startUtc.getTime() + 2000));
    await save("What is today's date?", dateFrom(today.startUtc.getTime() + 1000));
    await save("Current time?", dateFrom(today.startUtc.getTime() + 2000), { sessionId: "another-session" });
    await save("Foreign secret", dateFrom(today.startUtc.getTime() + 3000), { userId: "bob" });
    await save("Assistant claims are not user evidence", dateFrom(today.startUtc.getTime() + 4000), { role: "assistant" });
    const plan = vi.fn<RecallModel["plan"]>()
      .mockResolvedValueOnce(historyPlan({ operation: "summarize", collection: "new", queries: [], dateText: "yesterday" }))
      .mockResolvedValueOnce(historyPlan({ operation: "summarize", collection: "new", queries: [], dateText: "today", usePreviousEvidence: true }));
    const summarize = vi.fn<RecallModel["summarize"]>().mockImplementation(async input => {
      return { items: input.messages.map(row => ({ summary: row.content, turnId: row.id })) };
    });
    const select = vi.fn(); const run = vi.fn(); const background = vi.fn();
    const app = harness({ clock: () => calendar, recallModel: async () => ({ plan, select, summarize }), run, curate: background });
    const first = await (await app.handler(post({ message: "what questions did i ask u yesterday summaries in short", tz, selection: { provider, model: "test-model" } }))).text();
    expect(first).toContain(yesterday.label);
    expect(first).toContain("Compare hosting plans (2 messages;");
    expect(first).not.toContain("Current time?");
    await app.flush();
    await save("Latest follow-up", calendar.instant);
    const second = await (await app.handler(post({ message: "can you summaries today's messages as well?", tz, selection: { provider, model: "test-model" } }))).text();
    expect(second).toContain(today.label);
    expect(second).toContain("What is today's date?");
    expect(second).toContain("Current time?");
    expect(second).toContain("Latest follow");
    expect(second).not.toContain("Compare hosting plans (2 messages;");
    expect(second).not.toContain("Foreign secret");
    expect(second).not.toContain("Assistant claims");
    expect(second).not.toContain("couldn't locate");
    expect(second).not.toContain("event: error");
    expect(summarize.mock.calls[1][0].messages).toHaveLength(4); // includes yesterday's inventory request, excludes this request
    expect(select).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    await app.flush(); expect(background).not.toHaveBeenCalled();
    expect((await store.previousRecall(userId, sessionId, { ts: dateFrom(calendar.instant.getTime() + 1), id: 9999 }))?.sourceTurnIds).toEqual([]);
  });

  it("uses complete user-only inventory for a planned list, including history questions in this session", async () => {
    const original = await store.saveTurn({ userId, sessionId, role: "user", content: "What did I ask before?", ts: dateFrom(clock.instant.getTime() - 1000) });
    await store.saveTurn({ userId, sessionId, role: "assistant", content: "An earlier inventory", recall: { userTurnId: original.id, sourceTurnIds: [], historyOnly: true } });
    await store.saveTurn({ userId, sessionId: "other", role: "user", content: "Another chat", ts: dateFrom(clock.instant.getTime() - 1000) });
    const select = vi.fn(); const summarize = vi.fn();
    const app = harness({ recallModel: async () => ({ plan: async () => historyPlan({ operation: "list", collection: "new", queries: [], dateText: "today", scope: "session" }), select, summarize }) });
    const text = await (await app.handler(post({ message: "Show my messages today in this chat", tz: "UTC" }))).text();
    expect(text).toContain("What did I ask before?"); expect(text).not.toContain("Another chat");
    expect(select).not.toHaveBeenCalled(); expect(summarize).not.toHaveBeenCalled();
    await app.flush();
  });
  it("handles fractional monotonic timing in the real history request path", async () => {
    let tick = 0;
    const source = await store.saveTurn({ userId, sessionId, role: "user", content: "check neon db current pricing", ts: dateFrom("2026-11-15T10:10:12Z") });
    const run = vi.fn();
    const app = harness({ time: () => { tick += 0.125; return tick; }, run,
      recallModel: async () => ({ plan: async () => historyPlan(), select: async () => ({ status: "matched", matches: [{ turnId: source.id, quote: source.content }] }), summarize: vi.fn() }),
    });
    const body = await (await app.handler(post({ message: "did i ask u about neon db?", effort: "instant" }))).text();
    expect(body).not.toContain("event: error");
    expect(body).toContain("Yes — I found");
    expect(body).toContain(source.content);
    expect(run).not.toHaveBeenCalled();
    await app.flush();
  });
  it.each(historyCases)("grounds the screenshot's two-turn flow with $provider/$effort without web search or curation", async ({ provider, effort }) => {
    const source = await store.saveTurn({ userId, sessionId: "33333333-3333-4333-8333-333333333333", role: "user", content: "check neon db current pricing", ts: dateFrom("2026-11-15T10:10:12Z") });
    await store.saveTurn({ userId, sessionId: source.sessionId, role: "assistant", content: "Neon pricing " + "x".repeat(20_000), ts: dateFrom("2026-11-15T10:10:13Z") });
    await store.db.insert(threads).values({ userId, title: "Neon", summary: "The user never asked about pricing.", lastTs: clock.instant });
    const plan = vi.fn<RecallModel["plan"]>().mockResolvedValueOnce(historyPlan()).mockResolvedValueOnce(historyPlan({ operation: "when", usePreviousEvidence: true }));
    const select = vi.fn<RecallModel["select"]>().mockResolvedValue({ status: "matched", matches: [{ turnId: source.id, quote: source.content }] });
    const run = vi.fn(); const retrieve = vi.fn(); const background = vi.fn();
    const app = harness({ run, retrieve, curate: background, recallModel: async () => ({ plan, select, summarize: vi.fn() }), clock: tz => ({ ...clock, tz: tz ?? "UTC" }) });
    const first = await (await app.handler(post({ message: "do you remember i asked for neon pricing yes or no?", selection: { provider, model: "test-model" }, effort, tz: "Asia/Calcutta" }))).text();
    expect(first).toContain("Yes — I found"); expect(first).toContain(source.content);
    expect(first).not.toContain("event: sources"); expect(first.match(/event: done/g)).toHaveLength(1);
    await app.flush();
    const second = await (await app.handler(post({ message: "at what time did i ask for it", selection: { provider, model: "test-model" }, effort, tz: "Asia/Calcutta" }))).text();
    expect(second).toContain("15 November 2026 at 15:40:12"); expect(second).toContain("Asia/Calcutta");
    expect(second).toContain(source.content); expect(second).not.toContain("misunderstanding"); expect(second).not.toContain("event: sources");
    expect(plan.mock.calls[1][0].hasPreviousEvidence).toBe(true);
    expect(select).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled(); expect(retrieve).not.toHaveBeenCalled();
    await app.flush();
    expect(background).not.toHaveBeenCalled(); expect(await store.pendingCurations(userId)).toHaveLength(0);
    expect(app.logger.info.mock.calls.at(-1)?.[0]).toMatchObject({ answerMode: "history", searchCount: 0, recall: { evidenceIds: [source.id], reason: "verified_antecedent" } });
  });

  it("does not confirm a request from summaries, assistant assertions or the saved recall question itself", async () => {
    await store.db.insert(threads).values({ userId, title: "Neon", summary: "The user asked for Neon pricing.", lastTs: clock.instant });
    await store.saveTurn({ userId, sessionId, role: "assistant", content: "You asked for Neon pricing", ts: dateFrom("2026-11-15T10:00:00Z") });
    const select = vi.fn(); const run = vi.fn(); const background = vi.fn();
    const app = harness({ run, curate: background, recallModel: async () => ({ plan: async () => historyPlan(), select, summarize: vi.fn() }) });
    const first = await (await app.handler(post({ message: "do you remember i asked for neon pricing yes or no?" }))).text();
    expect(first).toContain("couldn't locate an original matching message"); expect(first).not.toContain("Yes");
    await app.flush();
    const second = await (await app.handler(post({ message: "Did I actually ask for Neon pricing previously?" }))).text();
    expect(second).toContain("couldn't locate an original matching message"); expect(second).not.toContain("Yes");
    expect(select).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    await app.flush(); expect(background).not.toHaveBeenCalled();
  });

  it("fails closed on planner errors rather than letting a model guess or search", async () => {
    const run = vi.fn(); const background = vi.fn();
    const app = harness({ run, curate: background, recallModel: async () => { throw new Error("private-provider-details"); } });
    const body = await (await app.handler(post({ message: "When did I ask about Neon?" }))).text();
    expect(body).toContain("couldn't determine the context"); expect(body).not.toContain("private-provider-details");
    expect(body.match(/event: done/g)).toHaveLength(1); expect(run).not.toHaveBeenCalled();
    await app.flush(); expect(background).not.toHaveBeenCalled();
  });

  it("composes mixed answers from separate stored-history and web evidence", async () => {
    const source = await store.saveTurn({ userId, sessionId, role: "user", content: "Check Neon pricing", ts: dateFrom("2026-11-14T10:00:00Z") });
    const model = new FakeModel([{ tools: [{ input: { queries: ["Neon pricing now"] } }] }, { text: ["Current Neon prices need the official pricing page. [Source](https://neon.com/pricing)"] }]);
    const search = vi.fn(async () => ({ queries: [{ query: "Neon pricing now", results: [{ title: "Neon pricing", url: "https://neon.com/pricing", snippet: "Current plans", published_date: null, is_official: true }] }], content: "", is_error: false, truncated: false }));
    const select = vi.fn<RecallModel["select"]>().mockResolvedValue({ status: "matched", matches: [{ turnId: source.id, quote: source.content }] });
    const background = vi.fn();
    const app = harness({ curate: background, recallModel: async () => ({ plan: async () => historyPlan({ intent: "mixed", operation: "when", researchQuestion: "Search the web for current Neon pricing" }), select, summarize: vi.fn() }),
      run: options => runAgent({ ...options, model, search }),
    });
    const body = await (await app.handler(post({ message: "When did I ask about Neon pricing, and what does it cost now?" }))).text();
    expect(body).toContain("14 November 2026 at 10:00:00"); expect(body).toContain(source.content); expect(body).toContain("Current Neon prices");
    expect(search).toHaveBeenCalledOnce(); expect(body.match(/event: done/g)).toHaveLength(1);
    expect(model.requests[0].messages).toEqual([{ role: "user", content: "Search the web for current Neon pricing" }]);
    expect(JSON.stringify(model.requests[0].system)).not.toContain("When did I ask");
    expect(model.requests.every(request => request.tools?.length === 1)).toBe(true);
    await app.flush(); expect(background).not.toHaveBeenCalled();
    const saved = (await store.historyFor(userId))[0];
    expect(saved.answerUi?.sources[0].url).toBe("https://neon.com/pricing");
    expect(saved.content.slice(saved.answerUi?.externalStart)).toBe("Current Neon prices need the official pricing page. [Source](https://neon.com/pricing)");
  });

  it.each(["gemini", "anthropic"] as const)("plans and lists all of today's user messages across chats with %s without answer/search/curation calls", async provider => {
    const prompts = Array.from({ length: 120 }, (_, i) => ({
      userId, sessionId: i % 2 ? "33333333-3333-4333-8333-333333333333" : sessionId,
      role: "user" as const, content: `Today's question ${i + 1}`, ts: dateFrom(clock.instant.getTime() - (121 - i) * 60_000), tz: "UTC",
    }));
    for (const prompt of prompts) {
      await store.saveTurn(prompt);
      await store.saveTurn({ ...prompt, role: "assistant", content: "Long assistant response ".repeat(300) });
    }
    await store.saveTurn({ userId: "bob", sessionId, role: "user", content: "Foreign secret", ts: dateFrom(clock.instant.getTime() - 1000) });
    await store.saveTurn({ userId, sessionId, role: "user", content: "Yesterday only", ts: dateFrom("2026-11-14T12:00:00Z") });
    const run = vi.fn(); const retrieve = vi.fn(); const background = vi.fn();
    const planner = vi.fn<RecallModel["plan"]>().mockResolvedValue(historyPlan({ operation: "list", collection: "new", queries: [], dateText: "today" }));
    const app = harness({ run, retrieve, curate: background, recallModel: async () => ({ plan: planner, select: vi.fn(), summarize: vi.fn() }) });
    const response = await app.handler(post({ message: "what are all the questions i asked u today?", tz: "UTC",
      sessionId: "44444444-4444-4444-8444-444444444444", selection: { provider, model: "test-model" } }));
    const body = await response.text();
    expect(body).toContain("**120** earlier");
    expect(body).toContain("Today's question 1"); expect(body).toContain("Today's question 120");
    expect(body).not.toContain("Long assistant response"); expect(body).not.toContain("Foreign secret"); expect(body).not.toContain("Yesterday only");
    expect(body).not.toContain("event: error"); expect(body.match(/event: done/g)).toHaveLength(1);
    expect(run).not.toHaveBeenCalled(); expect(retrieve).not.toHaveBeenCalled();
    await app.flush();
    expect(background).not.toHaveBeenCalled(); expect(await store.pendingCurations(userId)).toHaveLength(0);
    expect(app.logger.info.mock.calls[0][0]).toMatchObject({ answerMode: "history", searchCount: 0, assistantPersisted: true });
    await store.saveTurn({ userId, sessionId, role: "user", content: "Newest question after the first list", ts: dateFrom(clock.instant.getTime() - 500) });
    const next = harness({ run, retrieve, curate: background, recallModel: async () => ({ plan: planner, select: vi.fn(), summarize: vi.fn() }) });
    const updated = await (await next.handler(post({ message: "what all questions did i ask today", tz: "UTC", selection: { provider, model: "test-model" } }))).text();
    expect(updated).toContain("Newest question after the first list");
    await next.flush();
    expect(run).not.toHaveBeenCalled(); expect(background).not.toHaveBeenCalled();
  });

  it("paginates same-timestamp user rows inside the local day and excludes other days, future data and other users", async () => {
    const instant = dateFrom("2026-11-15T10:30:00Z");
    const rows = [
      { content: "Before local midnight", ts: dateFrom("2026-11-14T18:29:59Z") },
      { content: "At local midnight", ts: dateFrom("2026-11-14T18:30:00Z") },
      { content: "Same time first", ts: instant }, { content: "Same time second", ts: instant },
      { content: "Future message", ts: dateFrom("2026-11-15T10:31:00Z") },
    ];
    for (const row of rows) await store.saveTurn({ userId, sessionId, role: "user", ...row });
    await store.saveTurn({ userId: "bob", sessionId, role: "user", content: "Foreign", ts: instant });
    await store.saveTurn({ userId, sessionId, role: "assistant", content: "Assistant", ts: instant });
    const ranges = [{ startUtc: dateFrom("2026-11-14T18:30:00Z"), endUtc: dateFrom("2026-11-15T18:30:00Z") }];
    const first = await store.userMessagesFor(userId, { ranges, before: { ts: instant, id: 999 }, limit: 1 });
    expect(first.map(row => row.content)).toEqual(["Same time second", "Same time first"]);
    const next = await store.userMessagesFor(userId, { ranges, before: { ts: first[0].ts, id: first[0].id }, limit: 2 });
    expect(next.map(row => row.content)).toEqual(["Same time first", "At local midnight"]);
  });

  it("curates persisted search-backed answers after SSE ends and exposes the claims to later recall", async () => {
    const quote = "HubSpot Starter costs $20/seat/mo.";
    const source = { title: "HubSpot pricing", url: "https://hubspot.com/pricing", snippet: quote, published_date: "2026-11-14T00:00:00Z", is_official: true };
    const model = vi.fn(async () => ({ claims: [{ subject: "HubSpot Starter", attribute: "price", value: "$20/seat/mo", asOf: clock.iso,
      sourceUrls: [source.url], volatility: "high", quote, evidenceQuote: quote }], memory: [], threads: [{ title: "CRM shortlist", summary: "Shortlisted HubSpot Starter." }] }));
    const background = vi.fn((id: string, options: Parameters<typeof curate>[1]) => curate(id, { ...options, model }));
    const app = harness({ curate: background, run: (options) => runAgent({ ...options,
      model: new FakeModel([{ tools: [{ input: { queries: ["HubSpot pricing"] } }] }, { text: [quote] }]),
      search: async () => ({ queries: [{ query: "HubSpot pricing", results: [source] }], content: "", is_error: false, truncated: false }),
    }) });
    const body = await (await app.handler(post({ message: "Shortlist a CRM" }))).text();
    expect(body).toContain("event: done");
    expect(background).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
    await app.flush();
    expect(background).toHaveBeenCalledOnce();
    const [assistant] = await store.historyFor(userId);
    expect(await store.claimsForTurns(userId, [assistant.id])).toMatchObject([{ subject: "HubSpot Starter", value: "$20/seat/mo" }]);
    expect(app.logger.info.mock.calls[0][0]).toMatchObject({ curation: { completed: 1, failed: 0, deferred: false } });
    const followup = harness();
    await (await followup.handler(post({ message: "Is the CRM pricing from 15 November still correct?" }))).text();
    expect(JSON.stringify(followup.models[0].requests[0].system)).toContain("$20/seat/mo");
    await followup.flush();
  });

  it("keeps curator failure out of the response and retains pending work and both turns", async () => {
    const app = harness({ curate: async () => { throw new Error("private-api-key"); } });
    const body = await (await app.handler(post({ message: "Hello" }))).text();
    expect(body).not.toContain("event: error");
    await app.flush();
    expect(await store.historyFor(userId)).toHaveLength(2);
    expect(await store.pendingCurations(userId)).toHaveLength(1);
    expect(app.logger.info.mock.calls[0][0]).toMatchObject({ assistantPersisted: true, curation: { failed: 1 } });
    expect(JSON.stringify(app.logger.info.mock.calls)).not.toContain("private-api-key");
  });

  it("allows the next message once persistence finishes even if the curator is still running", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const background = vi.fn(async () => { await pending; return { completed: 0, failed: 0, deferred: false }; });
    const app = harness({ curate: background });
    await (await app.handler(post({ message: "First" }))).text();
    const flushing = app.flush();
    await vi.waitFor(() => expect(background).toHaveBeenCalledOnce());
    const next = await app.handler(post({ message: "Second" }));
    expect(next.status).toBe(200);
    await next.text();
    finish();
    await flushing;
    await app.flush();
  });

  it("persists streamed partial text after a model failure and emits one sanitized trace", async () => {
    const app = harness({ run: (options) => runAgent({ ...options, model: new FakeModel([{ text: ["Partial answer"], error: new Error("secret-key") }]) }) });
    const body = await (await app.handler(post({ message: "Hello" }))).text();
    expect(body).toContain("Partial answer");
    expect(body).toContain("event: error");
    expect(body).not.toContain("secret-key");
    await app.flush();
    const rows = await store.historyFor(userId);
    expect(rows[0].content).toContain("Partial answer");
    expect(app.logger.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(app.logger.error.mock.calls)).not.toContain("secret-key");
  });

  it("streams and persists a recovered answer with safe provider diagnostics in one trace", async () => {
    const model = new FakeModel([
      { tools: [{ input: { queries: ["fixture live score"] } }] },
      { error: new ModelProviderError({ provider: "gemini", kind: "tool_generation", status: 400 }) },
      { text: ["The current score could not be verified from these sources."] },
    ]);
    const search = vi.fn(async () => ({ queries: [{ query: "fixture live score", results: [{
      title: "Score fixture", url: "https://example.com/score", snippet: "No current score available.",
      published_date: null, is_official: false,
    }] }], content: "", is_error: false, truncated: false }));
    const app = harness({ run: (options) => runAgent({ ...options, model, search }) });
    const body = await (await app.handler(post({ message: "fixture live score" }))).text();
    expect(body).toContain("event: sources");
    expect(body).toContain("could not be verified");
    expect(body).not.toContain("event: error");
    expect(body.match(/event: done/g)).toHaveLength(1);
    expect(search).toHaveBeenCalledOnce();
    await app.flush();
    expect((await store.historyFor(userId))[0].content).toContain("could not be verified");
    expect(app.logger.info).toHaveBeenCalledOnce();
    expect(app.logger.info.mock.calls[0][0]).toMatchObject({
      searchCount: 1, assistantPersisted: true,
      modelFailures: [{ provider: "gemini", kind: "tool_generation", status: 400 }],
    });
  });

  it("contains persistence errors without claiming that an assistant turn was saved", async () => {
    const fake = { ...store, saveTurn: vi.fn(async (input: Parameters<Store["saveTurn"]>[0]) => {
      if (input.role === "assistant") throw new Error("db-url-secret");
      return store.saveTurn(input);
    }) };
    const app = harness({ store: async () => fake });
    await (await app.handler(post({ message: "Hello" }))).text();
    await app.flush();
    expect(app.logger.error.mock.calls[0][0]).toMatchObject({ userPersisted: true, assistantPersisted: false, failure: "assistant_persistence" });
    expect((await store.historyFor(userId))).toHaveLength(1);
  });

  it("does not call the model when the user turn cannot be saved", async () => {
    const run = vi.fn();
    const app = harness({ run, store: async () => ({ ...store, saveTurn: vi.fn().mockRejectedValue(new Error("db-password")) }) });
    const body = await (await app.handler(post({ message: "Hello" }))).text();
    expect(body).toContain("event: error");
    expect(body.match(/event: done/g)).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
    await app.flush();
    expect(app.logger.error.mock.calls[0][0]).toMatchObject({ userPersisted: false, assistantPersisted: false });
  });

  it("keeps the per-user admission until background persistence finishes", async () => {
    const app = harness();
    await (await app.handler(post({ message: "First" }))).text();
    const blocked = await app.handler(post({ message: "Second" }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("1");
    await app.flush();
    expect((await app.handler(post({ message: "Second" }))).status).toBe(200);
    await app.flush();
  });

  it("aborts model work on stream cancellation and preserves already streamed text", async () => {
    const model = new FakeModel([{ text: ["Partial"], hang: true }]);
    const app = harness({ run: (options) => runAgent({ ...options, model }) });
    const response = await app.handler(post({ message: "Hello" }));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("Partial");
    await reader.cancel();
    await app.flush();
    expect(model.streams[0].signal.aborted).toBe(true);
    expect((await store.historyFor(userId))[0]).toMatchObject({ role: "assistant", content: "Partial" });
    expect(app.logger.error.mock.calls[0][0]).toMatchObject({ cancelled: true, assistantPersisted: true });
  });

  it("returns validation errors before touching the database or scheduling work", async () => {
    const get = vi.fn();
    const app = harness({ store: get });
    for (const input of [{ message: " " }, { message: "Hello", tz: "Mars" }, { message: "Hello", userId }, { message: "Hello", sessionId: "bad" }, { message: "Hello", selection: { provider: "groq", model: "removed-model" } }]) {
      expect((await app.handler(post(input))).status).toBe(400);
    }
    expect((await app.handler(new Request("http://localhost/api/chat", { method: "POST", body: "{}" }))).status).toBe(415);
    expect((await app.handler(post("not JSON", { body: "{" }))).status).toBe(400);
    expect((await app.handler(post({ message: "x".repeat(40_000) }))).status).toBe(413);
    expect(get).not.toHaveBeenCalled();
    expect(app.tasks).toEqual([]);
  });

  it("returns a safe 503 and releases admission if initialization or after registration fails", async () => {
    const app = harness({ store: async () => { throw new Error("database-password"); } });
    const response = await app.handler(post({ message: "Hello" }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("password");
    expect(app.logger.error).toHaveBeenCalledOnce();
    const another = harness({ after: () => { throw new Error("No request context"); } });
    expect((await another.handler(post({ message: "Hello" }))).status).toBe(503);
    expect(await store.historyFor(userId)).toEqual([]);
  });

  it("returns private, paginated history with stable tie-breaking and session/user scopes", async () => {
    const otherSession = "33333333-3333-4333-8333-333333333333";
    for (const [id, session] of [["First", sessionId], ["Second", sessionId], ["Third", otherSession]]) {
      await store.saveTurn({ userId, sessionId: session, role: "user", content: id });
    }
    await store.saveTurn({ userId: "bob", sessionId, role: "user", content: "Private" });
    const get = createHistoryHandler({ store: async () => store, clock: () => clock });
    const request = (query: string) => new Request(`http://localhost/api/history?${query}`, { headers: { cookie } });
    const response = await get(request("limit=2&tz=UTC"));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const first = await response.json();
    expect(first.sessions).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    expect(decodeCursor(first.nextCursor).id).toBe(2);
    const next = await (await get(request(`limit=2&before=${first.nextCursor}`))).json();
    expect(next.nextCursor).toBeNull();
    expect(next.sessions[0].days[0].turns[0].content).toBe("First");
    expect(JSON.stringify(first)).not.toContain("Private");
    const filtered = await (await get(request(`sessionId=${otherSession}`))).json();
    expect(filtered.sessions.map((session: { id: string }) => session.id)).toEqual([otherSession]);
    expect((await get(request("limit=201"))).status).toBe(400);
    expect((await get(request("before=bad"))).status).toBe(400);
    expect((await get(request("userId=bob"))).status).toBe(400);
  });
});
