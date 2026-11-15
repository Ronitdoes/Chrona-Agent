import nextEnv from "@next/env";
import { afterAll, it, vi } from "vitest";
import { createConfiguredModel } from "../lib/agent/model";
import { configuredRecallModel } from "../lib/recall/model";
import { resolveModelSelection } from "../lib/model-config";
import { evaluate, printResults } from "./harness";
import { scenarios } from "./fixtures";
import type { EvalRow } from "./checks";

vi.stubEnv("NODE_ENV", "development");
nextEnv.loadEnvConfig(process.cwd(), true);
const rows: EvalRow[] = [];
it("revalidates the Tuesday Postgres fixture with the configured live model and synthetic search", async () => {
  const row: EvalRow = { scenario: "Live Tuesday Postgres", status: "FAIL", recallMs: 0, ttftMs: 0, totalMs: 0, searchCount: 0, toolCalls: 0 };
  rows.push(row);
  try {
    const selection = await resolveModelSelection();
    console.log(`Live evaluation provider: ${selection.provider}; model: ${selection.model}`);
    const scenario = { ...scenarios[2], message: `${scenarios[2].message} This is a fictional evaluation: AlphaPG and BetaPG are synthetic providers. Use one search batch for both providers and evaluate only the supplied fixture evidence. Give a table with each provider, old price, new or unverified price, verdict, source date and source link. Do not research real companies.` };
    await evaluate(scenario, row, { live: { selection, answer: await createConfiguredModel(selection), recall: await configuredRecallModel(selection) } });
  } catch (error) { row.status = "FAIL"; throw error; }
});
afterAll(() => {
  printResults(rows, "live");
  console.log("LIVE MODE: recall planning, evidence selection and answer synthesis use the configured provider. Search is synthetic; model requests may incur charges. This is a small regression check, not a production accuracy benchmark.");
  vi.unstubAllEnvs();
});
