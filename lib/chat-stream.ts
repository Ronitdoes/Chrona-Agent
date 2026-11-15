import { z } from "zod";
import type { ModelSelection } from "./model-selection";

const count = z.number().int().nonnegative();
export const chatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), data: z.object({ text: z.string() }) }),
  z.object({ type: z.literal("status"), data: z.object({
    id: z.string(), kind: z.literal("search"), queries: z.array(z.string()), state: z.enum(["running", "done"]), count,
  }) }),
  z.object({ type: z.literal("sources"), data: z.array(z.object({
    url: z.string(), title: z.string(), domain: z.string(), publishedDate: z.string().nullable(), isOfficial: z.boolean(),
  })) }),
  z.object({ type: z.literal("done"), data: z.object({ turnId: z.string(), ttftMs: z.number().nonnegative(), totalMs: z.number().nonnegative() }) }),
  z.object({ type: z.literal("error"), data: z.object({ message: z.string() }) }),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;
export class ChatStreamError extends Error {}
const knownEvents = new Set(["delta", "status", "sources", "done", "error"]);
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
  sessionId?: string; selection?: ModelSelection;
}): Promise<void> {
  options.signal.throwIfAborted();
  const response = await (options.fetch ?? globalThis.fetch)("/api/chat", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ message, tz: options.tz, sessionId: options.sessionId, selection: options.selection }), signal: options.signal,
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
