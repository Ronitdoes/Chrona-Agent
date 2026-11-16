import { richAnswerSchema } from "./answer-blocks";
import type { AnswerDetail } from "./answer-detail";
import { z } from "zod";
import type { ModelSelection } from "./model-selection";
import type { ResearchEffort } from "./research-effort";

const count = z.number().int().nonnegative();
export const chatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), data: z.object({ text: z.string() }) }),
  z.object({ type: z.literal("status"), data: z.object({
    id: z.string(), kind: z.literal("search"), queries: z.array(z.string()), state: z.enum(["running", "done"]), count, usage: z.array(z.object({ query: z.string(), provider: z.enum(["tavily", "exa"]), fallback: z.boolean() })).optional(),
  }) }),
  z.object({ type: z.literal("sources"), data: z.array(z.object({
    url: z.string(), title: z.string(), domain: z.string(), publishedDate: z.string().nullable(), isOfficial: z.boolean(),
  })) }),
  z.object({ type: z.literal("answer_ui"), data: richAnswerSchema }),
  z.object({ type: z.literal("done"), data: z.object({ turnId: z.string(), ttftMs: z.number().nonnegative(), totalMs: z.number().nonnegative() }) }),
  z.object({ type: z.literal("error"), data: z.object({ message: z.string() }) }),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;
export class ChatStreamError extends Error {}
const knownEvents = new Set(["delta", "status", "sources", "answer_ui", "done", "error"]);
const maxFrame = 131_072;

/** Incremental SSE framing, including CRLF split across chunks and multiline data. */
export function createEventParser(onEvent?: (event: ChatEvent) => boolean | void) {
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let size = 0;
  let first = true;
  return {
    push(chunk: string, final = false): ChatEvent[] {
      buffer += first ? chunk.replace(/^\uFEFF/, "") : chunk;
      if (chunk) first = false;
      const events: ChatEvent[] = [];
      for (;;) {
        const index = buffer.search(/[\r\n]/);
        if (index < 0 || (!final && buffer[index] === "\r" && index === buffer.length - 1)) break;
        const line = buffer.slice(0, index);
        const length = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(index + length);
        size += line.length + 1;
        if (size > maxFrame) throw new ChatStreamError("The response contained an oversized event.");
        if (!line) {
          if (data.length && knownEvents.has(event)) {
            let parsed: ChatEvent;
            try { parsed = chatEventSchema.parse({ type: event, data: JSON.parse(data.join("\n")) }); }
            catch { throw new ChatStreamError("The response stream could not be read. Please try again."); }
            events.push(parsed);
            if (onEvent?.(parsed) === false) return events;
          }
          event = "message"; data = []; size = 0;
        } else if (!line.startsWith(":")) {
          const separator = line.indexOf(":");
          const field = separator < 0 ? line : line.slice(0, separator);
          const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
          if (field === "event") event = value;
          if (field === "data") data.push(value);
        }
      }
      if (size + buffer.length > maxFrame) throw new ChatStreamError("The response contained an oversized event.");
      return events;
    },
  };
}

export async function readChatStream(body: ReadableStream<Uint8Array>, onEvent: (event: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let complete = false;
  const parser = createEventParser((event) => {
    onEvent(event);
    if (event.type === "done") { complete = true; return false; }
  });
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      parser.push(done ? decoder.decode() : decoder.decode(value, { stream: true }), done);
      if (complete) return;
      if (done) throw new ChatStreamError("The connection ended before the answer finished. Your partial answer is still here.");
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function requestChat(message: string, options: {
  tz: string; signal: AbortSignal; onEvent: (event: ChatEvent) => void; fetch?: typeof globalThis.fetch;
  sessionId?: string; selection?: ModelSelection; effort?: ResearchEffort; answerDetail?: AnswerDetail; searchProvider?: "tavily" | "exa"; onSession?: (id: string) => void;
}): Promise<void> {
  options.signal.throwIfAborted();
  let sessionId = options.sessionId;
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!sessionId && options.onSession) {
    const created = await fetcher("/api/conversations", { method: "POST", credentials: "same-origin", signal: options.signal });
    if (!created.ok) throw new ChatStreamError("The conversation could not be created.");
    sessionId = z.object({ id: z.uuid() }).parse(await created.json()).id;
    options.onSession?.(sessionId);
  }
  const response = await (options.fetch ?? globalThis.fetch)("/api/chat", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ message, tz: options.tz, sessionId, searchProvider: options.searchProvider, selection: options.selection, effort: options.effort, answerDetail: options.answerDetail }), signal: options.signal,
  });
  if (!response.ok) {
    const fallback = response.status === 429 ? "Please wait a moment before sending another message." : "The message could not be sent. Please try again.";
    const parsed = await response.json().catch(() => null);
    const error = z.object({ error: z.object({ message: z.string().trim().min(1).max(500) }) }).safeParse(parsed);
    throw new ChatStreamError(error.success ? error.data.error.message : fallback);
  }
  if (!response.body || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/event-stream") {
    throw new ChatStreamError("The server did not return a response stream. Please try again.");
  }
  await readChatStream(response.body, options.onEvent, options.signal);
}
