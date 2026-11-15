import { describe, expect, it } from "vitest";
import { dateFrom } from "../clock";
import { resolveDates } from "./temporal";

const NOW = dateFrom("2026-11-15T12:00:00.000Z");

function expected(
  startUtc: string,
  endUtc: string,
  label: string,
) {
  return {
    startUtc: dateFrom(startUtc),
    endUtc: dateFrom(endUtc),
    label,
  };
}

const cases = [
  {
    text: "Monday",
    utc: expected(
      "2026-11-09T00:00:00.000Z",
      "2026-11-10T00:00:00.000Z",
      "Monday 9 Nov 2026",
    ),
    kolkata: expected(
      "2026-11-08T18:30:00.000Z",
      "2026-11-09T18:30:00.000Z",
      "Monday 9 Nov 2026",
    ),
    newYork: expected(
      "2026-11-09T05:00:00.000Z",
      "2026-11-10T05:00:00.000Z",
      "Monday 9 Nov 2026",
    ),
  },
  {
    text: "last Tuesday",
    utc: expected(
      "2026-11-10T00:00:00.000Z",
      "2026-11-11T00:00:00.000Z",
      "Tuesday 10 Nov 2026",
    ),
    kolkata: expected(
      "2026-11-09T18:30:00.000Z",
      "2026-11-10T18:30:00.000Z",
      "Tuesday 10 Nov 2026",
    ),
    newYork: expected(
      "2026-11-10T05:00:00.000Z",
      "2026-11-11T05:00:00.000Z",
      "Tuesday 10 Nov 2026",
    ),
  },
  {
    text: "3 November",
    utc: expected(
      "2026-11-03T00:00:00.000Z",
      "2026-11-04T00:00:00.000Z",
      "3 Nov 2026",
    ),
    kolkata: expected(
      "2026-11-02T18:30:00.000Z",
      "2026-11-03T18:30:00.000Z",
      "3 Nov 2026",
    ),
    newYork: expected(
      "2026-11-03T05:00:00.000Z",
      "2026-11-04T05:00:00.000Z",
      "3 Nov 2026",
    ),
  },
  {
    text: "yesterday",
    utc: expected(
      "2026-11-14T00:00:00.000Z",
      "2026-11-15T00:00:00.000Z",
      "Yesterday 14 Nov 2026",
    ),
    kolkata: expected(
      "2026-11-13T18:30:00.000Z",
      "2026-11-14T18:30:00.000Z",
      "Yesterday 14 Nov 2026",
    ),
    newYork: expected(
      "2026-11-14T05:00:00.000Z",
      "2026-11-15T05:00:00.000Z",
      "Yesterday 14 Nov 2026",
    ),
  },
  {
    text: "last week",
    utc: expected(
      "2026-11-02T00:00:00.000Z",
      "2026-11-09T00:00:00.000Z",
      "2–8 Nov 2026",
    ),
    kolkata: expected(
      "2026-11-01T18:30:00.000Z",
      "2026-11-08T18:30:00.000Z",
      "2–8 Nov 2026",
    ),
    newYork: expected(
      "2026-11-02T05:00:00.000Z",
      "2026-11-09T05:00:00.000Z",
      "2–8 Nov 2026",
    ),
  },
  {
    text: "on the 3rd",
    utc: expected(
      "2026-11-03T00:00:00.000Z",
      "2026-11-04T00:00:00.000Z",
      "3 Nov 2026",
    ),
    kolkata: expected(
      "2026-11-02T18:30:00.000Z",
      "2026-11-03T18:30:00.000Z",
      "3 Nov 2026",
    ),
    newYork: expected(
      "2026-11-03T05:00:00.000Z",
      "2026-11-04T05:00:00.000Z",
      "3 Nov 2026",
    ),
  },
] as const;

