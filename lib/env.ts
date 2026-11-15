import { z } from "zod";
import { modelIdSchema } from "./model-selection";

const optionalText = z.string().trim().default("");

const envSchema = z.object({
  MODEL_PROVIDER: z.enum(["anthropic", "groq", "gemini"]).default("anthropic"),
  ANTHROPIC_API_KEY: optionalText,
  ANTHROPIC_MODEL: modelIdSchema.default("claude-sonnet-5-5"),
  GEMINI_API_KEY: optionalText,
  GEMINI_MODEL: modelIdSchema.default("gemini-3.5-flash-lite"),
  GROQ_API_KEY: optionalText,
  GROQ_MODEL: modelIdSchema.default("qwen/qwen3.8-27b"),
  GROQ_MAX_INPUT_TOKENS: z.coerce.number().int().min(1024).max(1_000_000).default(6500),
  GROQ_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(32_768).default(768),
  TAVILY_API_KEY: z.string().trim().min(1, "TAVILY_API_KEY is required"),
  EXA_API_KEY: optionalText,
  DATABASE_URL: optionalText,
  DEFAULT_TZ: z.string().trim().min(1).default("Asia/Kolkata"),
  NOW_OVERRIDE: optionalText,
}).superRefine((value, context) => {
  const key = value.MODEL_PROVIDER === "groq" ? "GROQ_API_KEY" : value.MODEL_PROVIDER === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!value[key]) context.addIssue({ code: "custom", path: [key], message: `${key} is required for MODEL_PROVIDER=${value.MODEL_PROVIDER}` });
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}

export const env = loadEnv();
