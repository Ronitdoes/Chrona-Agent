import { answerDetailSchema } from "./answer-detail";
import { randomUUID } from "node:crypto";
import pTimeout from "p-timeout";
import { z } from "zod";
import { runAgent } from "./agent/loop";
import { sse, textChunks, type AgentEvents, type SendEvent } from "./agent/events";
import { assemble, dataBlock } from "./agent/prompt";
import type { ModelFailure } from "./agent/errors";
import { now, monotonicMs, dateFrom } from "./clock";
import { curate, type CurationResult, type CuratorStore } from "./curator/curate";
import { boundEvidence } from "./curator/schema";
import { jsonError, readJson, RequestError, timeZone } from "./http";
import { capRecall, retrieve, type RecallStore } from "./recall/retrieve";
import { acquireChat } from "./requestLimit";
import { getOrCreateSession, withSession } from "./session";
import { getStore, type Store } from "./store";
import type { Turn } from "./store/schema";
import type { SearchResult } from "./tools/results";
import { createTurnTrace } from "./trace";
import { modelSelectionSchema } from "./model-selection";
import { resolveModelSelection } from "./model-config";
import { loadQuestionHistory, renderQuestionHistoryResult, resolveHistoryRequest, type HistoryListing, type QuestionHistory } from "./recall/history-list";
import { effortSchema, effortTimeoutMs, researchBudgetAfterRecall } from "./research-effort";
import { configuredRecallModel } from "./recall/model";
import { planningContext, validatePlan, type RecallPlan } from "./recall/plan";
import { answerHistory, renderHistoryAnswer, type HistoryStore } from "./recall/history";
import { summarizeQuestionHistory } from "./recall/history-summary";
import { collectionSchema, loadCollection, saveCollection, type RecallCollection } from "./recall/collection";

const inputSchema = z.strictObject({
  message: z.string().trim().min(1).max(20_000), sessionId: z.uuid().optional(), tz: timeZone.optional(),
  selection: modelSelectionSchema.optional(),
  effort: effortSchema.default("medium"),
  answerDetail: answerDetailSchema.default("auto"),
  searchProvider: z.enum(["tavily", "exa"]).optional(),
});
type ChatStore = RecallStore & HistoryStore & Pick<Store, "saveTurn" | "historyFor" | "userMessagesFor"> & CuratorStore;
type Trace = { info(data: Record<string, unknown>, message: string): void; error(data: Record<string, unknown>, message: string): void };
type Dependencies = {
  after: (task: () => Promise<void>) => void;
  store: () => Promise<ChatStore>;
  retrieve: typeof retrieve;
  run: typeof runAgent;
  clock: typeof now;
  time: () => number;
  trace: (userId: string, sessionId: string) => Trace;
  acquire: typeof acquireChat;
  curate: typeof curate;
  resolveSelection: typeof resolveModelSelection;
  recallModel: typeof configuredRecallModel;
};

