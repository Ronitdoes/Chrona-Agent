import assert from "node:assert/strict";
import type { Scenario } from "./fixtures";

export type Metrics = { recallMs: number; ttftMs: number; searchCount: number; totalMs: number };
export type EvalRow = Metrics & { scenario: string; status: "PASS" | "FAIL"; toolCalls: number; error?: string };

/** The expected verdicts are independent fixture labels, not model judgments. */
export function checkAnswer(answer: string, scenario: Scenario): void {
  answer = answer.replace(/\\([\\`*_{}\[\]()#+.!|<>~\-])/g, "$1");
  assert.ok(answer.includes(scenario.original), "Original user request was not restated from storage");
  const day = Number(scenario.date.slice(-2));
  assert.match(answer, new RegExp(`\\b${day} November 2026\\b`), "Resolved historical date is missing");
  for (const item of scenario.items) {
    const line = answer.split("\n").find(line => line.includes(item.subject) && line.includes(item.url));
    assert.ok(line, `${item.subject}: missing a source-backed result row`);
    const amount = (value: string) => new RegExp(value.split("/")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\d.])");
    assert.match(line, amount(item.old), `${item.subject}: missing the old price`);
    assert.match(line, amount(item.current), `${item.subject}: missing the current or unverified price`);
    const header = answer.split("\n").find(line => line.includes("|") && /\bverdict\b/i.test(line));
    const verdictIndex = header?.split("|").findIndex(cell => /\bverdict\b/i.test(cell)) ?? -1;
    const verdictCell = verdictIndex >= 0 ? line.split("|")[verdictIndex] : line;
    assert.ok(verdictCell, `${item.subject}: missing verdict column`);
    const verdict = item.verdict === "unknown" ? /couldn.t verify|cannot verify|unverified|unknown/i : new RegExp(`\\b${item.verdict}\\b`, "i");
    assert.match(verdictCell, verdict, `${item.subject}: incorrect verdict`);
    if (item.verdict === "unknown") assert.doesNotMatch(verdictCell, /\b(?:unchanged|changed)\b/i, "Undated evidence received a definitive change verdict");
    else assert.match(line, /14 November 2026|2026-11-14/, `${item.subject}: source date is missing`);
  }
}

export function checkMetrics(metrics: Metrics, maxWallMs: number): void {
  for (const value of [metrics.recallMs, metrics.ttftMs, metrics.searchCount, metrics.totalMs]) assert.ok(Number.isFinite(value) && value >= 0, "Invalid trace metric");
  assert.ok(metrics.recallMs <= metrics.totalMs && metrics.ttftMs <= metrics.totalMs, "Trace timings are out of order");
  assert.ok(metrics.totalMs <= maxWallMs + 1000, "Request exceeded its wall-clock budget and cleanup allowance");
}
