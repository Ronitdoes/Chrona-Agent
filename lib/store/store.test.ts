import { mkdtemp, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dateFrom, type Clock } from "../clock";
import { createStore, type Store } from "./index";
import { migrate } from "./migrate";
import { claims, memory, threads, turns } from "./schema";

const instant = dateFrom("2026-11-15T12:00:00Z");
const clock = (): Clock => ({
  instant, tz: "Asia/Kolkata", iso: instant.toISOString(), human: "Sunday 15 November 2026",
});

describe("store on PGlite", () => {
  let store: Store;

  beforeAll(async () => {
    store = await createStore({ dataDir: ":memory:", clock });
  }, 30_000);

  beforeEach(async () => {
    await store.db.execute(sql`TRUNCATE claims, memory, threads, turns RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await store?.close();
  });

  async function save(userId: string, content: string, ts = instant, sessionId = "session-1") {
    return store.saveTurn({ userId, sessionId, role: "user", content, ts });
  }

  it("creates the tables on first open and applies its migration only once", async () => {
    expect(store.driver).toBe("pglite");
    const saved = await save("alice", "CRM shortlist");
    await migrate(store.db);
    await migrate(store.db);

    const applied = await store.db.execute<{ version: number }>(sql`SELECT version FROM web_agent_migrations`);
    expect(applied.rows).toEqual([{ version: 1 }, { version: 2 }]);
    expect(await store.turnsInRange("alice", instant, dateFrom("2026-11-16T00:00:00Z"))).toEqual([saved]);
  });

  it("saves the injected timestamp and timezone when omitted", async () => {
    const saved = await store.saveTurn({ userId: "alice", sessionId: "one", role: "assistant", content: "Hello" });
    expect(saved.ts).toEqual(instant);
    expect(saved.tz).toBe("Asia/Kolkata");
    expect(saved.id).toBeTypeOf("number");
  });

  it("returns both roles across sessions with an inclusive start and exclusive end", async () => {
    const start = dateFrom("2026-11-09T00:00:00Z");
    const end = dateFrom("2026-11-10T00:00:00Z");
    await save("alice", "Before", dateFrom("2026-11-08T23:59:59Z"));
    const question = await save("alice", "Which CRM?", start);
    const answer = await store.saveTurn({ userId: "alice", sessionId: "session-2", role: "assistant", content: "These five", ts: start });
    await save("alice", "Outside", end);
    await save("bob", "Private", start);
    expect(await store.turnsInRange("alice", start, end)).toEqual([question, answer]);
  });

  it("generates a tsvector and a GIN index, and updates search when content changes", async () => {
    const turn = await save("alice", "Comparing database hosting providers");
    expect(turn.tsv).toContain("'databas'");
    const indexes = await store.db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'turns' AND indexname = 'turns_tsv'
    `);
    expect(indexes.rows[0].indexdef).toContain("USING gin (tsv)");
    expect((await store.searchTurns("alice", "databases", instant)).map((row) => row.id)).toEqual([turn.id]);

    await store.db.update(turns).set({ content: "CRM pricing shortlist" }).where(eq(turns.id, turn.id));
    expect(await store.searchTurns("alice", "databases", instant)).toEqual([]);
    expect((await store.searchTurns("alice", "pricing", instant))[0].id).toBe(turn.id);
  });

  it("uses web-search syntax, ranks equally relevant newer turns first, and isolates users", async () => {
    const old = await save("alice", "CRM pricing plans", dateFrom("2025-11-15T12:00:00Z"));
    const recent = await save("alice", "CRM pricing plans");
    await save("bob", "CRM pricing plans");
    await save("alice", "Database pricing plans");

    expect((await store.searchTurns("alice", '"CRM pricing" -database', instant)).map((row) => row.id))
      .toEqual([recent.id, old.id]);
    expect(await store.searchTurns("alice", "doesnotexist", instant)).toEqual([]);
    expect(await store.searchTurns("alice", "  ", instant)).toEqual([]);
    expect(await store.searchTurns("alice", "' ; DROP TABLE turns; --", instant)).toEqual([]);
    expect((await store.searchTurns("alice", "CRM", instant, 1)).map((row) => row.id)).toEqual([recent.id]);
  });

  it("scopes claims to both their owner and the owner of the linked turn", async () => {
    const alice = await save("alice", "CRM pricing");
    const bob = await save("bob", "Private pricing");
    const input = { subject: "CRM", attribute: "price", value: "$20", asOf: instant };
    const [claim] = await store.db.insert(claims).values([
      { ...input, userId: "alice", turnId: alice.id, sourceUrls: ["https://example.com/pricing"] },
      { ...input, userId: "bob", turnId: bob.id },
      { ...input, userId: "alice", turnId: bob.id },
      { ...input, userId: "bob", turnId: alice.id },
    ]).returning();

    expect(await store.claimsForTurns("alice", [alice.id, bob.id])).toEqual([claim]);
    expect(claim.sourceUrls).toEqual(["https://example.com/pricing"]);
    expect(claim.volatility).toBe("medium");
    expect(await store.claimsForTurns("alice", [])).toEqual([]);
    expect(await store.claimsForTurns("charlie", [alice.id, bob.id])).toEqual([]);
  });

  it("reads memory and recent threads only for the requested user", async () => {
    await store.db.insert(memory).values([
      { userId: "alice", key: "team", value: "20 people", updatedAt: instant },
      { userId: "bob", key: "team", value: "secret", updatedAt: instant },
    ]);
    await store.db.insert(threads).values([
      { userId: "alice", title: "Old", summary: "Old summary", lastTs: dateFrom("2026-11-01T12:00:00Z") },
      { userId: "alice", title: "Recent", summary: "New summary", lastTs: instant },
      { userId: "bob", title: "Private", summary: "Secret", lastTs: instant },
    ]);

    expect((await store.memoryFor("alice")).map((item) => item.value)).toEqual(["20 people"]);
    expect((await store.threadsFor("alice")).map((item) => item.title)).toEqual(["Recent", "Old"]);
    expect((await store.threadsFor("alice", 1)).map((item) => item.title)).toEqual(["Recent"]);
    expect(await store.memoryFor("charlie")).toEqual([]);
    expect(await store.threadsFor("charlie")).toEqual([]);
  });

  it("enforces primary keys, claim references and valid role values", async () => {
    await store.db.insert(memory).values({ userId: "alice", key: "team", value: "20", updatedAt: instant });
    await expect(store.db.insert(memory).values({ userId: "alice", key: "team", value: "30", updatedAt: instant })).rejects.toThrow();
    await expect(store.db.insert(claims).values({ userId: "alice", turnId: 999, subject: "CRM", attribute: "price", value: "$20", asOf: instant })).rejects.toThrow();
    await expect(store.db.execute(sql`INSERT INTO turns (user_id, session_id, role, content, ts) VALUES ('alice', 'one', 'system', 'bad role', ${instant.toISOString()}::timestamptz)`)).rejects.toThrow();
    await store.db.update(memory).set({ value: "30" }).where(and(eq(memory.userId, "alice"), eq(memory.key, "team")));
    expect((await store.memoryFor("alice"))[0].value).toBe("30");
  });

  it("rejects missing user scopes, invalid ranges and unbounded result limits", async () => {
    await expect(store.memoryFor(" ")).rejects.toThrow(/userId/);
    await expect(store.claimsForTurns("", [])).rejects.toThrow(/userId/);
    await expect(store.searchTurns("", "CRM", instant)).rejects.toThrow(/userId/);
    await expect(store.threadsFor("", 1)).rejects.toThrow(/userId/);
    await expect(store.saveTurn({ userId: "", sessionId: "one", role: "user", content: "bad" })).rejects.toThrow(/userId/);
    await expect(store.turnsInRange("alice", instant, instant)).rejects.toThrow(/range/i);
    await expect(store.turnsInRange("alice", instant, dateFrom("2026-11-16T00:00:00Z"), 201)).rejects.toThrow(/limit/);
    await expect(store.searchTurns("alice", "CRM", instant, 0)).rejects.toThrow(/limit/);
  });
});

