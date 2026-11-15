import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createTestStore } from "../../test/database";
import type { Store } from "./index";
import { importSnapshot, type DatabaseSnapshot } from "./transfer";

// Explicit wire fixtures: all values use PostgreSQL text, including JSON and IDs.
function snapshot(version = 4): DatabaseSnapshot {
  const columns = (definition: string) => definition.split(" ").map(pair => {
    const [name, type] = pair.split(":"); return { name, type };
  });
  const data: DatabaseSnapshot = {
    format: 1, versions: Array.from({ length: version }, (_, i) => i + 1),
    tables: {
      turns: { columns: columns("id:int8 user_id:text session_id:text role:text content:text ts:timestamptz tz:text"), rows: [
        ["9007199254740993", "alice", "one", "user", "CRM café — 你好", "2026-11-15 12:00:00.123456+00", null],
        ["9007199254740994", "alice", "one", "assistant", "Saved answer", "2026-11-15 12:00:01.654321+00", "Asia/Kolkata"],
      ] },
      claims: { columns: columns("id:int8 turn_id:int8 user_id:text subject:text attribute:text value:text as_of:timestamptz source_urls:jsonb volatility:text superseded_by:int8"), rows: [
        ["10", "9007199254740994", "alice", "CRM", "price", "$20", "2026-11-15 12:00:00.123456+00", '["https://example.com/é"]', "high", "11"],
        ["11", null, "alice", "CRM", "price", "$30", "2026-11-15 12:00:01+00", "[]", "medium", "11"],
      ] },
      memory: { columns: columns("user_id:text key:text value:text updated_at:timestamptz source_turn_id:int8"), rows: [
        ["alice", "team", "20", "2026-11-15 12:00:00+00", "9007199254740993"],
      ] },
      threads: { columns: columns("id:int8 user_id:text title:text summary:text last_ts:timestamptz source_turn_id:int8"), rows: [
        ["4", "alice", "CRM", "Comparison", "2026-11-15 12:00:01+00", null],
      ] },
      curations: { columns: columns("turn_id:int8 user_turn_id:int8 user_id:text evidence:jsonb completed:timestamptz"), rows: [
        ["9007199254740994", "9007199254740993", "alice", '[{"url": "https://example.com", "snippet": "café"}]', null],
      ] },
      recall_references: { columns: columns("answer_turn_id:int8 request_turn_id:int8 user_id:text source_turn_ids:jsonb history_only:bool"), rows: [
        ["9007199254740994", "9007199254740993", "alice", "[9007199254740993]", "true"],
      ] },
    },
    sequences: { turns: { lastValue: "9007199254741000", isCalled: true }, claims: { lastValue: "1", isCalled: false }, threads: { lastValue: "8", isCalled: false } },
  };
  if (version < 4) {
    data.tables.recall_references!.columns.pop(); data.tables.recall_references!.rows.forEach(row => row.pop());
  }
  if (version < 3) delete data.tables.recall_references;
  if (version < 2) {
    delete data.tables.curations;
    data.tables.threads!.columns.pop(); data.tables.threads!.rows.forEach(row => row.pop());
  }
  return data;
}

describe("transactional database transfer", () => {
  let store: Store | undefined;
  afterEach(async () => { await store?.close(); store = undefined; });

  it("preserves exact timestamps, bigint IDs, JSON, nulls, Unicode, links and sequence gaps", async () => {
    store = await createTestStore();
    const counts = await importSnapshot(store.db, snapshot());
    expect(counts).toEqual({ turns: 2, claims: 2, memory: 1, threads: 1, curations: 1, recall_references: 1 });
    const rows = await store.db.execute<{ id: string; ts: string; content: string; tz: string | null }>(sql`SELECT id::text, ts::text, content, tz FROM turns ORDER BY id`);
    expect(rows.rows[0]).toEqual({ id: "9007199254740993", ts: "2026-11-15 12:00:00.123456+00", content: "CRM café — 你好", tz: null });
    expect((await store.db.execute(sql`SELECT id::text, superseded_by::text FROM claims ORDER BY id`)).rows).toEqual([{ id: "10", superseded_by: "11" }, { id: "11", superseded_by: "11" }]);
    expect((await store.db.execute(sql`SELECT nextval('turns_id_seq')::text AS id, nextval('claims_id_seq')::text AS claim, nextval('threads_id_seq')::text AS thread`)).rows[0]).toEqual({ id: "9007199254741001", claim: "12", thread: "8" });
    expect((await store.db.execute(sql`SELECT count(*)::int AS count FROM turns WHERE tsv @@ websearch_to_tsquery('english', 'CRM')`)).rows[0]).toEqual({ count: 1 });
  });

  it.each([1, 2, 3])("imports version %i into the current schema with new defaults", async version => {
    store = await createTestStore();
    await importSnapshot(store.db, snapshot(version));
    expect((await store.db.execute(sql`SELECT version FROM web_agent_migrations ORDER BY version`)).rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    if (version === 3) expect((await store.db.execute(sql`SELECT history_only FROM recall_references`)).rows[0]).toEqual({ history_only: true });
  });

  it("imports empty tables without consuming initial sequence values", async () => {
    store = await createTestStore();
    const data = snapshot();
    Object.values(data.tables).forEach(table => { table.rows = []; });
    Object.values(data.sequences).forEach(sequence => { sequence.lastValue = "1"; sequence.isCalled = false; });
    expect(Object.values(await importSnapshot(store.db, data))).toEqual([0, 0, 0, 0, 0, 0]);
    expect((await store.db.execute(sql`SELECT nextval('turns_id_seq')::text AS id`)).rows[0]).toEqual({ id: "1" });
  });

  it("refuses a nonempty target and leaves existing data unchanged", async () => {
    store = await createTestStore();
    await importSnapshot(store.db, snapshot());
    await expect(importSnapshot(store.db, snapshot())).rejects.toThrow("empty application database");
    expect((await store.db.execute(sql`SELECT count(*)::int AS count FROM turns`)).rows[0]).toEqual({ count: 2 });
  });

  it("rolls back all inserted rows when a reference is invalid", async () => {
    store = await createTestStore();
    const data = snapshot();
    data.tables.claims!.rows[0][9] = "999";
    await expect(importSnapshot(store.db, data)).rejects.toThrow();
    expect((await store.db.execute(sql`SELECT count(*)::int AS count FROM turns`)).rows[0]).toEqual({ count: 0 });
    await expect(importSnapshot(store.db, snapshot())).resolves.toMatchObject({ turns: 2 });
  });

  it("rolls back sequence changes as well as rows if a sequence cannot be restored", async () => {
    store = await createTestStore();
    const data = snapshot();
    data.sequences.threads.lastValue = "9223372036854775808";
    await expect(importSnapshot(store.db, data)).rejects.toThrow();
    expect((await store.db.execute(sql`SELECT last_value::text, is_called FROM turns_id_seq`)).rows[0]).toEqual({ last_value: "1", is_called: false });
    expect((await store.db.execute(sql`SELECT count(*)::int AS count FROM turns`)).rows[0]).toEqual({ count: 0 });
  });
});
