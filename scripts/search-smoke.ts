import nextEnv from "@next/env";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createTavilyProvider } from "../lib/tools/providers/tavily";
import { createWebSearch } from "../lib/tools/webSearch";

it("prints real Tavily results for two parallel queries", async () => {
  // Next intentionally ignores .env.local in test mode; this opt-in smoke uses dev env.
  vi.stubEnv("NODE_ENV", "development");
  nextEnv.loadEnvConfig(process.cwd(), true);
  const key = z.string().trim().min(1).safeParse(process.env.TAVILY_API_KEY);
  if (!key.success) throw new Error("Set TAVILY_API_KEY in .env.local before running the live smoke test.");
  const search = createWebSearch({ primary: createTavilyProvider(key.data), concurrency: 2 });
  // Exactly two basic searches, no retries, no extraction or fallback costs.
  const result = await search({
    queries: ["PostgreSQL official documentation", "Next.js official documentation"],
    prefer_official: true,
  });
  console.log(JSON.stringify(result.queries.map((query) => ({
    query: query.query,
    results: query.results.map(({ title, url }) => ({ title, url })),
    error: query.error,
  })), null, 2));
  expect(result.is_error).toBe(false);
  expect(result.queries).toHaveLength(2);
  expect(result.queries.every((query) => !query.error && query.results.length > 0)).toBe(true);
});
