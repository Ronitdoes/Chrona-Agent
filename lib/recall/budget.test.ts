import { expect, it } from "vitest";
import { effortTimeoutMs, researchBudgetAfterRecall } from "../research-effort";

it("subtracts recall from the shared research budget and preserves a feasible final reserve", () => {
  expect(researchBudgetAfterRecall("instant", 10_000)).toEqual({ maxWallMs: 20_000, finalReserveMs: 8000 });
  expect(researchBudgetAfterRecall("high", 85_000)).toEqual({ maxWallMs: 5000, finalReserveMs: 5000 });
  expect(researchBudgetAfterRecall("medium", 44_000)).toBeNull();
  expect(researchBudgetAfterRecall("high", 100_000)).toBeNull();
  expect(() => researchBudgetAfterRecall("instant", NaN)).toThrow();
});

it("turns fractional clock durations into valid integer AbortSignal delays", () => {
  expect(effortTimeoutMs("instant", 0.125)).toBe(29_999);
  expect(effortTimeoutMs("medium", 1234.567)).toBe(43_765);
  expect(effortTimeoutMs("high", 89_999.75)).toBe(1);
  expect(effortTimeoutMs("instant", 40_000.25)).toBe(1);
  expect(() => AbortSignal.timeout(effortTimeoutMs("instant", 0.125))).not.toThrow();
  expect(() => effortTimeoutMs("instant", NaN)).toThrow();
  expect(() => effortTimeoutMs("instant", -1)).toThrow();
});
