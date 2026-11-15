import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["evals/live.ts"], fileParallelism: false,
  testTimeout: 60_000, hookTimeout: 30_000, silent: false, disableConsoleIntercept: true } });
