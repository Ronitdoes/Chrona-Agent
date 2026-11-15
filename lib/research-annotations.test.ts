import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "../components/markdown-message";
import { SearchStatus } from "../components/search-status";
import { SourceChips } from "../components/source-chips";
import { demoSearches, demoSources } from "./demo-chat";

const render = (content: string) => renderToStaticMarkup(createElement(MarkdownMessage, { content }));
describe("research annotations in real markdown", () => {
  it("renders explicit bold, prefix, heading and table verdicts with icons and text", () => {
    const html = render("**Changed** — Northstar costs $23.\n\nUnchanged: Orbit costs $15.\n\n## Couldn’t verify\n\n| Tool | Verdict |\n|---|---|\n| Harbor | Couldn't verify |");
    expect(html.match(/class="verdict-badge /g)).toHaveLength(4);
    expect(html).toContain("verdict-changed");
    expect(html).toContain("verdict-unchanged");
    expect(html).toContain("verdict-unknown");
    expect(html).toContain("Couldn’t verify");
    expect(html).toContain("aria-hidden=\"true\"");
  });
  it("only decorates valid, explicit as-of dates", () => {
    const html = render("As of 15 Nov 2026. As of November 14, 2026. As of 2026-11-13. As of 30 Feb 2026. As of yesterday.");
    expect(html.match(/class="as-of-chip"/g)).toHaveLength(3);
    expect(html).toContain('dateTime="2026-11-15"');
    expect(html).toContain("As of 30 Feb 2026");
    expect(html).toContain("As of yesterday");
  });
  it("leaves code, quotations, links and ordinary prose unchanged", () => {
    const html = render("The price is unchanged. No evidence of change.\n\nUnchanged pricing is not a verdict label.\n\n`Changed` and `As of 2026-11-15`\n\n```txt\nChanged\nAs of 2026-11-15\n```\n\n> **Changed**. As of 2026-11-15\n\n[Changed](https://example.com) and [As of 2026-11-15](https://example.com)");
    expect(html).not.toContain("verdict-badge");
    expect(html).not.toContain("as-of-chip");
    expect(html).toContain("Copy code");
    expect(html).toContain("https://example.com");
  });
  it("does not enable raw HTML while annotating text", () => {
    const html = render('<script>alert("bad")</script>\n\n[Bad](javascript:alert)\n\n**Changed**');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("verdict-changed");
  });
  it("reports result counts at batch level and never distributes them among queries", () => {
    const html = renderToStaticMarkup(createElement(SearchStatus, { searches: demoSearches, state: "complete" }));
    expect(html).toContain("Searched the web · 5 queries");
    expect(html).toContain("8 results across this batch");
    expect(html).toContain("4 results across this batch");
    expect(html).toContain("Northstar CRM official pricing");
    expect(html).not.toContain(" open=");
    expect(renderToStaticMarkup(createElement(SearchStatus, { searches: [], state: "complete" }))).toBe("");
  });
  it("renders safe source links, explicit official labels, missing dates and local favicon fallbacks", () => {
    const html = renderToStaticMarkup(createElement(SourceChips, { sources: [...demoSources, demoSources[0], { ...demoSources[0], url: "javascript:alert(1)" }], localFavicons: true }));
    expect(html.match(/class="source-chip"/g)).toHaveLength(3);
    expect(html).toContain('src="/demo-source.svg"');
    expect(html).toContain("Official");
    expect(html).toContain("Published");
    expect(html).toContain("14 Nov 2026");
    expect(html).toContain("Publication date unavailable");
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("/favicon.ico");
  });
});
