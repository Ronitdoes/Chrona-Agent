import { describe, expect, it, vi } from "vitest";
import { clock, turn, claim, memory, thread } from "../../test/agent-fixtures";
import { capRecall, keywordQuery, retrieve, type RecallStore } from "./retrieve";

function fakeStore(): RecallStore {
  return {
    turnsInRange: vi.fn().mockResolvedValue([]), searchTurns: vi.fn().mockResolvedValue([]),
    claimsForTurns: vi.fn().mockResolvedValue([]), memoryFor: vi.fn().mockResolvedValue([]), threadsFor: vi.fn().mockResolvedValue([]),
  };
}

describe("deterministic recall", () => {
  it("starts date, memory and thread queries concurrently and claims once turn IDs are known", async () => {
    const store = fakeStore();
    let finish!: (value: ReturnType<typeof turn>[]) => void;
    vi.mocked(store.turnsInRange).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(store.claimsForTurns).mockResolvedValue([claim()]);
    vi.mocked(store.memoryFor).mockResolvedValue([memory()]);
    vi.mocked(store.threadsFor).mockResolvedValue([thread()]);
    const pending = retrieve({ userId: "alice", text: "Monday", now: clock }, { store });
    expect(store.memoryFor).toHaveBeenCalledWith("alice");
    expect(store.threadsFor).toHaveBeenCalledWith("alice");
    expect(store.claimsForTurns).not.toHaveBeenCalled();
    finish([turn(1), turn(2, { role: "assistant", sessionId: "another", content: "HubSpot costs $20/seat/mo" })]);
    const found = await pending;
    expect(found.turns).toHaveLength(2);
    expect(found.claims).toHaveLength(1);
    expect(found.memory).toHaveLength(1);
    expect(found.threads).toHaveLength(1);
    expect(found.notFound).toBe(false);
    expect(found.matchedBy).toBe("date");
    expect(store.searchTurns).not.toHaveBeenCalled();
    expect(store.claimsForTurns).toHaveBeenCalledWith("alice", [1, 2]);
  });

  it("runs date ranges in parallel, deduplicates turns and reports which range was missing", async () => {
    const store = fakeStore();
    vi.mocked(store.turnsInRange).mockResolvedValueOnce([turn(1)]).mockResolvedValueOnce([]);
    const found = await retrieve({ userId: "alice", text: "Monday and 3 November", now: clock }, { store });
    expect(store.turnsInRange).toHaveBeenCalledTimes(2);
    expect(found.resolvedRanges).toHaveLength(2);
    expect(found.missingRanges[0].label).toBe("3 Nov 2026");
    expect(found.matchedBy).toBe("date");
    expect(store.searchTurns).not.toHaveBeenCalled();
  });

  it("falls back to keywords when a requested date has no hits without claiming a match on that day", async () => {
    const store = fakeStore();
    vi.mocked(store.searchTurns).mockResolvedValue([turn(1)]);
    const found = await retrieve({ userId: "alice", text: "What did I ask on 3 November about CRM pricing?", now: clock }, { store });
    expect(store.searchTurns).toHaveBeenCalledWith("alice", '"CRM" OR "pricing"', clock.instant);
    expect(found.matchedBy).toBe("keyword");
    expect(found.missingRanges[0].label).toBe("3 Nov 2026");
    expect(found.notFound).toBe(false);
  });

  it("uses the keyword path without dates and sets notFound on no hits", async () => {
    const store = fakeStore();
    const found = await retrieve({ userId: "alice", text: "CRM hosting", now: clock }, { store });
    expect(store.turnsInRange).not.toHaveBeenCalled();
    expect(store.searchTurns).toHaveBeenCalledWith("alice", '"CRM" OR "hosting"', clock.instant);
    expect(found.notFound).toBe(true);
    expect(found.matchedBy).toBe("none");
    expect(store.claimsForTurns).not.toHaveBeenCalled();
  });

  it("does not query all history when only recall boilerplate or a date remains", async () => {
    const store = fakeStore();
    const found = await retrieve({ userId: "alice", text: "What did I ask on 3 November?", now: clock }, { store });
    expect(found.notFound).toBe(true);
    expect(store.searchTurns).not.toHaveBeenCalled();
    expect(keywordQuery('CRM; "hosting" --')).toBe('"CRM" OR "hosting"');
  });

  it("keeps fetched user/assistant pairs together and never includes a claim without its transcript", () => {
    const result = capRecall({
      turns: [turn(1), turn(2, { role: "assistant", content: "x".repeat(1000) })],
      claims: [claim()], memory: [memory()], threads: [],
    }, 512);
    expect(result.turns).toEqual([]);
    expect(result.claims).toEqual([]);
    expect(result.memory).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("preserves keyword ranking for selection before chronological prompt ordering", () => {
    const mostRelevant = turn(2, { sessionId: "two", content: "x".repeat(180) });
    const other = turn(1, { content: "y".repeat(180) });
    const result = capRecall({ turns: [mostRelevant, other], claims: [], memory: [], threads: [] }, 512);
    expect(result.turns.map((item) => item.id)).toEqual([2]);
    expect(result.truncated).toBe(true);
  });

  it("keeps budget omission distinct from a genuine history miss and filters foreign rows", async () => {
    const store = fakeStore();
    vi.mocked(store.turnsInRange).mockResolvedValue([turn(1, { content: "x".repeat(2000) })]);
    vi.mocked(store.memoryFor).mockResolvedValue([memory({ userId: "bob" })]);
    vi.mocked(store.threadsFor).mockResolvedValue([thread({ userId: "bob" })]);
    const found = await retrieve({ userId: "alice", text: "Monday", now: clock, maxBytes: 512 }, { store });
    expect(found.notFound).toBe(false);
    expect(found.truncated).toBe(true);
    expect(found.turns).toEqual([]);
    expect(found.memory).toEqual([]);
    expect(found.threads).toEqual([]);
  });
});
