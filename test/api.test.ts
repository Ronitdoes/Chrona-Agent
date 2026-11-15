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
      recallModel: async () => ({ plan: async () => ({ intent: "general", operation: "list", queries: [], dateText: null, scope: "all", usePreviousEvidence: false, researchQuestion: null }), select: vi.fn() }),
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

  const historyPlan = (overrides: Partial<RecallPlan> = {}): RecallPlan => ({ intent: "history", operation: "exists", queries: ["neon pricing"], dateText: null, scope: "all", usePreviousEvidence: false, researchQuestion: null, ...overrides });
  const historyCases = (["gemini", "anthropic"] as const).flatMap(provider => (["instant", "medium", "high"] as const).map(effort => ({ provider, effort })));
  it("handles fractional monotonic timing in the real history request path", async () => {
    let tick = 0;
    const source = await store.saveTurn({ userId, sessionId, role: "user", content: "check neon db current pricing", ts: dateFrom("2026-11-15T10:10:12Z") });
    const run = vi.fn();
    const app = harness({ time: () => { tick += 0.125; return tick; }, run,
      recallModel: async () => ({ plan: async () => historyPlan(), select: async () => ({ status: "matched", matches: [{ turnId: source.id, quote: source.content }] }) }),
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
    const app = harness({ run, retrieve, curate: background, recallModel: async () => ({ plan, select }), clock: tz => ({ ...clock, tz: tz ?? "UTC" }) });
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
    const app = harness({ run, curate: background, recallModel: async () => ({ plan: async () => historyPlan(), select }) });
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
    const app = harness({ curate: background, recallModel: async () => ({ plan: async () => historyPlan({ intent: "mixed", operation: "when", researchQuestion: "Search the web for current Neon pricing" }), select }),
      run: options => runAgent({ ...options, model, search }),
    });
    const body = await (await app.handler(post({ message: "When did I ask about Neon pricing, and what does it cost now?" }))).text();
    expect(body).toContain("14 November 2026 at 10:00:00"); expect(body).toContain(source.content); expect(body).toContain("Current Neon prices");
    expect(search).toHaveBeenCalledOnce(); expect(body.match(/event: done/g)).toHaveLength(1);
    expect(model.requests[0].messages).toEqual([{ role: "user", content: "Search the web for current Neon pricing" }]);
    expect(JSON.stringify(model.requests[0].system)).not.toContain("When did I ask");
    expect(model.requests.every(request => request.tools?.length === 1)).toBe(true);
    await app.flush(); expect(background).not.toHaveBeenCalled();
  });

  it.each(["gemini", "anthropic"] as const)("lists all of today's user messages across chats with %s, without model/search/curation costs", async provider => {
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
    const app = harness({ run, retrieve, curate: background });
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
    const next = harness({ run, retrieve, curate: background });
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
