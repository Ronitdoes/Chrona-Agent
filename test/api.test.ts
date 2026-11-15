import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createChatHandler } from "../lib/chat";
import { createHistoryHandler } from "../lib/historyHandler";
import { runAgent } from "../lib/agent/loop";
import { ModelProviderError } from "../lib/agent/errors";
import { createStore, type Store } from "../lib/store";
import { createRequestLimit } from "../lib/requestLimit";
import { clock, FakeModel } from "./agent-fixtures";
import { decodeCursor } from "../lib/history";
import { curate } from "../lib/curator/curate";

const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const cookie = `user_id=${userId}; session_id=${sessionId}`;
const post = (value: unknown, options: RequestInit = {}) => new Request("http://localhost/api/chat", {
  method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(value), ...options,
});

describe("chat and history backend with real PGlite and fake model", () => {
  let store: Store;
  beforeAll(async () => { store = await createStore({ dataDir: ":memory:", clock: () => clock }); }, 30_000);
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
      resolveSelection: async requested => requested ?? { provider: "groq", model: "test-model" },
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
      { error: new ModelProviderError({ provider: "groq", kind: "tool_generation", status: 400 }) },
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
      modelFailures: [{ provider: "groq", kind: "tool_generation", status: 400 }],
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
    for (const input of [{ message: " " }, { message: "Hello", tz: "Mars" }, { message: "Hello", userId }, { message: "Hello", sessionId: "bad" }]) {
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
