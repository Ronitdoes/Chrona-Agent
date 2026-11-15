import { describe, expect, it } from "vitest";
import { greeting, historyGroups, mergeHistory, sessionMessages, starters } from "./workspace";
import type { HistorySession } from "./history";

const session = (id: string, lastTs: string): HistorySession => ({ id, title: id, lastTs, days: [] });
describe("workspace dates and history", () => {
  it("groups calendar days in the user's timezone across DST changes", () => {
    const sessions = [session("today", "2026-11-02T05:00:00Z"), session("yesterday", "2026-11-01T06:00:00Z"), session("week", "2026-10-27T16:00:00Z"), session("old", "2026-10-25T12:00:00Z")];
    expect(historyGroups(sessions, "2026-11-02T15:00:00Z", "America/New_York").map(group => [group.label, group.sessions[0].id])).toEqual([
      ["Today", "today"], ["Yesterday", "yesterday"], ["Previous 7 days", "week"], ["Older", "old"],
    ]);
  });
  it("uses local midnight and the injected clock for grouping and greetings", () => {
    expect(historyGroups([session("a", "2026-11-14T19:00:00Z")], "2026-11-15T01:00:00Z", "Asia/Kolkata")[0].label).toBe("Today");
    expect(greeting("2026-11-15T02:00:00Z", "Asia/Kolkata")).toBe("Good morning");
    expect(greeting("2026-11-15T08:00:00Z", "Asia/Kolkata")).toBe("Good afternoon");
    expect(greeting("2026-11-15T15:00:00Z", "Asia/Kolkata")).toBe("Good evening");
  });
  it("merges overlapping pages without duplicating or losing messages", () => {
    const first: HistorySession = { ...session("a", "2026-11-15T02:00:00Z"), days: [{ date: "2026-11-15", turns: [{ id: 2, role: "assistant", content: "Answer", ts: "2026-11-15T02:00:00Z", tz: "UTC" }] }] };
    const older: HistorySession = { ...first, days: [{ date: "2026-11-15", turns: [{ id: 1, role: "user", content: "Original question", ts: "2026-11-15T01:00:00Z", tz: "UTC" }, ...first.days[0].turns] }] };
    const merged = mergeHistory([first], [older]);
    expect(merged[0].title).toBe("Original question");
    expect(sessionMessages(merged[0]).map(turn => turn.content)).toEqual(["Original question", "Answer"]);
    expect(mergeHistory(merged, [older])).toEqual(merged);
    expect(sessionMessages()).toEqual([]);
    expect(starters).toHaveLength(3);
  });
});
