import { describe, expect, it } from "vitest";
import { dateFrom } from "./clock";
import { calendarContext, normalizeDateLiterals } from "./calendar-context";
import { clock } from "../test/agent-fixtures";

describe("unambiguous calendar context", () => {
  it.each(["15/11/2026", "11/15/2026", "15-11-2026", "2026-11-15"])("normalizes %s without swapping day and month", text => {
    expect(normalizeDateLiterals(text)).toEqual({ normalized: "2026-11-15", ambiguous: [], invalid: [] });
  });
  it("preserves both interpretations of ambiguous numeric dates", () => {
    const result = normalizeDateLiterals("match on 05/06/2026");
    expect(result.ambiguous).toEqual([{ input: "05/06/2026", choices: ["5 June 2026", "6 May 2026"] }]);
    expect(result.normalized).not.toContain("05/06/2026");
  });
  it("does not interpret URL path segments as a user's requested date", () => {
    const text = "Read https://example.com/05/06/2026/report";
    expect(normalizeDateLiterals(text)).toEqual({ normalized: text, ambiguous: [], invalid: [] });
  });
  it("accepts an explicit date order and rejects invalid calendar days", () => {
    expect(normalizeDateLiterals("DD/MM/YYYY: 05/06/2026").normalized).toContain("2026-06-05");
    expect(normalizeDateLiterals("MM/DD/YYYY: 05/06/2026").normalized).toContain("2026-05-06");
    expect(normalizeDateLiterals("31/02/2026").invalid).toEqual(["31/02/2026"]);
    expect(normalizeDateLiterals("2026-02-30").invalid).toEqual(["2026-02-30"]);
    expect(normalizeDateLiterals("02/02/2026").ambiguous).toEqual([]);
  });
  it("uses the user's day across UTC midnight and the International Date Line", () => {
    const instant = dateFrom("2026-11-15T19:00:00Z");
    expect(calendarContext({ ...clock, instant, tz: "Asia/Calcutta" })).toMatchObject({ today: "2026-11-16", todayLabel: "16 November 2026", weekday: "Monday", localTime: "00:30" });
    expect(calendarContext({ ...clock, instant, tz: "America/New_York" }).today).toBe("2026-11-15");
    expect(calendarContext({ ...clock, instant, tz: "Pacific/Auckland" }).today).toBe("2026-11-16");
  });
  it.each(["2029-01-01T00:30:00Z", "2032-02-29T23:30:00Z", "2040-12-31T23:30:00Z"])("derives date-format examples from the injected clock (%s)", iso => {
    const calendar = calendarContext({ ...clock, instant: dateFrom(iso), tz: "Pacific/Auckland" });
    expect(calendar.displayFormat).toContain(calendar.todayLabel);
    expect(calendar.displayFormat).not.toContain("2026");
  });
});
