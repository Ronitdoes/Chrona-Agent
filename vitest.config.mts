import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { DATABASE_URL: "postgresql://test@localhost/test", BETTER_AUTH_SECRET: "test-auth-secret-with-at-least-32-characters", API_KEY_ENCRYPTION_KEY: "11".repeat(32) },
    include: ["**/*.test.ts"],
    exclude: [...configDefaults.exclude, "data/**", ".next/**"],
  },
});
