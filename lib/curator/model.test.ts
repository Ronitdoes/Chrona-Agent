import { afterEach, expect, it, vi } from "vitest";
import { clock, turn } from "../../test/agent-fixtures";
import { curate } from "./curate";
import { configuredCuratorModel, createCuratorModel, createGeminiCuratorModel } from "./model";
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
function geminiCompletion(text: string, finishReason = "STOP") {
  return Response.json({ candidates: [{ finishReason, content: { parts: [{ text }] } }] });
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

it.each(["", "unused-anthropic-key"])("curates with the configured Gemini provider regardless of the Anthropic key (%s)", async (anthropicKey) => {
  vi.resetModules();
  vi.stubEnv("MODEL_PROVIDER", "gemini");
  vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
  vi.stubEnv("GEMINI_MODEL", "gemini-3.5-flash-lite");
  vi.stubEnv("TAVILY_API_KEY", "test-key");
  vi.stubEnv("ANTHROPIC_API_KEY", anthropicKey);
  vi.stubEnv("DATABASE_URL", "postgresql://test@localhost/test");
  const fetch = vi.fn<typeof globalThis.fetch>(async () => geminiCompletion(JSON.stringify(output)));
  vi.stubGlobal("fetch", fetch);
  const store = {
    pendingCurations: vi.fn().mockResolvedValue([input]),
    applyCuration: vi.fn().mockResolvedValue(true), memoryFor: vi.fn().mockResolvedValue([]), threadsFor: vi.fn().mockResolvedValue([]),
  };
  expect(await curate("alice", { store, clock: () => clock })).toEqual({ completed: 1, failed: 0, deferred: false });
  expect(store.applyCuration).toHaveBeenCalledWith("alice", input.assistant.id, output, clock.instant);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, request] = fetch.mock.calls[0];
  expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
  expect(request?.headers).toMatchObject({ "x-goog-api-key": "gemini-test-key" });
  expect(JSON.parse(String(request?.body))).toMatchObject({ generationConfig: { responseMimeType: "application/json" } });
});

it("keeps Haiku for the Anthropic provider even when a Gemini key is present", async () => {
  vi.resetModules();
  vi.stubEnv("MODEL_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
  vi.stubEnv("GEMINI_API_KEY", "unused-gemini-key");
  vi.stubEnv("DATABASE_URL", "postgresql://test@localhost/test");
  vi.stubEnv("TAVILY_API_KEY", "test-key");
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response(JSON.stringify(output)));
  vi.stubGlobal("fetch", fetch);
  const model = await configuredCuratorModel();
  expect(await model(input, new AbortController().signal)).toEqual(output);
  expect(String(fetch.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/messages");
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).model).toBe("claude-haiku-5-5");
});

it.each(["gemini-3.5-flash-lite", "custom-gemini-model"])("sends a schema-guided Gemini JSON request without tools (%s)", async (model) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => geminiCompletion(JSON.stringify(output)));
  expect(await createGeminiCuratorModel("test-key", model, { fetch })(input, new AbortController().signal)).toEqual(output);
  expect(fetch).toHaveBeenCalledOnce();
  expect(String(fetch.mock.calls[0][0])).toContain(`${model}:generateContent`);
  const request = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(request).toMatchObject({ generationConfig: { maxOutputTokens: 4096, responseMimeType: "application/json" } });
  expect(request.tools).toBeUndefined();
  expect(request.tool_choice).toBeUndefined();
  expect(request.systemInstruction.parts[0].text).toContain("untrusted data");
  expect(request.generationConfig.responseJsonSchema).toHaveProperty("properties.claims");
  expect(request.contents[0]).toMatchObject({ role: "user", parts: [{ text: JSON.stringify(input) }] });
});

it.each([
  ["not-json", "STOP"],
  [JSON.stringify({ claims: "invalid", memory: [], threads: [] }), "STOP"],
  [JSON.stringify(output), "MAX_TOKENS"],
  [JSON.stringify(output), "SAFETY"],
  ["", "STOP"],
])("rejects malformed, invalid, truncated or blocked Gemini output (%s, %s)", async (text, stop) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => geminiCompletion(text, stop));
  await expect(createGeminiCuratorModel("test-key", "gemini-3.5-flash-lite", { fetch })(input, new AbortController().signal))
    .rejects.toThrow("Gemini curator response failed");
  expect(fetch).toHaveBeenCalledOnce();
});

it("sanitizes Gemini HTTP failures without an automatic retry", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("private-provider-details", { status: 429 }));
  await expect(createGeminiCuratorModel("test-key", "gemini-3.5-flash-lite", { fetch })(input, new AbortController().signal))
    .rejects.toThrow(/^Gemini curator response failed$/);
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not send a cancelled Gemini curator request", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const controller = new AbortController(); controller.abort();
  await expect(createGeminiCuratorModel("test-key", "gemini-3.5-flash-lite", { fetch })(input, controller.signal)).rejects.toThrow("cancelled");
  expect(fetch).not.toHaveBeenCalled();
});

it("aborts a running Gemini curator request with the caller's signal", async () => {
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const signal = init?.signal;
    controller.abort();
    signal?.throwIfAborted();
    throw new Error("Expected cancellation");
  });
  await expect(createGeminiCuratorModel("test-key", "gemini-3.5-flash-lite", { fetch })(input, controller.signal)).rejects.toThrow("cancelled");
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
