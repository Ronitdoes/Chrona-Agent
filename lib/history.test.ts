import { describe, expect, it } from "vitest";
import { dateFrom } from "./clock";
import { decodeCursor, encodeCursor, groupHistory } from "./history";
import { turn } from "../test/agent-fixtures";

describe("history grouping and cursors", () => {
  it("groups sessions and local calendar days with stable chronological turn order", () => {
    const rows = [
      turn(2, { role: "assistant", content: "Second", ts: dateFrom("2026-11-15T06:00:00Z") }),
      turn(1, { content: " First\n question ", ts: dateFrom("2026-11-15T01:00:00Z") }),
      turn(3, { sessionId: "two", content: "New session", ts: dateFrom("2026-11-15T07:00:00Z") }),
    ];
    const result = groupHistory(rows, "America/New_York");
    expect(result.map((session) => session.id)).toEqual(["two", "one"]);
    expect(result[1].title).toBe("First question");
    expect(result[1].days.map((day) => day.date)).toEqual(["2026-11-14", "2026-11-15"]);
    expect(result[1].days[0].turns[0]).not.toHaveProperty("userId");
    expect(result[1].days[0].turns[0]).not.toHaveProperty("tsv");
    expect(groupHistory(rows, "Asia/Kolkata")[1].days).toHaveLength(1);
    expect(rows[0].id).toBe(2);
  });
  it("round-trips timestamp/ID cursors and rejects malformed values", () => {
    const row = turn(5);
    expect(decodeCursor(encodeCursor(row))).toEqual({ ts: row.ts, id: row.id });
    for (const raw of ["***", "x".repeat(513), Buffer.from('{"ts":"bad","id":1}').toString("base64url")]) {
      expect(() => decodeCursor(raw)).toThrow("Invalid history cursor");
    }
  });
});
