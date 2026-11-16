import type { ContentBlock, MessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import { dateFrom, type Clock } from "../lib/clock";
import type { Claim, Turn, Memory, Thread } from "../lib/store/schema";
import type { Recall } from "../lib/recall/retrieve";
import type { AgentModel, ModelReply, ModelRequest, ModelStream } from "../lib/agent/model";

export const clock: Clock = { instant: dateFrom("2026-11-15T12:00:00Z"), iso: "2026-11-15T12:00:00.000Z", human: "Sunday 15 November 2026, 12:00 (UTC)", tz: "UTC" };
export const turn = (id: number, overrides: Partial<Turn> = {}): Turn => ({
  id, userId: "alice", sessionId: "one", role: "user", content: "Which CRM?", ts: dateFrom("2026-11-09T12:00:00Z"), tz: "UTC", tsv: null, answerUi: null, ...overrides,
});
export const claim = (overrides: Partial<Claim> = {}): Claim => ({
  id: 1, turnId: 2, userId: "alice", subject: "HubSpot", attribute: "price", value: "$20/seat/mo",
  asOf: dateFrom("2026-11-09T12:00:01Z"), sourceUrls: ["https://hubspot.com/pricing"], volatility: "high", supersededBy: null, ...overrides,
});
export const memory = (overrides: Partial<Memory> = {}): Memory => ({ userId: "alice", key: "team", value: "20 people", updatedAt: clock.instant, sourceTurnId: 1, ...overrides });
export const thread = (overrides: Partial<Thread> = {}): Thread => ({ id: 1, userId: "alice", title: "CRM shortlist", summary: "Compared five tools", lastTs: clock.instant, sourceTurnId: null, ...overrides });
export const recall = (overrides: Partial<Recall> = {}): Recall => ({
  turns: [], claims: [], memory: [], threads: [], resolvedRanges: [], missingRanges: [], matchedBy: "none", notFound: true, truncated: false, ...overrides,
});

export type FakeStep = {
  text?: string[];
  tools?: { id?: string; name?: string; input: unknown }[];
  stop?: ModelReply["stop_reason"];
  error?: Error;
  hang?: boolean;
  beforeText?: () => void;
  after?: () => void;
};

export class FakeModel implements AgentModel {
  readonly requests: ModelRequest[] = [];
  readonly streams: { aborted: boolean; signal: AbortSignal }[] = [];
  constructor(private readonly script: FakeStep[]) {}

  stream(request: ModelRequest, { signal }: { signal: AbortSignal }): ModelStream {
    const index = this.requests.length;
    this.requests.push(structuredClone(request));
    const step = this.script[index];
    if (!step) throw new Error("Unexpected model request");
    const state = { aborted: false, signal };
    this.streams.push(state);
    const content: ContentBlock[] = [
      ...(step.text?.length ? [{ type: "text" as const, text: step.text.join(""), citations: null }] : []),
      ...(step.tools ?? []).map((tool, i) => ({ type: "tool_use" as const, id: tool.id ?? `tool-${index}-${i}`, name: tool.name ?? "web_search", input: tool.input, caller: { type: "direct" as const } })),
    ];
    return {
      abort: () => { state.aborted = true; },
      async finalMessage() {
        step.after?.();
        return { content, stop_reason: step.stop ?? (step.tools?.length ? "tool_use" : "end_turn") };
      },
      async *[Symbol.asyncIterator](): AsyncGenerator<MessageStreamEvent> {
        for (const text of step.text ?? []) {
          step.beforeText?.();
          yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
        }
        if (step.error) throw step.error;
        if (step.hang) await new Promise(() => {});
      },
    };
  }
}
