import { afterEach, describe, expect, it, vi } from "vitest";
import { accountContext } from "../account-context";
import { loadEnv } from "../env";
import { webSearch } from "./webSearch";
const config = loadEnv({
  DATABASE_URL: "postgresql://test@localhost/test",
  BETTER_AUTH_SECRET: "test-auth-secret-with-at-least-32-characters",
  API_KEY_ENCRYPTION_KEY: "11".repeat(32),
  TAVILY_API_KEY: "personal-tavily",
  EXA_API_KEY: "personal-exa",
});
afterEach(() => vi.unstubAllGlobals());
describe("account search routing", () => {
  it.each(["tavily", "exa"] as const)(
    "prefers %s and attributes mixed-batch fallback and cache hits",
    async (searchProvider) => {
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        const provider = String(url).includes("tavily") ? "tavily" : "exa";
        const query = JSON.parse(String(init?.body)).query;
        if (provider === searchProvider && query === "second")
          return new Response("private transport details", { status: 500 });
        return Response.json({
          results: [
            {
              title: "Result",
              url: "https://example.com",
              content: "Evidence",
              highlights: ["Evidence"],
            },
          ],
        });
      });
      vi.stubGlobal("fetch", fetcher);
      await accountContext.run(
        { userId: "alice", sessionId: "one", config, searchProvider },
        async () => {
          const result = await webSearch({ queries: ["first", "second"] });
          expect(result.usage).toEqual(
            expect.arrayContaining([
              { query: "first", provider: searchProvider, fallback: false },
              {
                query: "second",
                provider: searchProvider === "tavily" ? "exa" : "tavily",
                fallback: true,
              },
            ]),
          );
          expect(
            (await webSearch({ queries: ["second"] })).usage?.[0].fallback,
          ).toBe(true);
          expect(fetcher).toHaveBeenCalledTimes(3);
        },
      );
      await accountContext.run(
        {
          userId: "bob",
          sessionId: "two",
          config: {
            ...config,
            TAVILY_API_KEY: "bob-tavily",
            EXA_API_KEY: "bob-exa",
          },
          searchProvider,
        },
        async () => {
          await webSearch({ queries: ["first"] });
        },
      );
      expect(fetcher).toHaveBeenCalledTimes(4);
      const headers = fetcher.mock.calls[3][1]?.headers as Record<
        string,
        string
      >;
      expect(
        searchProvider === "tavily"
          ? headers.Authorization
          : headers["x-api-key"],
      ).toContain("bob-");
    },
  );
  it("returns safe failure with no fallback key, both failures, and cancellation", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("contains-sensitive-key", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetcher);
    for (const fallbackKey of ["", "personal-exa"]) {
      fetcher.mockClear();
      await accountContext.run(
        {
          userId: "alice",
          sessionId: "one",
          config: { ...config, EXA_API_KEY: fallbackKey },
          searchProvider: "tavily",
        },
        async () => {
          const result = await webSearch({ queries: ["query"] });
          expect(result.is_error).toBe(true);
          expect(JSON.stringify(result)).not.toContain(
            "contains-sensitive-key",
          );
          expect(fetcher).toHaveBeenCalledTimes(fallbackKey ? 2 : 1);
        },
      );
    }
    fetcher.mockClear();
    const controller = new AbortController();
    controller.abort();
    await accountContext.run(
      { userId: "alice", sessionId: "one", config, searchProvider: "exa" },
      async () => {
        const result = await webSearch(
          { queries: ["query"] },
          { signal: controller.signal },
        );
        expect(result.is_error).toBe(true);
        expect(fetcher).not.toHaveBeenCalled();
      },
    );
  });
});
