import { z } from "zod";
import type { ModelSelection } from "./model-selection";

export const answerDetailSchema = z.enum(["auto", "brief", "detailed"]);
export type AnswerDetail = z.infer<typeof answerDetailSchema>;
export const answerDetailProfiles = {
  auto: {
    label: "Auto",
    description: "Follow your request",
    extraFinalMs: 120_000,
  },
  brief: {
    label: "Brief",
    description: "Short and focused",
    extraFinalMs: 30_000,
  },
  detailed: {
    label: "Detailed",
    description: "Thorough explanations and examples",
    extraFinalMs: 240_000,
  },
} as const;

export function answerOutputTokens(selection?: ModelSelection): number {
  // Google documents 65,536 output tokens for this exact model. Custom model
  // IDs retain the conservative allowance until their capabilities are known.
  return selection?.provider === "gemini" &&
    selection.model === "gemini-3.5-flash-lite"
    ? 65_536
    : 8192;
}

export function answerDetailInstruction(detail: AnswerDetail): string {
  const preferences = {
    auto: "Choose the depth from the user's request and question complexity. Requests for a lengthy, comprehensive, step-by-step or detailed explanation deserve a fully developed answer. Keep straightforward factual questions focused.",
    brief:
      "The saved preference is Brief. Default to a short, focused answer covering the essential points and sources.",
    detailed:
      "The saved preference is Detailed. Develop every requested point with relevant background, reasoning, explanations and useful concrete examples. Organize a long answer into clear sections, and cite the sources supporting factual claims. Cover important caveats and distinguish confirmed facts from uncertainty.",
  };
  return `${preferences[detail]} Explicit instructions in the current user request about length, word count, detail, language or format take precedence over this saved preference. Use the space the topic needs. Avoid repetition, filler and unsupported elaboration. The token allowance is a ceiling, never a target. Preserve evidence boundaries and cite research claims.`;
}
