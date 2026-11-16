import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiModel } from "./gemini";
import type { ModelRequest } from "./model";
import { runAgent } from "./loop";
import type { AgentEvents, SendEvent } from "./events";
import { assemble } from "./prompt";
import { clock, recall, turn } from "../../test/agent-fixtures";

const queries = ["IND vs NZ live score", "India NZ score today"];
const frame = (parts: object[], finishReason = "STOP") => `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason }] })}\n\n`;
const streamed = (data: string) => new Response(data, { headers: { "Content-Type": "text/event-stream" } });
const first = () => streamed(frame([{ text: "Let me look up the score." }, { functionCall: {
  id: "call-1", name: "web_search", args: { queries },
} }]));
const final = () => streamed(frame([{ text: "The fixture source reports 100/2 at 10:00 UTC. [Score](https://example.com/score)" }]));
const unavailable = () => new Response("secret-provider-body", { status: 503 });

function setup(failure: Response, recovery: Response = final()) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(first()).mockResolvedValueOnce(failure).mockResolvedValueOnce(recovery);
  const search = vi.fn().mockResolvedValue({ queries: queries.map((query) => ({ query, results: [{
    title: "Fixture score", url: "https://example.com/score", snippet: "Fixture only: 100/2 at 10:00 UTC on 2026-11-15.",
    published_date: "2026-11-15T10:00:00Z", is_official: false,
  }] })), is_error: false, truncated: false, content: "" });
  const events: { event: keyof AgentEvents; data: AgentEvents[keyof AgentEvents] }[] = [];
  const send: SendEvent = (event, data) => { events.push({ event, data }); };
  const options = { system: [], messages: [{ role: "user" as const, content: "give live score of ind vs nz" }],
    model: createGeminiModel("test-key", undefined, { fetch }), search, send, time: () => 0 };
  return { fetch, search, events, options };
}

afterEach(() => vi.useRealTimers());

