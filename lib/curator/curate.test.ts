import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dateFrom } from "../clock";
import { createStore, type Store } from "../store";
import { claims, curations } from "../store/schema";
import { retrieve } from "../recall/retrieve";
import { assemble } from "../agent/prompt";
import { clock } from "../../test/agent-fixtures";
import { curate } from "./curate";
import { type Extraction, type CuratorInput } from "./schema";
import type { SearchResult } from "../tools/results";
import { createGroqCuratorModel } from "./model";

const names = ["HubSpot Starter", "Pipedrive Essential", "Zoho Standard", "Freshsales Growth", "Salesforce Starter"];
const at = dateFrom("2026-11-09T12:00:00Z");
function fixture(value = "$20/seat/mo", published = "2026-11-09T00:00:00Z", asOf = at.toISOString()) {
  const evidence: SearchResult[] = names.map((subject, index) => ({ title: `${subject} pricing`, url: `https://example.com/crm-${index}`,
    published_date: published, snippet: `${subject} costs ${value}.`, is_official: false }));
  const extraction: Extraction = {
    claims: evidence.map((source, i) => ({ subject: names[i], attribute: "price", value, asOf,
      sourceUrls: [source.url], volatility: "high", quote: source.snippet, evidenceQuote: source.snippet })),
    memory: [{ key: "team_size", value: "20-person sales team", quote: "We have a 20-person sales team." }],
    threads: [{ title: "CRM shortlist", summary: names.join(", ") }],
  };
  return { evidence, extraction, answer: evidence.map((source) => source.snippet).join("\n") };
}

