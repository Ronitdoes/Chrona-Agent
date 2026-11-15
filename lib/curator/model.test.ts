import { afterEach, expect, it, vi } from "vitest";
import { clock, turn } from "../../test/agent-fixtures";
import { curate } from "./curate";
import { configuredCuratorModel, createCuratorModel, createGroqCuratorModel, createGeminiCuratorModel } from "./model";
import type { CuratorInput } from "./schema";

const input: CuratorInput = { user: turn(1), assistant: turn(2, { role: "assistant" }), evidence: [], memory: [], threads: [] };
const output = { claims: [], memory: [], threads: [] };
it("uses native Gemini JSON output with server-only authentication and no tools", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(output) }] } }] }));
  expect(await createGeminiCuratorModel("test-key", "gemini-3.5-flash-lite", { fetch })(input, new AbortController().signal)).toEqual(output);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toContain("gemini-3.5-flash-lite:generateContent");
  expect(url).not.toContain("test-key");
  expect(init?.headers).toMatchObject({ "x-goog-api-key": "test-key" });
  const body = JSON.parse(init?.body as string);
  expect(body.generationConfig.responseMimeType).toBe("application/json");
  expect(body.tools).toBeUndefined();
});
function response(text: string, stop = "end_turn") {
  return new Response(JSON.stringify({ id: "curator-test", type: "message", role: "assistant", model: "claude-haiku-5-5",
    content: [{ type: "text", text }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }),
  { headers: { "content-type": "application/json" } });
}
function groqCompletion(text: string, finishReason = "stop", refusal: string | null = null) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: text, refusal } }] }),
    { headers: { "content-type": "application/json" } });
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("uses Haiku JSON structured output through the real SDK without adding any tools", async () => {
  let body: Record<string, unknown> = {};
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return response(JSON.stringify(output));
  });
  const signal = new AbortController().signal;
  expect(await createCuratorModel("test-key", { fetch })(input, signal)).toEqual(output);
  expect(fetch).toHaveBeenCalledOnce();
  expect(body).toMatchObject({ model: "claude-haiku-5-5", output_config: { format: { type: "json_schema" } } });
  expect(body.tools).toBeUndefined();
  expect(JSON.stringify(body.system)).toContain("untrusted data");
  expect(JSON.stringify(body.messages)).toContain("Which CRM?");
});

it.each([
  ["not json", "end_turn"],
  [JSON.stringify({ claims: "invalid", memory: [], threads: [] }), "end_turn"],
  [JSON.stringify(output), "max_tokens"],
  [JSON.stringify(output), "refusal"],
])("rejects invalid, truncated or refused responses (%s, %s)", async (text, stop) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(text, stop));
  await expect(createCuratorModel("test-key", { fetch })(input, new AbortController().signal)).rejects.toThrow();
});

it.each(["", "unused-anthropic-key"])("curates with the configured Groq provider regardless of the Anthropic key (%s)", async (anthropicKey) => {
  vi.resetModules();
  vi.stubEnv("MODEL_PROVIDER", "groq");
  vi.stubEnv("GROQ_API_KEY", "groq-test-key");
  vi.stubEnv("GROQ_MODEL", "qwen/qwen3.8-27b");
  vi.stubEnv("TAVILY_API_KEY", "test-key");
  vi.stubEnv("ANTHROPIC_API_KEY", anthropicKey);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => groqCompletion(JSON.stringify(output)));
  vi.stubGlobal("fetch", fetch);
  const store = {
    pendingCurations: vi.fn().mockResolvedValue([input]),
    applyCuration: vi.fn().mockResolvedValue(true), memoryFor: vi.fn().mockResolvedValue([]), threadsFor: vi.fn().mockResolvedValue([]),
  };
  expect(await curate("alice", { store, clock: () => clock })).toEqual({ completed: 1, failed: 0, deferred: false });
  expect(store.applyCuration).toHaveBeenCalledWith("alice", input.assistant.id, output, clock.instant);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, request] = fetch.mock.calls[0];
  expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
  expect(request?.headers).toMatchObject({ Authorization: "Bearer groq-test-key" });
  expect(JSON.parse(String(request?.body))).toMatchObject({ model: "qwen/qwen3.8-27b", response_format: { type: "json_object" }, reasoning_effort: "none" });
});