describe("post-search answer recovery", () => {
  it("finishes after multiple search batches and a stream failure with the full recalled context", async () => {
    const batch = (id: string, prefix: string) => streamed(frame([{ text: "Let me check these additional details. ".repeat(25) }, { functionCall: {
      id, name: "web_search", args: { queries: [1, 2, 3].map(index => `${prefix} ${index} live score match date timestamp source ${"detail ".repeat(35)}`) },
    } }]));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(batch("batch-1", "IND NZ"))
      .mockResolvedValueOnce(batch("batch-2", "Latest ODI"))
      .mockResolvedValueOnce(streamed("data: invalid\n\n"))
      .mockResolvedValueOnce(final());
    const search = vi.fn(async (input: unknown) => ({ queries: (input as { queries: string[] }).queries.map((query, index) => ({ query, results: [{
      title: "Fixture current score", url: `https://example.com/score/${index}`, snippet: "Fixture 100/2 at 10:00 UTC on 2026-11-15.", published_date: clock.iso, is_official: false,
    }] })), truncated: false, is_error: false, content: "" }));
    const prompt = assemble({ clock, message: "ind vs nz 5 odi", recall: recall({ turns: [turn(1, { content: "Earlier context ".repeat(200) })] }) });
    const events: string[] = [];
    const requests: ModelRequest[] = [];
    const actual = createGeminiModel("test-key", undefined, { fetch });
    const result = await runAgent({ ...prompt, model: { stream(request, options) { requests.push(request); return actual.stream(request, options); } }, search, time: () => 0, send: event => events.push(event) });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(requests.at(-1)?.tool_choice).toEqual({ type: "none" });
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.text).toContain("100/2");
    expect(result.limits).not.toContain("step limit");
    expect(result.modelFailures).toEqual([{ provider: "gemini", kind: "stream" }]);
    expect(events).not.toContain("error");
    const body = JSON.parse(fetch.mock.calls[3][1]?.body as string);
    expect(body.tools).toBeUndefined();
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(body.contents.at(-1).parts[0].text).toContain("100/2");
  });
  it.each(["unavailable", "stream"])("recovers once from %s using the existing evidence", async (kind) => {
    const failure = kind === "unavailable" ? unavailable() : streamed("data: invalid-json\n\n");
    const app = setup(failure);
    const result = await runAgent(app.options);
    expect(app.fetch).toHaveBeenCalledTimes(3);
    expect(app.search).toHaveBeenCalledTimes(1);
    expect(result.searchCount).toBe(2);
    expect(result.sources).toHaveLength(1);
    expect(result.text).toContain("100/2");
    expect(result.limits).not.toContain("response failure");
    expect(result.modelFailures).toEqual([expect.objectContaining({ provider: "gemini", kind })]);
    expect(app.events.filter(({ event }) => event === "error")).toHaveLength(0);
    expect(app.events.filter(({ event }) => event === "done")).toHaveLength(1);
    const body = JSON.parse(app.fetch.mock.calls[2][1]?.body as string);
    expect(body).toMatchObject({ generationConfig: { maxOutputTokens: 512 } });
    expect(result.text).toContain("short recovery answer");
    expect(body.tools).toBeUndefined();
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(body.contents.at(-1).parts[0].text).toContain("100/2");
    expect(JSON.stringify(body.systemInstruction)).toContain("already_shown");
    expect(JSON.stringify(body.systemInstruction)).toContain("Never invent a live score");
    expect(JSON.stringify([result, app.events, body])).not.toContain("secret");
  });

  it("stops after a failed recovery and preserves sources and partial text", async () => {
    const app = setup(unavailable(), unavailable());
    const result = await runAgent(app.options);
    expect(app.fetch).toHaveBeenCalledTimes(3);
    expect(app.search).toHaveBeenCalledTimes(1);
    expect(result.text).toContain("Let me look up the score.");
    expect(result.text).toContain("couldn't verify a current score");
    expect(result.text).toContain("https://example.com/score");
    expect(result.sources).toHaveLength(1);
    expect(result.modelFailures).toHaveLength(2);
    expect(result.limits).toContain("response failure");
    expect(app.events.filter(({ event }) => event === "error")).toEqual([{ event: "error", data: { message: expect.stringContaining("temporarily unavailable") } }]);
    expect(app.events.filter(({ event }) => event === "done")).toHaveLength(1);
  });

  it.each([401, 400, 413, 429])("does not blindly retry HTTP %s", async (status) => {
    const app = setup(new Response("secret", { status }));
    const result = await runAgent(app.options);
    expect(app.fetch).toHaveBeenCalledTimes(2);
    expect(result.sources).toHaveLength(1);
    expect(JSON.stringify(app.events)).toContain("The web search completed");
    expect(JSON.stringify(app.events)).not.toContain("secret");
  });

  it("honors a short Retry-After before the single final attempt", async () => {
    vi.useFakeTimers();
    const app = setup(new Response(null, { status: 429, headers: { "Retry-After": "0.025" } }));
    const pending = runAgent(app.options);
    await vi.advanceTimersByTimeAsync(0);
    expect(app.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(24);
    expect(app.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(app.fetch).toHaveBeenCalledTimes(3);
    expect(result.modelFailures).toEqual([{ provider: "gemini", kind: "rate_limit", status: 429, retryAfterMs: 25 }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not exceed rate-limit, wall-time or step budgets", async () => {
    const delayed = setup(new Response(null, { status: 429, headers: { "Retry-After": "120" } }));
    await runAgent(delayed.options);
    expect(delayed.fetch).toHaveBeenCalledTimes(2);
    const steps = setup(unavailable());
    await runAgent({ ...steps.options, budgets: { maxSteps: 2 } });
    expect(steps.fetch).toHaveBeenCalledTimes(2);
    const wall = setup(unavailable());
    let elapsed = 0;
    wall.fetch.mockReset().mockImplementationOnce(async () => first()).mockImplementationOnce(async () => { elapsed = 900; return unavailable(); });
    await runAgent({ ...wall.options, time: () => elapsed, budgets: { maxWallMs: 1000, finalReserveMs: 200 } });
    expect(wall.fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels the rate-limit wait without another request", async () => {
    vi.useFakeTimers();
    const app = setup(new Response(null, { status: 429, headers: { "Retry-After": "1" } }));
    const abort = new AbortController();
    const pending = runAgent({ ...app.options, signal: abort.signal });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await pending;
    expect(app.fetch).toHaveBeenCalledTimes(2);
    expect(app.events.filter(({ event }) => event === "done")).toHaveLength(1);
    expect(JSON.stringify(app.events)).toContain("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never retries before search has returned evidence", async () => {
    const app = setup(unavailable());
    app.fetch.mockReset().mockResolvedValueOnce(unavailable());
    const result = await runAgent(app.options);
    expect(app.fetch).toHaveBeenCalledTimes(1);
    expect(app.search).not.toHaveBeenCalled();
    expect(result.modelFailures).toEqual([{ provider: "gemini", kind: "unavailable", status: 503 }]);
  });
});
