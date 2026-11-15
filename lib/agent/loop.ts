import { randomUUID } from "node:crypto";
import type { MessageParam, TextBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import pTimeout, { TimeoutError } from "p-timeout";
import { monotonicMs } from "../clock";
import { fitBudget, wrapResults, type SearchResult } from "../tools/results";
import { webSearch, type WebSearchResult } from "../tools/webSearch";
import { type AgentEvents, type SendEvent, type Source } from "./events";
import { createConfiguredModel, type AgentModel, type ModelReply, type ModelStream, type ModelRequest } from "./model";
import { dataBlock } from "./prompt";
import { webSearchInput, webSearchTool } from "./schema";
import { modelFailure, modelFailureMessage, recoveryDelay, type ModelFailure } from "./errors";
import { requiresWebSearch } from "./search-policy";
import type { ModelSelection } from "../model-selection";

type Budgets = {
  maxSteps: number; maxQueries: number; maxWallMs: number; finalReserveMs: number;
  resultTokens: number; outputTokens: number;
};
const defaults: Budgets = { maxSteps: 4, maxQueries: 10, maxWallMs: 45_000, finalReserveMs: 5000, resultTokens: 8000, outputTokens: 2048 };
type Search = (input: unknown, options: { signal: AbortSignal }) => Promise<WebSearchResult>;
type RunOptions = {
  system: TextBlockParam[]; messages: MessageParam[]; send: SendEvent;
  turnId?: string; signal?: AbortSignal; model?: AgentModel; search?: Search;
  time?: () => number; budgets?: Partial<Budgets>;
  selection?: ModelSelection;
};

export async function runAgent(options: RunOptions) {
  const time = options.time ?? monotonicMs;
  const started = time();
  const elapsed = () => Math.max(0, time() - started);
  const limits = { ...defaults, ...options.budgets };
  const turnId = options.turnId ?? randomUUID();
  const messages = [...options.messages];
  const current = messages.findLast((message) => message.role === "user");
  const requireSearch = typeof current?.content === "string" && requiresWebSearch(current.content);
  const sources = new Map<string, Source>();
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

  async function streamStep(model: AgentModel, request: ModelRequest, milliseconds: number): Promise<ModelReply> {
    const stepController = new AbortController();
    const stepSignal = AbortSignal.any([signal, stepController.signal]);
    let stream: ModelStream | undefined;
    let hasText = false;
    const forward = (delta: string) => {
      if (!hasText && delta) { if (text) append("\n\n"); hasText = true; }
      append(delta);
    };
    try {
      return await pTimeout((async () => {
        stepSignal.throwIfAborted();
        stream = model.stream(request, { signal: stepSignal });
        for await (const event of stream) {
          stepSignal.throwIfAborted();
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") forward(event.delta.text);
        }
        const reply = await stream.finalMessage();
        stepSignal.throwIfAborted();
        if (!hasText) for (const block of reply.content) if (block.type === "text") forward(block.text);
        return reply;
      })(), { milliseconds, signal });
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
      if (searchCount >= limits.maxQueries) { reasons.add("query limit"); forceFinal = true; }
      if (elapsed() >= limits.maxWallMs - limits.finalReserveMs) { reasons.add("time limit"); forceFinal = true; }
      const last = index === limits.maxSteps - 1;
      const final = last || forceFinal;
      const remaining = limits.maxWallMs - elapsed() - (final ? 0 : limits.finalReserveMs);
      const system: TextBlockParam[] = [...options.system];
      if (final) system.push({ type: "text", text: `Final response; tools are disabled. Answer now using existing evidence or clearly say what could not be verified. Do not announce another search or claim a match is live without a current source timestamp.\n${report()}` });
      if (recoveryUsed) system.push({ type: "text", text: `The previous request failed. Give a concise final answer from existing evidence. Never invent a live score or timestamp. Continue without repeating this partial text (earlier text may be omitted):\n${dataBlock("already_shown", text.slice(-160))}` });
      let reply: ModelReply;
      steps++;
      try {
        reply = await streamStep(model, {
          model: "claude-sonnet-5-5", max_tokens: recoveryUsed ? Math.min(limits.outputTokens, 512) : limits.outputTokens, system, messages: [...messages],
          tools: [webSearchTool], tool_choice: final ? { type: "none" }
            : index === 0 && requireSearch ? { type: "tool", name: "web_search", disable_parallel_tool_use: true }
              : { type: "auto", disable_parallel_tool_use: true },
        }, Math.max(1, remaining));
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
        if (reply.stop_reason === "max_tokens" || reply.stop_reason === "model_context_window_exceeded") {
          reasons.add("output limit"); emit("error", { message: "The answer reached its output limit." });
        }
        break;
      }
      if (final) {
        if (last) reasons.add("step limit");
        emit("error", { message: "The model requested a search after research had ended." });
        for (const call of calls) {
          const parsed = webSearchInput.safeParse(call.input);
          if (parsed.success) parsed.data.queries.forEach((query) => unverified.add(query));
        }
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
        try {
          const found = await pTimeout(search({ ...parsed.data, queries }, { signal: searchSignal }), {
            milliseconds: Math.max(1, limits.maxWallMs - limits.finalReserveMs - elapsed()), signal,
          });
          signal.throwIfAborted();
          if (found.error) {
            if (found.error.code === "output_budget") reasons.add("search output limit");
            throw new Error("Search returned no usable evidence");
          }
          const skipped = parsed.data.queries.slice(available).map((query) => ({
            query, results: [], error: { code: "search_failed" as const, message: "Not run: query budget reached." },
          }));
          const bounded = fitBudget([...found.queries, ...skipped], limits.resultTokens);
          bounded.payload.truncated ||= found.truncated;
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
          emit("status", { id, kind: "search", queries, state: "done", count });
        }
        emit("sources", [...sources.values()]);
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
    if (!text.trim()) append("I couldn't complete an answer from the available evidence.");
    const budgetReasons = [...reasons].filter((reason) => reason !== "response failure");
    if (budgetReasons.length) {
      const searched = [...completed].slice(0, 10).map((query) => query.slice(0, 200)).join("; ") || "none";
      const unchecked = [...unverified].slice(0, 10).map((query) => query.slice(0, 200)).join("; ") || "any checks not supported by the sources above";
      append(`\n\nResearch ended because of ${budgetReasons.join(", ")}. Searches completed: ${searched}. Unverified: ${unchecked}.`);
    }
  }
  const totalMs = elapsed();
  const timing = { turnId, ttftMs: ttftMs ?? 0, totalMs };
  emit("done", timing);
  return { ...timing, text, searchCount, steps, sources: [...sources.values()], evidence: [...evidence.values()], messages, modelFailures,
    limits: [...reasons], completedQueries: [...completed], unverifiedQueries: [...unverified] };
}
