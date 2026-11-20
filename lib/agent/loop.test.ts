import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { clock, recall, FakeModel } from "../../test/agent-fixtures";
import { createWebSearch } from "../tools/webSearch";
import { FakeSearchProvider } from "../tools/providers/fake";
import type { WebSearchResult } from "../tools/webSearch";
import { runAgent } from "./loop";
import { assemble } from "./prompt";
import { sse, type AgentEvents, type SendEvent } from "./events";
import { effortProfiles, effortSchema } from "../research-effort";

type Captured = { [K in keyof AgentEvents]: { event: K; data: AgentEvents[K] } }[keyof AgentEvents];
function setup(model: FakeModel) {
  const events: Captured[] = [];
  const send: SendEvent = (event, data) => { events.push({ event, data } as Captured); };
  return { ...assemble({ clock, recall: recall(), message: "Check the shortlisted CRMs" }), model, send, turnId: "turn-test", events };
}
const response = (queries: string[]): WebSearchResult => ({
  queries: queries.map((query) => ({ query, results: [{
    title: "Pricing", url: "https://example.com/pricing", published_date: "2026-11-14T00:00:00Z", snippet: "$20/seat/mo", is_official: false,
  }] })), is_error: false, content: "unused provider representation", truncated: false,
});
function toolResults(model: FakeModel, request: number): ToolResultBlockParam[] {
  const last = model.requests[request].messages.at(-1);
  const blocks: ContentBlockParam[] = Array.isArray(last?.content) ? last.content : [];
  return blocks.filter((block): block is ToolResultBlockParam => block.type === "tool_result");
}
afterEach(() => { vi.useRealTimers(); });

