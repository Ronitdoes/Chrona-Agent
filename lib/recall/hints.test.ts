import { describe, expect, it } from "vitest";
import { dateFrom, type Clock } from "../clock";
import { hints } from "./hints";

const clock: Clock = {
  instant: dateFrom("2026-11-15T12:00:00Z"), tz: "Asia/Kolkata",
  iso: "2026-11-15T12:00:00.000Z", human: "Sunday 15 November 2026",
};

describe("revalidation query hints", () => {
  it("builds one focused query per subject, merging its attributes", () => {
    expect(hints([
      { subject: "HubSpot Sales Hub", attribute: "price" },
      { subject: "HubSpot Sales Hub", attribute: "monthly cost" },
      { subject: "PostgreSQL", attribute: "version" },
      { subject: "HubSpot Sales Hub", attribute: "release" },
    ], clock)).toEqual([
      "HubSpot Sales Hub pricing release notes 2026",
      "PostgreSQL latest version release notes 2026",
    ]);
  });

  it("deduplicates subjects case-insensitively and normalizes whitespace", () => {
    expect(hints([
      { subject: "  HubSpot   Sales Hub ", attribute: "PRICE" },
      { subject: "hubspot sales hub", attribute: "pricing" },
    ], clock)).toEqual(["HubSpot Sales Hub pricing 2026"]);
  });

  it("retains unknown feature attributes and supplies a fallback for missing attributes", () => {
    expect(hints([
      { subject: "CRM", attribute: "sso_enabled" },
      { subject: "Other", attribute: " " },
      { subject: " ", attribute: "price" },
    ], clock)).toEqual(["CRM sso enabled 2026", "Other official updates 2026"]);
  });

  it("uses the injected user's local year near New Year", () => {
    const instant = dateFrom("2027-01-01T00:30:00Z");
    const claims = [{ subject: "CRM", attribute: "price" }];
    expect(hints(claims, { ...clock, instant, tz: "America/New_York" })).toEqual(["CRM pricing 2026"]);
    expect(hints(claims, { ...clock, instant })).toEqual(["CRM pricing 2027"]);
  });

  it("does not mutate claims, drops no subjects to fit a tool batch, and bounds each query", () => {
    const claims = Array.from({ length: 7 }, (_, i) => Object.freeze({ subject: `Vendor ${i} ${"x".repeat(600)}`, attribute: "price" }));
    Object.freeze(claims);
    const result = hints(claims, clock);
    expect(result).toHaveLength(7);
    expect(result.every((query) => query.length <= 500 && query.endsWith("pricing 2026"))).toBe(true);
    expect(result).toEqual(hints(claims, clock));
  });

  it("returns no hints without claims", () => {
    expect(hints([], clock)).toEqual([]);
  });
});
