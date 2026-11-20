import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { AnswerBody } from "../../components/answer-body";
import { FakeModel } from "../../test/agent-fixtures";
import { buildRichAnswer } from "../answer-blocks";
import { createGeminiModel } from "./gemini";
import { runAgent } from "./loop";
import { createAnthropicModel } from "./model";
import { planVisuals } from "./visual-plan";

const question = "How does a bicycle drivetrain work?";
const flow = {
  kind: "flow", anchor: "a0", title: "Motion through the drivetrain",
  nodes: ["Pedals", "Chainring"], edges: [{ from: 0, to: 1 }],
};
const answer = "Pedals rotate the chainring.\n\nThe chain then moves.";
const empty = buildRichAnswer([], {});

afterEach(() => vi.useRealTimers());

it("rejects bogus anchors and locates a repeated section after its own prose in a mixed answer", async () => {
  const external = "### Stages\n\nFirst explanation.\n\n```md\n### Stages\n```\n\n### Stages\n\nSecond explanation.\n\n### Notes\n\nClosing.";
  const prefix = "### Stages\n\nPrivate explanation.\n\n";
  const correct = `a${external.lastIndexOf("### Stages")}`;
  const fenced = `a${external.indexOf("### Stages", 1)}`;
  const model = new FakeModel([{ text: [JSON.stringify({ blocks: [
    { ...flow, title: "Fenced heading", anchor: fenced },
    { ...flow, anchor: correct },
    { ...flow, title: "Invalid edge", anchor: correct, edges: [{ from: 0, to: 6 }] },
  ] })] }]);
  const snapshot = await planVisuals({ question, answer: external, model, snapshot: empty,
    evidence: new Map(), candidates: {}, signal: new AbortController().signal, milliseconds: 200 });
  expect(snapshot?.blocks).toHaveLength(1);
  const html = renderToStaticMarkup(createElement(AnswerBody, { content: prefix + external,
    answerUi: snapshot && { ...snapshot, externalStart: prefix.length } }));
  const figure = html.indexOf(flow.title);
  expect(figure).toBeGreaterThan(html.indexOf("Second explanation"));
  expect(figure).toBeLessThan(html.indexOf("<h3>Notes"));
  expect(html).not.toContain("Fenced heading");
  expect(html).not.toContain("Invalid edge");
});

it.each(["timeout", "cancel"] as const)("retains prose when the figure pass ends by %s", async mode => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const model = new FakeModel([{ text: [answer] }, { hang: true }]);
  const events: string[] = [];
  const result = runAgent({ model, signal: controller.signal, time: () => 0, system: [],
    messages: [{ role: "user", content: question }], contextualVisuals: true, send(event, data) {
      events.push(event);
      if (mode === "cancel" && event === "research_phase" && "stage" in data && data.stage === "visuals") controller.abort();
    } });
  await vi.advanceTimersByTimeAsync(12_001);
  expect((await result).text).toBe(answer);
  expect(events).not.toContain("answer_ui");
  expect(events).not.toContain("error");
  if (mode === "timeout") expect(model.streams[1].aborted).toBe(true);
});

it("skips figures when the user asks for a text-only explanation", async () => {
  const model = new FakeModel([{ text: [answer] }]);
  await runAgent({ model, system: [], messages: [{ role: "user", content: `${question} Text only, please.` }],
    contextualVisuals: true, send: () => {} });
  expect(model.requests).toHaveLength(1);
});

it.each(["anthropic", "gemini"] as const)("uses the production %s stream transport for private figure JSON", async provider => {
  const text = JSON.stringify({ blocks: [flow] });
  const frames = provider === "anthropic" ? [
    { type: "message_start", message: { id: "msg-test", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } },
    { type: "message_stop" },
  ] : [{ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }];
  const body = frames.map(frame => `${"type" in frame ? `event: ${frame.type}\n` : ""}data: ${JSON.stringify(frame)}\n\n`).join("");
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
  const model = provider === "anthropic" ? createAnthropicModel("test-key", { fetch }) : createGeminiModel("test-key", undefined, { fetch });
  const snapshot = await planVisuals({ question, answer, model, snapshot: empty,
    evidence: new Map(), candidates: {}, signal: new AbortController().signal, milliseconds: 1000 });
  expect(snapshot?.blocks).toEqual([{ ...flow, id: "v1" }]);
  const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(sent.tools).toBeUndefined();
  expect(sent.tool_choice).toBeUndefined();
  expect(sent.toolConfig).toBeUndefined();
});
