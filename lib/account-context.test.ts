import { expect, it, vi } from "vitest";
import { accountContext, providerConfig } from "./account-context";
import { loadEnv } from "./env";
const constructed = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor(options: { apiKey: string }) {
      constructed(options.apiKey);
    }
  },
}));
it("keeps answer, recall and deferred curator factories on each account's key", async () => {
  const { createConfiguredModel } = await import("./agent/model");
  const { configuredRecallModel } = await import("./recall/model");
  const { configuredCuratorModel } = await import("./curator/model");
  const selection = {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
  } as const;
  const config = loadEnv({
    DATABASE_URL: "postgresql://test@localhost/test",
    BETTER_AUTH_SECRET: "test-auth-secret-with-at-least-32-characters",
    API_KEY_ENCRYPTION_KEY: "11".repeat(32),
  });
  const calls: (() => Promise<void>)[] = [];
  await Promise.all(
    ["alice", "bob"].map((userId) =>
      accountContext.run(
        {
          userId,
          sessionId: userId,
          config: { ...config, ANTHROPIC_API_KEY: userId },
          searchProvider: "tavily",
        },
        async () => {
          await createConfiguredModel(selection);
          await configuredRecallModel(selection);
          const captured = accountContext.getStore()!;
          calls.push(() =>
            accountContext.run(captured, async () => {
              expect((await providerConfig()).ANTHROPIC_API_KEY).toBe(userId);
              await configuredCuratorModel(selection);
            }),
          );
        },
      ),
    ),
  );
  await Promise.all(calls.map((call) => call()));
  expect(
    constructed.mock.calls.filter(([key]) => key === "alice"),
  ).toHaveLength(3);
  expect(constructed.mock.calls.filter(([key]) => key === "bob")).toHaveLength(
    3,
  );
});
