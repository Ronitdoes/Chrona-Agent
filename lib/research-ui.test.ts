import { describe, expect, it } from "vitest";
import { asOfDate, displayDate, searchSummary, sourceDetails, verdictFromLabel } from "./research-ui";
import { demoSearches, demoSources } from "./demo-chat";

describe("research UI data", () => {
  it.each([
    ["2026-11-15", "2026-11-15"], ["15 November 2026", "2026-11-15"], ["15 Nov. 2026", "2026-11-15"],
    ["November 15, 2026", "2026-11-15"], ["Nov 15 2026", "2026-11-15"], ["29 Feb 2024", "2024-02-29"],
    ["29 Feb 2026", null], ["2026-02-30", null], ["yesterday", null], ["15 2026", null],
  ])("normalizes explicit as-of date %s", (input, expected) => {
    expect(asOfDate(input)).toBe(expected);
  });
  it("formats publication timestamps in UTC and rejects ambiguous/missing dates", () => {
    expect(displayDate("2026-11-15T23:30:00-08:00")).toBe("16 Nov 2026");
    expect(displayDate("2026-11-15")).toBe("15 Nov 2026");
    expect(displayDate("11/15/2026")).toBeNull();
    expect(displayDate(null)).toBeNull();
  });
  it("recognizes exact verdict labels without inferring that missing evidence means unchanged", () => {
    expect(verdictFromLabel(" CHANGED ")).toBe("changed");
    expect(verdictFromLabel("Unchanged")).toBe("unchanged");
    expect(verdictFromLabel("Couldn't verify")).toBe("unknown");
    expect(verdictFromLabel("Couldn’t verify")).toBe("unknown");
    expect(verdictFromLabel("Could not verify")).toBe("unknown");
    expect(verdictFromLabel("No evidence of change")).toBeNull();
    expect(verdictFromLabel("unchanged pricing")).toBeNull();
  });
  it("derives a source domain and favicon from the actual safe URL", () => {
    expect(sourceDetails({ ...demoSources[0], url: "https://www.example.com/pricing", domain: "misleading.example" })).toEqual({
      url: "https://www.example.com/pricing", domain: "example.com", favicon: "https://www.example.com/favicon.ico",
    });
    for (const url of ["javascript:alert(1)", "data:text/html,hello", "file:///private", "https://user:secret@example.com", "not a URL"]) {
      expect(sourceDetails({ ...demoSources[0], url })).toBeNull();
    }
  });
  it("counts all queries while distinguishing running, stopped and interrupted searches", () => {
    expect(searchSummary(demoSearches, "complete")).toEqual({ phase: "done", count: 5, label: "Searched the web · 5 queries" });
    const running = [{ ...demoSearches[0], state: "running" as const }];
    expect(searchSummary(running, "streaming").phase).toBe("running");
    expect(searchSummary(running, "stopped").phase).toBe("stopped");
    expect(searchSummary(running, "error").phase).toBe("interrupted");
    expect(searchSummary(running, "complete").phase).toBe("interrupted");
    expect(searchSummary([{ ...demoSearches[0], queries: ["pricing"], count: 0 }], "complete").label).toBe("Searched the web · 1 query");
  });
});
