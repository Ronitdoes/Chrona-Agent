import type { Clock } from "../clock";
import type { HistoryCursor } from "../history";
import type { Store } from "../store";
import { historySummarySchema, type RecallModel, type SummaryInput } from "./plan";
import { loadQuestionHistory, renderQuestionHistoryResult, type HistoryListing, type QuestionHistory } from "./history-list";
import type { HistoryResponse } from "./collection";

/** Bound inference independently of the inventory's retrieval/output limits. */
export function summaryInput(history: QuestionHistory, message: string): { input: SummaryInput; truncated: boolean } {
  let remaining = 24_000;
  let truncated = history.truncated;
  const messages: SummaryInput["messages"] = [];
  for (const row of [...history.messages].sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id)) {
    if (!remaining || messages.length === 100) { truncated = true; break; }
    const content = row.content.slice(0, Math.min(2000, remaining));
    truncated ||= content.length !== row.content.length;
    remaining -= content.length;
    messages.push({ id: row.id, content });
  }
  return { input: { message, messages }, truncated };
}

/** Validate source membership and complete, nonduplicated coverage, not semantic entailment. */
export function validateSummary(output: unknown, input: SummaryInput) {
  const summary = historySummarySchema.parse(output);
  const remaining = new Set(input.messages.map(row => row.id));
  for (const item of summary.items) {
    if (!remaining.delete(item.turnId)) throw new Error("Each summary item requires one original message");
  }
  if (remaining.size) throw new Error("Summary omitted supplied messages");
  return summary;
}

const literal = (text: string) => text.replace(/[\\`*_{}\[\]()#+.!|<>~\-]/g, "\\$&").replace(/\r\n?|\n/g, " ");

export async function summarizeQuestionHistory(options: {
  userId: string; request: HistoryListing; before: HistoryCursor; clock: Clock;
  message: string; model: Pick<RecallModel, "summarize">; signal: AbortSignal;
  history?: QuestionHistory;
}, store: Pick<Store, "userMessagesFor" | "historySources">): Promise<HistoryResponse> {
  const load = async (): Promise<QuestionHistory> => {
    if (!options.history) return loadQuestionHistory(options, store);
    const ids = options.history.messages.map(row => row.id);
    const messages = await store.historySources(options.userId, ids, options.before);
    if (messages.length !== ids.length) throw new Error("Collection source unavailable");
    return { messages, truncated: options.history.truncated };
  };
  const history = await load();
  if (!history.messages.length) return renderQuestionHistoryResult(history, options.request, options.clock);
  const { input, truncated } = summaryInput(history, options.message);
  try {
    // Fetch earlier USER messages in each anchor's own session without the day's
    // filter. They explain references, but never become selected-day messages.
    const anchors = new Map(history.messages.map(row => [row.id, row]));
    const contextFor = async (id: number) => {
      options.signal.throwIfAborted();
      const anchor = anchors.get(id)!;
      const rows = await store.userMessagesFor(options.userId, { sessionId: anchor.sessionId, before: { ts: anchor.ts, id }, limit: 4 });
      return rows.filter(row => row.userId === options.userId && row.sessionId === anchor.sessionId &&
        (row.ts < anchor.ts || row.ts.getTime() === anchor.ts.getTime() && row.id < id)).slice(0, 4)
        .reverse().map(row => ({ id: row.id, content: row.content.slice(0, 800), timestamp: row.ts.toISOString() }));
    };
    const contexts = await Promise.all(input.messages.map(row => contextFor(row.id)));
    let contextBudget = 16_000;
    input.messages.forEach((row, index) => {
      row.context = contexts[index].slice().reverse().flatMap(context => {
        if (!contextBudget) return [];
        const content = context.content.slice(0, contextBudget);
        contextBudget -= content.length;
        return [{ ...context, content }];
      }).reverse();
    });
    const summary = validateSummary(await options.model.summarize(input, options.signal), input);
    // Deletions/edits during inference invalidate the generated summary.
    const fresh = await load();
    const originals = new Map(history.messages.map(row => [row.id, row]));
    const current = new Map(fresh.messages.map(row => [row.id, row]));
    if (!input.messages.every(row => current.get(row.id)?.content === originals.get(row.id)?.content &&
      current.get(row.id)?.ts.getTime() === originals.get(row.id)?.ts.getTime())) throw new Error("Summary source changed");
    const contextIds = [...new Set(input.messages.flatMap(row => row.context?.map(context => context.id) ?? []))];
    const contextSources = await store.historySources(options.userId, contextIds, options.before);
    const currentContext = new Map(contextSources.map(row => [row.id, row]));
    if (!input.messages.every(row => row.context?.every(context => {
      const source = currentContext.get(context.id), anchor = originals.get(row.id)!;
      return source?.userId === options.userId && source.role === "user" && source.sessionId === anchor.sessionId &&
        source.ts.toISOString() === context.timestamp && source.content.startsWith(context.content);
    }))) throw new Error("Summary context changed");
    const timestamp = new Intl.DateTimeFormat("en-GB", { timeZone: options.clock.tz, dateStyle: "medium", timeStyle: "short" });
    const label = options.request.ranges.map(range => range.label).join(", ") || (options.request.sessionId ? "this conversation" : "all saved conversations");
    const groups = new Map<string, { summary: string; turnIds: number[] }>();
    for (const item of summary.items) {
      const original = originals.get(item.turnId)!;
      const key = `${original.content.trim().replace(/\s+/g, " ").toLowerCase()}\0${item.summary.trim().toLowerCase()}`;
      const group = groups.get(key);
      if (group) group.turnIds.push(item.turnId);
      else groups.set(key, { summary: item.summary, turnIds: [item.turnId] });
    }
    const items = [...groups.values()].map(item => {
      const rows = item.turnIds.map(id => originals.get(id)!).sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.id - b.id);
      const start = timestamp.format(rows[0].ts);
      const end = timestamp.format(rows.at(-1)!.ts);
      return { first: rows[0], text: `- ${literal(item.summary)} (${rows.length} message${rows.length === 1 ? "" : "s"}; ${start}${end !== start ? ` – ${end}` : ""})` };
    }).sort((a, b) => a.first.ts.getTime() - b.first.ts.getTime() || a.first.id - b.first.id);
    return { text: `Summary of **${input.messages.length}** earlier messages for **${literal(label)}** (times in **${literal(options.clock.tz)}**), as of **${timestamp.format(options.clock.instant)}**:\n\n${items.map(item => item.text).join("\n\n")}${truncated ? "\n\nSome older messages or long-message details were omitted by the summary budget; this is not a complete summary." : ""}`, sourceTurnIds: input.messages.map(row => row.id), truncated };
  } catch {
    options.signal.throwIfAborted();
    // A failed summary is not evidence of missing history. Preserve fresh originals.
    const fresh = await load();
    const fallback = renderQuestionHistoryResult(fresh, options.request, options.clock);
    return { ...fallback, text: `I couldn't create a reliable summary. Here are the saved messages instead:\n\n${fallback.text}` };
  }
}
