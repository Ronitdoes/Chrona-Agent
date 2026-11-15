import { describe, expect, it } from "vitest";
import { checkAnswer, checkMetrics } from "./checks";
import { recordedAnswer, scenarios } from "./fixtures";

describe("evaluation oracle", () => {
  const scenario = scenarios[0];
  const valid = `${scenario.original}\n9 November 2026\n${recordedAnswer(scenario)}`;
  it("accepts the independently labeled reference answer", () => { expect(() => checkAnswer(valid, scenario)).not.toThrow(); });
  it.each([
    valid.replace("couldn't verify", "unchanged"), valid.replace("$25/month", "$99/month"),
    valid.replace("[Source](https://example.com/eval/cedarcrm)", "no source"), valid.replaceAll("14 November 2026", "date missing"),
    valid.replace(scenario.original, "invented memory"), valid.replace("$25/month", "$250/month"),
  ])("rejects a corrupted answer %#", answer => { expect(() => checkAnswer(answer, scenario)).toThrow(); });
  it.each([NaN, -1, Infinity, 50_001])("rejects invalid or over-budget total latency %s", totalMs => {
    expect(() => checkMetrics({ recallMs: 1, ttftMs: 2, searchCount: 1, totalMs }, 45_000)).toThrow();
  });
});
