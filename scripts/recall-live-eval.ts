import nextEnv from "@next/env";
import { expect, it, vi } from "vitest";
import { createRecallModel } from "../lib/recall/model";
import { now } from "../lib/clock";
import type { RecallPlan } from "../lib/recall/plan";

vi.stubEnv("NODE_ENV", "development");
nextEnv.loadEnvConfig(process.cwd(), true);
const { env } = await import("../lib/env");
const fixtures = [
  { id: 1, content: "check neon db current pricing", context: [] },
  { id: 2, content: "do you remember I asked for neon pricing yes or no?", context: [] },
  { id: 3, content: "I never asked for Neon pricing.", context: [] },
  { id: 4, content: 'Example prompt: "check Neon pricing". Explain why this is a pricing question.', context: [] },
  { id: 5, content: "If I asked for Neon pricing tomorrow, could you help?", context: [] },
];

for (const provider of ["gemini", "anthropic"] as const) {
  const key = provider === "gemini" ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY;
  const modelId = provider === "gemini" ? env.GEMINI_MODEL : env.ANTHROPIC_MODEL;
  it.skipIf(!key)(`${provider}: interprets recall and rejects meta/negated/quoted/hypothetical decoys`, async () => {
    const model = createRecallModel({ provider, model: modelId }, key);
    const signal = new AbortController().signal;
    const message = "do you remember i asked for neon pricing yes or no?";
    const calendar = now();
    const plan = await model.plan({ message, recent: [], hasPreviousEvidence: false, clock: calendar }, signal);
    expect(plan.intent).toBe("history"); expect(plan.operation).toBe("exists");
    expect(plan.queries.join(" ").toLowerCase()).toContain("neon");
    const candidates = fixtures.map(candidate => ({ ...candidate, timestamp: calendar.iso, localTimestamp: calendar.human }));
    const matched = await model.select({ message, plan, candidates }, signal);
    expect(matched.status).toBe("matched"); expect(matched.matches.map(match => match.turnId)).toEqual([1]);
    const missed = await model.select({ message, plan, candidates: candidates.slice(1) }, signal);
    expect(missed).toEqual({ status: "not_found", matches: [] });
    const followup = await model.plan({ message: "at what time did i ask for it", recent: [
      { id: 6, role: "user", content: message }, { id: 7, role: "assistant", content: "Yes — I found your earlier message: check neon db current pricing." },
    ], hasPreviousEvidence: true, clock: calendar }, signal);
    expect(followup.intent).toBe("history"); expect(followup.operation).toBe("when"); expect(followup.usePreviousEvidence).toBe(true);
    const mixed: RecallPlan = await model.plan({ message: "When did I ask about Neon pricing and what does it cost now?", recent: [], hasPreviousEvidence: false, clock: calendar }, signal);
    expect(mixed.intent).toBe("mixed"); expect(mixed.researchQuestion?.toLowerCase()).toContain("neon");
  });
}
