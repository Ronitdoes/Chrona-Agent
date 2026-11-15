import { createTestStore } from "../../test/database";
import { afterEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Store } from "./index";
import { clock } from "../../test/agent-fixtures";
import { dateFrom } from "../clock";

const shared = globalThis as typeof globalThis & { webAgentStore?: Promise<Store> };
afterEach(() => { delete shared.webAgentStore; vi.resetModules(); });

it("refreshes an old globally cached store and migrates its existing connection after hot reload", async () => {
  const original = await createTestStore({ clock: () => clock });
  try {
    const source = await original.saveTurn({ userId: "alice", sessionId: "one", role: "user", content: "Check Neon pricing", ts: clock.instant });
    // Reproduce a server started before the recall queries and migrations existed.
    await original.db.execute(sql`DROP TABLE recall_references`);
    await original.db.execute(sql`DELETE FROM web_agent_migrations WHERE version >= 3`);
    const staleHistory = vi.fn(async () => { throw new Error("stale query implementation"); });
    const close = vi.fn(original.close);
    shared.webAgentStore = Promise.resolve({ ...original, close, historyFor: staleHistory,
      previousRecall: undefined, searchUserHistory: undefined, historySources: undefined, historyContext: undefined,
    } as unknown as Store);
    vi.resetModules();
    const { getStore } = await import("./index");
    const first = getStore();
    expect(getStore()).toBe(first);
    const ready = await first;
    expect(ready.db).toBe(original.db);
    expect(close).not.toHaveBeenCalled();
    const boundary = { ts: dateFrom(clock.instant.getTime() + 1), id: source.id + 1 };
    expect(await ready.previousRecall("alice", "one", boundary)).toBeNull();
    expect((await ready.historySources("alice", [source.id], boundary)).map(turn => turn.content)).toEqual([source.content]);
    expect((await ready.historyFor("alice", { sessionId: "one" })).map(turn => turn.content)).toEqual([source.content]);
    expect(staleHistory).not.toHaveBeenCalled();
    const versions = await original.db.execute<{ version: number }>(sql`SELECT version FROM web_agent_migrations ORDER BY version`);
    expect(versions.rows.map(row => row.version)).toEqual([1, 2, 3, 4]);
  } finally { await original.close(); }
});
