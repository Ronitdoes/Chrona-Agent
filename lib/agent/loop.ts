import { buildRichAnswer, type RichAnswerV1 } from "../answer-blocks";
import type { ImageCandidates } from "../tools/webSearch";
import { answerDetailInstruction, answerDetailProfiles, answerOutputTokens, type AnswerDetail } from "../answer-detail";
import { randomUUID } from "node:crypto";
import type { MessageParam, TextBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import pTimeout, { TimeoutError } from "p-timeout";
import { monotonicMs, type Clock } from "../clock";
import { fitBudget, wrapResults, type SearchResult } from "../tools/results";
import { webSearch, type WebSearchResult } from "../tools/webSearch";
import { type AgentEvents, type SendEvent, type Source } from "./events";
import { createConfiguredModel, type AgentModel, type ModelReply, type ModelStream, type ModelRequest } from "./model";
import { dataBlock } from "./prompt";
import { webSearchInput, webSearchTool } from "./schema";
import { modelFailure, modelFailureMessage, recoveryDelay, type ModelFailure } from "./errors";
import { isLiveScoreRequest, requiresWebSearch } from "./search-policy";
import { researchFallback } from "./research-fallback";
import type { ModelSelection } from "../model-selection";
import { effortProfiles, limitResearchSources, type ResearchEffort } from "../research-effort";
import { reviewSportsCalendar } from "./calendar-review";

type Budgets = {
  maxSteps: number; maxQueries: number; maxWallMs: number; finalReserveMs: number;
  resultTokens: number; outputTokens: number;
};
const defaults: Budgets = { maxSteps: 4, maxQueries: 10, maxWallMs: 45_000, finalReserveMs: 10_000, resultTokens: 8000, outputTokens: 2048 };
// Gemini counts thought tokens against maxOutputTokens. Recovery still needs
// room for a complete answer, so its ceiling is generous but bounded.
const recoveryOutputTokens = 8_192;
type Search = (input: unknown, options: { signal: AbortSignal; fresh?: boolean }) => Promise<WebSearchResult>;
type RunOptions = {
  system: TextBlockParam[]; messages: MessageParam[]; send: SendEvent;
  turnId?: string; signal?: AbortSignal; model?: AgentModel; search?: Search;
  time?: () => number; budgets?: Partial<Budgets>;
  selection?: ModelSelection;
  effort?: ResearchEffort;
  answerDetail?: AnswerDetail;
  clock?: Clock;
};

export async function runAgent(options: RunOptions) {
  const time = options.time ?? monotonicMs;
  const started = time();
  const elapsed = () => Math.max(0, time() - started);
  const profile = options.effort ? effortProfiles[options.effort] : undefined;
  const answerDetail = options.answerDetail ?? "auto";
  const answerProfile = answerDetailProfiles[answerDetail];
  const limits = { ...defaults, ...profile,
    maxWallMs: (profile?.maxWallMs ?? defaults.maxWallMs) + answerProfile.extraFinalMs,
    finalReserveMs: (profile?.finalReserveMs ?? defaults.finalReserveMs) + answerProfile.extraFinalMs,
    outputTokens: answerOutputTokens(options.selection), ...options.budgets,
  };
  if (profile) limits.maxQueries = Math.min(limits.maxQueries, profile.maxQueries);
  const turnId = options.turnId ?? randomUUID();
  const messages = [...options.messages];
  const current = messages.findLast((message) => message.role === "user");
  const requireSearch = typeof current?.content === "string" && requiresWebSearch(current.content);
  const liveLookup = typeof current?.content === "string" && isLiveScoreRequest(current.content);
  const sources = new Map<string, Source>();
  let answerUi: RichAnswerV1 | undefined;
  const imageCandidates: ImageCandidates = {};
  const evidence = new Map<string, SearchResult>();
  const completed = new Set<string>();
  const unverified = new Set<string>();
  const reasons = new Set<string>();
  const modelFailures: ModelFailure[] = [];
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let deliveryFailed = false;
  let text = "";
  let ttftMs: number | undefined;
  let searchCount = 0;
  let steps = 0;
  let searchId = 0;
  let forceFinal = false;
  let recoveryUsed = false;
  let terminalFailure: ModelFailure | undefined;
  let answerCompleted = false;
  let finalRepairUsed = false;
  let calendarRepairUsed = false;

  const emit = <K extends keyof AgentEvents>(event: K, data: AgentEvents[K]) => {
    if (deliveryFailed) return;
    try { options.send(event, data); }
    catch { deliveryFailed = true; controller.abort(); }
  };
  const append = (delta: string) => {
    if (!delta) return;
    ttftMs ??= elapsed();
    text += delta;
    emit("delta", { text: delta });
  };
  const report = () => dataBlock("research_progress", {
    limits: [...reasons], completedCount: completed.size, unverifiedQueries: [...unverified].slice(0, 3).map(query => query.slice(0, 120)), searchCount,
  });
  const errorResult = (id: string, message: string): ToolResultBlockParam => ({
    type: "tool_result", tool_use_id: id, is_error: true,
    content: wrapResults({ queries: [], truncated: false, error: { code: "search_failed", message } }),
  });
  async function waitForRecovery(milliseconds: number): Promise<void> {
    if (!milliseconds) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
      const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(signal.reason); };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  async function streamStep(model: AgentModel, request: ModelRequest, milliseconds: number, answerMilliseconds: number): Promise<ModelReply> {
    const stepStarted = time();
    const stepController = new AbortController();
    const stepSignal = AbortSignal.any([signal, stepController.signal]);
    let stream: ModelStream | undefined;
    let hasText = false;
    let startAnswer!: () => void;
    const answerStarted = new Promise<void>(resolve => { startAnswer = resolve; });
    const forward = (delta: string) => {
      if (!hasText && delta) { if (text) append("\n\n"); hasText = true; }
      append(delta);
    };
    try {
      const work = (async () => {
        stepSignal.throwIfAborted();
        stream = model.stream(request, { signal: stepSignal });
        for await (const event of stream) {
          stepSignal.throwIfAborted();
          if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
            startAnswer();
            if (!liveLookup) forward(event.delta.text);
          }
        }
        const reply = await stream.finalMessage();
        stepSignal.throwIfAborted();
        if (!liveLookup && !hasText) for (const block of reply.content) if (block.type === "text") forward(block.text);
        return reply;
      })();
      // A direct answer can start in a tools-enabled turn. Once text starts,
      // let it finish within the answer deadline instead of cutting it off at
      // the research deadline and regenerating the already-streamed answer.
      const first = await pTimeout(Promise.race([
        work.then(reply => ({ reply })),
        answerStarted.then(() => null),
      ]), { milliseconds, signal });
      if (first) return first.reply;
      return await pTimeout(work, { milliseconds: Math.max(1, answerMilliseconds - (time() - stepStarted)), signal });
    } finally {
      stepController.abort();
      stream?.abort();
    }
  }

  try {
    if (!Number.isInteger(limits.maxSteps) || limits.maxSteps < 1 || limits.maxSteps > 4 ||
      !Number.isInteger(limits.maxQueries) || limits.maxQueries < 0 || limits.maxQueries > 10 ||
      !Number.isFinite(limits.maxWallMs) || limits.maxWallMs <= 0 ||
      !Number.isFinite(limits.finalReserveMs) || limits.finalReserveMs <= 0 || limits.finalReserveMs > limits.maxWallMs ||
      !Number.isInteger(limits.resultTokens) || limits.resultTokens < 512 ||
      !Number.isInteger(limits.outputTokens) || limits.outputTokens < 1) throw new Error("Invalid agent budgets");
    signal.throwIfAborted();
    const model = options.model ?? await createConfiguredModel(options.selection);
    const search = options.search ?? webSearch;

    for (let index = 0; index < limits.maxSteps; index++) {
      signal.throwIfAborted();
      if (elapsed() >= limits.maxWallMs) { reasons.add("time limit"); break; }
      if (searchCount >= limits.maxQueries) forceFinal = true;
      if (liveLookup && searchId >= 2) forceFinal = true;
      if (options.effort === "instant" && searchId) forceFinal = true;
      if (elapsed() >= limits.maxWallMs - limits.finalReserveMs) { reasons.add("time limit"); forceFinal = true; }
      const last = index === limits.maxSteps - 1;
      // Reserve a synthesis turn and, where the step budget permits, one
      // correction if the model still asks to search with tools disabled.
      const researchSteps = Math.max(1, limits.maxSteps - 2);
      const final = last || index >= researchSteps || forceFinal;
      const remaining = limits.maxWallMs - elapsed() - (final ? 0 : limits.finalReserveMs);
      const system: TextBlockParam[] = [...options.system, { type: "text", text: answerDetailInstruction(answerDetail) }];
      if (profile) system.push({ type: "text", text: `Research effort: ${profile.label}. For a research question, aim for ${profile.range} focused search queries and up to ${profile.maxSources} distinct useful sources, batching queries (maximum six per call). The hard query cap is ${profile.maxQueries}. Stop sooner for a simple answer or if sources are unavailable; never pad searches or invent sources to fill a quota. Use more of the budget to resolve genuine gaps and cross-check claims. Research and final synthesis share the same time budget.` });
      if (!final) system.push({ type: "text", text: `There are at most ${researchSteps - index} search rounds left before final synthesis. Batch related checks into the available rounds. Request needed searches directly. Start answer text when ready to deliver the answer. Then answer from the evidence, distinguishing confirmed details from speculation or details that could not be verified.` });
      if (final) system.push({ type: "text", text: `Final response; tools are disabled. Preserve the requested answer detail and format. Answer now using existing evidence or clearly say what could not be verified. Cite the strongest relevant sources. For a score, state the match date/status and update timestamp only if supported; otherwise explain the specific verification gap. Do not announce another search or claim a match is live without a current source timestamp.\n${report()}` });
      if (recoveryUsed) system.push({ type: "text", text: `The previous request failed. Give a concise final answer from existing evidence. Never invent a live score or timestamp. Continue without repeating this partial text (earlier text may be omitted):\n${dataBlock("already_shown", text.slice(-160))}` });
      let reply: ModelReply;
      steps++;
      try {
        reply = await streamStep(model, {
          model: "claude-sonnet-5-5", max_tokens: recoveryUsed ? Math.min(limits.outputTokens, recoveryOutputTokens) : limits.outputTokens, system, messages: [...messages],
          // Recovery uses the text-only low-thinking path so thought tokens do not consume its answer budget.
          ...(options.effort && !recoveryUsed ? { researchEffort: options.effort } : {}),
          tools: [webSearchTool], tool_choice: final ? { type: "none" }
            : index === 0 && requireSearch ? { type: "tool", name: "web_search", disable_parallel_tool_use: true }
              : { type: "auto", disable_parallel_tool_use: true },
        }, Math.max(1, remaining), Math.max(1, limits.maxWallMs - elapsed()));
      } catch (error) {
        if (error instanceof TimeoutError && !final && !signal.aborted) {
          reasons.add("time limit"); forceFinal = true; continue;
        }
        if (!signal.aborted) {
          const failure = modelFailure(error);
          modelFailures.push(failure);
          const delay = recoveryDelay(failure);
          const remaining = limits.maxWallMs - elapsed();
          if (!recoveryUsed && evidence.size && index + 1 < limits.maxSteps && delay !== null && delay + limits.finalReserveMs < remaining) {
            recoveryUsed = true;
            forceFinal = true;
            await waitForRecovery(delay);
            continue;
          }
          terminalFailure = failure;
        }
        throw error;
      }
      const calls = reply.content.filter((block) => block.type === "tool_use");
      if (!calls.length) {
        const answer = reply.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        const calendarIssue = liveLookup ? reviewSportsCalendar(answer, typeof current?.content === "string" ? current.content : "", options.clock) : null;
        if (calendarIssue) {
          if (!calendarRepairUsed && index + 1 < limits.maxSteps && limits.maxWallMs - elapsed() > 1000) {
            calendarRepairUsed = true;
            forceFinal = true;
            messages.push({ role: "assistant", content: reply.content }, { role: "user", content: `Correct the previous answer before showing it. ${calendarIssue} Use only existing evidence, keep the same match identity, write dates as day + month name + four-digit year and cite the supporting sources. If the dates or status cannot be reconciled, say they could not be verified. Do not search again.` });
            continue;
          }
          reasons.add("response failure");
          emit("error", { message: "The answer's dates and match status could not be reconciled. Available sources are preserved as unverified." });
          break;
        }
        if (liveLookup && answer) append(`${text ? "\n\n" : ""}${answer}`);
        answerCompleted = reply.content.some(block => block.type === "text" && block.text.trim());
        if (reply.stop_reason === "max_tokens" || reply.stop_reason === "model_context_window_exceeded") {
          reasons.add("output limit"); emit("error", { message: "The answer reached its output limit." });
        }
        if (recoveryUsed && answerCompleted) append("\n\nA provider interruption occurred; this answer was recovered from the search results already collected.");
        break;
      }
      if (liveLookup && !final) for (const block of reply.content) if (block.type === "text" && block.text) append(`${text ? "\n\n" : ""}${block.text}`);
      if (final) {
        for (const call of calls) {
          const parsed = webSearchInput.safeParse(call.input);
          if (parsed.success) parsed.data.queries.forEach((query) => unverified.add(query));
        }
        if (!last && !finalRepairUsed) {
          finalRepairUsed = true;
          forceFinal = true;
          messages.push({ role: "assistant", content: reply.content }, { role: "user", content: calls.map(call => errorResult(call.id, "No further searches can run. Preserve the requested answer detail and format. Give an answer from existing evidence, or explain what could not be verified and cite the available sources.")) });
          continue;
        }
        if (last) reasons.add("step limit");
        emit("error", { message: "The research limit was reached before a complete answer could be verified. Available sources are preserved." });
        break;
      }
      messages.push({ role: "assistant", content: reply.content });
      const results: ToolResultBlockParam[] = [];
      for (const call of calls) {
        if (call.name !== "web_search") {
          results.push(errorResult(call.id, "Only web_search is available. No other tool can run.")); continue;
        }
        const parsed = webSearchInput.safeParse(call.input);
        if (!parsed.success) {
          results.push(errorResult(call.id, "Invalid web_search arguments. Supply one to six queries and valid filters.")); continue;
        }
        const available = Math.max(0, limits.maxQueries - searchCount);
        const queries = parsed.data.queries.slice(0, available);
        parsed.data.queries.slice(available).forEach((query) => unverified.add(query));
        if (queries.length < parsed.data.queries.length) { reasons.add("query limit"); forceFinal = true; }
        if (liveLookup && searchId >= 2) {
          forceFinal = true;
          queries.forEach(query => unverified.add(query));
          results.push(errorResult(call.id, "The two live-score search passes are complete. Answer from the available evidence; explain missing fixture details or update times without another search."));
          continue;
        }
        if (!queries.length || elapsed() >= limits.maxWallMs - limits.finalReserveMs) {
          queries.forEach((query) => unverified.add(query));
          if (queries.length) { reasons.add("time limit"); forceFinal = true; }
          results.push(errorResult(call.id, "Research budget reached. No further searches ran; answer with the available evidence.")); continue;
        }
        const id = `s${++searchId}`;
        searchCount += queries.length;
        emit("status", { id, kind: "search", queries, state: "running", count: 0 });
        const searchController = new AbortController();
        const searchSignal = AbortSignal.any([signal, searchController.signal]);
        let count = 0;
        let usage: AgentEvents["status"]["usage"];
        try {
          const found = await pTimeout(search({ ...parsed.data, queries, include_images: Boolean(parsed.data.include_images !== false && (answerUi?.images.length ?? 0) < 4) }, { signal: searchSignal, ...(liveLookup ? { fresh: true } : {}) }), {
            milliseconds: Math.max(1, limits.maxWallMs - limits.finalReserveMs - elapsed()), signal,
          });
          usage = found.usage;
          Object.assign(imageCandidates, found.images ?? {});
          signal.throwIfAborted();
          if (found.error) {
            if (found.error.code === "output_budget") reasons.add("search output limit");
            throw new Error("Search returned no usable evidence");
          }
          const skipped = parsed.data.queries.slice(available).map((query) => ({
            query, results: [], error: { code: "search_failed" as const, message: "Not run: query budget reached." },
          }));
          const selected = profile ? limitResearchSources([...found.queries, ...skipped], new Set(evidence.keys()), profile.maxSources) : { queries: [...found.queries, ...skipped], truncated: false };
          const bounded = fitBudget(selected.queries, limits.resultTokens);
          bounded.payload.truncated ||= found.truncated || selected.truncated;
          bounded.content = wrapResults(bounded.payload);
          const failed = found.is_error || Boolean(bounded.payload.error);
          for (const query of queries) {
            const evidence = bounded.payload.queries.find((item) => item.query === query);
            if (failed || !evidence || evidence.error) {
              if (!completed.has(query)) unverified.add(query);
            } else { completed.add(query); unverified.delete(query); }
          }
          for (const query of bounded.payload.queries) for (const item of query.results) {
            const domain = new URL(item.url).hostname;
            count++;
            sources.set(item.url, { url: item.url, title: item.title, domain, publishedDate: item.published_date, isOfficial: item.is_official });
            evidence.set(item.url, item);
          }
          results.push({ type: "tool_result", tool_use_id: call.id, is_error: failed, content: bounded.content });
        } catch (error) {
          queries.forEach((query) => unverified.add(query));
          if (error instanceof TimeoutError) { reasons.add("time limit"); forceFinal = true; }
          if (signal.aborted) throw error;
          results.push(errorResult(call.id, "Search failed or timed out. These queries remain unverified."));
        } finally {
          searchController.abort();
          emit("status", { id, kind: "search", queries, state: "done", count, ...(usage ? { usage } : {}) });
        }
        emit("sources", [...sources.values()]);
        if (sources.size) {
          const snapshot = buildRichAnswer([...sources.values()], imageCandidates, answerUi);
          if (JSON.stringify(snapshot) !== JSON.stringify(answerUi)) {
            answerUi = snapshot;
            emit("answer_ui", snapshot);
          }
        }
      }
      messages.push({ role: "user", content: results });
    }
  } catch {
    emit("error", { message: signal.aborted ? "The request was cancelled." : modelFailureMessage(terminalFailure ?? { provider: "unknown", kind: "unknown" }, evidence.size > 0) });
    if (!signal.aborted) reasons.add("response failure");
  } finally {
    controller.abort();
  }

  if (!options.signal?.aborted && !deliveryFailed) {
    if (!answerCompleted && (evidence.size || liveLookup && searchCount)) append(`${text ? "\n\n" : ""}${researchFallback([...evidence.values()], liveLookup)}`);
    else if (!text.trim()) append("I couldn't complete an answer from the available evidence.");
    const budgetReasons = [...reasons].filter((reason) => reason !== "response failure");
    if (budgetReasons.length) {
      const searched = [...completed].slice(0, 10).map((query) => query.slice(0, 200)).join("; ") || "none";
      const unchecked = [...unverified].slice(0, 10).map((query) => query.slice(0, 200)).join("; ") || "any checks not supported by the sources above";
      append(liveLookup
        ? `\n\nResearch stopped at the ${budgetReasons.join(", ")} after ${searchCount} queries. Details without supporting evidence remain unverified.`
        : `\n\nResearch ended because of ${budgetReasons.join(", ")}. Searches completed: ${searched}. Unverified: ${unchecked}.`);
    }
  }
  const totalMs = elapsed();
  const timing = { turnId, ttftMs: ttftMs ?? 0, totalMs };
  emit("done", timing);
  return { ...timing, text, searchCount, steps, sources: [...sources.values()], evidence: [...evidence.values()], messages, modelFailures,
    limits: [...reasons], completedQueries: [...completed], unverifiedQueries: [...unverified] };
}
