import { sse, type AgentEvents, type Source } from "./agent/events";
import type { ChatMessage } from "./chat-state";
import { readChatStream, type ChatEvent, type requestChat } from "./chat-stream";

export type DemoScenario = "comparison" | "no-results" | "interrupted" | "slow";
export const demoSources: Source[] = [
  { url: "https://example.com/pricing", domain: "example.com", title: "Northstar CRM — sample pricing", publishedDate: "2026-11-14T09:00:00Z", isOfficial: true },
  { url: "https://example.org/releases", domain: "example.org", title: "Orbit Sales — sample release notes", publishedDate: "2026-11-13T12:00:00Z", isOfficial: false },
  { url: "https://example.net/plans", domain: "example.net", title: "Harbor CRM — sample plan information", publishedDate: null, isOfficial: false },
];
export const demoSearches: AgentEvents["status"][] = [
  { id: "demo-s1", kind: "search", queries: ["Northstar CRM official pricing", "Orbit Sales release notes"], state: "done", count: 8 },
  { id: "demo-s2", kind: "search", queries: ["Harbor CRM plans", "Northstar CRM November updates", "Orbit Sales current plans"], state: "done", count: 4 },
];
export const demoAnswer = `I compared the sample shortlist with its earlier baseline. Here’s what the available evidence supports.

### Northstar CRM
**Changed** — The sample price moved from **$20 to $23 per seat/month**. As of 15 November 2026.

### Orbit Sales
**Unchanged** — A newer dated source still lists **$15 per seat/month**. As of 2026-11-15.

### Harbor CRM
**Couldn’t verify** — The plan page has no publication date, so it cannot establish whether the earlier price still applies. As of November 15, 2026.

The distinction matters: a missing announcement is not evidence that a price stayed the same.`;

export const demoMessages: ChatMessage[] = [
  { id: "demo-u", role: "user", state: "complete", content: "Has anything changed in our CRM shortlist since Monday?" },
  { id: "demo-a", role: "assistant", state: "complete", content: demoAnswer, searches: demoSearches, sources: demoSources },
];

export function demoEvents(scenario: DemoScenario): ChatEvent[] {
  const running: AgentEvents["status"] = { id: "demo-search", kind: "search", queries: demoSearches.flatMap((search) => search.queries), state: "running", count: 0 };
  const events: ChatEvent[] = [{ type: "status", data: running }];
  if (scenario === "interrupted") return [...events,
    { type: "delta", data: { text: "I found a dated sample pricing page, but the remaining checks could not finish." } },
    { type: "sources", data: [demoSources[0]] },
    { type: "error", data: { message: "The demo search was interrupted. The partial answer and source are preserved." } },
    { type: "done", data: { turnId: "demo-turn", ttftMs: 180.5, totalMs: 960.25 } },
  ];
  if (scenario !== "slow") events.push({ type: "status", data: { ...running, state: "done", count: scenario === "no-results" ? 0 : 12 } });
  events.push({ type: "sources", data: scenario === "no-results" ? [] : demoSources });
  const text = scenario === "no-results"
    ? "**Couldn’t verify** — No dated results were returned for the sample shortlist. As of 15 Nov 2026. Without newer evidence, I can’t confirm a change or call the earlier answer unchanged."
    : scenario === "slow" ? "I’m checking the sample shortlist. You can stop this reply at any point.\n\n" + demoAnswer : demoAnswer;
  for (const chunk of text.match(/[\s\S]{1,45}/g) ?? []) events.push({ type: "delta", data: { text: chunk } });
  if (scenario === "slow") events.push({ type: "status", data: { ...running, state: "done", count: 12 } });
  events.push({ type: "done", data: { turnId: "demo-turn", ttftMs: 180.5, totalMs: 2400.75 } });
  return events;
}

/** In-browser fake backend: same bytes, parser and reducer; no fetch, keys or storage. */
export function createDemoRequest(scenario: DemoScenario): typeof requestChat {
  return async (_message, options) => {
    options.signal.throwIfAborted();
    const events = demoEvents(scenario);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let index = 0;
    const encoder = new TextEncoder();
    const cleanup = () => { if (timer !== undefined) clearTimeout(timer); options.signal.removeEventListener("abort", onAbort); };
    let fail: (() => void) | undefined;
    const onAbort = () => { if (!closed) { closed = true; cleanup(); fail?.(); } };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        fail = () => controller.error(new DOMException("Demo stopped", "AbortError"));
        options.signal.addEventListener("abort", onAbort, { once: true });
        const next = () => {
          if (closed) return;
          if (index === events.length) { closed = true; cleanup(); controller.close(); return; }
          const event = events[index++];
          controller.enqueue(encoder.encode(sse(event.type, event.data)));
          timer = setTimeout(next, scenario === "slow" ? 350 : event.type === "status" ? 450 : 45);
        };
        next();
      },
      cancel() { closed = true; cleanup(); },
    });
    await readChatStream(body, options.onEvent, options.signal);
  };
}
