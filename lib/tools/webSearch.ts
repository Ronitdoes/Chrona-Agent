import { LRUCache } from "lru-cache";
import pLimit from "p-limit";
import pTimeout from "p-timeout";
import { webSearchInput, type WebSearchInput } from "../agent/schema";
import { now, type Clock } from "../clock";
import { isLiveScoreRequest } from "../agent/search-policy";
import { liveScoreEvidence } from "./live-results";
import { createTavilyProvider } from "./providers/tavily";
import { createExaProvider } from "./providers/exa";
import type { SearchProvider, SearchRequest } from "./providers/types";
import { fitBudget, normalizeResults, officialDomainsFor, wrapResults, type QueryResult, type SearchResult, type SearchPayload } from "./results";

type Options = {
  primary: SearchProvider;
  onProvider?: (provider: SearchProvider, query: string, fallback: boolean) => void;
  fallback?: SearchProvider;
  clock?: () => Clock;
  concurrency?: number;
  timeoutMs?: number;
  maxTokens?: number;
  officialDomains?: (query: string) => string[];
};

export type WebSearchResult = SearchPayload & { usage?: { query: string; provider: "tavily" | "exa"; fallback: boolean }[]; is_error: boolean; content: string };

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
  const cache = new LRUCache<string, { results: SearchResult[]; provider: SearchProvider; fallback: boolean }>({
    max: 200, ttlResolution: 0, perf: { now: () => clock().instant.getTime() },
  });

  async function callProvider(provider: SearchProvider, request: Omit<SearchRequest, "signal">, signal?: AbortSignal) {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      return await pTimeout(Promise.resolve().then(() => {
        combined.throwIfAborted();
        return provider.search({ ...request, signal: combined });
      }), { milliseconds: request.fresh && options.timeoutMs === undefined ? 15_000 : timeoutMs, signal });
    } finally {
      controller.abort();
    }
  }

  async function searchOne(query: string, input: WebSearchInput, signal?: AbortSignal, forceFresh = false): Promise<QueryResult> {
    if (signal?.aborted) return { query, results: [], error: { code: "aborted", message: "Search was cancelled." } };
    const instant = clock().instant;
    const fresh = forceFresh || isLiveScoreRequest(query);
    const officialDomains = (options.officialDomains ?? officialDomainsFor)(query);
    const filters = {
      recency: input.recency, since: input.since, topic: fresh ? "general" as const : input.topic,
      prefer_official: input.prefer_official, depth: fresh ? "deep" as const : input.depth,
    };
    const request = { ...filters, query, instant, officialDomains, ...(fresh ? { fresh: true } : {}) };
    const key = JSON.stringify([query, filters, instant.toISOString().slice(0, 10), officialDomains]);
    const cached = fresh ? undefined : cache.get(key);
    if (cached) {
      options.onProvider?.(cached.provider, query, cached.fallback);
      return { query, results: cached.results };
    }
    for (const provider of [options.primary, options.fallback]) {
      if (!provider) continue;
      try {
        const raw = await callProvider(provider, request, signal);
        options.onProvider?.(provider, query, provider !== options.primary);
        if (signal?.aborted) break;
        const results = normalizeResults(fresh ? liveScoreEvidence(raw) : raw, officialDomains, input.prefer_official, filters.depth === "deep", fresh);
        if (fresh && !results.length && provider === options.primary && options.fallback) continue;
        if (fresh) for (const result of results) result.retrieved_at = clock().iso;
        else cache.set(key, { results, provider, fallback: provider !== options.primary }, { ttl: cacheTtl(input) });
        return { query, results };
      } catch {
        if (signal?.aborted) break;
      }
    }
    return { query, results: [], error: signal?.aborted
      ? { code: "aborted", message: "Search was cancelled." }
      : { code: "search_failed", message: "Search providers failed or timed out. Retry or report this query as unverifiable." } };
  }

  return async function webSearch(rawInput: unknown, { signal, fresh = false }: { signal?: AbortSignal; fresh?: boolean } = {}): Promise<WebSearchResult> {
    const parsed = webSearchInput.safeParse(rawInput);
    let queries: QueryResult[] = [];
    let error: SearchPayload["error"];
    if (!parsed.success) {
      error = { code: "invalid_input", message: "Invalid web_search input. Supply 1–6 nonempty queries and valid optional filters (since: YYYY-MM-DD)." };
    } else {
      // Deduplicate repeated queries within a call, while retaining their input order.
      const pending = new Map<string, Promise<QueryResult>>();
      queries = await Promise.all(parsed.data.queries.map((query) => {
        if (!pending.has(query)) pending.set(query, limit(() => searchOne(query, parsed.data, signal, fresh)));
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

export async function webSearch(input: unknown, options?: { signal?: AbortSignal; fresh?: boolean }): Promise<WebSearchResult> {
  const { accountContext } = await import("../account-context");
  const account = accountContext.getStore();
  if (account) {
    if (!account.search) {
      const { config, searchProvider } = account;
      const primary = searchProvider === "tavily" ? createTavilyProvider(config.TAVILY_API_KEY) : createExaProvider(config.EXA_API_KEY);
      const other = searchProvider === "tavily" ? "exa" : "tavily";
      const fallback = other === "exa" ? config.EXA_API_KEY && createExaProvider(config.EXA_API_KEY) : config.TAVILY_API_KEY && createTavilyProvider(config.TAVILY_API_KEY);
      let usage: NonNullable<WebSearchResult["usage"]> = [];
      const search = createWebSearch({ primary, fallback: fallback || undefined,
        onProvider: (provider, query, usedFallback) => usage.push({ query, provider: provider === primary ? searchProvider : other, fallback: usedFallback }),
      });
      account.search = async (raw, searchOptions) => {
        usage = [];
        const result = await search(raw, searchOptions);
        return { ...result, usage: [...usage] };
      };
    }
    return account.search(input, options);
  }
  if (!configured) {
    const { env } = await import("../env");
    configured = createWebSearch({
      primary: createTavilyProvider(env.TAVILY_API_KEY),
      fallback: env.EXA_API_KEY ? createExaProvider(env.EXA_API_KEY) : undefined,
    });
  }
  return configured(input, options);
}
