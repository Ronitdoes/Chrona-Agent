import { afterAll, it } from "vitest";
import { evaluate, printResults } from "./harness";
import { scenarios } from "./fixtures";
import type { EvalRow } from "./checks";

const rows: EvalRow[] = [];
for (const scenario of scenarios) {
  it(scenario.id, async () => {
    const row: EvalRow = { scenario: scenario.id, status: "FAIL", recallMs: 0, ttftMs: 0, totalMs: 0, searchCount: 0, toolCalls: 0 };
    rows.push(row); await evaluate(scenario, row);
  });
}
for (const [label, options] of [["Missing history", { missing: true }], ["Query budget", { exhaustQueries: true }]] as const) {
  it(label, async () => {
    const row: EvalRow = { scenario: label, status: "FAIL", recallMs: 0, ttftMs: 0, totalMs: 0, searchCount: 0, toolCalls: 0 };
    rows.push(row); await evaluate(scenarios[0], row, options);
  });
}
afterAll(() => printResults(rows));
