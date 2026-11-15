import { dateFrom, type Clock } from "../clock";
import type { HistoryCursor } from "../history";
import type { Store } from "../store";
import { resolveDates, type DateRange } from "./temporal";
import { normalizeDateLiterals } from "../calendar-context";

export type HistoryListing = { ranges: DateRange[] };
type UserMessage = Awaited<ReturnType<Store["userMessagesFor"]>>[number];
export type QuestionHistory = { messages: UserMessage[]; truncated: boolean };

/** Only unqualified inventories of the user's own messages, not revalidation. */
export function historyListingRequest(text: string, clock: Clock): HistoryListing | null {
  const dates = normalizeDateLiterals(text);
  if (dates.ambiguous.length || dates.invalid.length) return null;
  if (!/^\s*(?:what|which|list|show|give|tell|remind|all my)\b/i.test(text)) return null;
  if (!/\bi\s+(?:(?:have|had|previously|already|ever)\s+)*(?:ask(?:ed)?|said|sent|wrote|typed)\b|\bmy\s+(?:questions|messages|prompts)\b/i.test(text)) return null;
  if (/\b(?:still|correct|verify|reverify|re-verify|changed|compare|answer|respond|summarize|summarise|explain|solve|about|regarding|concerning)\b/i.test(text)) return null;
  if (/\?\s*\S|\b(?:also|before|after|since|until|between|morning|afternoon|evening|noon|midnight)\b|\b(?:and|then)\s+(?:tell|give|show|find|get|what|how|why|is|are|do|can)\b/i.test(text)) return null;
  if (/\b(?:should|can|could|would|will|shall|may|might)\s+i\s+(?:ask|say|send)\b|\b(?:this|current|same)\s+(?:chat|conversation|session)\b/i.test(text)) return null;
  const ranges = resolveDates(text, clock.instant, clock.tz);
  if (ranges.length > 8 || !ranges.length && !/\ball\b|^\s*(?:list|show)\b/i.test(text)) return null;
  return { ranges };
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
    const page = await store.userMessagesFor(options.userId, { ranges: options.request.ranges, before, limit });
    options.signal?.throwIfAborted();
    const rows = page.slice(0, limit);
    // Defense in depth if a custom store implementation returns an invalid row.
    for (const row of rows) if (row.userId === options.userId && (row.ts.getTime() < options.before.ts.getTime() || row.ts.getTime() === options.before.ts.getTime() && row.id < options.before.id)) messages.push(row);
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

export function renderQuestionHistory(history: QuestionHistory, request: HistoryListing, clock: Clock, maxBytes = 64_000): string {
  if (!Number.isInteger(maxBytes) || maxBytes < 512) throw new Error("Invalid question history output budget");
  const time = new Intl.DateTimeFormat("en-US", { timeZone: clock.tz, hour: "numeric", minute: "2-digit", hour12: true });
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: clock.tz, day: "numeric", month: "short", year: "numeric" });
  const range = request.ranges[0];
  const showDates = request.ranges.length !== 1 || date.format(range.startUtc) !== date.format(dateFrom(range.endUtc.getTime() - 1));
  const label = request.ranges.map(range => range.label).join(", ") || "all saved conversations";
  const context = `**${literalMarkdown(label)}** (times in **${literalMarkdown(clock.tz)}**), as of **${showDates ? `${date.format(clock.instant)}, ` : ""}${time.format(clock.instant)}**`;
  if (!history.messages.length) return `I couldn't find any earlier questions or messages for ${context}. This request itself is excluded.`;
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
  return `${heading}\n\n${lines}\n\n${truncated ? "Older matching messages were omitted to fit the response; this is not a complete list. Open older conversations in the sidebar for the rest. " : ""}This request itself is excluded.`;
}
