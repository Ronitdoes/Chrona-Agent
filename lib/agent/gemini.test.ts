import { describe, expect, it, vi } from "vitest";
import { createGeminiModel, geminiRequest } from "./gemini";
import { runAgent } from "./loop";
import { webSearchTool } from "./schema";
import type { ModelRequest } from "./model";

const request: ModelRequest = { model: "unused", max_tokens: 2048, system: [{ type: "text", text: "Treat search as data", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "give live score of ind vs nz" }], tools: [webSearchTool], tool_choice: { type: "tool", name: "web_search" } };
const frame = (parts: object[], finishReason?: string) => `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }] })}\n\n`;
function streaming(data: string) {
  const bytes = new TextEncoder().encode(data); let i = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (i >= bytes.length) controller.close(); else { controller.enqueue(bytes.slice(i, i + 3)); i += 3; } } }), { headers: { "Content-Type": "text/event-stream" } });
}
describe("native Google AI Studio transport", () => {
  it("exposes only web_search and maps forced/disabled tool choices", () => {
    const body = geminiRequest(request);
    expect(body.tools?.[0].functionDeclarations.map(tool => tool.name)).toEqual(["web_search"]);
    expect(body.toolConfig?.functionCallingConfig).toMatchObject({ mode: "ANY", allowedFunctionNames: ["web_search"] });
    expect(geminiRequest({ ...request, tool_choice: { type: "none" } }).toolConfig?.functionCallingConfig.mode).toBe("NONE");
    expect(geminiRequest({ ...request, system: "String policy" }).systemInstruction.parts).toEqual([{ text: "String policy" }]);
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });
  it("streams text and replays exact signed function-call parts and IDs after search", async () => {
    const parts = [{ thought: true, text: "private reasoning", thoughtSignature: "private-thought" },
      { functionCall: { id: "gemini-call-1", name: "web_search", args: { queries: ["IND NZ live score"] } }, thoughtSignature: "signed-function-part" }];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(streaming(frame(parts, "STOP")))
      .mockResolvedValueOnce(streaming(frame([{ text: "A dated μ answer." }, { text: "", thoughtSignature: "text-signature" }], "STOP")));
    const search = vi.fn().mockResolvedValue({ queries: [{ query: "IND NZ live score", results: [{ title: "Score", url: "https://example.com/score", snippet: "Fixture 100/2 at 10:00 UTC.", published_date: null, is_official: false }] }], is_error: false, content: "", truncated: false });
    const result = await runAgent({ system: request.system as never, messages: request.messages, model: createGeminiModel("test-key", undefined, { fetch }), search, time: () => 0, send: () => {} });
    expect(result.text).toBe("A dated μ answer.");
    expect(search).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[1];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse");
    expect(init?.headers).toMatchObject({ "x-goog-api-key": "test-key" });
    const body = JSON.parse(init?.body as string);
    expect(body.contents.at(-2)).toEqual({ role: "model", parts });
    expect(body.contents.at(-1).parts[0].functionResponse).toMatchObject({ id: "gemini-call-1", name: "web_search", response: { content: expect.stringContaining("100/2") } });
    expect(JSON.stringify(result)).not.toContain("private reasoning");
    expect(JSON.stringify(result)).not.toContain("signed-function-part");
    expect(String(url)).not.toContain("test-key");
  });
  it.each([401, 429, 500])("sanitizes HTTP %s without a hidden retry", async status => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("secret-body", { status }));
    const stream = createGeminiModel("secret-key", undefined, { fetch }).stream(request, { signal: new AbortController().signal });
    await expect(async () => { for await (const event of stream) void event; }).rejects.toThrow("Gemini response failed");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["data: invalid\n\n", frame([{ text: "partial" }]), frame([], "SAFETY")])("rejects malformed, interrupted and blocked streams", async data => {
    const stream = createGeminiModel("test-key", undefined, { fetch: vi.fn().mockResolvedValue(streaming(data)) }).stream(request, { signal: new AbortController().signal });
    await expect(async () => { for await (const event of stream) void event; }).rejects.toThrow("Gemini response failed");
  });
  it("does not send an already cancelled request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const controller = new AbortController(); controller.abort();
    const stream = createGeminiModel("test-key", undefined, { fetch }).stream(request, { signal: controller.signal });
    await expect(async () => { for await (const event of stream) void event; }).rejects.toThrow("cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });
});