describe("resolveDates", () => {
  it.each(cases)(
    "resolves $text in UTC",
    ({ text, utc }) => {
      expect(resolveDates(text, NOW, "UTC")).toEqual([utc]);
    },
  );

  it.each(cases)(
    "resolves $text in Asia/Kolkata",
    ({ text, kolkata }) => {
      expect(resolveDates(text, NOW, "Asia/Kolkata")).toEqual([kolkata]);
    },
  );

  it.each(cases)(
    "resolves $text in America/New_York",
    ({ text, newYork }) => {
      expect(resolveDates(text, NOW, "America/New_York")).toEqual([newYork]);
    },
  );

  it("keeps last Tuesday strictly before a Tuesday reference", () => {
    const tuesday = dateFrom("2026-11-10T12:00:00.000Z");

    expect(resolveDates("last Tuesday", tuesday, "UTC")).toEqual([
      expected(
        "2026-11-03T00:00:00.000Z",
        "2026-11-04T00:00:00.000Z",
        "Tuesday 3 Nov 2026",
      ),
    ]);
  });

  it("resolves multiple expressions in one sentence", () => {
    expect(resolveDates("Monday and 3 November", NOW, "UTC")).toEqual([
      expected(
        "2026-11-09T00:00:00.000Z",
        "2026-11-10T00:00:00.000Z",
        "Monday 9 Nov 2026",
      ),
      expected(
        "2026-11-03T00:00:00.000Z",
        "2026-11-04T00:00:00.000Z",
        "3 Nov 2026",
      ),
    ]);
  });

  it("moves a future month/day expression to the previous year", () => {
    const january = dateFrom("2026-01-15T12:00:00.000Z");

    expect(resolveDates("3 November", january, "UTC")[0].startUtc.toISOString()).toBe(
      "2025-11-03T00:00:00.000Z",
    );
  });

  it("returns no ranges when the text has no date expression", () => {
    expect(resolveDates("What is the capital of France?", NOW, "UTC")).toEqual([]);
  });

  it("does not mistake a ranking for a date", () => {
    expect(resolveDates("This vendor ranked 3rd in the review.", NOW, "UTC")).toEqual([]);
  });

  it.each([
    ["2026-03-08T12:00:00Z", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    ["2026-11-01T12:00:00Z", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
  ])("uses local midnight on DST transition days (%s)", (instant, start, end) => {
    const [range] = resolveDates("today", dateFrom(instant), "America/New_York");
    expect(range.startUtc.toISOString()).toBe(start);
    expect(range.endUtc.toISOString()).toBe(end);
  });

  it("uses the user's calendar day near UTC midnight", () => {
    const instant = dateFrom("2026-11-15T01:00:00Z");
    expect(resolveDates("yesterday", instant, "America/New_York")).toEqual([
      expected("2026-11-13T05:00:00.000Z", "2026-11-14T05:00:00.000Z", "Yesterday 13 Nov 2026"),
    ]);
    expect(resolveDates("yesterday", instant, "Asia/Kolkata")).toEqual([cases[3].kolkata]);
  });

  it.each([
    ["2026-11-02T12:00:00Z", "on the 3rd", "2026-10-03T00:00:00.000Z"],
    ["2026-03-01T12:00:00Z", "on the 31st", "2026-01-31T00:00:00.000Z"],
    ["2026-05-01T12:00:00Z", "on the 31st", "2026-03-31T00:00:00.000Z"],
    ["2026-01-01T12:00:00Z", "on the 3rd", "2025-12-03T00:00:00.000Z"],
  ])("finds the most recent valid ordinal date from %s", (instant, text, start) => {
    expect(resolveDates(text, dateFrom(instant), "UTC")[0].startUtc.toISOString()).toBe(start);
  });

  it("allows a bare weekday to resolve to today", () => {
    expect(resolveDates("Sunday", NOW, "UTC")[0].startUtc.toISOString()).toBe("2026-11-15T00:00:00.000Z");
  });

  it("deduplicates dates while preserving first-mention order", () => {
    expect(resolveDates("On Monday we compared CRMs. On 3 November we discussed hosting. Monday was helpful.", NOW, "UTC")).toEqual([cases[0].utc, cases[2].utc]);
  });

  it("rejects invalid timezones and reference instants", () => {
    expect(() => resolveDates("Monday", NOW, "Mars/Olympus_Mons")).toThrow(/timezone/i);
    expect(() => resolveDates("Monday", dateFrom(NaN), "UTC")).toThrow(/instant/i);
  });
});