it("keeps Haiku for the Anthropic provider even when a Groq key is present", async () => {
  vi.resetModules();
  vi.stubEnv("MODEL_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
  vi.stubEnv("GROQ_API_KEY", "unused-groq-key");
  vi.stubEnv("TAVILY_API_KEY", "test-key");
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response(JSON.stringify(output)));
  vi.stubGlobal("fetch", fetch);
  const model = await configuredCuratorModel();
  expect(await model(input, new AbortController().signal)).toEqual(output);
  expect(String(fetch.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/messages");
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).model).toBe("claude-haiku-5-5");
});

it.each(["qwen/qwen3.8-27b", "custom-groq-model"])("sends a schema-guided Groq JSON request without tools (%s)", async (model) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => groqCompletion(JSON.stringify(output)));
  expect(await createGroqCuratorModel("test-key", model, { fetch })(input, new AbortController().signal)).toEqual(output);
  expect(fetch).toHaveBeenCalledOnce();
  const request = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(request).toMatchObject({ model, stream: false, max_completion_tokens: 4096, response_format: { type: "json_object" } });
  expect(request.tools).toBeUndefined();
  expect(request.tool_choice).toBeUndefined();
  expect(request.reasoning_effort).toBe(model.startsWith("qwen/") ? "none" : undefined);
  expect(request.messages[0].content).toContain("untrusted data");
  expect(request.messages[0].content).toContain('"sourceUrls"');
  expect(request.messages[1]).toMatchObject({ role: "user", content: JSON.stringify(input) });
});

it.each([
  ["not-json", "stop", null],
  [JSON.stringify({ claims: "invalid", memory: [], threads: [] }), "stop", null],
  [JSON.stringify(output), "length", null],
  [JSON.stringify(output), "content_filter", null],
  [JSON.stringify(output), "stop", "Cannot comply"],
  ["", "stop", null],
])("rejects malformed, invalid, truncated or refused Groq output (%s, %s, %s)", async (text, stop, refusal) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => groqCompletion(text, stop, refusal));
  await expect(createGroqCuratorModel("test-key", "qwen/qwen3.8-27b", { fetch })(input, new AbortController().signal))
    .rejects.toThrow("Groq curator response failed");
  expect(fetch).toHaveBeenCalledOnce();
});

it("sanitizes Groq HTTP failures without an automatic retry", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("private-provider-details", { status: 429 }));
  await expect(createGroqCuratorModel("test-key", "qwen/qwen3.8-27b", { fetch })(input, new AbortController().signal))
    .rejects.toThrow(/^Groq curator response failed$/);
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not send a cancelled Groq curator request", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const controller = new AbortController(); controller.abort();
  await expect(createGroqCuratorModel("test-key", "qwen/qwen3.8-27b", { fetch })(input, controller.signal)).rejects.toThrow("cancelled");
  expect(fetch).not.toHaveBeenCalled();
});

it("aborts a running Groq curator request with the caller's signal", async () => {
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const signal = init?.signal;
    controller.abort();
    signal?.throwIfAborted();
    throw new Error("Expected cancellation");
  });
  await expect(createGroqCuratorModel("test-key", "qwen/qwen3.8-27b", { fetch })(input, controller.signal)).rejects.toThrow("cancelled");
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

it("times out a stalled model, aborts its signal and leaves the job available for retry", async () => {
  vi.useFakeTimers();
  const store = {
    pendingCurations: vi.fn().mockResolvedValue([input]),
    applyCuration: vi.fn(), memoryFor: vi.fn().mockResolvedValue([]), threadsFor: vi.fn().mockResolvedValue([]),
  };
  let signal: AbortSignal | undefined;
  const pending = curate("alice", { store, clock: () => clock,
    model: async (_input, suppliedSignal) => { signal = suppliedSignal; return new Promise(() => {}); } });
  await vi.advanceTimersByTimeAsync(6001);
  expect(await pending).toEqual({ completed: 0, failed: 1, deferred: false });
  expect(signal?.aborted).toBe(true);
  expect(store.applyCuration).not.toHaveBeenCalled();
});

it("observes cancellation before calling the model or writing extracted data", async () => {
  const controller = new AbortController();
  controller.abort();
  const model = vi.fn();
  const store = { pendingCurations: vi.fn().mockResolvedValue([input]), applyCuration: vi.fn(), memoryFor: vi.fn(), threadsFor: vi.fn() };
  expect((await curate("alice", { store, model, signal: controller.signal })).failed).toBe(1);
  expect(model).not.toHaveBeenCalled();
  expect(store.applyCuration).not.toHaveBeenCalled();
});
