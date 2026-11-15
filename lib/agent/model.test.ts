import { expect, it, vi } from "vitest";
import { createAnthropicModel } from "./model";
import { runAgent } from "./loop";

it("uses the actual SDK stream parser with a mocked fetch, without calling a model API", async () => {
  const events = [
    ["message_start", { message: { id: "msg-test", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "SDK streamed text" } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
    ["message_stop", {}],
  ].map(([event, payload]) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(payload as object) })}\n\n`).join("");
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(events, { headers: { "content-type": "text/event-stream" } }));
  const result = await runAgent({
    system: [{ type: "text", text: "Answer concisely", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "Hello" }], model: createAnthropicModel("test-key", { fetch }), send: () => {},
    effort: "high",
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(result.text).toBe("SDK streamed text");
  const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(body.output_config.effort).toBe("high");
  expect(body).not.toHaveProperty("researchEffort");
});
