import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let loadEnv: typeof import("./env").loadEnv;
beforeAll(async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("TAVILY_API_KEY", "test-key");
  vi.stubEnv("MODEL_PROVIDER", "anthropic");
  loadEnv = (await import("./env")).loadEnv;
});
afterAll(() => { vi.unstubAllEnvs(); });

describe("provider configuration", () => {
  it("supports Google AI Studio without other provider keys", () => {
    const config = loadEnv({ MODEL_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", TAVILY_API_KEY: "test-key" });
    expect(config.GEMINI_MODEL).toBe("gemini-3.5-flash-lite");
    expect(config.ANTHROPIC_API_KEY).toBe("");
    expect(() => loadEnv({ MODEL_PROVIDER: "gemini", TAVILY_API_KEY: "test-key" })).toThrow("GEMINI_API_KEY");
    expect(() => loadEnv({ MODEL_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", GEMINI_MODEL: "../invalid", TAVILY_API_KEY: "test-key" })).toThrow();
  });
  it("keeps Anthropic as the default and requires its key", () => {
    expect(loadEnv({ ANTHROPIC_API_KEY: "test-key", TAVILY_API_KEY: "test-key" }).MODEL_PROVIDER).toBe("anthropic");
    expect(() => loadEnv({ TAVILY_API_KEY: "test-key" })).toThrow("ANTHROPIC_API_KEY is required");
  });
  it("rejects unknown providers, missing search keys and blank model names", () => {
    expect(() => loadEnv({ MODEL_PROVIDER: "unknown", TAVILY_API_KEY: "test-key" })).toThrow();
    expect(() => loadEnv({ MODEL_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" })).toThrow("TAVILY_API_KEY");
    expect(() => loadEnv({ MODEL_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", TAVILY_API_KEY: "test-key", GEMINI_MODEL: " " })).toThrow();
  });
  it("rejects the removed provider at startup", () => {
    expect(() => loadEnv({ MODEL_PROVIDER: "groq", TAVILY_API_KEY: "test-key" })).toThrow();
  });
});