it("persists the fallback database across close and reopen", async () => {
  const dataRoot = resolve("data");
  // mkdtemp requires its parent; ordinary startup creates data/pglite itself.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dataRoot, { recursive: true });
  const dataDir = await mkdtemp(`${dataRoot}${sep}store-test-`);
  let store: Store | undefined;
  try {
    store = await createStore({ databaseUrl: " ", dataDir, clock });
    const saved = await store.saveTurn({ userId: "alice", sessionId: "one", role: "user", content: "Persistent CRM shortlist" });
    const assistant = await store.saveTurn({ userId: "alice", sessionId: "one", role: "assistant", content: "Pending extraction", curation: {
      userTurnId: saved.id, evidence: [{ title: "Pricing", url: "https://example.com/pricing", snippet: "$20/mo", published_date: null, is_official: false }],
    } });
    await store.close();
    store = undefined;
    store = await createStore({ dataDir, clock });
    expect((await store.searchTurns("alice", "shortlist", instant))[0].id).toBe(saved.id);
    expect((await store.pendingCurations("alice"))[0]).toMatchObject({ assistant: { id: assistant.id }, evidence: [{ snippet: "$20/mo" }] });
  } finally {
    await store?.close();
    if (!dataDir.startsWith(`${dataRoot}${sep}store-test-`)) throw new Error("Unsafe test cleanup path");
    await rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);
