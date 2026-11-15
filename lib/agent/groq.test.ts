import { describe, expect, it, vi } from "vitest";
import { createGroqModel, groqRequest } from "./groq";
import { runAgent } from "./loop";
import { webSearchTool } from "./schema";
import type { ModelRequest } from "./model";

const request: ModelRequest = {
  model: "claude-sonnet-5-5", max_tokens: 2048,
  system: [{ type: "text", text: "Answer briefly", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "Hello" }], tools: [webSearchTool], tool_choice: { type: "auto", disable_parallel_tool_use: true },
};
const frame = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
function streaming(data: string, chunkSize = 19): Response {
  const bytes = new TextEncoder().encode(data);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset + chunkSize)); offset = Math.min(offset + chunkSize, bytes.length);
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
describe("optional Groq transport", () => {
  it("maps the existing single tool to Groq and strips Anthropic-only caching controls", () => {
    const body = groqRequest(request, "qwen/qwen3.8-27b");
    expect(body.model).toBe("qwen/qwen3.8-27b");
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.reasoning_effort).toBe("none");
    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0].function.name).toBe("web_search");
    expect(body.messages[0]).toEqual({ role: "system", content: "Answer briefly" });
    expect(JSON.stringify(body)).not.toContain("cache_control");
    expect(groqRequest({ ...request, tool_choice: { type: "none" } }, body.model).tool_choice).toBe("none");
    expect(groqRequest({ ...request, tool_choice: { type: "tool", name: "web_search" } }, body.model).tool_choice).toEqual({ type: "function", function: { name: "web_search" } });
    expect(() => groqRequest({ ...request, tool_choice: { type: "tool", name: "other" } }, body.model)).toThrow("Only web_search");
  });
  it("handles fragmented UTF-8/SSE content without exposing reasoning", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(streaming(
      ': keep-alive\r\n\r\n' + frame({ reasoning: "private reasoning" }) + frame({ content: "Hello μ" }) + frame({}, "stop") + "data: [DONE]\r\n\r\n", 1,
    ));
    const stream = createGroqModel("test-key", undefined, { fetch }).stream(request, { signal: new AbortController().signal });
    let text = "";
    for await (const event of stream) if (event.type === "content_block_delta" && event.delta.type === "text_delta") text += event.delta.text;
    expect(text).toBe("Hello μ");
    expect((await stream.finalMessage()).content).toEqual([{ type: "text", text: "Hello μ", citations: null }]);
    expect(fetch.mock.calls[0][0]).toBe("https://api.groq.com/openai/v1/chat/completions");
  });
  it("assembles streamed tool arguments and sends paired results through the unchanged loop", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(streaming(frame({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "web_search", arguments: '{"quer' } }] }) +
        frame({ tool_calls: [{ index: 0, function: { arguments: 'ies":["CRM pricing"]}' } }] }, "tool_calls") + "data: [DONE]\r\n\r\n"))
      .mockResolvedValueOnce(streaming(frame({ content: "A dated answer." }) + frame({}, "stop") + "data: [DONE]\r\n\r\n"));
    const search = vi.fn().mockResolvedValue({ queries: [{ query: "CRM pricing", results: [] }], is_error: false, content: "", truncated: false });
    const result = await runAgent({ system: [], messages: request.messages, model: createGroqModel("test-key", undefined, { fetch }), search, send: () => {}, time: () => 0 });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ queries: ["CRM pricing"] }), expect.anything());
    expect(result.text).toBe("A dated answer.");
    const body = JSON.parse(fetch.mock.calls[1][1]?.body as string);
    expect(body.messages.at(-2)).toMatchObject({ role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "web_search", arguments: '{"queries":["CRM pricing"]}' } }] });
    expect(body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-1" });
    expect(body.tools).toHaveLength(1);
  });
  it("sanitizes HTTP/parse errors and rejects truncated streams", async () => {
    for (const response of [new Response("secret-key", { status: 401 }), streaming("data: not-json\n\n"), streaming(frame({ content: "Incomplete" }))]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      const stream = createGroqModel("test-key", undefined, { fetch }).stream(request, { signal: new AbortController().signal });
      await expect(async () => { for await (const event of stream) void event; }).rejects.toThrow("Groq response failed");
      await expect(stream.finalMessage()).rejects.toThrow("Groq response failed");
    }
  });
  it("does not send a cancelled request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const abort = new AbortController(); abort.abort();
    const stream = createGroqModel("test-key", undefined, { fetch }).stream(request, { signal: abort.signal });
    await expect(async () => { for await (const event of stream) void event; }).rejects.toThrow("cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });
});
