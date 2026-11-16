import { z } from "zod";
import { modelIdSchema } from "./model-selection";
import { databaseUrlSchema } from "./database-url";

const optionalText = z.string().trim().default("");

const envSchema = z.object({
  MODEL_PROVIDER: z.enum(["anthropic", "gemini"]).default("anthropic"),
  ANTHROPIC_API_KEY: optionalText,
  ANTHROPIC_MODEL: modelIdSchema.default("claude-sonnet-5-5"),
  GEMINI_API_KEY: optionalText,
  GEMINI_MODEL: modelIdSchema.default("gemini-3.5-flash-lite"),
  TAVILY_API_KEY: optionalText,
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z.string().min(32),
  API_KEY_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, "Use a 32-byte hex encryption key"),
  EXA_API_KEY: optionalText,
  DATABASE_URL: databaseUrlSchema,
  // Pooled endpoint (e.g. Neon pooler) used for runtime connections when set.
  DATABASE_URL_POOLED: databaseUrlSchema.optional(),
  TEST_DATABASE_URL: databaseUrlSchema.optional(),
  DEFAULT_TZ: z.string().trim().min(1).refine(value => {
    try { new Intl.DateTimeFormat("en-GB", { timeZone: value }); return true; }
    catch { return false; }
  }, "DEFAULT_TZ must be a valid timezone").default("Asia/Kolkata"),
  NOW_OVERRIDE: optionalText.refine(value => !value || z.iso.datetime({ offset: true }).safeParse(value).success,
    "NOW_OVERRIDE must be a valid ISO timestamp with Z or an explicit offset"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}

export const env = loadEnv();
