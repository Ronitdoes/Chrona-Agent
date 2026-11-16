import { describe, expect, it } from "vitest";
import {
  answerDetailInstruction,
  answerDetailSchema,
  answerDetailProfiles,
  answerOutputTokens,
} from "./answer-detail";
import { effortProfiles, researchBudgetAfterRecall } from "./research-effort";

describe("answer detail", () => {
  it("supports Auto, Brief and Detailed with a verified Gemini ceiling", () => {
    expect(answerDetailSchema.options).toEqual(["auto", "brief", "detailed"]);
    expect(answerDetailSchema.safeParse("unlimited").success).toBe(false);
    expect(
      answerOutputTokens({
        provider: "gemini",
        model: "gemini-3.5-flash-lite",
      }),
    ).toBe(65_536);
    expect(
      answerOutputTokens({ provider: "gemini", model: "custom-model" }),
    ).toBe(8192);
    expect(
      answerOutputTokens({ provider: "anthropic", model: "claude-sonnet-5-5" }),
    ).toBe(8192);
  });
  it.each(answerDetailSchema.options)(
    "lets the current request override the %s preference",
    (detail) => {
      const instruction = answerDetailInstruction(detail);
      expect(instruction).toContain(
        "take precedence over this saved preference",
      );
      expect(instruction).toContain("word count");
      expect(instruction).toContain("ceiling, never a target");
    },
  );
  it.each(answerDetailSchema.options)(
    "extends %s synthesis without expanding research time or search quotas",
    (detail) => {
      for (const effort of ["instant", "medium", "high"] as const) {
        const original = effortProfiles[effort];
        const budget = researchBudgetAfterRecall(effort, 1000, detail)!;
        expect(budget.maxWallMs - budget.finalReserveMs).toBe(
          original.maxWallMs - original.finalReserveMs - 1000,
        );
        expect(budget.finalReserveMs).toBe(
          original.finalReserveMs + answerDetailProfiles[detail].extraFinalMs,
        );
        expect(budget.maxWallMs + 1000).toBeLessThan(360_000);
      }
    },
  );
  it("keeps a final-answer opportunity after preparation uses the research time", () => {
    expect(researchBudgetAfterRecall("high", 100_000, "detailed")).toEqual({
      maxWallMs: 230_000,
      finalReserveMs: 230_000,
    });
    expect(researchBudgetAfterRecall("high", 330_000, "detailed")).toBeNull();
  });
});
