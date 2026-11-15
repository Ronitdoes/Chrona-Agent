import { canonicalUrl, type SearchResult } from "../tools/results";

const escapeMarkdown = (text: string) => text.replace(/\s+/g, " ").replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, "\\$&");

/** Expose bounded source excerpts without inventing a verified answer from them. */
export function researchFallback(evidence: SearchResult[], live: boolean): string {
  const sources = new Map<string, SearchResult>();
  for (const source of evidence) {
    const url = canonicalUrl(source.url);
    if (url && !sources.has(url)) sources.set(url, source);
    if (sources.size === 3) break;
  }
  const opening = live
    ? "I couldn't verify a current score from the retrieved pages. The source excerpts below are unverified and may be stale."
    : "I found sources, but couldn't finish verifying the answer. These source excerpts remain unverified.";
  const entries = [...sources].map(([url, source]) => {
    const title = escapeMarkdown(source.title.slice(0, 120) || new URL(url).hostname);
    const destination = url.replace(/\(/g, "%28").replace(/\)/g, "%29");
    const excerpt = escapeMarkdown(source.snippet.slice(0, 220));
    return `- [${title}](${destination})${excerpt ? ` — “${excerpt}”` : ""}`;
  });
  return entries.length ? `${opening}\n\n${entries.join("\n")}` : live
    ? "I couldn't find usable source evidence to verify a current score. Check an official scorecard or try again shortly."
    : "I couldn't find usable source evidence to verify the answer.";
}
