import { canonicalUrl } from "./results";
import type { ProviderResult } from "./providers/types";

/** Streaming promotions and predictions cannot establish the current match state. */
export function liveScoreEvidence(results: ProviderResult[]): ProviderResult[] {
  const videoDomains = ["youtube.com", "youtu.be", "twitch.tv", "facebook.com", "tiktok.com"];
  return results.filter(result => {
    const url = canonicalUrl(result.url);
    if (!url || !result.snippet.trim() && !result.content?.trim()) return false;
    const hostname = new URL(url).hostname;
    if (videoDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) return false;
    return !/\b(?:predictions?|dream11|fantasy|betting|watch[- ]?along|how to watch|live stream(?:ing)?|live telecast)\b/i.test(`${result.title} ${new URL(url).pathname}`);
  });
}
