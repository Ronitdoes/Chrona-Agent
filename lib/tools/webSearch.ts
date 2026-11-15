import { LRUCache } from "lru-cache";
import pLimit from "p-limit";
import pTimeout from "p-timeout";
import { webSearchInput, type WebSearchInput } from "../agent/schema";
import { now, type Clock } from "../clock";
import { createTavilyProvider } from "./providers/tavily";
import { createExaProvider } from "./providers/exa";
import type { SearchProvider, SearchRequest } from "./providers/types";
import { fitBudget, normalizeResults, officialDomainsFor, wrapResults, type QueryResult, type SearchResult, type SearchPayload } from "./results";

type Options = {
  primary: SearchProvider;
  fallback?: SearchProvider;
  clock?: () => Clock;
  concurrency?: number;
  timeoutMs?: number;
  maxTokens?: number;
  officialDomains?: (query: string) => string[];
};

export type WebSearchResult = SearchPayload & { is_error: boolean; content: string };

export function cacheTtl(input: Pick<WebSearchInput, "topic" | "recency">): number {
  if (input.topic === "news" || input.recency === "day") return 60_000;
  return { week: 300_000, month: 900_000, year: 3_600_000 }[input.recency ?? "year"];
}

export function createWebSearch(options: Options) {
  const clock = options.clock ?? now;
  const limit = pLimit(options.concurrency ?? 3);
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxTokens = options.maxTokens ?? 8000;
  if (!(timeoutMs > 0 && Number.isFinite(timeoutMs))) throw new Error("Search timeout must be positive and finite");
  if (!Number.isInteger(maxTokens) || maxTokens < 512) throw new Error("Search token budget must be at least 512");
  const cache = new LRUCache<string, SearchResult[]>({
    max: 200, ttlResolution: 0, perf: { now: () => clock().instant.getTime() },
  });

  async function callProvider(provider: SearchProvider, request: Omit<SearchRequest, "signal">, signal?: AbortSignal) {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      return await pTimeout(Promise.resolve().then(() => {
        combined.throwIfAborted();
        return provider.search({ ...request, signal: combined });
      }), { milliseconds: timeoutMs, signal });
    } finally {
      controller.abort();
    }
  }

  async function searchOne(query: string, input: WebSearchInput, signal?: AbortSignal): Promise<QueryResult> {
    if (signal?.aborted) return { query, results: [], error: { code: "aborted", message: "Search was cancelled." } };
    const instant = clock().instant;
    const officialDomains = (options.officialDomains ?? officialDomainsFor)(query);
    const filters = {
      recency: input.recency, since: input.since, topic: input.topic,
      prefer_official: input.prefer_official, depth: input.depth,
    };
    const request = { ...filters, query, instant, officialDomains };
    const key = JSON.stringify([query, filters, instant.toISOString().slice(0, 10), officialDomains]);
    const cached = cache.get(key);
    if (cached) return { query, results: cached };
    for (const provider of [options.primary, options.fallback]) {
      if (!provider) continue;
      try {
        const raw = await callProvider(provider, request, signal);
        if (signal?.aborted) break;
        const results = normalizeResults(raw, officialDomains, input.prefer_official, input.depth === "deep");
        cache.set(key, results, { ttl: cacheTtl(input) });
        return { query, results };
      } catch {
        if (signal?.aborted) break;
      }
    }
    return { query, results: [], error: signal?.aborted
      ? { code: "aborted", message: "Search was cancelled." }
      : { code: "search_failed", message: "Search providers failed or timed out. Retry or report this query as unverifiable." } };
  }

  return async function webSearch(rawInput: unknown, { signal }: { signal?: AbortSignal } = {}): Promise<WebSearchResult> {
    const parsed = webSearchInput.safeParse(rawInput);
    let queries: QueryResult[] = [];
    let error: SearchPayload["error"];
    if (!parsed.success) {
      error = { code: "invalid_input", message: "Invalid web_search input. Supply 1–6 nonempty queries and valid optional filters (since: YYYY-MM-DD)." };
    } else {
      // Deduplicate repeated queries within a call, while retaining their input order.
      const pending = new Map<string, Promise<QueryResult>>();
      queries = await Promise.all(parsed.data.queries.map((query) => {
        if (!pending.has(query)) pending.set(query, limit(() => searchOne(query, parsed.data, signal)));
        return pending.get(query)!;
      }));
    }
    const { payload, content } = error
      ? { payload: { queries, error, truncated: false }, content: "" }
      : fitBudget(queries, maxTokens);
    if (error) {
      return { ...payload, is_error: true, content: wrapResults(payload) };
    }
    return { ...payload, content, is_error: Boolean(payload.error) || payload.queries.every((query) => Boolean(query.error)) };
  };
}

let configured: ReturnType<typeof createWebSearch> | undefined;

export async function webSearch(input: unknown, options?: { signal?: AbortSignal }): Promise<WebSearchResult> {
  if (!configured) {
    const { env } = await import("../env");
    configured = createWebSearch({
      primary: createTavilyProvider(env.TAVILY_API_KEY),
      fallback: env.EXA_API_KEY ? createExaProvider(env.EXA_API_KEY) : undefined,
    });
  }
  return configured(input, options);
}
