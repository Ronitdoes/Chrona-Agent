import { defineConfig } from "vitest/config";

// Explicit opt-in: sends synthetic fixtures to configured providers. No DB writes.
export default defineConfig({ test: { environment: "node", include: ["scripts/recall-live-eval.ts"], testTimeout: 60_000 } });
