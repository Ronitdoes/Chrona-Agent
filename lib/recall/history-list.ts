import { dateFrom, type Clock } from "../clock";
import type { HistoryCursor } from "../history";
import type { Store } from "../store";
import { resolveDates, type DateRange } from "./temporal";
import { normalizeDateLiterals } from "../calendar-context";
import type { RecallPlan } from "./plan";
import type { HistoryResponse } from "./collection";

export type HistoryListing = { ranges: DateRange[]; sessionId?: string };
type UserMessage = Awaited<ReturnType<Store["userMessagesFor"]>>[number];
export type QuestionHistory = { messages: UserMessage[]; truncated: boolean };

/** Plan interpretation never gets to silently discard an explicit current date. */
export function resolveHistoryRequest(plan: RecallPlan, text: string, clock: Clock, sessionId: string):
  { status: "ready"; request: HistoryListing } | { status: "previous" } | { status: "unresolved" } {
  const literals = normalizeDateLiterals(text);
  if (literals.ambiguous.length || literals.invalid.length) return { status: "unresolved" };
  let ranges: DateRange[];
  // Resolve literal/relative dates in code even if the interpreter omitted them
  // or incorrectly carried a date from the preceding request.
  try {
    const explicit = resolveDates(text, clock.instant, clock.tz, "collection");
    const planned = plan.dateText && text.includes(plan.dateText)
      ? resolveDates(plan.dateText, clock.instant, clock.tz, "collection") : [];
    // A copied scope phrase can distinguish a requested day from another day
    // merely mentioned in the sentence. With multiple dates and no such phrase,
    // ask instead of silently unioning them into a broader selection.
    if (explicit.length > 1 && !planned.length) return { status: "unresolved" };
    ranges = planned.length ? planned : explicit;
  } catch { return { status: "unresolved" }; }
  if (ranges.length > 8) return { status: "unresolved" };
  if (ranges.length) return { status: "ready", request: { ranges, ...(plan.scope === "session" ? { sessionId } : {}) } };
  if (plan.collection === "previous" && !plan.dateText) return { status: "previous" };
  if (plan.dateText) return { status: "unresolved" };
  if (plan.collection === "all" || plan.collection === "new" && plan.scope === "session") {
    return { status: "ready", request: { ranges: [], ...(plan.scope === "session" ? { sessionId } : {}) } };
  }
  return { status: "unresolved" };
}

/** Fresh, user-only, cross-session keyset pages; the current request is excluded. */
export async function loadQuestionHistory(options: {
  userId: string; request: HistoryListing; before: HistoryCursor; signal?: AbortSignal; maxMessages?: number;
}, store: Pick<Store, "userMessagesFor">): Promise<QuestionHistory> {
  const maximum = options.maxMessages ?? 1000;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1000) throw new Error("Invalid question history limit");
  const messages: UserMessage[] = [];
  let before = options.before;
  let truncated = false;
  while (messages.length < maximum) {
    options.signal?.throwIfAborted();
    const limit = Math.min(200, maximum - messages.length);
    const page = await store.userMessagesFor(options.userId, { ranges: options.request.ranges, sessionId: options.request.sessionId, before, limit });
    options.signal?.throwIfAborted();
    const rows = page.slice(0, limit);
    // Defense in depth if a custom store implementation returns an invalid row.
    for (const row of rows) if (row.userId === options.userId &&
      (!options.request.sessionId || row.sessionId === options.request.sessionId) &&
      (!options.request.ranges.length || options.request.ranges.some(range => row.ts >= range.startUtc && row.ts < range.endUtc)) &&
      (row.ts.getTime() < before.ts.getTime() || row.ts.getTime() === before.ts.getTime() && row.id < before.id)) messages.push(row);
    truncated = page.length > limit;
    const last = rows.at(-1);
    if (!truncated || !last) break;
    if (!(last.ts.getTime() < before.ts.getTime() || last.ts.getTime() === before.ts.getTime() && last.id < before.id)) throw new Error("Question history cursor did not advance");
    before = { ts: last.ts, id: last.id };
  }
  return { messages, truncated };
}

function literalMarkdown(text: string): string {
  return text.replace(/[\\`*_{}\[\]()#+.!|<>~\-]/g, "\\$&").replace(/\r\n?|\n/g, "\n   ");
}

export function renderQuestionHistoryResult(history: QuestionHistory, request: HistoryListing, clock: Clock, maxBytes = 64_000): HistoryResponse {
  if (!Number.isInteger(maxBytes) || maxBytes < 512) throw new Error("Invalid question history output budget");
  const time = new Intl.DateTimeFormat("en-US", { timeZone: clock.tz, hour: "numeric", minute: "2-digit", hour12: true });
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: clock.tz, day: "numeric", month: "short", year: "numeric" });
  const range = request.ranges[0];
  const showDates = request.ranges.length !== 1 || date.format(range.startUtc) !== date.format(dateFrom(range.endUtc.getTime() - 1));
  const label = request.ranges.map(range => range.label).join(", ") || (request.sessionId ? "this conversation" : "all saved conversations");
  const context = `**${literalMarkdown(label)}** (times in **${literalMarkdown(clock.tz)}**), as of **${date.format(clock.instant)}, ${time.format(clock.instant)}**`;
  if (!history.messages.length) return { text: `I couldn't find any earlier questions or messages for ${context}.`, sourceTurnIds: [], truncated: history.truncated };
  const selected: { ts: Date; id: number; line: string }[] = [];
  let size = Buffer.byteLength(context, "utf8") + 512;
  let truncated = history.truncated;
  for (const message of [...history.messages].sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id)) {
    const shortened = message.content.length > 4000;
    const line = `**${showDates ? `${date.format(message.ts)}, ` : ""}${time.format(message.ts)}** — ${literalMarkdown(message.content.slice(0, 4000))}${shortened ? " … *(message shortened; open its conversation for the full text)*" : ""}`;
    const bytes = Buffer.byteLength(line, "utf8") + 16;
    if (size + bytes > maxBytes) { truncated = true; break; }
    size += bytes;
    selected.push({ ts: message.ts, id: message.id, line });
  }
  selected.sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.id - b.id);
  const heading = `Your **${selected.length}** ${truncated ? "most recent matching" : "earlier"} questions and messages for ${context}:`;
  const lines = selected.map((message, index) => `${index + 1}. ${message.line}`).join("\n\n");
  return { text: `${heading}\n\n${lines}${truncated ? "\n\nOlder matching messages were omitted to fit the response; this is not a complete list. Open older conversations in the sidebar for the rest." : ""}`, sourceTurnIds: selected.map(row => row.id), truncated };
}

export function renderQuestionHistory(history: QuestionHistory, request: HistoryListing, clock: Clock, maxBytes = 64_000): string {
  return renderQuestionHistoryResult(history, request, clock, maxBytes).text;
}
