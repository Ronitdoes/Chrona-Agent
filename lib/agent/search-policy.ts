const browsingOptOut = /\b(?:do not|don't|never|without|no(?: need to)?)\s+(?:(?:use|using)\s+(?:the\s+)?)?(?:web(?:\s+search)?|internet|search(?:ing)?|brows(?:e|ing))\b/i;
const stableRequest = /^\s*(?:define\b|(?:what (?:is|are)|what's) (?:a|an|the term)\b|(?:explain|describe) how\b|how (?:do|does)\b|(?:write|implement|translate)\b)/i;

export function isLiveScoreRequest(text: string): boolean {
  if (browsingOptOut.test(text) || stableRequest.test(text) || /\b(?:exam|credit|test|quiz|SAT|GRE|IELTS)\s+scores?\b/i.test(text)) return false;
  return /\b(?:scores?|scorecards?|live[- ]?scores?|matches|match|fixtures?|kick[- ]?off)\b/i.test(text) &&
    /\b(?:live|latest|current|today|tonight|now|right now)\b/i.test(text);
}

/** Require the single search tool for explicit lookups and live-score requests. */
export function requiresWebSearch(text: string): boolean {
  if (browsingOptOut.test(text)) return false;
  if (/\b(?:search|browse)\s+(?:the\s+)?(?:web|internet|online)\b/i.test(text)) return true;
  return isLiveScoreRequest(text);
}
