import { z } from "zod";
import { dateFrom } from "../../clock";
import { ProviderError, type Fetch, type SearchProvider, type SearchRequest } from "./types";

const responseSchema = z.object({ results: z.array(z.object({
  title: z.string().nullish(),
  url: z.string(),
  publishedDate: z.string().nullish(),
  text: z.string().nullish(),
  highlights: z.array(z.string()).nullish(),
})) });

export function startPublishedDate(request: Pick<SearchRequest, "recency" | "since" | "instant">): string | undefined {
  const days = { day: 1, week: 7, month: 30, year: 365 };
  const relative = request.recency
    ? request.instant.getTime() - days[request.recency] * 86_400_000
    : undefined;
  const explicit = request.since ? dateFrom(`${request.since}T00:00:00Z`).getTime() : undefined;
  if (relative === undefined && explicit === undefined) return undefined;
  return dateFrom(Math.max(relative ?? -Infinity, explicit ?? -Infinity)).toISOString();
}

export function createExaProvider(apiKey: string, fetcher: Fetch = globalThis.fetch): SearchProvider {
  return {
    async search(request) {
      if (!apiKey.trim()) throw new ProviderError("Exa");
      const response = await fetcher("https://api.exa.ai/search", {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        signal: request.signal,
        body: JSON.stringify({
          query: request.query,
          type: "auto",
          numResults: 5,
          startPublishedDate: startPublishedDate(request),
          ...(request.topic === "news" ? { category: "news" } : {}),
          contents: {
            highlights: true,
            ...(request.depth === "deep" ? { text: { maxCharacters: 12_000 } } : {}),
          },
          // Exa includeDomains restricts; boost official sources locally instead.
        }),
      });
      if (!response.ok) throw new ProviderError("Exa", response.status);
      const data = responseSchema.safeParse(await response.json());
      if (!data.success) throw new ProviderError("Exa");
      return data.data.results.map((result) => ({
        title: result.title ?? result.url,
        url: result.url,
        published_date: result.publishedDate,
        snippet: result.highlights?.join("\n") ?? result.text?.slice(0, 1200) ?? "",
        ...(request.depth === "deep" ? { content: result.text } : {}),
      }));
    },
  };
}
