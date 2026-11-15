import { describe, expect, it } from "vitest";
import { webSearchInput, webSearchTool } from "./schema";

describe("the only model-facing tool", () => {
  it("is named web_search and derives its JSON schema from the input validator", () => {
    expect(webSearchTool.name).toBe("web_search");
    expect(webSearchTool.input_schema.type).toBe("object");
    expect(webSearchTool.input_schema.required).toEqual(["queries"]);
    expect(webSearchTool.input_schema.additionalProperties).toBe(false);
    expect(webSearchInput.parse({ queries: ["  CRM pricing  "] })).toEqual({
      queries: ["CRM pricing"], topic: "general", prefer_official: false, depth: "fast",
    });
  });

  it.each([
    { queries: [] }, { queries: [" "] }, { queries: Array(7).fill("pricing") },
    { queries: ["pricing"], since: "2026-02-30" },
    { queries: ["pricing"], since: "15 November" },
    { queries: ["pricing"], depth: "fetch" },
    { queries: ["pricing"], topic: "finance" },
    { queries: ["pricing"], url: "https://example.com" },
  ])("rejects invalid tool input: %j", (input) => {
    expect(webSearchInput.safeParse(input).success).toBe(false);
  });
});