describe("hand-written agent loop", () => {
  it("repairs the screenshot's date/status contradiction before streaming it, within Instant's budget", async () => {
    const contradictory = "There is no India vs New Zealand match being played today, Sunday, November 15, 2026. The 5th ODI took place earlier today.";
    const corrected = "Today's India vs New Zealand match finished earlier today, 15 November 2026. It is no longer live. [Source](https://example.com/pricing)";
    const model = new FakeModel([
      { tools: [{ input: { queries: ["India New Zealand match 15 November 2026"] } }] },
      { text: [contradictory] }, { text: [corrected] },
    ]);
    const options = setup(model);
    const search = vi.fn(async () => response(["India New Zealand match 15 November 2026"]));
    const result = await runAgent({ ...options, messages: [{ role: "user", content: "ind vs nz match today" }], search, effort: "instant", time: () => 0 });
    expect(result.text).toBe(corrected);
    expect(model.requests).toHaveLength(3);
    expect(model.requests[2].tool_choice).toEqual({ type: "none" });
    expect(search).toHaveBeenCalledOnce();
    expect(JSON.stringify(options.events)).not.toContain("There is no India");
    expect(options.events.filter(event => event.event === "done")).toHaveLength(1);
    expect(options.events.filter(event => event.event === "error")).toHaveLength(0);
  });

  it("withholds repeatedly contradictory date claims and preserves the sources as unverified", async () => {
    const contradictory = "No India vs New Zealand match today. The match finished earlier today.";
    const model = new FakeModel([{ tools: [{ input: { queries: ["India NZ fixture today"] } }] }, { text: [contradictory] }, { text: [contradictory] }]);
    const options = setup(model);
    const result = await runAgent({ ...options, messages: [{ role: "user", content: "ind vs nz match today" }], search: async () => response(["India NZ fixture today"]), effort: "instant", time: () => 0 });
    expect(result.text).not.toContain(contradictory);
    expect(JSON.stringify(options.events)).not.toContain(contradictory);
    expect(result.text).toContain("unverified");
    expect(result.sources).toHaveLength(1);
    expect(model.requests).toHaveLength(3);
    expect(options.events.filter(event => event.event === "done")).toHaveLength(1);
  });

  it.each(effortSchema.options.filter(effort => effort !== "deep"))("enforces %s effort across all query batches and model-visible sources", async effort => {
    const profile = effortProfiles[effort];
    const model = new FakeModel([
      { tools: [{ input: { queries: Array.from({ length: 6 }, (_, i) => `Query ${i}`) } }] },
      { tools: [{ input: { queries: Array.from({ length: 6 }, (_, i) => `Query ${i + 6}`) } }] },
      { text: ["Verified findings from the retained sources."] },
    ]);
    const search = vi.fn(async (input: unknown) => ({ ...response([]), queries: (input as { queries: string[] }).queries.map(query => ({ query, results: Array.from({ length: 3 }, (_, index) => ({
      title: `${query} source ${index}`, url: `https://example.com/${encodeURIComponent(query)}/${index}`, snippet: "Fixture evidence", published_date: null, is_official: false,
    })) })) }));
    const result = await runAgent({ ...setup(model), effort, search, time: () => 0 });
    expect(result.searchCount).toBe(profile.maxQueries);
    expect(result.sources).toHaveLength(profile.maxSources);
    expect(result.evidence).toHaveLength(profile.maxSources);
    expect(model.requests.every(request => request.researchEffort === effort)).toBe(true);
    expect(model.requests.at(-1)?.tool_choice).toEqual({ type: "none" });
    expect(model.requests[0].max_tokens).toBe(8192);
  });

  it("caps Deep at five batches and twenty distinct queries and keeps capacity for last-round sources", async () => {
    const model = new FakeModel([
      ...Array.from({ length: 5 }, (_, round) => ({ tools: [{ input: { queries: [
        ...Array.from({ length: 4 }, (_, index) => `Query ${round * 4 + index}`), " QUERY   0 ",
      ] } }] })),
      { text: ["Findings from five batches."] },
    ]);
    const search = vi.fn(async ({ queries }: { queries: string[] }) => ({ ...response([]), queries: queries.map(query => ({
      query, results: Array.from({ length: 4 }, (_, index) => ({
        title: `${query} source ${index}`, url: `https://example.com/${encodeURIComponent(query)}/${index}`,
        snippet: "Fixture evidence", published_date: null, is_official: false,
      })),
    })) }));
    const result = await runAgent({ ...setup(model), effort: "deep", search: input => search(input as { queries: string[] }), time: () => 0 });
    expect(search).toHaveBeenCalledTimes(5);
    expect(search.mock.calls.map(([{ queries }]) => queries.length)).toEqual([4, 4, 4, 4, 4]);
    expect(result.searchCount).toBe(20);
    expect(result.sources).toHaveLength(20);
    expect(result.sources.some(source => source.title.startsWith("Query 16"))).toBe(true);
    expect(model.requests[5].tool_choice).toEqual({ type: "none" });
  });

  it("ends Deep search at its deadline and still synthesizes within the same turn budget", async () => {
    let now = 0;
    const model = new FakeModel([{ tools: [{ input: { queries: ["Opening search"] } }] }, { text: ["Findings before the deadline."] }]);
    const search = vi.fn(async () => {
      now = 180_001;
      return response(["Opening search"]);
    });
    const result = await runAgent({ ...setup(model), effort: "deep", search, time: () => now });
    expect(search).toHaveBeenCalledOnce();
    expect(model.requests[1].tool_choice).toEqual({ type: "none" });
    expect(result.text).toContain("Findings before the deadline.");
    expect(result.limits).toContain("time limit");
  });

  it("requires web_search for a live score, then restores normal routing after results", async () => {
    const model = new FakeModel([{ tools: [{ input: { queries: ["IND NZ score"] } }] }, { text: ["The score could not be verified."] }]);
    const options = setup(model);
    await runAgent({ ...options, messages: [{ role: "user", content: "give live score of ind vs nz" }], search: async () => response(["IND NZ score"]), time: () => 0 });
    expect(model.requests[0].tool_choice).toMatchObject({ type: "tool", name: "web_search" });
    expect(model.requests[1].tool_choice).toMatchObject({ type: "auto" });
    expect(model.requests.every(request => request.tools?.length === 1)).toBe(true);
  });

  it("streams stable answers without searching and emits exact timing and SSE payloads", async () => {
    let time = 0;
    const model = new FakeModel([{ text: ["Hello", " there"], beforeText: () => { time = 850; }, after: () => { time = 1000; } }]);
    const options = setup(model);
    const search = vi.fn();
    const result = await runAgent({ ...options, search, time: () => time });
    expect(result.text).toBe("Hello there");
    expect(search).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].tools?.map((tool) => "name" in tool ? tool.name : undefined)).toEqual(["web_search"]);
    expect(options.events).toEqual([
      { event: "delta", data: { text: "Hello" } }, { event: "delta", data: { text: " there" } },
      { event: "done", data: { turnId: "turn-test", ttftMs: 850, totalMs: 1000 } },
    ]);
    expect(sse("delta", { text: "a\nb" })).toBe('event: delta\ndata: {"text":"a\\nb"}\n\n');
  });

  it("makes one search tool call that fans out across all items, then pairs the result with its tool ID", async () => {
    const gates: (() => void)[] = [];
    const primary = new FakeSearchProvider(async (request) => {
      await new Promise<void>((resolve) => { gates.push(resolve); });
      return [{ title: request.query, url: `https://example.com/${request.query.split(" ")[0]}`, snippet: "$20/mo", published_date: "2026-11-14" }];
    });
    const search = vi.fn(createWebSearch({ primary, clock: () => clock, concurrency: 2 }));
    const model = new FakeModel([
      { tools: [{ id: "batch-1", input: { queries: ["HubSpot pricing", "Pipedrive pricing"] } }] },
      { text: ["Here are the dated findings."] },
    ]);
    const options = setup(model);
    const pending = runAgent({ ...options, search, time: () => 0 });
    await vi.waitFor(() => expect(primary.calls).toHaveLength(2));
    gates.forEach((resolve) => resolve());
    const result = await pending;
    expect(search).toHaveBeenCalledTimes(1);
    expect(result.searchCount).toBe(2);
    expect(toolResults(model, 1)[0]).toMatchObject({ tool_use_id: "batch-1", is_error: false });
    expect(options.events.map(({ event }) => event)).toEqual(["status", "status", "sources", "answer_ui", "delta", "done"]);
    expect(options.events[0]).toEqual({ event: "status", data: { id: "s1", kind: "search", queries: ["HubSpot pricing", "Pipedrive pricing"], state: "running", count: 0 } });
    expect(options.events[1]).toEqual({ event: "status", data: { id: "s1", kind: "search", queries: ["HubSpot pricing", "Pipedrive pricing"], state: "done", count: 2 } });
    expect(result.sources[0]).toEqual({ url: "https://example.com/HubSpot", title: "HubSpot pricing", domain: "example.com", publishedDate: "2026-11-14T00:00:00.000Z", isOfficial: false });
    expect(result.text).toBe("Here are the dated findings.");
  });

  it("reserves final synthesis and one correction within four model steps", async () => {
    const model = new FakeModel([
      ...Array.from({ length: 3 }, (_, i) => ({ tools: [{ input: { queries: [`Query ${i}`] } }] })),
      { text: ["Partial findings."] },
    ]);
    const options = setup(model);
    const search = vi.fn(async (input: unknown) => response((input as { queries: string[] }).queries));
    const result = await runAgent({ ...options, search, time: () => 0 });
    expect(model.requests).toHaveLength(4);
    expect(search).toHaveBeenCalledTimes(2);
    expect(model.requests[2].tool_choice).toEqual({ type: "none" });
    expect(toolResults(model, 3)[0]).toMatchObject({ is_error: true });
    expect(model.requests[3].tool_choice).toEqual({ type: "none" });
    expect(model.requests[3].tools?.map((tool) => "name" in tool ? tool.name : undefined)).toEqual(["web_search"]);
    expect(JSON.stringify(model.requests[3].system)).toContain("Answer now");
    expect(result.text).not.toContain("step limit");
    expect(result.limits).not.toContain("step limit");
    expect(options.events.filter((event) => event.event === "done")).toHaveLength(1);
  });

  it.each(["auto", "brief", "detailed"] as const)("preserves %s detail through final correction within the four-call limit", async answerDetail => {
    const model = new FakeModel([
      { tools: [{ input: { queries: ["First check"] } }] },
      { tools: [{ input: { queries: ["Second check"] } }] },
      { tools: [{ input: { queries: ["Late check"] } }] },
      { text: ["A developed answer with explanations, examples and citations."] },
    ]);
    const options = setup(model);
    const result = await runAgent({ ...options, answerDetail, selection: { provider: "gemini", model: "gemini-3.5-flash-lite" }, effort: "high", search: async input => response((input as { queries: string[] }).queries), time: () => 0 });
    expect(result.text).toContain("developed answer");
    expect(result.steps).toBe(4);
    expect(result.searchCount).toBe(2);
    expect(model.requests.every(request => request.max_tokens === 65_536 && request.tools?.length === 1)).toBe(true);
    expect(JSON.stringify(model.requests.at(-1)?.system)).toContain("take precedence over this saved preference");
    expect(toolResults(model, 3)[0].content).toContain("Preserve the requested answer detail");
    expect(toolResults(model, 3)[0].content).not.toContain("Give a concise answer");
    expect(options.events.some(event => event.event === "error")).toBe(false);
  });

  it("finishes a score-today lookup after two fresh search passes without chasing more guesses", async () => {
    const model = new FakeModel([
      { tools: [{ input: { queries: ["IND NZ fixture today"] } }] },
      { tools: [{ input: { queries: ["IND NZ scorecard"] } }] },
      { text: ["The current score could not be verified; here are the relevant match pages."] },
    ]);
    const search = vi.fn(async (input: unknown, options: { fresh?: boolean }) => {
      expect(options.fresh).toBe(true);
      return response((input as { queries: string[] }).queries);
    });
    const result = await runAgent({ ...setup(model), messages: [{ role: "user", content: "ind vs nz score today" }], search, time: () => 0 });
    expect(model.requests[0].tool_choice).toMatchObject({ type: "tool", name: "web_search" });
    expect(model.requests[2].tool_choice).toEqual({ type: "none" });
    expect(search.mock.calls).toHaveLength(2);
    expect(result.text).not.toContain("step limit");
  });

  it("repairs one late search request within the model budget and never runs that search", async () => {
    const model = new FakeModel([
      { tools: [{ input: { queries: ["IND NZ score today"] } }] },
      { tools: [{ input: { queries: ["IND NZ scorecard"] } }] },
      { tools: [{ id: "late", input: { queries: ["Unnecessary guess"] } }] },
      { text: ["The sources do not establish a current score. [Match page](https://example.com/pricing)"] },
    ]);
    const options = setup(model);
    const search = vi.fn(async (input: unknown) => response((input as { queries: string[] }).queries));
    const result = await runAgent({ ...options, messages: [{ role: "user", content: "ind vs nz score today" }], search, time: () => 0 });
    expect(search).toHaveBeenCalledTimes(2);
    expect(model.requests).toHaveLength(4);
    expect(toolResults(model, 3)[0]).toMatchObject({ tool_use_id: "late", is_error: true });
    expect(result.limits).not.toContain("step limit");
    expect(options.events.filter(event => event.event === "error")).toHaveLength(0);
    expect(options.events.filter(event => event.event === "done")).toHaveLength(1);
  });

  it("preserves useful source excerpts if the model keeps asking to search during final synthesis", async () => {
    const model = new FakeModel(Array.from({ length: 4 }, (_, i) => ({ tools: [{ input: { queries: [`Score query ${i}`] } }] })));
    const search = vi.fn(async (input: unknown) => response((input as { queries: string[] }).queries));
    const result = await runAgent({ ...setup(model), messages: [{ role: "user", content: "ind vs nz score today" }], search, time: () => 0 });
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.text).toContain("couldn't verify a current score");
    expect(result.text).toContain("https://example.com/pricing");
    expect(result.text).not.toContain("I couldn't complete an answer");
    expect(result.text).not.toContain("Score query");
  });

  it("runs no more than ten queries and explicitly reports omitted queries", async () => {
    const first = Array.from({ length: 6 }, (_, i) => `Query ${i}`);
    const second = Array.from({ length: 6 }, (_, i) => `Query ${i + 6}`);
    const model = new FakeModel([{ tools: [{ input: { queries: first } }] }, { tools: [{ input: { queries: second } }] }, { text: ["Some findings."] }]);
    const options = setup(model);
    const search = vi.fn(async (input: unknown) => response((input as { queries: string[] }).queries));
    const result = await runAgent({ ...options, search, time: () => 0 });
    expect(result.searchCount).toBe(10);
    expect((search.mock.calls[1][0] as { queries: string[] }).queries).toEqual(second.slice(0, 4));
    expect(model.requests[2].tool_choice).toEqual({ type: "none" });
    expect(toolResults(model, 2)[0].content).toContain("Not run: query budget reached");
    expect(result.unverifiedQueries).toEqual(["Query 10", "Query 11"]);
    expect(result.text).toContain("Query 10; Query 11");
    expect(result.sources).toHaveLength(1);
  });

  it("rejects invalid arguments and unknown tools without executing anything else", async () => {
    const model = new FakeModel([
      { tools: [{ id: "bad-args", input: { queries: [] } }, { id: "other-tool", name: "read_page", input: {} }] },
      { text: ["Please clarify the search."] },
    ]);
    const search = vi.fn();
    const result = await runAgent({ ...setup(model), search, time: () => 0 });
    expect(search).not.toHaveBeenCalled();
    expect(result.searchCount).toBe(0);
    expect(toolResults(model, 1)).toEqual([
      expect.objectContaining({ tool_use_id: "bad-args", is_error: true }),
      expect.objectContaining({ tool_use_id: "other-tool", is_error: true }),
    ]);
  });

  it("bounds tool-result text and only emits sources retained for the model", async () => {
    const model = new FakeModel([{ tools: [{ input: { queries: ["Price query"] } }] }, { text: ["Findings."] }]);
    const search = vi.fn(async () => {
      const found = response(["Price query"]);
      found.queries[0].results[0].content = "x".repeat(20_000);
      return found;
    });
    await runAgent({ ...setup(model), search, time: () => 0, budgets: { resultTokens: 512 } });
    const body = toolResults(model, 1)[0].content;
    expect(typeof body).toBe("string");
    expect(Buffer.byteLength(body as string)).toBeLessThanOrEqual(512);
    expect(body).toContain('"truncated":true');
  });

  it("retains upstream truncation and clears an earlier failure after a successful retry", async () => {
    const model = new FakeModel([
      { tools: [{ input: { queries: ["Price query"] } }] },
      { tools: [{ input: { queries: ["Price query"] } }] },
      { text: ["The available evidence is truncated."] },
    ]);
    const search = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue({ ...response(["Price query"]), truncated: true });
    const result = await runAgent({ ...setup(model), search, time: () => 0 });
    expect(result.completedQueries).toEqual(["Price query"]);
    expect(result.unverifiedQueries).toEqual([]);
    expect(toolResults(model, 2)[0].content).toContain('"truncated":true');
  });

  it("turns search exceptions into paired tool errors and closes the running status", async () => {
    const model = new FakeModel([{ tools: [{ id: "failed", input: { queries: ["Price query"] } }] }, { text: ["I couldn't verify the price."] }]);
    const options = setup(model);
    const result = await runAgent({ ...options, time: () => 0, search: async () => { throw new Error("secret key in error"); } });
    expect(toolResults(model, 1)[0]).toMatchObject({ tool_use_id: "failed", is_error: true });
    expect(JSON.stringify(options.events)).not.toContain("secret key");
    expect(result.unverifiedQueries).toEqual(["Price query"]);
    expect(options.events.filter((event) => event.event === "status").map((event) => event.data.state)).toEqual(["running", "done"]);
  });

  it("preserves partial text on model failures and never forwards error details", async () => {
    const model = new FakeModel([{ text: ["Partial answer"], error: new Error("api-key-secret") }]);
    const options = setup(model);
    const result = await runAgent({ ...options, time: () => 0 });
    expect(result.text).toContain("Partial answer");
    expect(options.events.filter((event) => event.event === "error")).toHaveLength(1);
    expect(options.events.at(-1)?.event).toBe("done");
    expect(JSON.stringify(options.events)).not.toContain("api-key-secret");
  });

  it("interrupts a stalled research stream with time reserved for a final answer", async () => {
    vi.useFakeTimers();
    let time = 0;
    const model = new FakeModel([{ hang: true }, { text: ["An honest partial answer."] }]);
    const pending = runAgent({ ...setup(model), time: () => time, budgets: { maxWallMs: 1000, finalReserveMs: 200 } });
    time = 801;
    await vi.advanceTimersByTimeAsync(801);
    const result = await pending;
    expect(model.requests).toHaveLength(2);
    expect(model.streams[0].aborted).toBe(true);
    expect(model.requests[1].tool_choice).toEqual({ type: "none" });
    expect(result.text).toContain("An honest partial answer.");
    expect(result.limits).toContain("time limit");
  });

  it("lets a direct detailed answer finish in its answer window without regenerating streamed text", async () => {
    vi.useFakeTimers();
    let time = 0;
    const model = new FakeModel([{ text: ["A complete detailed explanation."] }]);
    const delayed: typeof model = model;
    const original = model.stream.bind(model);
    delayed.stream = (request, options) => {
      const stream = original(request, options);
      return { ...stream, async *[Symbol.asyncIterator]() {
        yield* stream;
        await new Promise(resolve => setTimeout(resolve, 900));
      } };
    };
    const pending = runAgent({ ...setup(delayed), answerDetail: "detailed", time: () => time, budgets: { maxWallMs: 1000, finalReserveMs: 200 } });
    await vi.advanceTimersByTimeAsync(0);
    time = 801; await vi.advanceTimersByTimeAsync(801);
    expect(model.requests).toHaveLength(1);
    time = 900; await vi.advanceTimersByTimeAsync(99);
    const result = await pending;
    expect(result.text).toBe("A complete detailed explanation.");
    expect(result.limits).not.toContain("time limit");
    expect(result.steps).toBe(1);
  });

  it("also caps a stalled final stream and still emits a terminal response", async () => {
    vi.useFakeTimers();
    let time = 0;
    const model = new FakeModel([{ hang: true }, { hang: true }]);
    const options = setup(model);
    const pending = runAgent({ ...options, time: () => time, budgets: { maxWallMs: 1000, finalReserveMs: 200 } });
    time = 800;
    await vi.advanceTimersByTimeAsync(800);
    time = 1000;
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    expect(result.text).toContain("couldn't complete an answer");
    expect(result.totalMs).toBe(1000);
    expect(options.events.at(-1)?.event).toBe("done");
    expect(model.requests).toHaveLength(2);
  });

  it("cancels a stalled search at the research deadline before final synthesis", async () => {
    vi.useFakeTimers();
    let time = 0;
    let searchSignal: AbortSignal | undefined;
    const model = new FakeModel([{ tools: [{ input: { queries: ["Pricing"] } }] }, { text: ["Pricing remains unverified."] }]);
    const pending = runAgent({ ...setup(model), time: () => time,
      budgets: { maxWallMs: 1000, finalReserveMs: 200 },
      search: async (_, { signal }) => { searchSignal = signal; return new Promise(() => {}); },
    });
    await vi.advanceTimersByTimeAsync(0);
    time = 801;
    await vi.advanceTimersByTimeAsync(801);
    const result = await pending;
    expect(searchSignal?.aborted).toBe(true);
    expect(result.unverifiedQueries).toEqual(["Pricing"]);
    expect(model.requests[1].tool_choice).toEqual({ type: "none" });
  });

  it.each(["auto", "detailed"] as const)("honors cancellation of %s answers without another model request", async answerDetail => {
    const model = new FakeModel([{ hang: true }]);
    const options = setup(model);
    const controller = new AbortController();
    const pending = runAgent({ ...options, answerDetail, signal: controller.signal, time: () => 0 });
    controller.abort();
    const result = await pending;
    expect(model.requests).toHaveLength(1);
    expect(model.streams[0].aborted).toBe(true);
    expect(result.text).toBe("");
    expect(options.events).toEqual([{ event: "error", data: { message: "The request was cancelled." } }, { event: "done", data: { turnId: "turn-test", ttftMs: 0, totalMs: 0 } }]);
  });

  it("contains output-limit failures and rejects tool calls from a tools-disabled final step", async () => {
    const cutoff = await runAgent({ ...setup(new FakeModel([{ text: ["Cut off"], stop: "max_tokens" }])), time: () => 0 });
    expect(cutoff.limits).toContain("output limit");
    const search = vi.fn();
    const final = await runAgent({ ...setup(new FakeModel([{ tools: [{ input: { queries: ["Forbidden late search"] } }] }])), search, time: () => 0, budgets: { maxSteps: 1 } });
    expect(search).not.toHaveBeenCalled();
    expect(final.unverifiedQueries).toEqual(["Forbidden late search"]);
    expect(final.text).not.toBe("");
  });

  it("does not throw if the client disconnects while receiving a delta", async () => {
    const model = new FakeModel([{ text: ["Partial"], tools: [{ input: { queries: ["Price query"] } }] }]);
    const search = vi.fn();
    const result = await runAgent({ ...setup(model), search, send: () => { throw new Error("disconnected"); }, time: () => 0 });
    expect(result.text).toBe("Partial");
    expect(search).not.toHaveBeenCalled();
  });
});
