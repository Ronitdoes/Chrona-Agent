import type { Clock } from "../clock";
import type { HistoryCursor } from "../history";
import { normalizeDateLiterals } from "../calendar-context";
import type { Store } from "../store";
import type { Turn } from "../store/schema";
import { resolveDates, type DateRange } from "./temporal";
import { evidenceSelectionSchema, type RecallModel, type RecallPlan } from "./plan";

export type HistoryStore = Pick<Store, "searchUserHistory" | "historySources" | "historyContext" | "previousRecall">;
export type HistoryEvidence = { turn: Turn; quote: string };
export type HistoryAnswer = {
  status: "matched" | "ambiguous" | "not_found" | "unavailable" | "unresolved";
  matches: HistoryEvidence[]; context: Turn[];
  coverage: { pages: number; candidateIds: number[]; hasMore: boolean; shortened: boolean; ranges: DateRange[]; scope: RecallPlan["scope"] };
  reason: string;
};

export function historySearchQuery(queries: readonly string[]): string {
  return [...new Set(queries.map(query => {
    // Quote every term: model text cannot add tsquery operators or SQL.
    const words = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
    return words.map(word => `"${word}"`).join(" ");
  }).filter(Boolean))].join(" OR ");
}

function isEarlier(turn: Turn, before: HistoryCursor): boolean {
  return turn.ts.getTime() < before.ts.getTime() || turn.ts.getTime() === before.ts.getTime() && turn.id < before.id;
}
function inScope(turn: Turn, options: { userId: string; sessionId: string; before: HistoryCursor; plan: RecallPlan }, ranges: DateRange[]): boolean {
  return turn.userId === options.userId && turn.role === "user" && isEarlier(turn, options.before) &&
    (options.plan.scope !== "session" || turn.sessionId === options.sessionId) &&
    (!ranges.length || ranges.some(range => turn.ts >= range.startUtc && turn.ts < range.endUtc));
}

/** IDs, original quote membership, ownership and chronology are checked in code.
 * Whether the original request semantically supports the question is a separate
 * model judgment; summaries and assistant assertions never become candidates.
 */
export function validateHistorySelection(output: unknown, candidates: readonly Turn[]): { status: "matched" | "ambiguous" | "not_found"; matches: HistoryEvidence[] } {
  const selection = evidenceSelectionSchema.parse(output);
  if (selection.status === "not_found") {
    if (selection.matches.length) throw new Error("Unexpected evidence for a miss");
    return { status: "not_found", matches: [] };
  }
  if (!selection.matches.length) throw new Error("History assertion requires original evidence");
  const ids = new Set<number>();
  const matches = selection.matches.map(match => {
    const turn = candidates.find(turn => turn.id === match.turnId && turn.role === "user");
    if (!turn || !match.quote.trim() || !turn.content.includes(match.quote) || ids.has(turn.id)) throw new Error("Invalid history evidence");
    ids.add(turn.id);
    return { turn, quote: match.quote };
  });
  return { status: selection.status, matches };
}

