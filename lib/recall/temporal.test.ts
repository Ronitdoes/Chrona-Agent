import { describe, expect, it } from "vitest";
import { resolveDates } from "./temporal";

const NOW = new Date("2026-11-15T12:00:00.000Z");

function expected(
  startUtc: string,
  endUtc: string,
  label: string,
) {
  return {
    startUtc: new Date(startUtc),
    endUtc: new Date(endUtc),
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
    const tuesday = new Date("2026-11-10T12:00:00.000Z");

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
    const january = new Date("2026-01-15T12:00:00.000Z");

    expect(resolveDates("3 November", january, "UTC")[0].startUtc.toISOString()).toBe(
      "2025-11-03T00:00:00.000Z",
    );
  });

  it("returns no ranges when the text has no date expression", () => {
    expect(resolveDates("What is the capital of France?", NOW, "UTC")).toEqual([]);
  });
});