import { defineConfig } from "vitest/config";

// Explicit opt-in: this makes real Gemini and Tavily requests, without DB writes.
export default defineConfig({
  test: {
    environment: "node", include: ["scripts/live-search-smoke.ts"], testTimeout: 65_000,
    silent: false, disableConsoleIntercept: true,
  },
});
