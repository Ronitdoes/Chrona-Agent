import { expect, it } from "vitest";
import { boundEvidence, validateExtraction } from "./schema";
import { turn } from "../../test/agent-fixtures";

it("bounds retry evidence, dedupes URLs and retains dates even after the excerpt budget is used", () => {
  const source = { title: "Pricing", url: "https://example.com/0", published_date: "2026-11-14T00:00:00Z", snippet: "s".repeat(2000), content: "c".repeat(9000), is_official: true };
  const sources = Array.from({ length: 100 }, (_, i) => ({ ...source, url: `https://example.com/${i}` }));
  const bounded = boundEvidence([source, ...sources]);
  expect(bounded).toHaveLength(80);
  expect(bounded.reduce((sum, item) => sum + item.snippet.length + (item.content?.length ?? 0), 0)).toBe(24_000);
  expect(bounded.at(-1)).toMatchObject({ published_date: source.published_date, snippet: "", content: "" });
});

it("does not mistake a price prefix for support of a different price", () => {
  const text = "The price is $200/seat/mo.";
  expect(validateExtraction({ claims: [{ subject: "CRM", attribute: "price", value: "$20/seat/mo", asOf: "2026-11-09T12:00:00Z",
    sourceUrls: ["https://example.com"], volatility: "high", quote: text, evidenceQuote: text }], memory: [], threads: [] }, {
    user: turn(1), assistant: turn(2, { role: "assistant", content: text }),
    evidence: [{ title: "Pricing", url: "https://example.com", snippet: text, published_date: null, is_official: false }],
  })).toBeNull();
});
