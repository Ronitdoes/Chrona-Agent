import { z } from "zod";
import type { Clock } from "../clock";
import type { Turn } from "../store/schema";

export const recallPlanSchema = z.strictObject({
  intent: z.enum(["general", "history", "mixed"]),
  operation: z.enum(["exists", "when", "list", "summarize", "revalidate"]),
  collection: z.enum(["none", "new", "previous", "all"]),
  queries: z.array(z.string().trim().min(1).max(200)).max(3),
  dateText: z.string().trim().min(1).max(200).nullable(),
  scope: z.enum(["all", "session"]),
  usePreviousEvidence: z.boolean(),
  researchQuestion: z.string().trim().min(1).max(20_000).nullable(),
});
export type RecallPlan = z.infer<typeof recallPlanSchema>;
export const evidenceSelectionSchema = z.strictObject({
  status: z.enum(["matched", "ambiguous", "not_found"]),
  matches: z.array(z.strictObject({ turnId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), quote: z.string().min(1).max(2000) })).max(10),
});
export type EvidenceSelection = z.infer<typeof evidenceSelectionSchema>;
export const historySummarySchema = z.strictObject({
  items: z.array(z.strictObject({
    turnId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    summary: z.string().trim().min(1).max(240),
  })).min(1).max(100),
});
export type HistorySummary = z.infer<typeof historySummarySchema>;
export type SummaryInput = { message: string; messages: { id: number; content: string; context?: { id: number; content: string; timestamp: string }[] }[] };
export type PlanInput = { message: string; recent: Pick<Turn, "id" | "role" | "content">[]; hasPreviousEvidence: boolean; previousCollection?: { count: number; timezone: string; labels: string[]; truncated: boolean }; clock: Pick<Clock, "iso" | "tz"> };
export type SelectionInput = { message: string; plan: RecallPlan; candidates: { id: number; timestamp: string; localTimestamp: string; content: string; context: { role: Turn["role"]; content: string }[] }[] };
export interface RecallModel {
  plan(input: PlanInput, signal: AbortSignal): Promise<RecallPlan>;
  select(input: SelectionInput, signal: AbortSignal): Promise<EvidenceSelection>;
  summarize(input: SummaryInput, signal: AbortSignal): Promise<HistorySummary>;
}

// Bound the interpreter's context without rewriting or confusing it with instructions.
export function planningContext(turns: readonly Turn[]): PlanInput["recent"] {
  let remaining = 12_000;
  return [...turns].sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id).flatMap(turn => {
    if (!remaining) return [];
    const content = turn.content.slice(0, Math.min(2000, remaining));
    remaining -= content.length;
    return [{ id: turn.id, role: turn.role, content }];
  }).reverse();
}

export function validatePlan(output: unknown, input: PlanInput): RecallPlan {
  const plan = recallPlanSchema.parse(output);
  if (plan.intent === "general") return { ...plan, collection: "none", queries: [], dateText: null, usePreviousEvidence: false, researchQuestion: null };
  if (plan.dateText && !input.message.includes(plan.dateText) && !input.recent.some(turn => turn.role === "user" && turn.content.includes(plan.dateText!))) throw new Error("Recall date must be extracted from user text");
  if (plan.intent === "mixed" && !plan.researchQuestion) throw new Error("Mixed recall requires an external question");
  if (plan.collection !== "none") {
    if (plan.intent !== "history" || !["list", "summarize"].includes(plan.operation) || plan.queries.length) throw new Error("Invalid collection operation");
    return { ...plan, usePreviousEvidence: false };
  }
  return plan;
}
