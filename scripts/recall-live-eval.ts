import nextEnv from "@next/env";
import { expect, it, vi } from "vitest";
import { createRecallModel } from "../lib/recall/model";
import { now } from "../lib/clock";
import type { RecallPlan } from "../lib/recall/plan";
import { validateSummary } from "../lib/recall/history-summary";

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
  it.skipIf(!key)(`${provider}: collection provenance and contextual midnight continuations`, async () => {
    const model = createRecallModel({ provider, model: modelId }, key);
    const signal = new AbortController().signal;
    const calendar = now();
    const previousCollection = { count: 6, timezone: calendar.tz, labels: ["a previously selected calendar day"], truncated: false };
    for (const message of ["lemme know the 6 messages", "Show those messages individually now"]) {
      const plan = await model.plan({ message, recent: [
        { id: 10, role: "user", content: "Summarize my messages today" },
        { id: 11, role: "assistant", content: "Summary of six earlier messages for today." },
      ], hasPreviousEvidence: false, previousCollection, clock: calendar }, signal);
      expect(plan).toMatchObject({ intent: "history", operation: "list", collection: "previous", dateText: null, queries: [] });
    }
    const input = { message: "Summarize today's messages briefly", messages: [
      { id: 100, content: "recheck again for today", context: [
        { id: 1, content: "Explain how post credit scenes connect the upcoming films", timestamp: "2031-04-10T17:00:00Z" },
        { id: 2, content: "Explain the latest details deeply", timestamp: "2031-04-10T17:01:00Z" },
      ] },
      { id: 101, content: "What's today's date?", context: [] },
      { id: 102, content: "Recap yesterday's questions", context: [] },
    ] };
    const summary = validateSummary(await model.summarize(input, signal), input);
    const continuation = summary.items.find(item => item.turnId === 100)!;
    expect(continuation.summary).toMatch(/films?|movies?|scenes?|credits?/i);
    expect(continuation.summary).not.toMatch(/today'?s messages/i);
    expect(summary.items).toHaveLength(3);
  }, 60_000);
  it.skipIf(!key)(`${provider}: plans broad recap follow-ups and summarizes all supplied message types`, async () => {
    const model = createRecallModel({ provider, model: modelId }, key);
    const signal = new AbortController().signal;
    const calendar = now();
    const previous = "what questions did i ask u yesterday summaries in short";
    const first = await model.plan({ message: previous, recent: [], hasPreviousEvidence: false, clock: calendar }, signal);
    expect(first).toMatchObject({ intent: "history", operation: "summarize", collection: "new", queries: [], dateText: "yesterday", usePreviousEvidence: false });
    for (const message of ["can you summaries today's messages as well?", "Give me a brief recap of my messages today too"]) {
      const plan = await model.plan({ message, recent: [
        { id: 10, role: "user", content: previous }, { id: 11, role: "assistant", content: "Yesterday you asked about hosting and algorithms." },
      ], hasPreviousEvidence: false, clock: calendar }, signal);
      expect(plan).toMatchObject({ intent: "history", operation: "summarize", collection: "new", queries: [], dateText: "today", usePreviousEvidence: false });
    }
    const input = { message: "Summarize my messages briefly", messages: [
      { id: 1, content: "What is today's date?" }, { id: 2, content: "Current time?" },
      { id: 3, content: "Recap yesterday's questions" }, { id: 4, content: "Compare hosting plans" }, { id: 5, content: "Compare hosting plans" },
    ] };
    const summary = validateSummary(await model.summarize(input, signal), input);
    expect(summary.items).toHaveLength(input.messages.length);
  }, 60_000);
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
