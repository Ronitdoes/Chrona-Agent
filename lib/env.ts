import { z } from "zod";

const optionalText = z.string().trim().default("");

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().trim().min(1, "ANTHROPIC_API_KEY is required"),
  TAVILY_API_KEY: z.string().trim().min(1, "TAVILY_API_KEY is required"),
  EXA_API_KEY: optionalText,
  DATABASE_URL: optionalText,
  DEFAULT_TZ: z.string().trim().min(1).default("Asia/Kolkata"),
  NOW_OVERRIDE: optionalText,
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}

export const env = loadEnv();