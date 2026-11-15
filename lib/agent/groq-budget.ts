import { z } from "zod";
import { fitBudget, wrapResults } from "../tools/results";
import { ModelProviderError } from "./errors";
import type { GroqRequest } from "./groq";

export const GROQ_INPUT_BUDGET = 6500;
export const GROQ_OUTPUT_BUDGET = 768;

// Count serialized UTF-8 bytes as a conservative token upper bound, including
// tools, JSON escaping and message framing, rather than budgeting each part alone.
export function groqInputSize(body: GroqRequest): number {
  return Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools }), "utf8") + 64 + body.messages.length * 32;
}

const errorSchema = z.object({ code: z.enum(["invalid_input", "search_failed", "aborted", "output_budget"]), message: z.string() });
const payloadSchema = z.object({
  queries: z.array(z.object({ query: z.string(), error: errorSchema.optional(), results: z.array(z.object({
    title: z.string(), url: z.string(), published_date: z.string().nullable(), snippet: z.string(),
    content: z.string().optional(), is_official: z.boolean(),
  })) })), truncated: z.boolean(), error: errorSchema.optional(),
});
const omission = "Some history, recalled context or search excerpts were omitted to fit the provider input limit. Use only the remaining evidence; never invent omitted details.";

/** Shrink data and complete old exchanges; never truncate policy, clock or the current question. */
export function fitGroqRequest(original: GroqRequest, maxInputTokens: number): GroqRequest {
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 512) throw new Error("Invalid Groq input budget");
  if (groqInputSize(original) <= maxInputTokens) return original;
  const body = structuredClone(original);
  const system = body.messages.find((message) => message.role === "system");
  if (system) system.content = `${system.content ?? ""}\n${omission}`;
  else body.messages.unshift({ role: "system", content: omission });
  const over = () => groqInputSize(body) > maxInputTokens;
  // Streamed search preambles remain visible to the user, but are not evidence
  // and need not be repeated in every subsequent model request.
  for (const message of body.messages) if (message.tool_calls?.length) message.content = null;
  let results = body.messages.flatMap((message) => {
    if (message.role !== "tool" || !message.content) return [];
    const match = /^(Tool error: )?<search_result>([\s\S]*)<\/search_result>$/.exec(message.content);
    if (!match) return [];
    try {
      const parsed = payloadSchema.safeParse(JSON.parse(match[2]));
      return parsed.success ? [{ message, payload: parsed.data, prefix: match[1] ?? "" }] : [];
    } catch { return []; }
  });
  const shrinkResults = (bytes: number) => {
    for (const { message, payload, prefix } of results) {
      const seen = new Set<string>();
      const shortened = payload.queries.map(query => ({ ...query, query: query.query.slice(0, 80), results: query.results.filter(source => {
        if (seen.has(source.url)) return false; seen.add(source.url); return true;
      }) })).filter(query => query.results.length || query.error);
      let bounded = fitBudget(shortened, bytes).payload;
      const originalSources = new Map(shortened.flatMap(query => query.results.map(source => [source.url, source] as const)));
      const useful = () => bounded.queries.some(query => query.results.some(source => source.snippet.length >= Math.min(160, originalSources.get(source.url)?.snippet.length ?? 0)));
      // Query labels must not consume the whole evidence allowance. If keeping
      // every group leaves no source at all, omit older groups before retrying.
      while (shortened.length > 1 && shortened.some(query => query.results.length) && !useful()) {
        shortened.pop(); bounded = fitBudget(shortened, bytes).payload; bounded.truncated = true;
      }
      bounded.truncated ||= shortened.length < payload.queries.length;
      bounded.truncated ||= payload.queries.some(query => query.query.length > 80);
      bounded.truncated ||= payload.truncated;
      bounded.error ??= payload.error;
      const content = prefix + wrapResults(bounded);
      if (content.length < (message.content?.length ?? 0)) message.content = content;
    }
  };
  for (const message of body.messages) for (const call of message.tool_calls ?? []) {
    if (call.function.name !== "web_search") continue;
    try {
      const input = JSON.parse(call.function.arguments) as { queries?: unknown };
      if (!Array.isArray(input.queries) || !input.queries.every(query => typeof query === "string")) continue;
      const shorter = JSON.stringify({ ...input, queries: input.queries.map(query => (query as string).slice(0, 80)) });
      if (shorter.length < call.function.arguments.length) call.function.arguments = shorter;
    } catch { /* Unrecognized call arguments remain intact. */ }
  }
  // Retain one complete recent tool exchange and roll all earlier evidence into
  // its result. Repeated tool schemas/IDs and assistant preambles otherwise grow
  // even after every excerpt has been shortened, starving final synthesis.
  if (over()) {
    const current = body.messages.findLastIndex(message => message.role === "user");
    const latest = body.messages.findLastIndex(message => Boolean(message.tool_calls?.length));
    if (latest > current + 1 && results.length > 1) {
      const retained = results.find(result => body.messages.indexOf(result.message) > latest);
      if (retained) {
        const queries = new Map<string, typeof retained.payload.queries[number]>();
        for (const result of [...results].reverse()) for (const query of result.payload.queries) {
          const existing = queries.get(query.query);
          if (!existing) queries.set(query.query, structuredClone(query));
          else for (const source of query.results) if (!existing.results.some(item => item.url === source.url)) existing.results.push(source);
        }
        retained.payload = { queries: [...queries.values()], truncated: true };
        body.messages.splice(current + 1, latest - current - 1);
        results = results.filter(result => body.messages.includes(result.message));
        retained.message.content = retained.prefix + wrapResults(retained.payload);
      }
    }
  }
  // Reserve useful fresh evidence before making room by omitting older context.
  shrinkResults(Math.max(512, Math.min(2000, Math.floor(maxInputTokens / 3 / Math.max(1, results.length)))));
  while (over()) {
    const current = body.messages.findLastIndex((message) => message.role === "user");
    const first = body.messages.findIndex((message) => message.role !== "system");
    if (first < 0 || first >= current) break;
    const next = body.messages.findIndex((message, index) => index > first && message.role === "user");
    if (next < 0) break;
    body.messages.splice(first, next - first);
  }
  const omitData = (names: string[]) => {
    for (const message of body.messages) if (message.role === "system" && message.content) {
      for (const name of names) {
        const pattern = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g");
        message.content = message.content.replace(pattern, (block, json: string) => {
          try { return Array.isArray(JSON.parse(json)) ? `<${name}>[]</${name}>` : block; }
          catch { return block; }
        });
      }
    }
  };
  // Original recalled transcripts and their extracted claims leave together.
  for (const names of [["recalled_turns", "claims", "suggested_queries"], ["threads"], ["memory"]]) {
    if (!over()) break;
    omitData(names);
  }
  for (const bytes of [1024, 512]) { if (over()) shrinkResults(bytes); }
  if (over()) {
    for (const { message, payload, prefix } of results) {
      message.content = prefix + wrapResults({ queries: [], truncated: true, ...(payload.error ? { error: payload.error } : {}) });
      if (!over()) break;
    }
  }
  if (over()) throw new ModelProviderError({ provider: "groq", kind: "request_size" });
  return body;
}
