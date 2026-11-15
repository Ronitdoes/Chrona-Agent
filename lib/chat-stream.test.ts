import { describe, expect, it, vi } from "vitest";
import { sse } from "./agent/events";
import { createEventParser, readChatStream, requestChat } from "./chat-stream";

const done = sse("done", { turnId: "request-1", ttftMs: 100, totalMs: 200 });
function stream(text: string, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset + chunkSize)); offset += chunkSize;
  } });
}

describe("POST SSE client", () => {
  it("reads every contract event across byte-fragmented Unicode, CRLF and JSON boundaries", async () => {
    const events = [
      sse("status", { id: "s1", kind: "search", queries: ["CRM pricing"], state: "running", count: 0 }),
      sse("delta", { text: "Hello μ 🌍\n" }),
      sse("status", { id: "s1", kind: "search", queries: ["CRM pricing"], state: "done", count: 1 }),
      sse("sources", [{ title: "Pricing", url: "https://example.com", domain: "example.com", publishedDate: null, isOfficial: true }]),
      sse("error", { message: "One source could not be verified." }), done,
    ].join("").replace(/\n/g, "\r\n");
    const received: unknown[] = [];
    await readChatStream(stream(events), (event) => received.push(event), new AbortController().signal);
    expect(received).toHaveLength(6);
    expect(received[1]).toEqual({ type: "delta", data: { text: "Hello μ 🌍\n" } });
    expect(received.at(-1)).toMatchObject({ type: "done", data: { turnId: "request-1" } });
  });

  it("handles multiline data, comments, BOM and unknown events", () => {
    const parser = createEventParser();
    expect(parser.push('\uFEFF: heartbeat\n\nevent: unknown\ndata: ignored\n\nevent: delta\ndata: {\ndata: "text":"hello"\ndata: }\n\n'))
      .toEqual([{ type: "delta", data: { text: "hello" } }]);
  });

  it.each(['event: delta\ndata: not-json\n\n', 'event: delta\ndata: {"text":1}\n\n', 'event: done\ndata: {}\n\n'])("rejects malformed known events (%s)", (text) => {
    expect(() => createEventParser().push(text)).toThrow(/could not be read/);
  });

  it("bounds unfinished event buffers", () => {
    expect(() => createEventParser().push('data: ' + 'x'.repeat(131_072))).toThrow(/oversized/);
  });

  it("preserves delivered deltas but rejects EOF before done", async () => {
    const onEvent = vi.fn();
    await expect(readChatStream(stream(sse("delta", { text: "Partial answer" })), onEvent, new AbortController().signal)).rejects.toThrow(/before the answer finished/);
    expect(onEvent).toHaveBeenCalledWith({ type: "delta", data: { text: "Partial answer" } });
  });

  it("cancels a stalled reader when stopped and releases the stream lock", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const pending = readChatStream(body, vi.fn(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("does not deliver anything after the first done event", async () => {
    const onEvent = vi.fn();
    await readChatStream(stream(done + sse("delta", { text: "Late" }), 1000), onEvent, new AbortController().signal);
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls[0][0].type).toBe("done");
  });

  it("preserves a valid delta before a malformed frame in the same network chunk", async () => {
    const onEvent = vi.fn();
    await expect(readChatStream(stream(sse("delta", { text: "Keep me" }) + "event: delta\ndata: broken\n\n", 1000), onEvent, new AbortController().signal)).rejects.toThrow(/could not be read/);
    expect(onEvent).toHaveBeenCalledWith({ type: "delta", data: { text: "Keep me" } });
  });

  it("ignores malformed trailing frames after done and accepts fractional timing", async () => {
    const onEvent = vi.fn();
    await readChatStream(stream(sse("done", { turnId: "one", ttftMs: 1.25, totalMs: 2.75 }) + "event: delta\ndata: broken\n\n", 1000), onEvent, new AbortController().signal);
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls[0][0].data.totalMs).toBe(2.75);
  });

  it("accepts standalone CR line endings, including the final CR at EOF", async () => {
    const onEvent = vi.fn();
    await readChatStream(stream(done.replace(/\n/g, "\r")), onEvent, new AbortController().signal);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "done" }));
  });

  it("POSTs the timezone and message with cookies, using a cancellable fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(stream(done), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }));
    const signal = new AbortController().signal;
    await requestChat("Hello", { tz: "Asia/Kolkata", signal, onEvent: vi.fn(), fetch });
    expect(fetch).toHaveBeenCalledWith("/api/chat", expect.objectContaining({ method: "POST", credentials: "same-origin", signal, body: JSON.stringify({ message: "Hello", tz: "Asia/Kolkata" }) }));
  });

  it("surfaces safe HTTP errors and rejects non-SSE successful responses", async () => {
    for (const [response, expected] of [
      [Response.json({ error: { message: "Please wait." } }, { status: 429 }), "Please wait."],
      [new Response("<html>private proxy error</html>", { status: 502 }), "could not be sent"],
      [Response.json({ text: "wrong protocol" }), "did not return a response stream"],
    ] as const) {
      await expect(requestChat("Hello", { tz: "UTC", signal: new AbortController().signal, onEvent: vi.fn(), fetch: vi.fn().mockResolvedValue(response) })).rejects.toThrow(expected);
    }
  });
});
