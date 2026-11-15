import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runAgent } from "./agent/loop";
import { sse, type AgentEvents, type SendEvent } from "./agent/events";
import { assemble } from "./agent/prompt";
import type { ModelFailure } from "./agent/errors";
import { now, monotonicMs } from "./clock";
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

const inputSchema = z.strictObject({
  message: z.string().trim().min(1).max(20_000), sessionId: z.uuid().optional(), tz: timeZone.optional(),
  selection: modelSelectionSchema.optional(),
});
type ChatStore = RecallStore & Pick<Store, "saveTurn" | "historyFor"> & CuratorStore;
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
};

export function createChatHandler(overrides: Pick<Dependencies, "after"> & Partial<Omit<Dependencies, "after">>) {
  const deps: Dependencies = { store: getStore, retrieve, run: runAgent, clock: now, time: monotonicMs, trace: createTurnTrace, acquire: acquireChat, curate, resolveSelection: resolveModelSelection, ...overrides };
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

    try {
      // Register while still in the request scope; this task waits for streaming to settle.
      deps.after(async () => {
        await finished;
        let assistantPersisted = false;
        try {
          const user = await userWrite;
          if ("failed" in user) failure ??= "user_persistence";
          else if (assistantText) {
            const saved = await store.saveTurn({ userId: session.userId, sessionId: session.sessionId, role: "assistant", content: assistantText, ts: assistantAt, tz: calendar.tz,
              curation: { userTurnId: user.turn.id, evidence: failure || abort.signal.aborted ? [] : boundEvidence(evidence) },
            });
            assistantTurnId = saved.id;
            assistantPersisted = true;
          }
        } catch { failure ??= "assistant_persistence"; }
        finally {
          // A slow extractor must not keep the user's next message behind admission control.
          admission.release();
          // A curator failure never changes the saved transcript or the already-finished SSE response.
          try { curation = await deps.curate(session.userId, { store, turnId: assistantTurnId, clock: () => deps.clock(calendar.tz), selection }); }
          catch { curation = { completed: 0, failed: 1, deferred: false }; }
          trace[failure ? "error" : "info"]({
            turnId, userTurnId, assistantTurnId, recallMs, ttftMs: ttftMs ?? 0, searchCount, totalMs,
            userPersisted: userTurnId !== undefined, assistantPersisted, cancelled: abort.signal.aborted, failure: failure ?? null,
            curation,
            modelFailures,
            provider: selection.provider, model: selection.model,
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
          try { controller.enqueue(encoder.encode(sse(event, data))); }
          catch { closed = true; abort.abort(); throw new Error("Stream disconnected"); }
        };
        const work = async () => {
          try {
            abort.signal.throwIfAborted();
            const recallStarted = deps.time();
            const [recalled, recent] = await Promise.all([
              deps.retrieve({ userId: session.userId, text: input.message, now: calendar }, { store: recallStore }),
              excludeCurrent(store.historyFor(session.userId, { sessionId: session.sessionId, limit: 20 })),
            ]).finally(() => { recallMs = Math.max(0, deps.time() - recallStarted); });
            if ("failed" in await userWrite) throw new Error("User persistence failed");
            abort.signal.throwIfAborted();
            const prompt = assemble({ clock: calendar, recall: recalled, message: input.message });
            const sessionContext = capRecall({ turns: [...recent].reverse(), claims: [], memory: [], threads: [] }, 6000);
            const context = sessionContext.turns;
            while (context[0]?.role === "assistant") context.shift();
            if (sessionContext.truncated) prompt.system.push({ type: "text", text: "Some older current-session turns were omitted by the context budget. Do not invent their contents." });
            prompt.messages.unshift(...context.map((turn) => ({ role: turn.role, content: turn.content })));
            const result = await deps.run({ ...prompt, send, signal: abort.signal, turnId, time: deps.time, selection });
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
