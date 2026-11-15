/** Require the single search tool for explicit lookups and live-score requests. */
export function requiresWebSearch(text: string): boolean {
  if (/\b(?:do not|don't|never|without|no(?: need to)?)\s+(?:(?:use|using)\s+(?:the\s+)?)?(?:web(?:\s+search)?|internet|search(?:ing)?|brows(?:e|ing))\b/i.test(text)) return false;
  if (/\b(?:search|browse)\s+(?:the\s+)?(?:web|internet|online)\b/i.test(text)) return true;
  if (/^\s*(?:define\b|(?:what (?:is|are)|what's) (?:a|an|the term)\b|(?:explain|describe) how\b|how (?:do|does)\b|(?:write|implement|translate)\b)/i.test(text)) return false;
  return /\b(?:live|latest|current)\s+(?:(?:cricket|football|soccer|match|sports?)\s+)?scores?\b/i.test(text);
}
