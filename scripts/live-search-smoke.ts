import nextEnv from "@next/env";
import { expect, it, vi } from "vitest";
import { monotonicMs, now } from "../lib/clock";
import { createGeminiModel } from "../lib/agent/gemini";
import { assemble } from "../lib/agent/prompt";
import { runAgent } from "../lib/agent/loop";
import { createWebSearch } from "../lib/tools/webSearch";
import { createTavilyProvider } from "../lib/tools/providers/tavily";
import { calendarContext } from "../lib/calendar-context";
import { reviewSportsCalendar } from "../lib/agent/calendar-review";
import { effortProfiles } from "../lib/research-effort";

it.each([
  { label: "Medium live-score lookup", message: "ind vs nz score today", effort: "medium" },
  { label: "Instant match-today date/status regression", message: "ind vs nz match today", effort: "instant" },
] as const)("$label finishes with consistent dates and an answer or a clear verification limit", async ({ message, effort }) => {
  vi.stubEnv("NODE_ENV", "development");
  nextEnv.loadEnvConfig(process.cwd(), true);
  const { env } = await import("../lib/env");
  if (!env.GEMINI_API_KEY) throw new Error("Configure GEMINI_API_KEY before the live smoke test.");
  const calendar = now();
  const requests: { tools: boolean; mode?: string }[] = [];
  const searchRequests: { status?: number; milliseconds: number; aborted?: boolean }[] = [];
  const model = createGeminiModel(env.GEMINI_API_KEY, env.GEMINI_MODEL, { fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ tools: Boolean(body.tools?.length), mode: body.toolConfig?.functionCallingConfig?.mode });
    return globalThis.fetch(url, init);
  } });
  const search = createWebSearch({ primary: createTavilyProvider(env.TAVILY_API_KEY, async (url, init) => {
    const started = monotonicMs();
    try {
      const response = await globalThis.fetch(url, init);
      searchRequests.push({ status: response.status, milliseconds: Math.round(monotonicMs() - started) });
      return response;
    } catch (error) {
      searchRequests.push({ milliseconds: Math.round(monotonicMs() - started), aborted: Boolean(init?.signal?.aborted) });
      throw error;
    }
  }) });
  const prompt = assemble({ clock: calendar, message, recall: {
    turns: [], claims: [], memory: [], threads: [], resolvedRanges: [], missingRanges: [], matchedBy: "none", notFound: true, truncated: false,
  } });
  const events: string[] = [];
  const result = await runAgent({ ...prompt, model, search, effort, send: event => events.push(event) });
  console.log(JSON.stringify({ clock: calendar.iso, model: env.GEMINI_MODEL, requests, searchRequests, steps: result.steps,
    queries: result.searchCount, sources: result.sources.length, limits: result.limits, failures: result.modelFailures, answer: result.text }, null, 2));
  expect(result.searchCount).toBeGreaterThan(0);
  expect(result.sources.length).toBeGreaterThan(0);
  expect(result.steps).toBeLessThanOrEqual(effortProfiles[effort].maxSteps);
  expect(result.searchCount).toBeLessThanOrEqual(effortProfiles[effort].maxQueries);
  expect(result.sources.length).toBeLessThanOrEqual(effortProfiles[effort].maxSources);
  expect(events.filter(event => event === "done")).toHaveLength(1);
  expect(result.text).not.toContain("I couldn't complete an answer from the available evidence.");
  expect(result.limits).not.toContain("response failure");
  expect(result.limits).not.toContain("step limit");
  expect(requests.at(-1)?.tools).toBe(false);
  expect(reviewSportsCalendar(result.text, message, calendar)).toBeNull();
  expect(result.text).toContain(calendarContext(calendar).todayLabel);
});