export async function answerHistory(options: {
  userId: string; sessionId: string; message: string; before: HistoryCursor; clock: Clock;
  plan: RecallPlan; model: RecallModel; signal: AbortSignal;
}, store: HistoryStore): Promise<HistoryAnswer> {
  const { plan, clock } = options;
  if (!options.userId.trim()) throw new Error("History requires a userId");
  const coverage: HistoryAnswer["coverage"] = { pages: 0, candidateIds: [], hasMore: false, shortened: false, ranges: [], scope: plan.scope };
  const result = (status: HistoryAnswer["status"], reason: string, matches: HistoryEvidence[] = [], context: Turn[] = []): HistoryAnswer => ({ status, reason, matches, context, coverage });
  try {
    options.signal.throwIfAborted();
    if (plan.dateText) {
      const dates = normalizeDateLiterals(plan.dateText);
      if (dates.ambiguous.length || dates.invalid.length) return result("unresolved", "date_ambiguous_or_invalid");
      coverage.ranges = resolveDates(plan.dateText, clock.instant, clock.tz);
      if (!coverage.ranges.length) return result("unresolved", "date_not_resolved");
    }
    if (plan.usePreviousEvidence) {
      const reference = await store.previousRecall(options.userId, options.sessionId, options.before);
      if (!reference?.sourceTurnIds.length) return result("unresolved", "no_verified_antecedent");
      const turns = await store.historySources(options.userId, reference.sourceTurnIds, options.before);
      if (turns.length !== reference.sourceTurnIds.length || !turns.every(turn => inScope(turn, options, coverage.ranges))) return result("unavailable", "referenced_message_unavailable");
      const context = (await Promise.all(turns.map(turn => store.historyContext(options.userId, turn.id, options.before)))).flat();
      coverage.shortened = turns.some(turn => turn.content.length > 2000);
      options.signal.throwIfAborted();
      return result(turns.length > 1 && plan.operation === "when" ? "ambiguous" : "matched", "verified_antecedent", turns.map(turn => ({ turn, quote: turn.content.slice(0, 2000) })), context);
    }
    const query = historySearchQuery(plan.queries);
    if (!query && !coverage.ranges.length && plan.operation !== "list") return result("unresolved", "topic_not_resolved");
    let cursor = options.before;
    const matches = new Map<number, HistoryEvidence>();
    const context = new Map<number, Turn[]>();
    let ambiguous = false;
    // Bounded chronological pages; sentinel rows describe coverage honestly.
    for (let page = 0; page < 3; page++) {
      options.signal.throwIfAborted();
      const found = await store.searchUserHistory(options.userId, { query, ranges: coverage.ranges, before: cursor,
        ...(plan.scope === "session" ? { sessionId: options.sessionId } : {}), limit: 10 });
      options.signal.throwIfAborted();
      coverage.pages++;
      coverage.hasMore = found.length > 10;
      const rows = found.slice(0, 10);
      if (!rows.every(turn => inScope(turn, options, coverage.ranges) && isEarlier(turn, cursor))) throw new Error("History store returned out-of-scope data");
      if (!rows.length) break;
      coverage.candidateIds.push(...rows.map(turn => turn.id));
      const contexts = await Promise.all(rows.map(turn => store.historyContext(options.userId, turn.id, options.before)));
      const candidates = rows.map((turn, index) => {
        // Keep a relevant exact excerpt of long user messages, independently of
        // assistant-answer size. Full originals remain available for validation.
        const terms = plan.queries.flatMap(query => query.match(/[\p{L}\p{N}]+/gu) ?? []).sort((a, b) => b.length - a.length);
        const indexOfTerm = terms.map(term => turn.content.toLowerCase().indexOf(term.toLowerCase())).find(index => index >= 0) ?? 0;
        const start = Math.max(0, indexOfTerm - 200);
        const content = turn.content.slice(start, start + 2000);
        coverage.shortened ||= content.length !== turn.content.length;
        const neighbors = contexts[index].filter(neighbor => neighbor.userId === options.userId && neighbor.sessionId === turn.sessionId && isEarlier(neighbor, options.before));
        context.set(turn.id, neighbors);
        return { id: turn.id, timestamp: turn.ts.toISOString(), localTimestamp: `${new Intl.DateTimeFormat("en-GB", { timeZone: clock.tz, dateStyle: "full", timeStyle: "long" }).format(turn.ts)} (${clock.tz})`, content,
          context: neighbors.filter(neighbor => neighbor.id !== turn.id).map(neighbor => ({ role: neighbor.role, content: neighbor.content.slice(0, 800) })) };
      });
      const selected = validateHistorySelection(await options.model.select({ message: options.message, plan, candidates }, options.signal), rows);
      ambiguous ||= selected.status === "ambiguous";
      for (const match of selected.matches) {
        if (!candidates.find(candidate => candidate.id === match.turn.id)?.content.includes(match.quote)) throw new Error("Quote was not in supplied evidence");
        matches.set(match.turn.id, match);
      }
      if (!coverage.hasMore || matches.size >= 10) break;
      const last = rows.at(-1)!;
      cursor = { ts: last.ts, id: last.id };
    }
    options.signal.throwIfAborted();
    const selected = [...matches.values()].slice(0, 10).sort((a, b) => a.turn.ts.getTime() - b.turn.ts.getTime() || a.turn.id - b.turn.id);
    coverage.hasMore ||= matches.size > selected.length;
    if (!selected.length) return result("not_found", "no_supported_message");
    // Re-read after inference: a deletion during a slow model call invalidates
    // the answer before any text is streamed.
    const fresh = await store.historySources(options.userId, selected.map(match => match.turn.id), options.before);
    if (fresh.length !== selected.length || !fresh.every(turn => inScope(turn, options, coverage.ranges))) return result("unavailable", "selected_message_unavailable");
    return result(ambiguous || selected.length > 1 && plan.operation === "when" ? "ambiguous" : "matched", "original_user_messages", selected,
      [...new Map(selected.flatMap(match => context.get(match.turn.id) ?? []).map(turn => [turn.id, turn])).values()]);
  } catch (error) {
    if (options.signal.aborted && options.signal.reason?.name !== "TimeoutError") throw error;
    return result("unavailable", "history_verification_failed");
  }
}

function literal(text: string): string {
  return text.replace(/[\\`*_{}\[\]()#+.!|<>~\-]/g, "\\$&").replace(/\r\n?|\n/g, " ");
}

/** All displayed facts come from validated original records, never generated prose. */
export function renderHistoryAnswer(answer: HistoryAnswer, plan: RecallPlan, clock: Clock): string {
  if (answer.status === "unresolved") return answer.reason.startsWith("date_")
    ? "Which calendar date do you mean? Please use a date such as 15 November 2026."
    : "I don't have a verified earlier message to attach that reference to. Which topic or conversation do you mean?";
  if (answer.status === "unavailable") return "I couldn't verify the original saved message, so I can't reliably confirm the request or give its time.";
  const scope = answer.coverage.scope === "session" ? "this conversation" : "your saved conversations";
  const dates = answer.coverage.ranges.map(range => literal(range.label)).join(", ");
  const checked = `${scope}${dates ? ` for ${dates}` : ""}`;
  if (answer.status === "not_found") return `I couldn't locate an original matching message in ${checked} that I checked, so I can't reliably confirm it or give its time.${answer.coverage.hasMore ? " Some matching history remains unchecked." : ""} This doesn't establish that you never asked.`;
  const timestamp = new Intl.DateTimeFormat("en-GB", { timeZone: clock.tz, day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const lines = answer.matches.map(({ turn, quote }) => `- **${timestamp.format(turn.ts)} (${literal(clock.tz)})** — “${literal(quote)}”${quote !== turn.content ? " *(excerpt)*" : ""}`).join("\n\n");
  const heading = answer.status === "ambiguous" ? answer.matches.length > 1 ? "I found several possible earlier messages. Which one do you mean?" : "I found a possible earlier message, but can't confidently match it to your question. Is this the one you mean?"
    : plan.operation === "exists" ? "Yes — I found this earlier message in your saved history:" : "I found these original messages in your saved history:";
  return `${heading}\n\n${lines}${answer.coverage.hasMore ? "\n\nAdditional matching messages remain unchecked; these are not an exhaustive list or a verified earliest occurrence." : ""}`;
}
