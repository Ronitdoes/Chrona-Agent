import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecallModel } from "./model";
import { planningContext, validatePlan, type PlanInput, type RecallPlan } from "./plan";
import { clock, turn } from "../../test/agent-fixtures";

const plan: RecallPlan = { intent: "history", operation: "exists", collection: "none", queries: ["neon pricing"], dateText: null, scope: "all", usePreviousEvidence: false, researchQuestion: null };
const input: PlanInput = { message: "do you remember I asked for Neon pricing yes or no?", recent: [], hasPreviousEvidence: false, clock };
const signal = () => new AbortController().signal;
function anthropic(text: string, stop = "end_turn") {
  return Response.json({ id: "recall-test", type: "message", role: "assistant", model: "test-model", content: [{ type: "text", text }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
}
function gemini(text: string, finishReason = "STOP") {
  return Response.json({ candidates: [{ finishReason, content: { parts: [{ thought: true, text: "private thought" }, { text }] } }] });
}
afterEach(() => vi.unstubAllGlobals());

describe.each(["gemini", "anthropic"] as const)("%s recall transport", provider => {
  it("uses the selected provider's native structured output without exposing a tool", async () => {
    const selected = { status: "matched", matches: [{ turnId: 1, quote: "Neon pricing" }] };
    const summary = { items: [{ turnId: 1, summary: "Asked for hosting prices." }] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(provider === "gemini" ? gemini(JSON.stringify(plan)) : anthropic(JSON.stringify(plan)))
      .mockResolvedValueOnce(provider === "gemini" ? gemini(JSON.stringify(selected)) : anthropic(JSON.stringify(selected)))
      .mockResolvedValueOnce(provider === "gemini" ? gemini(JSON.stringify(summary)) : anthropic(JSON.stringify(summary)));
    const model = createRecallModel({ provider, model: "test-model" }, "test-key", { fetch });
    expect(await model.plan(input, signal())).toEqual(plan);
    expect(await model.select({ message: input.message, plan, candidates: [{ id: 1, timestamp: clock.iso, localTimestamp: clock.human, content: "Neon pricing", context: [] }] }, signal())).toEqual(selected);
    expect(await model.summarize({ message: "Recap my messages", messages: [{ id: 1, content: "Hosting prices?" }] }, signal())).toEqual(summary);
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).not.toContain("test-key");
      const body = JSON.parse(String(init?.body));
      expect(body.tools).toBeUndefined(); expect(body.tool_choice).toBeUndefined();
      if (provider === "gemini") {
        expect(body.generationConfig.responseMimeType).toBe("application/json");
        expect(body.generationConfig.responseJsonSchema.type).toBe("object");
        expect(init?.headers).toMatchObject({ "x-goog-api-key": "test-key" });
      } else expect(body).toMatchObject({ model: "test-model", output_config: { format: { type: "json_schema" } } });
    }
  });
  it.each(["invalid-json", JSON.stringify({ ...plan, intent: "invalid" })])("rejects invalid structured plans (%s)", async text => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(provider === "gemini" ? gemini(text) : anthropic(text));
    await expect(createRecallModel({ provider, model: "test-model" }, "test-key", { fetch }).plan(input, signal())).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects truncated output and provider errors without retrying", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(provider === "gemini" ? gemini(JSON.stringify(plan), "MAX_TOKENS") : anthropic(JSON.stringify(plan), "max_tokens"))
      .mockResolvedValueOnce(new Response("private provider error", { status: 429 }));
    const model = createRecallModel({ provider, model: "test-model" }, "test-key", { fetch });
    await expect(model.plan(input, signal())).rejects.toThrow();
    await expect(model.plan(input, signal())).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not send a cancelled request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const controller = new AbortController(); controller.abort();
    await expect(createRecallModel({ provider, model: "test-model" }, "test-key", { fetch }).plan(input, controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("requires exact user date phrases and an external question for mixed plans", () => {
  expect(() => validatePlan({ ...plan, dateText: "15 November 2026" }, input)).toThrow();
  expect(validatePlan({ ...plan, dateText: "yesterday" }, { ...input, message: "What did I ask yesterday?" }).dateText).toBe("yesterday");
  expect(() => validatePlan({ ...plan, dateText: "yesterday" }, { ...input, recent: [{ id: 1, role: "assistant", content: "yesterday" }] })).toThrow();
  expect(() => validatePlan({ ...plan, intent: "mixed" }, input)).toThrow();
});

it("treats inventories on a new day as fresh queries rather than reusing previous source IDs", () => {
  const result = validatePlan({ ...plan, operation: "summarize", collection: "new", queries: [], dateText: "today", usePreviousEvidence: true }, { ...input, message: "Recap today's messages too" });
  expect(result.usePreviousEvidence).toBe(false);
  expect(result.dateText).toBe("today");
});

it("bounds planner context, preserves roles and prioritizes the most recent messages", () => {
  const rows = Array.from({ length: 20 }, (_, i) => turn(i + 1, { content: `Message ${i} ` + "x".repeat(4000) }));
  const context = planningContext(rows);
  expect(context).toHaveLength(6); expect(context.at(-1)?.id).toBe(20);
  expect(context[0].id).toBe(15); expect(context.every(row => row.content.length === 2000)).toBe(true);
});
