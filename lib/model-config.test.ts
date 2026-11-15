import { beforeAll, describe, expect, it, vi, afterAll } from "vitest";
import { modelCatalog, resolveModelSelection } from "./model-config";
import { modelSelectionSchema } from "./model-selection";
let loadEnv: typeof import("./env").loadEnv;
beforeAll(async () => { vi.stubEnv("MODEL_PROVIDER", "gemini"); vi.stubEnv("GEMINI_API_KEY", "test-key"); vi.stubEnv("TAVILY_API_KEY", "test-key"); loadEnv = (await import("./env")).loadEnv; });
afterAll(() => vi.unstubAllEnvs());
describe("model selection", () => {
  it("publishes IDs and availability without exposing keys", async () => {
    const config = loadEnv({ MODEL_PROVIDER: "gemini", GEMINI_API_KEY: "secret-gemini", TAVILY_API_KEY: "secret-search" });
    const catalog = modelCatalog(config);
    expect(catalog.default.provider).toBe("gemini");
    expect(catalog.providers.map(provider => provider.id)).toEqual(["anthropic", "gemini"]);
    expect(catalog.providers.find(provider => provider.id === "gemini")).toMatchObject({ available: true, models: [{ id: "gemini-3.5-flash-lite" }] });
    expect(JSON.stringify(catalog)).not.toContain("secret");
    expect(await resolveModelSelection({ provider: "gemini", model: "gemini-3.5-flash-lite" }, config)).toEqual({ provider: "gemini", model: "gemini-3.5-flash-lite" });
    await expect(resolveModelSelection({ provider: "anthropic", model: "claude-sonnet-5-5" }, config)).rejects.toThrow("ANTHROPIC_API_KEY");
  });
  it.each(["", "../model", "model?key=secret", "https://model host", "x".repeat(121)])("rejects unsafe model ID %s", model => {
    expect(modelSelectionSchema.safeParse({ provider: "gemini", model }).success).toBe(false);
  });
  it("rejects a saved selection for the removed provider so the workspace uses its configured default", () => {
    expect(modelSelectionSchema.safeParse({ provider: "groq", model: "removed-model" }).success).toBe(false);
  });
});
