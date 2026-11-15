import { defineConfig } from "vitest/config";

// Opt-in only: npm test never invokes a paid provider.
export default defineConfig({
  test: {
    environment: "node", include: ["scripts/search-smoke.ts"], testTimeout: 25_000,
    silent: false, disableConsoleIntercept: true,
  },
});
