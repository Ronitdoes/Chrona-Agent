import { z } from "zod";
import { dateFrom, type Clock } from "../clock";
import type { HistoryCursor } from "../history";
import type { Store } from "../store";
import type { HistoryListing, QuestionHistory } from "./history-list";
import type { Turn } from "../store/schema";

const instant = z.iso.datetime({ offset: true });
export const collectionSchema = z.strictObject({
  sourceTurnIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(1000),
  ranges: z.array(z.strictObject({ startUtc: instant, endUtc: instant, label: z.string().max(200) })).max(8),
  sessionId: z.string().min(1).nullable(),
  timezone: z.string().min(1).max(100),
  before: z.strictObject({ ts: instant, id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  truncated: z.boolean(),
}).superRefine((value, context) => {
  if (new Set(value.sourceTurnIds).size !== value.sourceTurnIds.length || value.ranges.some(range => Date.parse(range.startUtc) >= Date.parse(range.endUtc))) {
    context.addIssue({ code: "custom", message: "Invalid history collection" });
  }
  try { new Intl.DateTimeFormat("en-GB", { timeZone: value.timezone }); }
  catch { context.addIssue({ code: "custom", message: "Invalid collection timezone" }); }
});
export type RecallCollection = z.infer<typeof collectionSchema>;
export type HistoryResponse = { text: string; sourceTurnIds: number[]; truncated: boolean };

export function saveCollection(response: HistoryResponse, request: HistoryListing, before: HistoryCursor, clock: Clock): RecallCollection {
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: clock.tz, day: "numeric", month: "short", year: "numeric" });
  return collectionSchema.parse({ sourceTurnIds: response.sourceTurnIds,
    ranges: request.ranges.map(range => {
      const first = date.format(range.startUtc), last = date.format(dateFrom(range.endUtc.getTime() - 1));
      // A persisted "today" label would become false after midnight. References
      // retain absolute dates as well as absolute bounds.
      return { startUtc: range.startUtc.toISOString(), endUtc: range.endUtc.toISOString(), label: first === last ? first : `${first} – ${last}` };
    }),
    sessionId: request.sessionId ?? null, timezone: clock.tz, before: { ts: before.ts.toISOString(), id: before.id }, truncated: response.truncated });
}

export function collectionContains(turn: Pick<Turn, "ts" | "id" | "sessionId">, collection: RecallCollection): boolean {
  const boundary = Date.parse(collection.before.ts);
  return (turn.ts.getTime() < boundary || turn.ts.getTime() === boundary && turn.id < collection.before.id) &&
    (!collection.sessionId || turn.sessionId === collection.sessionId) &&
    (!collection.ranges.length || collection.ranges.some(range => turn.ts.getTime() >= Date.parse(range.startUtc) && turn.ts.getTime() < Date.parse(range.endUtc)));
}

/** Rehydrate only the exact displayed originals. Never expand a missing reference. */
export async function loadCollection(value: unknown, options: { userId: string; before: HistoryCursor; signal: AbortSignal }, store: Pick<Store, "historySources">): Promise<{ history: QuestionHistory; request: HistoryListing; collection: RecallCollection }> {
  const collection = collectionSchema.parse(value);
  options.signal.throwIfAborted();
  const boundary = dateFrom(collection.before.ts);
  if (boundary > options.before.ts || boundary.getTime() === options.before.ts.getTime() && collection.before.id > options.before.id) throw new Error("Future collection reference");
  const rows = await store.historySources(options.userId, collection.sourceTurnIds, options.before);
  options.signal.throwIfAborted();
  if (rows.length !== collection.sourceTurnIds.length || new Set(rows.map(row => row.id)).size !== rows.length ||
    !rows.every(row => row.userId === options.userId && row.role === "user" && collection.sourceTurnIds.includes(row.id) && collectionContains(row, collection))) throw new Error("Collection source unavailable");
  return { history: { messages: rows, truncated: collection.truncated }, request: {
    ranges: collection.ranges.map(range => ({ ...range, startUtc: dateFrom(range.startUtc), endUtc: dateFrom(range.endUtc) })),
    ...(collection.sessionId ? { sessionId: collection.sessionId } : {}),
  }, collection };
}
