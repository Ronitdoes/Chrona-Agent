import { defineConfig } from "drizzle-kit";

// Authoring configuration only. The app applies its hand-written SQL at startup.
export default defineConfig({
  schema: "./lib/store/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
});
