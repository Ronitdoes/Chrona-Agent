import { describe, expect, it, vi } from "vitest";
import { dateFrom } from "../../clock";
import { createExaProvider, startPublishedDate } from "./exa";
import { createTavilyProvider } from "./tavily";
import type { Fetch, SearchRequest } from "./types";

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    query: "HubSpot pricing", instant: dateFrom("2026-11-15T12:00:00Z"),
    topic: "general", prefer_official: false, depth: "fast", officialDomains: ["hubspot.com"],
    signal: new AbortController().signal, ...overrides,
  };
}

function response(json: unknown, status = 200) {
  return vi.fn<Fetch>().mockResolvedValue(new Response(JSON.stringify(json), { status }));
}

describe("Tavily provider", () => {
  it("maps filters to the documented API fields and extracts deep content", async () => {
    const fetcher = response({ results: [{ title: "HubSpot", url: "https://hubspot.com/pricing", content: "Snippet", raw_content: "Full table", published_date: "2026-11-14" }] });
    const input = request({ recency: "week", since: "2026-11-01", topic: "news", depth: "deep", prefer_official: true });
    const result = await createTavilyProvider("test-key", fetcher).search(input);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    expect(options?.headers).toEqual({ Authorization: "Bearer test-key", "Content-Type": "application/json" });
    expect(options?.signal).toBe(input.signal);
    expect(JSON.parse(options?.body as string)).toEqual({
      query: "HubSpot pricing", search_depth: "advanced", max_results: 5, topic: "news",
      time_range: "week", start_date: "2026-11-01", include_published_date: true,
      include_answer: false, include_raw_content: "markdown", include_domains: ["hubspot.com"], include_domains_mode: "prefer",
    });
    expect(result[0]).toMatchObject({ snippet: "Snippet", content: "Full table", published_date: "2026-11-14" });
  });

  it("uses a basic search without full content or domain restrictions by default", async () => {
    const fetcher = response({ results: [{ url: "https://example.com", content: null }] });
    const result = await createTavilyProvider("test-key", fetcher).search(request());
    const body = JSON.parse(fetcher.mock.calls[0][1]?.body as string);
    expect(body.search_depth).toBe("basic");
    expect(body.include_raw_content).toBe(false);
    expect(body).not.toHaveProperty("include_domains");
    expect(body).not.toHaveProperty("include_domains_mode");
    expect(body).not.toHaveProperty("max_age_hours");
    expect(result[0].snippet).toBe("");
    expect(result[0]).not.toHaveProperty("content");
  });

  it("requests live page retrieval for fresh score lookups", async () => {
    const fetcher = response({ results: [] });
    await createTavilyProvider("test-key", fetcher).search(request({ query: "IND NZ score today", fresh: true, depth: "deep" }));
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toMatchObject({
      max_age_hours: 0, max_results: 3, search_depth: "advanced", include_raw_content: "markdown", include_answer: false,
    });
  });

  it("surfaces HTTP errors and rejects malformed success responses", async () => {
    await expect(createTavilyProvider("test-key", response({ detail: "secret" }, 429)).search(request())).rejects.toThrow("HTTP 429");
    await expect(createTavilyProvider("test-key", response({ unexpected: [] })).search(request())).rejects.toThrow("Tavily search failed");
  });
});

describe("Exa fallback provider", () => {
  it("maps news, publication filters, highlights and deep text in one search request", async () => {
    const fetcher = response({ results: [{ title: "Pricing", url: "https://hubspot.com/pricing", publishedDate: "2026-11-14T00:00:00Z", highlights: ["First", "Second"], text: "Full page" }] });
    const input = request({ topic: "news", recency: "week", since: "2026-11-10", depth: "deep", prefer_official: true });
    const result = await createExaProvider("test-key", fetcher).search(input);
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.exa.ai/search");
    const options = fetcher.mock.calls[0][1];
    expect(options?.headers).toEqual({ "x-api-key": "test-key", "Content-Type": "application/json" });
    expect(options?.signal).toBe(input.signal);
    expect(JSON.parse(options?.body as string)).toEqual({
      query: "HubSpot pricing", type: "auto", numResults: 5,
      startPublishedDate: "2026-11-10T00:00:00.000Z", category: "news",
      contents: { highlights: true, text: { maxCharacters: 12_000 } },
    });
    expect(result[0]).toMatchObject({ snippet: "First\nSecond", content: "Full page", published_date: "2026-11-14T00:00:00Z" });
  });

  it("uses the stricter of since and the rolling recency window", () => {
    expect(startPublishedDate(request({ recency: "day", since: "2026-11-01" }))).toBe("2026-11-14T12:00:00.000Z");
    expect(startPublishedDate(request({ since: "2026-11-01" }))).toBe("2026-11-01T00:00:00.000Z");
    expect(startPublishedDate(request())).toBeUndefined();
  });

  it("omits optional filters and full text in fast mode", async () => {
    const fetcher = response({ results: [{ url: "https://example.com", highlights: ["Snippet"] }] });
    const result = await createExaProvider("test-key", fetcher).search(request());
    const body = JSON.parse(fetcher.mock.calls[0][1]?.body as string);
    expect(body).not.toHaveProperty("category");
    expect(body).not.toHaveProperty("startPublishedDate");
    expect(body.contents).toEqual({ highlights: true });
    expect(result[0]).not.toHaveProperty("content");
  });

  it("surfaces HTTP errors and rejects malformed success responses", async () => {
    await expect(createExaProvider("test-key", response({ error: "secret" }, 503)).search(request())).rejects.toThrow("HTTP 503");
    await expect(createExaProvider("test-key", response({ results: "invalid" })).search(request())).rejects.toThrow("Exa search failed");
  });
});
