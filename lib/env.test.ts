import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let loadEnv: typeof import("./env").loadEnv;
beforeAll(async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("TAVILY_API_KEY", "test-key");
  vi.stubEnv("MODEL_PROVIDER", "anthropic");
  vi.stubEnv("DATABASE_URL", "postgresql://test@localhost/test");
  loadEnv = (await import("./env")).loadEnv;
});
afterAll(() => { vi.unstubAllEnvs(); });

describe("provider configuration", () => {
  it("validates clock overrides and default timezone at startup", () => {
    const source = { DATABASE_URL: "postgresql://test@localhost/test", ANTHROPIC_API_KEY: "test-key", TAVILY_API_KEY: "test-key" };
    expect(() => loadEnv({ ...source, DEFAULT_TZ: "Mars/Olympus_Mons" })).toThrow("DEFAULT_TZ");
    for (const NOW_OVERRIDE of ["bad", "2032-02-30T12:00:00Z", "2032-02-29T12:00:00"]) expect(() => loadEnv({ ...source, NOW_OVERRIDE })).toThrow("NOW_OVERRIDE");
    expect(loadEnv({ ...source, NOW_OVERRIDE: "2032-02-29T12:00:00+05:30", DEFAULT_TZ: "Asia/Calcutta" }).NOW_OVERRIDE).toBe("2032-02-29T12:00:00+05:30");
  });
  it.each([undefined, "", " ", "invalid", "https://localhost/test"])("requires a PostgreSQL DATABASE_URL %#", DATABASE_URL => {
    expect(() => loadEnv({ ANTHROPIC_API_KEY: "test-key", TAVILY_API_KEY: "test-key", DATABASE_URL })).toThrow("DATABASE_URL");
  });
  it("trims valid PostgreSQL URLs and validates optional test configuration", () => {
    const source = { ANTHROPIC_API_KEY: "test-key", TAVILY_API_KEY: "test-key", DATABASE_URL: " postgres://user@localhost/test " };
    expect(loadEnv(source).DATABASE_URL).toBe("postgres://user@localhost/test");
    expect(() => loadEnv({ ...source, TEST_DATABASE_URL: "invalid" })).toThrow("TEST_DATABASE_URL");
  });
  it("supports Google AI Studio without other provider keys", () => {
    const config = loadEnv({ DATABASE_URL: "postgresql://test@localhost/test", MODEL_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", TAVILY_API_KEY: "test-key" });
    expect(config.GEMINI_MODEL).toBe("gemini-3.5-flash-lite");
    expect(config.ANTHROPIC_API_KEY).toBe("");
    expect(() => loadEnv({ DATABASE_URL: "postgresql://test@localhost/test", MODEL_PROVIDER: "gemini", TAVILY_API_KEY: "test-key" })).toThrow("GEMINI_API_KEY");
    expect(() => loadEnv({ DATABASE_URL: "postgresql://test@localhost/test", MODEL_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", GEMINI_MODEL: "../invalid", TAVILY_API_KEY: "test-key" })).toThrow();
  });
  it("keeps Anthropic as the default and requires its key", () => {
    expect(loadEnv({ DATABASE_URL: "postgresql://test@localhost/test", ANTHROPIC_API_KEY: "test-key", TAVILY_API_KEY: "test-key" }).MODEL_PROVIDER).toBe("anthropic");
    expect(() => loadEnv({ DATABASE_URL: "postgresql://test@localhost/test", TAVILY_API_KEY: "test-key" })).toThrow("ANTHROPIC_API_KEY is required");
  });
  it("rejects unknown providers, missing search keys and blank model names", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgresql://test@localhost/test", MODEL_PROVIDER: "unknown", TAVILY_API_KEY: "test-key" })).toThrow();
    expect(() => loadEnv({ DATABASE_URL: "postgresql://test@localhost/test", MODEL_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" })).toThrow("TAVILY_API_KEY");
    expect(() => loadEnv({ DATABASE_URL: "postgresql://test@localhost/test", MODEL_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", TAVILY_API_KEY: "test-key", GEMINI_MODEL: " " })).toThrow();
  });
  it("rejects the removed provider at startup", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgresql://test@localhost/test", MODEL_PROVIDER: "groq", TAVILY_API_KEY: "test-key" })).toThrow();
  });
});
