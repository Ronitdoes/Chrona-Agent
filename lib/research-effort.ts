import { answerDetailProfiles, type AnswerDetail } from "./answer-detail";
import { z } from "zod";
import type { QueryResult } from "./tools/results";

export const effortSchema = z.enum(["instant", "medium", "high", "deep"]);
export type ResearchEffort = z.infer<typeof effortSchema>;

export const effortProfiles = {
  instant: { label: "Instant", maxQueries: 2, maxSources: 2, maxSteps: 3, maxWallMs: 30_000, finalReserveMs: 8000, resultTokens: 4000, thinking: "low" },
  medium: { label: "Medium", maxQueries: 5, maxSources: 5, maxSteps: 4, maxWallMs: 45_000, finalReserveMs: 10_000, resultTokens: 8000, thinking: "medium" },
  high: { label: "High", maxQueries: 10, maxSources: 10, maxSteps: 4, maxWallMs: 90_000, finalReserveMs: 15_000, resultTokens: 16_000, thinking: "high" },
  deep: { label: "Deep", maxQueries: 20, maxSources: 20, maxSteps: 7, maxWallMs: 180_000, finalReserveMs: 105_000, resultTokens: 16_000, thinking: "high" },
} as const;

export function effortDeadlines(effort: ResearchEffort, detail?: AnswerDetail) {
  const profile = effortProfiles[effort];
  const extension = detail ? answerDetailProfiles[detail].extraFinalMs : 0;
  const maxWallMs = effort === "deep" ? 285_000 : Math.min(285_000, profile.maxWallMs + extension);
  const researchMs = effort === "deep" ? profile.maxWallMs : profile.maxWallMs - profile.finalReserveMs;
  return { maxWallMs, finalReserveMs: maxWallMs - researchMs };
}

/** Interpretation, retrieval and synthesis share the user's chosen time budget. */
export function researchBudgetAfterRecall(effort: ResearchEffort, elapsedMs: number, answerDetail?: AnswerDetail): { maxWallMs: number; finalReserveMs: number } | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error("Invalid elapsed time");
  const deadlines = effortDeadlines(effort, answerDetail);
  const maxWallMs = deadlines.maxWallMs - elapsedMs;
  return (effort === "deep" && elapsedMs >= effortProfiles.deep.maxWallMs) || maxWallMs <= 1000 ? null
    : { maxWallMs, finalReserveMs: Math.min(deadlines.finalReserveMs, maxWallMs) };
}

/** Node's AbortSignal.timeout requires integer milliseconds, while the injected
 * monotonic clock normally returns fractional values. Keep a positive delay
 * even when preparation has already exhausted the effort budget.
 */
export function effortTimeoutMs(effort: ResearchEffort, elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error("Invalid elapsed time");
  return Math.max(1, Math.floor(effortProfiles[effort].maxWallMs - elapsedMs));
}

/** Fairly retain distinct sources across queries and earlier search batches. */
export function limitResearchSources(queries: QueryResult[], known: ReadonlySet<string>, maximum: number) {
  const allowed = new Set(known);
  const rounds = Math.max(0, ...queries.map(query => query.results.length));
  for (let index = 0; index < rounds && allowed.size < maximum; index++) {
    for (const query of queries) {
      const result = query.results[index];
      if (result && allowed.size < maximum) allowed.add(result.url);
    }
  }
  let truncated = false;
  const limited = queries.map(query => {
    const results = query.results.filter(result => allowed.has(result.url));
    truncated ||= results.length !== query.results.length;
    return { ...query, results };
  });
  return { queries: limited, truncated };
}

export function deepSourceLimit(round: number, remainingQueries: number, roundLimit: number) {
  const maximum = effortProfiles.deep.maxSources;
  const futureRounds = Math.min(remainingQueries, Math.max(0, roundLimit - round));
  return maximum - futureRounds * 3;
}

export function queryKey(query: string) {
  return query.trim().replace(/\s+/gu, " ").toLowerCase();
}
