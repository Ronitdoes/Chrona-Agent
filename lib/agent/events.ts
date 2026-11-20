export type Source = { url: string; title: string; domain: string; publishedDate: string | null; isOfficial: boolean };
export const researchStages = ["searching", "checking", "writing", "visuals"] as const;
export type AgentEvents = {
  status: { id: string; kind: "search"; queries: string[]; state: "running" | "done"; count: number; sources?: Source[]; usage?: { query: string; provider: "tavily" | "exa"; fallback: boolean }[] };
  research_phase: { stage: typeof researchStages[number] };
  delta: { text: string };
  sources: Source[];
  answer_ui: import("../answer-blocks").RichAnswer;
  done: { turnId: string; ttftMs: number; totalMs: number };
  error: { message: string };
};
export type SendEvent = <K extends keyof AgentEvents>(event: K, data: AgentEvents[K]) => void;

export function* textChunks(text: string): Generator<string> {
  let chunk = "";
  for (const character of text) {
    chunk += character;
    if (chunk.length >= 4096) {
      yield chunk;
      chunk = "";
    }
  }
  if (chunk) yield chunk;
}

export function sse<K extends keyof AgentEvents>(event: K, data: AgentEvents[K]): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
