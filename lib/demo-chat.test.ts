import { afterEach, describe, expect, it, vi } from "vitest";
import { chatReducer, initialChat, type ChatState } from "./chat-state";
import { createDemoRequest, demoEvents, type DemoScenario } from "./demo-chat";
import { chatEventSchema } from "./chat-stream";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("local fake-backend demo", () => {
  it.each<DemoScenario>(["comparison", "no-results", "interrupted", "slow"])("uses the real event contract and reducer without fetch (%s)", async (scenario) => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let state: ChatState = chatReducer(initialChat, { type: "start", userId: "u", assistantId: "a", text: "Sample request" });
    for (const event of demoEvents(scenario)) expect(chatEventSchema.safeParse(event).success).toBe(true);
    const task = createDemoRequest(scenario)("Sample request", { tz: "UTC", signal: new AbortController().signal, fetch,
      onEvent: (event) => { state = chatReducer(state, { type: "event", assistantId: "a", event }); },
    });
    await vi.runAllTimersAsync();
    await task;
    state = chatReducer(state, { type: "finish", assistantId: "a", outcome: "complete" });
    expect(fetch).not.toHaveBeenCalled();
    expect(state.activeId).toBeNull();
    expect(state.messages[1].content).toBeTruthy();
    expect(state.messages[1].timing?.turnId).toBe("demo-turn");
    expect(state.messages[1].state).toBe(scenario === "interrupted" ? "error" : "complete");
    expect(state.messages[1].sources?.length).toBe(scenario === "no-results" ? 0 : scenario === "interrupted" ? 1 : 3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a slow demo and cleans up pending timers", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onEvent = vi.fn();
    const task = createDemoRequest("slow")("Stop this example", { tz: "UTC", signal: controller.signal, onEvent });
    const rejection = expect(task).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(800);
    controller.abort();
    await rejection;
    const count = onEvent.mock.calls.length;
    await vi.runAllTimersAsync();
    expect(onEvent.mock.calls.length).toBe(count);
    expect(vi.getTimerCount()).toBe(0);
  });
});
