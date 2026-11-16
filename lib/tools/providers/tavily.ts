import { z } from "zod";
import { ProviderError, type Fetch, type SearchProvider } from "./types";

const responseSchema = z.object({ results: z.array(z.object({
  title: z.string().nullish(),
  url: z.string(),
  content: z.string().nullish(),
  raw_content: z.string().nullish(),
  published_date: z.string().nullish(),
  images: z.array(z.union([z.string(), z.object({ url: z.string(), description: z.string().nullish() })]).catch("")).catch([]).optional(),
})) });

export function createTavilyProvider(apiKey: string, fetcher: Fetch = globalThis.fetch): SearchProvider {
  return {
    async search(request) {
      if (!apiKey.trim()) throw new ProviderError("Tavily");
      const response = await fetcher("https://api.tavily.com/search", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: request.signal,
        body: JSON.stringify({
          query: request.query,
          search_depth: request.depth === "deep" ? "advanced" : "basic",
          max_results: request.fresh ? 3 : 5,
          topic: request.topic,
          time_range: request.recency,
          start_date: request.since,
          include_published_date: true,
          include_answer: false,
          ...(request.include_images ? { include_images: true } : {}),
          include_raw_content: request.depth === "deep" ? "markdown" : false,
          ...(request.fresh ? { max_age_hours: 0 } : {}),
          ...(request.prefer_official && request.officialDomains.length ? {
            include_domains: request.officialDomains,
            include_domains_mode: "prefer",
          } : {}),
        }),
      });
      if (!response.ok) throw new ProviderError("Tavily", response.status);
      const data = responseSchema.safeParse(await response.json());
      if (!data.success) throw new ProviderError("Tavily");
      return data.data.results.map((result) => ({
        title: result.title ?? result.url,
        url: result.url,
        published_date: result.published_date,
        snippet: result.content ?? "",
        ...(request.include_images ? { images: (result.images ?? []).map(image => ({ url: typeof image === "string" ? image : image.url })) } : {}),
        ...(request.depth === "deep" ? { content: result.raw_content } : {}),
      }));
    },
  };
}