describe("post-response curator with real PGlite", () => {
  let store: Store;
  beforeAll(async () => { store = await createStore({ dataDir: ":memory:", clock: () => clock }); }, 30_000);
  beforeEach(async () => { await store.db.execute(sql`TRUNCATE curations, claims, memory, threads, turns RESTART IDENTITY CASCADE`); });
  afterAll(async () => { await store?.close(); });

  async function seed(options: { userId?: string; ts?: Date; data?: ReturnType<typeof fixture>; question?: string; evidence?: boolean } = {}) {
    const { userId = "alice", ts = at, data = fixture() } = options;
    const user = await store.saveTurn({ userId, sessionId: "one", role: "user", ts,
      content: options.question ?? "We have a 20-person sales team. Shortlist five CRMs." });
    const assistant = await store.saveTurn({ userId, sessionId: "one", role: "assistant", content: data.answer, ts,
      curation: { userTurnId: user.id, evidence: options.evidence === false ? [] : data.evidence } });
    return { user, assistant, data };
  }
  const run = (output: unknown) => curate("alice", { store, clock: () => clock, model: vi.fn().mockResolvedValue(output) });

  it("extracts the five CRM claims, durable memory and one thread for deterministic revalidation", async () => {
    const { assistant, data } = await seed();
    const model = vi.fn(async (input: CuratorInput) => {
      expect(input.user.content).toContain("20-person");
      expect(input.assistant.id).toBe(assistant.id);
      expect((await store.historyFor("alice"))).toHaveLength(2);
      return data.extraction;
    });
    expect(await curate("alice", { store, model, clock: () => clock })).toEqual({ completed: 1, failed: 0, deferred: false });
    expect(await store.claimsForTurns("alice", [assistant.id])).toHaveLength(5);
    expect(await store.memoryFor("alice")).toMatchObject([{ key: "team_size", value: "20-person sales team", sourceTurnId: 1 }]);
    expect(await store.threadsFor("alice")).toMatchObject([{ title: "CRM shortlist" }]);
    const recalled = await retrieve({ userId: "alice", text: "Has our CRM shortlist from Monday changed?", now: clock }, { store });
    const prompt = assemble({ clock, recall: recalled, message: "Check the shortlist" });
    expect(recalled.claims).toHaveLength(5);
    for (const name of names) expect(JSON.stringify(prompt.system)).toContain(name);
    expect(JSON.stringify(prompt.system)).toContain("pricing 2026");
  });

  it("dedupes within a batch and across repeated and concurrent passes", async () => {
    const { assistant, data } = await seed();
    data.extraction.claims.push({ ...data.extraction.claims[0], subject: " HUBSPOT   STARTER " });
    data.extraction.memory.push({ ...data.extraction.memory[0], key: "Team Size" });
    data.extraction.threads.push({ ...data.extraction.threads[0], title: "crm SHORTLIST" });
    await Promise.all([run(data.extraction), run(data.extraction)]);
    const model = vi.fn();
    expect((await curate("alice", { store, model })).completed).toBe(0);
    expect(model).not.toHaveBeenCalled();
    expect(await store.claimsForTurns("alice", [assistant.id])).toHaveLength(5);
    expect(await store.memoryFor("alice")).toHaveLength(1);
    expect(await store.threadsFor("alice")).toHaveLength(1);
    expect(await store.pendingCurations("alice")).toEqual([]);
  });

  it("persists the five CRM claims through Groq JSON extraction and retains invalid output for retry", async () => {
    const { assistant, data } = await seed();
    let valid = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop",
      message: { content: JSON.stringify(valid ? data.extraction : { invalid: true }) } }] }), { headers: { "content-type": "application/json" } }));
    const model = createGroqCuratorModel("test-key", "qwen/qwen3.8-27b", { fetch });
    expect((await curate("alice", { store, model, clock: () => clock })).failed).toBe(1);
    expect(await store.pendingCurations("alice")).toHaveLength(1);
    expect(await store.claimsForTurns("alice", [assistant.id])).toHaveLength(0);
    expect(await store.historyFor("alice")).toHaveLength(2);
    valid = true;
    expect((await curate("alice", { store, model, clock: () => clock })).completed).toBe(1);
    expect(await store.claimsForTurns("alice", [assistant.id])).toHaveLength(5);
    expect(await store.memoryFor("alice")).toHaveLength(1);
    expect(await store.threadsFor("alice")).toHaveLength(1);
    expect(await store.pendingCurations("alice")).toHaveLength(0);
  });

  it.each(["invalid shape", "invented URL", "invented evidence", "invented quote", "future date", "invented memory", "conflicting duplicate"])("discards the entire output on %s and keeps the transcript and retry", async (kind) => {
    const { assistant, data } = await seed();
    const output = structuredClone(data.extraction);
    if (kind === "invalid shape") (output.claims[0] as unknown as { volatility: string }).volatility = "urgent";
    if (kind === "invented URL") output.claims[0].sourceUrls = ["https://invented.example/pricing"];
    if (kind === "invented evidence") output.claims[0].evidenceQuote = "Invented pricing is $20/seat/mo.";
    if (kind === "invented quote") output.claims[0].quote = "The answer never said this costs $20/seat/mo.";
    if (kind === "future date") output.claims[0].asOf = "2027-01-01T00:00:00Z";
    if (kind === "invented memory") output.memory[0].value = "50 people";
    if (kind === "conflicting duplicate") output.claims.push({ ...output.claims[0], value: "$23/seat/mo" });
    expect((await run(output)).failed).toBe(1);
    expect(await store.claimsForTurns("alice", [assistant.id])).toEqual([]);
    expect(await store.memoryFor("alice")).toEqual([]);
    expect(await store.threadsFor("alice")).toEqual([]);
    expect(await store.historyFor("alice")).toHaveLength(2);
    expect(await store.pendingCurations("alice")).toHaveLength(1);
  });

  it("retries failed extraction on the next turn, using the original saved evidence", async () => {
    const first = await seed();
    const failed = await curate("alice", { store, model: async () => { throw new Error("private-api-key"); } });
    expect(failed).toEqual({ completed: 0, failed: 1, deferred: false });
    const second = await seed({ ts: clock.instant, data: fixture("$23/seat/mo", "2026-11-14T00:00:00Z", clock.iso) });
    const model = vi.fn(async (input: CuratorInput) => input.assistant.id === first.assistant.id ? first.data.extraction : second.data.extraction);
    expect(await curate("alice", { store, model, clock: () => clock })).toMatchObject({ completed: 2, failed: 0 });
    expect(model.mock.calls.map(([input]) => input.evidence[0].snippet)).toEqual([first.data.evidence[0].snippet, second.data.evidence[0].snippet]);
    expect(await store.pendingCurations("alice")).toEqual([]);
    expect(await store.threadsFor("alice")).toHaveLength(1);
  });

  it.each([
    ["2026-11-14T00:00:00Z", true],
    [null, false],
    ["2026-11-08T00:00:00Z", false],
    ["2026-11-20T00:00:00Z", false],
  ])("supersedes only confirmed changes with a newer nonfuture date (%s)", async (published, replaces) => {
    const first = await seed();
    await run(first.data.extraction);
    const fresh = fixture("$23/seat/mo", published ?? "", clock.iso);
    fresh.evidence.forEach((source) => { source.published_date = published; });
    const second = await seed({ ts: clock.instant, data: fresh });
    await run(fresh.extraction);
    const old = await store.claimsForTurns("alice", [first.assistant.id]);
    const current = await store.claimsForTurns("alice", [second.assistant.id]);
    expect(current).toHaveLength(replaces ? 5 : 0);
    expect(old.every((claim) => replaces ? current.some((next) => next.id === claim.supersededBy) : claim.supersededBy === null)).toBe(true);
    expect(old[0].value).toBe("$20/seat/mo");
  });

  it("merges equivalent values, memory corrections and case-insensitive thread titles", async () => {
    const first = await seed();
    await run(first.data.extraction);
    const fresh = fixture("$20 per user per month", "2026-11-14T00:00:00Z", clock.iso);
    fresh.extraction.memory = [{ key: "team_size", value: "30-person sales team", quote: "We now have a 30-person sales team." }];
    fresh.extraction.threads = [{ title: "crm   SHORTLIST", summary: "Rechecked the five shortlisted CRMs." }];
    const second = await seed({ ts: clock.instant, data: fresh, question: "We now have a 30-person sales team." });
    await run(fresh.extraction);
    expect(await store.claimsForTurns("alice", [first.assistant.id, second.assistant.id])).toHaveLength(5);
    expect(await store.memoryFor("alice")).toMatchObject([{ key: "team_size", value: "30-person sales team", sourceTurnId: second.user.id }]);
    expect(await store.threadsFor("alice")).toMatchObject([{ title: "CRM shortlist", summary: "Rechecked the five shortlisted CRMs." }]);
  });

  it("keeps late retries from overwriting newer memory, threads or claims", async () => {
    const old = await seed();
    const newer = fixture("$23/seat/mo", "2026-11-14T00:00:00Z", clock.iso);
    newer.extraction.memory = [{ key: "team_size", value: "30-person sales team", quote: "A 30-person sales team." }];
    newer.extraction.threads[0].summary = "Newer summary";
    const fresh = await seed({ ts: clock.instant, data: newer, question: "A 30-person sales team." });
    await store.applyCuration("alice", fresh.assistant.id, newer.extraction, clock.instant);
    await run(old.data.extraction);
    expect((await store.memoryFor("alice"))[0].value).toBe("30-person sales team");
    expect((await store.threadsFor("alice"))[0].summary).toBe("Newer summary");
    expect(await store.claimsForTurns("alice", [old.assistant.id])).toEqual([]);
  });

  it("scopes pending work and every write to the conversation owner", async () => {
    const alice = await seed();
    const bob = await seed({ userId: "bob" });
    expect((await store.pendingCurations("alice")).map((job) => job.assistant.id)).toEqual([alice.assistant.id]);
    expect(await store.applyCuration("bob", alice.assistant.id, alice.data.extraction, clock.instant)).toBe(false);
    await run(alice.data.extraction);
    expect(await store.memoryFor("bob")).toEqual([]);
    expect(await store.claimsForTurns("bob", [bob.assistant.id])).toEqual([]);
    await expect(store.saveTurn({ userId: "bob", sessionId: "one", role: "assistant", content: "Forged", ts: at,
      curation: { userTurnId: alice.user.id, evidence: [] } })).rejects.toThrow(/owned/);
    await expect(store.pendingCurations("")).rejects.toThrow(/userId/);
    await expect(store.applyCuration("", alice.assistant.id, {}, at)).rejects.toThrow(/userId/);
  });

  it("extracts memory from an answer without search but rejects searchless claims", async () => {
    const { data } = await seed({ evidence: false });
    expect((await run(data.extraction)).failed).toBe(1);
    expect((await run({ ...data.extraction, claims: [] })).completed).toBe(1);
    expect(await store.memoryFor("alice")).toHaveLength(1);
  });

  it("rolls back the entire merge if a database write fails and retries safely", async () => {
    const { assistant, data } = await seed();
    await store.db.execute(sql`ALTER TABLE threads ADD CONSTRAINT test_reject_thread CHECK (title <> 'CRM shortlist')`);
    try {
      expect((await run(data.extraction)).failed).toBe(1);
      expect(await store.claimsForTurns("alice", [assistant.id])).toEqual([]);
      expect(await store.memoryFor("alice")).toEqual([]);
      expect(await store.pendingCurations("alice")).toHaveLength(1);
    } finally { await store.db.execute(sql`ALTER TABLE threads DROP CONSTRAINT test_reject_thread`); }
    expect((await run(data.extraction)).completed).toBe(1);
    expect((await store.db.select().from(curations))[0].completed).toEqual(clock.instant);
    expect(await store.db.select().from(claims)).toHaveLength(5);
  });

  it("keeps persistent failures from starving the current answer", async () => {
    await seed();
    await seed();
    const current = await seed({ ts: clock.instant, data: fixture("$23/seat/mo", "2026-11-14T00:00:00Z", clock.iso) });
    const model = vi.fn(async (input: CuratorInput) => input.assistant.id === current.assistant.id ? current.data.extraction : { invalid: true });
    expect(await curate("alice", { store, model, turnId: current.assistant.id, clock: () => clock })).toMatchObject({ completed: 1, failed: 1 });
    expect(await store.claimsForTurns("alice", [current.assistant.id])).toHaveLength(5);
    expect(await store.pendingCurations("alice")).toHaveLength(2);
  });
});
