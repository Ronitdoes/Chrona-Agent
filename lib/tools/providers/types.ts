import type { WebSearchInput } from "../../agent/schema";

export type ProviderResult = {
  title: string;
  url: string;
  published_date?: string | null;
  snippet: string;
  content?: string | null;
};

export type SearchRequest = Omit<WebSearchInput, "queries"> & {
  query: string;
  instant: Date;
  officialDomains: string[];
  fresh?: boolean;
  signal: AbortSignal;
};

export interface SearchProvider {
  search(request: SearchRequest): Promise<ProviderResult[]>;
}

export type Fetch = typeof globalThis.fetch;

// Do not forward response bodies or transport errors: they may echo credentials.
export class ProviderError extends Error {
  constructor(provider: string, status?: number) {
    super(`${provider} search failed${status ? ` (HTTP ${status})` : ""}`);
    this.name = "ProviderError";
  }
}
