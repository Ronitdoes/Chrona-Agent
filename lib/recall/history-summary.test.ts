import { describe, expect, it, vi } from "vitest";
import { clock, turn } from "../../test/agent-fixtures";
import { dateFrom } from "../clock";
import { summarizeQuestionHistory, summaryInput, validateSummary } from "./history-summary";
import type { RecallModel } from "./plan";

const messages = [
  turn(1, { content: "What is today's date?", ts: dateFrom(clock.instant.getTime() - 3000) }),
  turn(2, { content: "Current time?", ts: dateFrom(clock.instant.getTime() - 2000) }),
  turn(3, { content: "What did I ask yesterday?", ts: dateFrom(clock.instant.getTime() - 1000) }),
];
const input = summaryInput({ messages, truncated: false }, "Recap my messages").input;
const summary = { items: [{ turnId: 1, summary: "Asked for the date." }, { turnId: 2, summary: "Asked for the current time." }, { turnId: 3, summary: "Requested yesterday's message history." }] };

describe("bounded, source-linked history summaries", () => {
  it.each([
    { items: [{ turnId: 999, summary: "Forged" }] },
    { items: [{ turnId: 1, summary: "Omitted messages" }] },
    { items: [{ turnId: 1, summary: "First" }, { turnId: 1, summary: "Duplicate" }, { turnId: 2, summary: "Second" }, { turnId: 3, summary: "Third" }] },
    { items: [{ turnIds: [1, 2, 3], summary: "Catch-all hides distinct requests" }] },
    { items: [] },
  ])("rejects forged, missing or duplicate source coverage %#", output => {
    expect(() => validateSummary(output, input)).toThrow();
  });
  it("bounds large inputs, prioritizes newest messages and discloses incomplete coverage", () => {
    const history = { messages: Array.from({ length: 150 }, (_, index) => turn(index + 1, { content: "x".repeat(3000) })), truncated: false };
    const bounded = summaryInput(history, "Summarize");
    expect(bounded.truncated).toBe(true);
    expect(bounded.input.messages[0].id).toBe(150);
    expect(bounded.input.messages.reduce((total, row) => total + row.content.length, 0)).toBeLessThanOrEqual(24_000);
    const countBound = summaryInput({ ...history, messages: history.messages.map(row => ({ ...row, content: "short" })) }, "Recap");
    expect(countBound.input.messages).toHaveLength(100);
    expect(countBound.truncated).toBe(true);
  });

  async function run(summarize: RecallModel["summarize"], pages = [messages, messages]) {
    let inventories = 0;
    const store = { userMessagesFor: vi.fn(async (_userId, options) => options.sessionId ? [] : pages[Math.min(inventories++, pages.length - 1)]), historySources: vi.fn(async () => []) };
    const response = await summarizeQuestionHistory({ userId: "alice", request: { ranges: [] }, before: { ts: clock.instant, id: 99 }, clock,
      message: "Recap my messages", model: { summarize }, signal: new AbortController().signal }, store);
    return { ...response, store };
  }
  it("includes date/time/recall questions and groups repeats with code-rendered timestamps and counts", async () => {
    const summarize = vi.fn<RecallModel["summarize"]>().mockResolvedValue(summary);
    const { text, store } = await run(summarize);
    expect(text).toContain("**3** earlier messages");
    expect(text).toContain("Asked for the date\\. (1 message;");
    expect(text).toContain("Asked for the current time\\. (1 message;");
    expect(text).toContain("Requested yesterday's message history\\.");
    expect(text).toContain("UTC");
    expect(store.userMessagesFor).toHaveBeenCalledTimes(5);
    expect(summarize.mock.calls[0][0].messages.map(row => row.content)).toEqual([...messages].reverse().map(row => row.content));
    expect(text).not.toContain("couldn't locate");
  });
  it("preserves originals rather than claiming no history on a provider failure", async () => {
    const { text } = await run(async () => { throw new Error("private provider error"); });
    expect(text).toContain("saved messages instead");
    expect(text).toContain("Current time?");
    expect(text).not.toContain("private provider error");
  });
  it("invalidates a summary after source deletion or modification during inference", async () => {
    const { text } = await run(async () => summary, [messages, messages.slice(1)]);
    expect(text).toContain("saved messages instead");
    expect(text).not.toContain("Asked for the date and current time.");
    expect(text).not.toContain("What is today's date?");
    const edited = messages.map(row => row.id === 1 ? { ...row, content: "Edited original" } : row);
    expect((await run(async () => summary, [messages, edited])).text).toContain("Edited original");
  });
  it("skips summary inference for empty history and honors cancellation", async () => {
    const summarize = vi.fn();
    expect((await run(summarize, [[], []])).text).toContain("couldn't find any earlier");
    expect(summarize).not.toHaveBeenCalled();
    const signal = AbortSignal.abort();
    const store = { userMessagesFor: vi.fn(), historySources: vi.fn() };
    await expect(summarizeQuestionHistory({ userId: "alice", request: { ranges: [] }, before: { ts: clock.instant, id: 99 }, clock,
      message: "Recap", model: { summarize }, signal }, store)).rejects.toThrow();
    expect(store.userMessagesFor).not.toHaveBeenCalled();
  });
});
