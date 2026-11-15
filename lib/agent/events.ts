export type Source = { url: string; title: string; domain: string; publishedDate: string | null; isOfficial: boolean };
export type AgentEvents = {
  status: { id: string; kind: "search"; queries: string[]; state: "running" | "done"; count: number };
  delta: { text: string };
  sources: Source[];
  done: { turnId: string; ttftMs: number; totalMs: number };
  error: { message: string };
};
export type SendEvent = <K extends keyof AgentEvents>(event: K, data: AgentEvents[K]) => void;

export function sse<K extends keyof AgentEvents>(event: K, data: AgentEvents[K]): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
