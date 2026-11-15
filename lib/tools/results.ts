import { z } from "zod";
import { dateFrom } from "../clock";
import type { ProviderResult } from "./providers/types";

// Conservative, server-owned identity hints. Unknown vendors stay unclassified.
const vendors: [RegExp, string][] = [
  [/\bhubspot\b/i, "hubspot.com"], [/\bsalesforce\b/i, "salesforce.com"],
  [/\bpipedrive\b/i, "pipedrive.com"], [/\bzoho\b/i, "zoho.com"],
  [/\b(freshsales|freshworks)\b/i, "freshworks.com"], [/\bneon\b/i, "neon.com"],
  [/\bneon\b/i, "neon.tech"], [/\bsupabase\b/i, "supabase.com"],
  [/\brender\b/i, "render.com"], [/\brailway\b/i, "railway.com"],
  [/\bpostgres(?:ql)?\b/i, "postgresql.org"], [/\bnext\.?js\b/i, "nextjs.org"],
  [/\bopenai\b/i, "openai.com"], [/\banthropic\b/i, "anthropic.com"],
  [/\btavily\b/i, "tavily.com"], [/\bexa\b/i, "exa.ai"],
];

export function officialDomainsFor(query: string): string[] {
  return vendors.filter(([pattern]) => pattern.test(query)).map(([, domain]) => domain);
}

export type SearchResult = {
  title: string;
  url: string;
  published_date: string | null;
  snippet: string;
  content?: string;
  is_official: boolean;
};

const isoDay = z.iso.date();
const isoInstant = z.iso.datetime({ offset: true });

export function normalizePublishedDate(raw?: string | null): string | null {
  if (!raw) return null;
  // Provider timestamps must have a zone; local datetimes would depend on the host.
  const explicitZone = /(?:\b(?:GMT|UTC)(?:[+-]\d{4})?|[+-]\d{4})$/i.test(raw);
  if (!isoDay.safeParse(raw).success && !isoInstant.safeParse(raw).success && !explicitZone) return null;
  const date = dateFrom(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function canonicalUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return;
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid)$/i.test(name)) url.searchParams.delete(name);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.href;
  } catch { return; }
}

export function normalizeResults(raw: ProviderResult[], domains: string[], preferOfficial: boolean, deep: boolean): SearchResult[] {
  const results = new Map<string, SearchResult>();
  for (const item of raw) {
    const url = canonicalUrl(item.url);
    if (!url || url.length > 2048) continue;
    const hostname = new URL(url).hostname;
    const result: SearchResult = {
      title: item.title.slice(0, 240), url,
      published_date: normalizePublishedDate(item.published_date),
      snippet: item.snippet.slice(0, 1200),
      ...(deep && item.content ? { content: item.content.slice(0, 6000) } : {}),
      is_official: domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)),
    };
    const existing = results.get(url);
    if (existing) {
      // Merge duplicate evidence rather than dropping a later date or full text.
      existing.published_date ??= result.published_date;
      if ((result.content?.length ?? 0) > (existing.content?.length ?? 0)) existing.content = result.content;
      if (result.snippet.length > existing.snippet.length) existing.snippet = result.snippet;
    } else results.set(url, result);
  }
  return [...results.values()].sort((a, b) =>
    (preferOfficial ? Number(b.is_official) - Number(a.is_official) : 0) ||
    Number(Boolean(b.published_date)) - Number(Boolean(a.published_date)) ||
    (b.published_date ?? "").localeCompare(a.published_date ?? ""),
  ).slice(0, 5);
}

export type SearchError = { code: "invalid_input" | "search_failed" | "aborted" | "output_budget"; message: string };
export type QueryResult = { query: string; results: SearchResult[]; error?: SearchError };
export type SearchPayload = { queries: QueryResult[]; truncated: boolean; error?: SearchError };

export function wrapResults(payload: SearchPayload): string {
  // Escaping every angle bracket prevents a page from closing the data wrapper.
  const json = JSON.stringify(payload).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return `<search_result>${json}</search_result>`;
}

export function fitBudget(queries: QueryResult[], maxTokens: number): { payload: SearchPayload; content: string } {
  const payload: SearchPayload = { queries: structuredClone(queries), truncated: false };
  let content = wrapResults(payload);
  // UTF-8 bytes are a conservative token upper bound, including JSON and wrappers.
  const over = () => Buffer.byteLength(content, "utf8") > maxTokens;
  while (over()) {
    payload.truncated = true;
    const longest = [...payload.queries].sort((a, b) => b.results.length - a.results.length)[0];
    if (longest?.results.length > 1) {
      longest.results.pop();
    } else {
      const fields = payload.queries.flatMap((query) => query.results.flatMap((result) =>
        (["content", "snippet", "title"] as const).map((key) => ({ result, key, value: result[key] ?? "" })),
      )).filter((field) => field.value.length > 16).sort((a, b) => b.value.length - a.value.length);
      const field = fields[0];
      if (field) field.result[field.key] = field.value.slice(0, Math.floor(field.value.length / 2));
      else {
        const remaining = payload.queries.findLast((query) => query.results.length);
        if (remaining) remaining.results.pop();
        else {
          payload.queries = [];
          payload.error = { code: "output_budget", message: "Search output exceeded its budget. Retry with shorter or fewer queries." };
        }
      }
    }
    content = wrapResults(payload);
  }
  return { payload, content };
}
