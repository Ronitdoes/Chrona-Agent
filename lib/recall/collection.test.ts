import { describe, expect, it, vi } from "vitest";
import { clock, turn } from "../../test/agent-fixtures";
import { dateFrom } from "../clock";
import { collectionSchema, loadCollection, saveCollection } from "./collection";
import { resolveDates } from "./temporal";

const before = { ts: clock.instant, id: 99 };
const original = turn(1, { ts: dateFrom(clock.instant.getTime() - 1000) });
const collection = saveCollection({ text: "", sourceTurnIds: [1], truncated: false }, { ranges: resolveDates("today", clock.instant, clock.tz) }, before, clock);
const options = { userId: "alice", before, signal: new AbortController().signal };

describe("exact persisted history collections", () => {
  it("rehydrates exact source IDs without running an unrestricted search", async () => {
    const store = { historySources: vi.fn(async () => [original]) };
    const result = await loadCollection(collection, options, store);
    expect(result.history.messages.map(row => row.id)).toEqual([1]);
    expect(store.historySources).toHaveBeenCalledWith("alice", [1], before);
    expect(result.request.ranges[0].startUtc).toEqual(dateFrom(collection.ranges[0].startUtc));
    expect(collection.ranges[0].label).toBe("15 Nov 2026");
    expect(collection.ranges[0].label).not.toMatch(/today|yesterday/i);
  });
  it.each([
    [], [turn(1, { ...original, userId: "bob" })], [turn(1, { ...original, role: "assistant" })],
    [turn(1, { ...original, ts: dateFrom(clock.instant.getTime() + 1) })], [original, original], [turn(2, { ts: original.ts })],
  ].map(rows => ({ rows })))("rejects missing, foreign, duplicate, invented or out-of-bound originals %#", async ({ rows }) => {
    await expect(loadCollection(collection, options, { historySources: async () => rows })).rejects.toThrow();
  });
  it("rejects session-scope changes and future collection boundaries", async () => {
    await expect(loadCollection({ ...collection, sessionId: "another" }, options, { historySources: async () => [original] })).rejects.toThrow();
    await expect(loadCollection({ ...collection, before: { ts: dateFrom(clock.instant.getTime() + 1000).toISOString(), id: 99 } }, options, { historySources: vi.fn() })).rejects.toThrow();
  });
  it("rejects malformed provenance and keeps an empty verified collection empty", async () => {
    expect(collectionSchema.safeParse({ ...collection, sourceTurnIds: [1, 1] }).success).toBe(false);
    expect(collectionSchema.safeParse({ ...collection, timezone: "Mars/Unknown" }).success).toBe(false);
    const result = await loadCollection({ ...collection, sourceTurnIds: [] }, options, { historySources: async () => [] });
    expect(result.history.messages).toEqual([]);
  });
});
