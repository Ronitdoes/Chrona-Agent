import type { AgentEvents, Source } from "./agent/events";
import type { ChatEvent } from "./chat-stream";

export type ChatMessage = {
  id: string; role: "user" | "assistant"; content: string;
  state: "streaming" | "complete" | "stopped" | "error";
  error?: string; sources?: Source[]; searches?: AgentEvents["status"][]; timing?: AgentEvents["done"];
};
export type ChatState = { messages: ChatMessage[]; activeId: string | null };
export const initialChat: ChatState = { messages: [], activeId: null };
export type ChatAction =
  | { type: "load"; messages: ChatMessage[] }
  | { type: "start"; userId: string; assistantId: string; text: string }
  | { type: "event"; assistantId: string; event: ChatEvent }
  | { type: "finish"; assistantId: string; outcome: "complete" | "stopped" | "error"; error?: string };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "load") return state.activeId ? state : { messages: action.messages, activeId: null };
  if (action.type === "start") {
    if (state.activeId || !action.text.trim()) return state;
    return { activeId: action.assistantId, messages: [...state.messages,
      { id: action.userId, role: "user", content: action.text.trim(), state: "complete" },
      { id: action.assistantId, role: "assistant", content: "", state: "streaming", sources: [], searches: [] },
    ] };
  }
  // Ignore late callbacks from a stopped request, including while its successor is streaming.
  if (state.activeId !== action.assistantId) return state;
  return {
    activeId: action.type === "finish" ? null : state.activeId,
    messages: state.messages.map((message) => {
      if (message.id !== action.assistantId) return message;
      if (action.type === "finish") return { ...message,
        state: message.state === "streaming" ? action.outcome : message.state,
        error: message.error ?? action.error,
      };
      const event = action.event;
      switch (event.type) {
        case "delta": return { ...message, content: message.content + event.data.text };
        case "sources": return { ...message, sources: event.data };
        case "status": return { ...message, searches: [...(message.searches ?? []).filter((search) => search.id !== event.data.id), event.data] };
        case "error": return { ...message, state: "error", error: event.data.message };
        case "done": return { ...message, state: message.state === "streaming" ? "complete" : message.state, timing: event.data };
      }
    }),
  };
}
