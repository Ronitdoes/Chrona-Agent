import { describe, expect, it } from "vitest";
import { deepSourceLimit, effortProfiles, effortSchema, limitResearchSources, researchBudgetAfterRecall } from "./research-effort";

const source = (id: string) => ({ title: id, url: `https://example.com/${id}`, snippet: id, published_date: null, is_official: false });

describe("research effort", () => {
  it("bounds query and source budgets at 2, 5, 10 and 20", () => {
    expect(Object.values(effortProfiles).map(profile => [profile.maxQueries, profile.maxSources])).toEqual([[2, 2], [5, 5], [10, 10], [20, 20]]);
    expect(effortSchema.safeParse("unlimited").success).toBe(false);
    for (const profile of Object.values(effortProfiles)) expect(profile.finalReserveMs).toBeLessThan(profile.maxWallMs);
  });
  it("reserves source capacity and shares one Deep deadline with preparation", () => {
    expect([1, 2, 3, 4, 5].map(round => deepSourceLimit(round, 10, 5))).toEqual([8, 11, 14, 17, 20]);
    expect(deepSourceLimit(2, 0, 5)).toBe(20);
    expect(researchBudgetAfterRecall("deep", 45_000, "detailed")).toEqual({ maxWallMs: 240_000, finalReserveMs: 105_000 });
    expect(researchBudgetAfterRecall("deep", 180_000)).toBeNull();
  });
  it("shares the source budget across queries without mutating provider evidence", () => {
    const input = [{ query: "one", results: [source("a"), source("b")] }, { query: "two", results: [source("c"), source("d")] }];
    const limited = limitResearchSources(input, new Set(), 2);
    expect(limited.queries.map(query => query.results.map(result => result.title))).toEqual([["a"], ["c"]]);
    expect(limited.truncated).toBe(true);
    expect(input[0].results).toHaveLength(2);
  });
  it("counts duplicate URLs once and carries limits across search batches", () => {
    const input = [{ query: "next", results: [source("a"), source("b"), source("c")] }];
    expect(limitResearchSources(input, new Set([source("a").url]), 2).queries[0].results.map(result => result.title)).toEqual(["a", "b"]);
    expect(limitResearchSources(input, new Set([source("a").url, source("b").url]), 2).queries[0].results.map(result => result.title)).toEqual(["a", "b"]);
    expect(limitResearchSources([], new Set(), 2)).toEqual({ queries: [], truncated: false });
  });
});