export function createChatHandler(overrides: Pick<Dependencies, "after"> & Partial<Omit<Dependencies, "after">>) {
  const deps: Dependencies = { store: getStore, retrieve, run: runAgent, clock: now, time: monotonicMs, trace: createTurnTrace, acquire: acquireChat, curate, resolveSelection: resolveModelSelection, recallModel: configuredRecallModel, ...overrides };
  return async function POST(request: Request): Promise<Response> {
    const started = deps.time();
    let input: z.infer<typeof inputSchema>;
    try {
      const parsed = inputSchema.safeParse(await readJson(request));
      if (!parsed.success) return jsonError("Supply a nonempty message (up to 20,000 characters), a valid timezone and an optional UUID sessionId.", 400);
      input = parsed.data;
    } catch (error) {
      return jsonError(error instanceof RequestError ? error.message : "Invalid request.", error instanceof RequestError ? error.status : 400);
    }
    let selection;
    try { selection = await deps.resolveSelection(input.selection); }
    catch (error) { return jsonError(error instanceof Error && error.message.startsWith("Add ") ? error.message : "The selected model is not available. Check the server configuration.", 400); }
    const session = getOrCreateSession(request, input.sessionId);
    const admission = deps.acquire(session.userId);
    if ("retryAfter" in admission) return withSession(jsonError("Please wait before sending another message.", 429, { "Retry-After": String(admission.retryAfter) }), session);
    const turnId = randomUUID();
    const trace = deps.trace(session.userId, session.sessionId);
    let calendar: ReturnType<typeof now>;
    let store: ChatStore;
    try { calendar = deps.clock(input.tz); store = await deps.store(); }
    catch {
      admission.release();
      trace.error({ turnId, recallMs: 0, ttftMs: 0, searchCount: 0, totalMs: deps.time() - started, userPersisted: false, assistantPersisted: false, failure: "initialization" }, "chat_turn");
      return withSession(jsonError("The chat service is temporarily unavailable.", 503), session);
    }

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) abort.abort();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    let closed = false;
    let sentDone = false;
    let assistantText = "";
    let answerUi: AgentEvents["answer_ui"] | undefined;
    let firstVisualMs: number | undefined;
    let snapshotBytes = 0;
    let assistantAt = calendar.instant;
    let recallMs = 0;
    let ttftMs: number | undefined;
    let totalMs = 0;
    let searchCount = 0;
    let failure: string | undefined;
    let userTurnId: number | undefined;
    let assistantTurnId: number | undefined;
    let evidence: SearchResult[] = [];
    let curation: CurationResult | undefined;
    let modelFailures: ModelFailure[] = [];
    let skipCuration = false;
    let answerMode = "model";
    let recallSourceIds: number[] | undefined;
    let recallCollection: RecallCollection | undefined;
    let recallTrace: Record<string, unknown> | undefined;

    try {
      // Register while still in the request scope; this task waits for streaming to settle.
      deps.after(async () => {
        await finished;
        let assistantPersisted = false;
        try {
          const user = await userWrite;
          if ("failed" in user) failure ??= "user_persistence";
          else if (assistantText) {
            const saved = await store.saveTurn({ userId: session.userId, sessionId: session.sessionId, role: "assistant", content: assistantText, answerUi, ts: assistantAt, tz: calendar.tz,
              ...(!skipCuration ? { curation: { userTurnId: user.turn.id, evidence: failure || abort.signal.aborted ? [] : boundEvidence(evidence) } } : {}),
              ...(recallSourceIds !== undefined && !failure && !abort.signal.aborted ? { recall: { userTurnId: user.turn.id, sourceTurnIds: recallSourceIds, historyOnly: answerMode === "history", collection: recallCollection } } : {}),
            });
            assistantTurnId = saved.id;
            assistantPersisted = true;
          }
        } catch { failure ??= "assistant_persistence"; }
        finally {
          // A slow extractor must not keep the user's next message behind admission control.
          admission.release();
          // A curator failure never changes the saved transcript or the already-finished SSE response.
          try { if (!skipCuration) curation = await deps.curate(session.userId, { store, turnId: assistantTurnId, clock: () => deps.clock(calendar.tz), selection }); }
          catch { curation = { completed: 0, failed: 1, deferred: false }; }
          trace[failure ? "error" : "info"]({
            turnId, userTurnId, assistantTurnId, firstVisualMs, snapshotBytes, recallMs, ttftMs: ttftMs ?? 0, searchCount, totalMs,
            userPersisted: userTurnId !== undefined, assistantPersisted, cancelled: abort.signal.aborted, failure: failure ?? null,
            curation,
            modelFailures,
            provider: selection.provider, model: selection.model,
            effort: input.effort,
            answerDetail: input.answerDetail,
            answerMode, recall: recallTrace,
          }, "chat_turn");
        }
      });
    } catch {
      request.signal.removeEventListener("abort", onAbort);
      admission.release();
      trace.error({ turnId, recallMs: 0, ttftMs: 0, searchCount: 0, totalMs: deps.time() - started, failure: "background_registration" }, "chat_turn");
      return withSession(jsonError("The chat service is temporarily unavailable.", 503), session);
    }
    // Observe rejection immediately. The user write runs concurrently with recall.
    const userWrite: Promise<{ turn: Turn } | { failed: true }> = store.saveTurn({ userId: session.userId, sessionId: session.sessionId, role: "user", content: input.message, ts: calendar.instant, tz: calendar.tz })
      .then((turn) => { userTurnId = turn.id; return { turn }; }, () => ({ failed: true as const }));
    const excludeCurrent = async (rows: Promise<Turn[]>): Promise<Turn[]> => {
      const [turns, user] = await Promise.all([rows, userWrite]);
      if ("failed" in user) throw new Error("User persistence failed");
      return turns.filter((turn) => turn.id !== user.turn.id);
    };
    const recallStore: RecallStore = {
      ...store,
      turnsInRange: (...args) => excludeCurrent(store.turnsInRange(...args)),
      searchTurns: (...args) => excludeCurrent(store.searchTurns(...args)),
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send: SendEvent = (event, data) => {
          if (event === "answer_ui") {
            answerUi = data as AgentEvents["answer_ui"];
            snapshotBytes = Buffer.byteLength(JSON.stringify(answerUi), "utf8");
            if (answerUi.blocks.length) firstVisualMs ??= Math.max(0, deps.time() - started);
          }
          if (event === "delta") {
            const delta = data as AgentEvents["delta"];
            if (delta.text) ttftMs ??= Math.max(0, deps.time() - started);
            assistantText += delta.text;
          }
          if (event === "status" && (data as AgentEvents["status"]).state === "running") searchCount += (data as AgentEvents["status"]).queries.length;
          if (event === "error") failure ??= "agent";
          if (event === "done") {
            if (sentDone) return;
            sentDone = true;
            totalMs = Math.max(0, deps.time() - started);
            data = { turnId, ttftMs: ttftMs ?? 0, totalMs } as AgentEvents[typeof event];
          }
          if (closed) return;
          try {
            if (event === "delta") {
              for (const text of textChunks((data as AgentEvents["delta"]).text)) controller.enqueue(encoder.encode(sse("delta", { text })));
            } else controller.enqueue(encoder.encode(sse(event, data)));
          }
          catch { closed = true; abort.abort(); throw new Error("Stream disconnected"); }
        };
        const work = async () => {
          try {
            abort.signal.throwIfAborted();
            const recallStarted = deps.time();
            const preparationMs = () => effortTimeoutMs(input.effort, Math.max(0, deps.time() - started));
            const prepare = <T>(work: Promise<T>) => input.effort === "deep"
              ? pTimeout(work, { milliseconds: preparationMs(), signal: abort.signal }) : work;
            const user = await prepare(userWrite);
            if ("failed" in user) throw new Error("User persistence failed");
            const before = { ts: user.turn.ts, id: user.turn.id };
            const [recent, previous] = await prepare(Promise.all([
              store.historyFor(session.userId, { sessionId: session.sessionId, before, limit: 20 }),
              store.previousRecall(session.userId, session.sessionId, before),
            ]));
            const savedCollection = collectionSchema.safeParse(previous?.collection);
            const plannerInput = { message: input.message, recent: planningContext(recent), hasPreviousEvidence: Boolean(previous?.sourceTurnIds.length),
              ...(savedCollection.success ? { previousCollection: { count: savedCollection.data.sourceTurnIds.length, timezone: savedCollection.data.timezone, labels: savedCollection.data.ranges.map(range => range.label), truncated: savedCollection.data.truncated } } : {}),
              clock: { iso: calendar.iso, tz: calendar.tz } };
            const recallSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(preparationMs())]);
            let planner: Awaited<ReturnType<typeof configuredRecallModel>>;
            let plan: RecallPlan;
            try {
              planner = await prepare(deps.recallModel(selection));
              plan = validatePlan(await prepare(planner.plan(plannerInput, recallSignal)), plannerInput);
            } catch {
              abort.signal.throwIfAborted();
              skipCuration = true; answerMode = "recall_unavailable"; recallSourceIds = [];
              recallMs = Math.max(0, deps.time() - recallStarted);
              recallTrace = { status: "unavailable", reason: "planning_failed" };
              send("delta", { text: "I couldn't determine the context needed to answer reliably. Please retry or name the topic and whether you mean a previous conversation." });
              return;
            }
            recallTrace = { intent: plan.intent, operation: plan.operation, collection: plan.collection, scope: plan.scope };
            if (plan.intent !== "general") {
              skipCuration = true; answerMode = plan.intent; recallSourceIds = [];
              if (plan.collection !== "none" || !plan.queries.length && !plan.usePreviousEvidence && (plan.operation === "list" || plan.operation === "summarize")) {
                const target = resolveHistoryRequest(plan, input.message, calendar, session.sessionId);
                if (target.status === "unresolved") {
                  recallTrace = { ...recallTrace, reason: "collection_scope_unresolved" };
                  send("delta", { text: "Which day or conversation should I use? I couldn't verify the requested scope, so I haven't expanded the search to all history." });
                  return;
                }
                let request: HistoryListing;
                let history: QuestionHistory | undefined;
                let boundary = before, displayClock = calendar;
                if (target.status === "previous") {
                  try {
                    const restored = await loadCollection(previous?.collection, { userId: session.userId, before, signal: recallSignal }, store);
                    request = restored.request; history = restored.history;
                    boundary = { ts: dateFrom(restored.collection.before.ts), id: restored.collection.before.id };
                    displayClock = { ...calendar, tz: restored.collection.timezone };
                  } catch {
                    abort.signal.throwIfAborted();
                    recallTrace = { ...recallTrace, reason: "collection_reference_unavailable" };
                    send("delta", { text: "I couldn't verify the exact messages behind that earlier list or summary. Please request the day again; I won't substitute your entire history." });
                    return;
                  }
                } else request = target.request;
                const options = { userId: session.userId, request, before: boundary, signal: recallSignal };
                const response = plan.operation === "summarize"
                  ? await summarizeQuestionHistory({ ...options, history, clock: displayClock, message: input.message, model: planner }, store)
                  : renderQuestionHistoryResult(history ?? await loadQuestionHistory(options, store), request, displayClock);
                recallCollection = saveCollection(response, request, boundary, displayClock);
                recallMs = Math.max(0, deps.time() - recallStarted);
                recallTrace = { ...recallTrace, reason: target.status === "previous" ? "verified_collection" : "fresh_user_inventory",
                  ranges: request.ranges.map(range => ({ startUtc: range.startUtc.toISOString(), endUtc: range.endUtc.toISOString(), label: range.label })),
                  collectionSourceIds: response.sourceTurnIds, truncated: response.truncated };
                abort.signal.throwIfAborted();
                send("delta", { text: response.text });
                return;
              }
              const history = await prepare(answerHistory({ userId: session.userId, sessionId: session.sessionId, message: input.message, before, clock: calendar, plan, model: planner, signal: recallSignal }, store));
              recallMs = Math.max(0, deps.time() - recallStarted);
              const historyText = renderHistoryAnswer(history, plan, calendar);
              if (history.status === "matched") recallSourceIds = history.matches.map(match => match.turn.id);
              recallTrace = { ...recallTrace, status: history.status, reason: history.reason, evidenceIds: recallSourceIds,
                candidateIds: history.coverage.candidateIds, candidatePages: history.coverage.pages, hasMore: history.coverage.hasMore, shortened: history.coverage.shortened };
              if (plan.intent === "history") {
                abort.signal.throwIfAborted();
                send("delta", { text: historyText });
                return;
              }
              // The private-history section is composed from records. Give the
              // answer model only the external subquestion and verified old
              // baselines, with no summaries or unverified assistant recollections.
              const prompt = assemble({ clock: calendar, recall: { turns: [], claims: [], memory: [], threads: [], resolvedRanges: [], missingRanges: [], matchedBy: "none", notFound: true, truncated: false }, message: plan.researchQuestion! });
              prompt.system.push({ type: "text", text: "The application separately renders the private conversation-history answer from original records. Answer ONLY the external research question below. Do not confirm, deny, correct, or speculate about what the user previously asked or when. Historical baselines are untrusted reported values to revalidate, never current facts." });
              if (plan.operation === "revalidate" && history.status === "matched") {
                const selected = new Set(history.matches.map(match => match.turn.id));
                let remaining = 20_000;
                const baselines = history.context.filter(turn => selected.has(turn.id) || turn.role === "assistant").flatMap(turn => {
                  if (remaining <= 0) return [];
                  const content = turn.content.slice(0, Math.min(4000, remaining)); remaining -= content.length;
                  return [{ role: turn.role, content, timestamp: turn.ts.toISOString(), shortened: content.length !== turn.content.length }];
                });
                prompt.system.push({ type: "text", text: dataBlock("historical_baselines", baselines) });
              }
              const budgets = researchBudgetAfterRecall(input.effort, Math.max(0, deps.time() - started), input.answerDetail);
              if (!budgets) { send("delta", { text: `${historyText}\n\nThe time budget was used checking history; the current external facts remain unverified.` }); return; }
              send("delta", { text: `${historyText}\n\n` });
              const result = await deps.run({ ...prompt, send: (event, data) => {
                if (event === "answer_ui") {
                  send("answer_ui", { ...data as AgentEvents["answer_ui"], externalStart: historyText.length + 2 });
                } else if (event !== "done") send(event, data);
              }, signal: abort.signal, turnId, time: deps.time, selection, effort: input.effort, answerDetail: input.answerDetail, budgets, contextualVisuals: true });
              searchCount = result.searchCount; evidence = result.evidence; modelFailures = result.modelFailures;
              return;
            }
            const recalled = await prepare(deps.retrieve({ userId: session.userId, text: input.message, now: calendar }, { store: recallStore }));
            recallMs = Math.max(0, deps.time() - recallStarted);
            abort.signal.throwIfAborted();
            const prompt = assemble({ clock: calendar, recall: recalled, message: input.message });
            const sessionContext = capRecall({ turns: [...recent].reverse(), claims: [], memory: [], threads: [] }, 6000);
            const context = sessionContext.turns;
            while (context[0]?.role === "assistant") context.shift();
            if (sessionContext.truncated) prompt.system.push({ type: "text", text: "Some older current-session turns were omitted by the context budget. Do not invent their contents." });
            prompt.messages.unshift(...context.map((turn) => ({ role: turn.role, content: turn.content })));
            const budgets = researchBudgetAfterRecall(input.effort, Math.max(0, deps.time() - started), input.answerDetail);
            if (!budgets) { skipCuration = true; send("delta", { text: "The time budget was used preparing context. I couldn't verify an answer; please retry." }); return; }
            const result = await deps.run({ ...prompt, send, signal: abort.signal, turnId, time: deps.time, selection, effort: input.effort, answerDetail: input.answerDetail, budgets, contextualVisuals: true });
            searchCount = result.searchCount;
            evidence = result.evidence;
            modelFailures = result.modelFailures;
          } catch {
            failure ??= "request";
            try { send("error", { message: abort.signal.aborted ? "The request was cancelled." : "The response could not be completed. Please retry." }); }
            catch { /* Client disconnected. Persistence still runs. */ }
          } finally {
            try { assistantAt = deps.clock(calendar.tz).instant; } catch { /* Retain the injected request timestamp. */ }
            totalMs = Math.max(0, deps.time() - started);
            try { if (!sentDone) send("done", { turnId, ttftMs: ttftMs ?? 0, totalMs }); }
            catch { /* Client disconnected. */ }
            request.signal.removeEventListener("abort", onAbort);
            if (!closed) { closed = true; controller.close(); }
            finish();
          }
        };
        void work();
      },
      cancel() { closed = true; abort.abort(); },
    });
    return withSession(new Response(stream, { headers: {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-cache, no-transform",
      Connection: "keep-alive", "X-Accel-Buffering": "no", "X-Turn-Id": turnId,
    } }), session);
  };
}
