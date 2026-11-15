import { createTestStore } from "../../test/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Store } from "./index";
import { claims, memory, threads } from "./schema";
import { clock } from "../../test/agent-fixtures";
import { dateFrom } from "../clock";

describe("owned conversation deletion with real Postgres", () => {
  let store: Store;
  beforeAll(async () => { store = await createTestStore({ clock: () => clock }); }, 30_000);
  beforeEach(async () => { await store.db.execute(sql`TRUNCATE claims, memory, threads, turns RESTART IDENTITY CASCADE`); });
  afterAll(async () => store?.close());
  async function pair(userId: string, sessionId: string) {
    const user = await store.saveTurn({ userId, sessionId, role: "user", content: "My team has 20 people", ts: dateFrom(clock.instant.getTime() - 1000) });
    const assistant = await store.saveTurn({ userId, sessionId, role: "assistant", content: "Saved answer", curation: { userTurnId: user.id, evidence: [] } });
    return { user, assistant };
  }
  it("removes messages, pending extraction and source-linked notes while preserving other chats/users", async () => {
    const removed = await pair("alice", "delete-me");
    const kept = await pair("alice", "keep-me");
    const foreign = await pair("bob", "delete-me");
    const [newClaim] = await store.db.insert(claims).values({ userId: "alice", turnId: removed.assistant.id, subject: "Fixture", attribute: "price", value: "$25", asOf: clock.instant }).returning();
    await store.db.insert(claims).values({ userId: "alice", turnId: kept.assistant.id, subject: "Fixture", attribute: "price", value: "$20", asOf: clock.instant, supersededBy: newClaim.id });
    await store.db.insert(memory).values([
      { userId: "alice", key: "removed", value: "20", sourceTurnId: removed.user.id, updatedAt: clock.instant },
      { userId: "alice", key: "kept", value: "safe", sourceTurnId: kept.user.id, updatedAt: clock.instant },
      { userId: "bob", key: "foreign", value: "safe", sourceTurnId: foreign.user.id, updatedAt: clock.instant },
    ]);
    await store.db.insert(threads).values([
      { userId: "alice", title: "Removed", summary: "Removed note", sourceTurnId: removed.assistant.id, lastTs: clock.instant },
      { userId: "alice", title: "Kept", summary: "Kept note", sourceTurnId: kept.assistant.id, lastTs: clock.instant },
    ]);
    expect(await store.deleteConversation("alice", "delete-me")).toBe(true);
    expect(await store.historyFor("alice", { sessionId: "delete-me" })).toEqual([]);
    expect(await store.historyFor("alice", { sessionId: "keep-me" })).toHaveLength(2);
    expect(await store.historyFor("bob", { sessionId: "delete-me" })).toHaveLength(2);
    expect((await store.memoryFor("alice")).map(row => row.key)).toEqual(["kept"]);
    expect((await store.memoryFor("bob")).map(row => row.key)).toEqual(["foreign"]);
    expect((await store.threadsFor("alice")).map(row => row.title)).toEqual(["Kept"]);
    expect((await store.claimsForTurns("alice", [kept.assistant.id]))[0].supersededBy).toBeNull();
    expect((await store.pendingCurations("alice", 10)).map(job => job.assistant.id)).toEqual([kept.assistant.id]);
    expect(await store.applyCuration("alice", removed.assistant.id, { claims: [], memory: [], threads: [] }, clock.instant)).toBe(false);
    const listed = await store.userMessagesFor("alice", { before: { ts: dateFrom(clock.instant.getTime() + 1), id: 999 } });
    expect(listed.map(row => row.sessionId)).toEqual(["keep-me"]);
    expect(await store.deleteConversation("alice", "delete-me")).toBe(false);
  });
  it("rolls back the entire deletion if a referential constraint prevents completion", async () => {
    const removed = await pair("alice", "delete-me");
    await store.db.insert(memory).values({ userId: "alice", key: "must-remain", value: "20", sourceTurnId: removed.user.id, updatedAt: clock.instant });
    // Simulate invalid legacy data. Deletion must not erase another user's row
    // to work around its FK, nor leave the owner's conversation half-deleted.
    await store.db.insert(threads).values({ userId: "bob", title: "Foreign legacy reference", summary: "Keep", sourceTurnId: removed.assistant.id, lastTs: clock.instant });
    await expect(store.deleteConversation("alice", "delete-me")).rejects.toThrow();
    expect(await store.historyFor("alice", { sessionId: "delete-me" })).toHaveLength(2);
    expect(await store.memoryFor("alice")).toHaveLength(1);
    expect(await store.pendingCurations("alice")).toHaveLength(1);
    expect(await store.db.select().from(threads).where(eq(threads.userId, "bob"))).toHaveLength(1);
  });
});
