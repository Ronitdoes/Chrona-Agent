import { describe, expect, it } from "vitest";
import { chatReducer, initialChat, type ChatState } from "./chat-state";

const started = () => chatReducer(initialChat, { type: "start", text: " Hello ", userId: "u1", assistantId: "a1" });
const delta = (state: ChatState, text: string) => chatReducer(state, { type: "event", assistantId: "a1", event: { type: "delta", data: { text } } });
describe("streamed conversation state", () => {
  it("adds one user/assistant pair and prevents concurrent sends", () => {
    const state = started();
    expect(state.messages.map((message) => [message.role, message.content])).toEqual([["user", "Hello"], ["assistant", ""]]);
    expect(chatReducer(state, { type: "start", text: "Double click", userId: "u2", assistantId: "a2" })).toBe(state);
    expect(chatReducer(initialChat, { type: "start", text: " ", userId: "u1", assistantId: "a1" })).toBe(initialChat);
  });
  it("keeps partial text on Stop and ignores late events from that request", () => {
    const stopped = chatReducer(delta(started(), "Partial"), { type: "finish", assistantId: "a1", outcome: "stopped" });
    expect(stopped.messages[1]).toMatchObject({ content: "Partial", state: "stopped" });
    expect(delta(stopped, "late")).toBe(stopped);
    const next = chatReducer(stopped, { type: "start", text: "Next", userId: "u2", assistantId: "a2" });
    expect(delta(next, "old request")).toBe(next);
    expect(next.messages).toHaveLength(4);
  });
  it("stores source/status/timing metadata and preserves an SSE error through done", () => {
    let state = started();
    for (const status of ["running", "done"] as const) state = chatReducer(state, { type: "event", assistantId: "a1", event: { type: "status", data: { id: "s1", kind: "search", queries: ["CRM"], state: status, count: 1 } } });
    state = chatReducer(state, { type: "event", assistantId: "a1", event: { type: "sources", data: [] } });
    state = chatReducer(state, { type: "event", assistantId: "a1", event: { type: "error", data: { message: "A source failed" } } });
    state = chatReducer(state, { type: "event", assistantId: "a1", event: { type: "done", data: { turnId: "server-1", ttftMs: 1, totalMs: 2 } } });
    state = chatReducer(state, { type: "finish", assistantId: "a1", outcome: "complete" });
    expect(state.activeId).toBeNull();
    expect(state.messages[1]).toMatchObject({ state: "error", error: "A source failed", searches: [{ state: "done" }], timing: { turnId: "server-1" } });
    expect(state.messages[1].searches).toHaveLength(1);
  });
});
