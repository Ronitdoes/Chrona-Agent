import type { Clock } from "../clock";
import type { Claim } from "../store/schema";

type HintClaim = Pick<Claim, "subject" | "attribute">;

function clean(value: string): string {
  return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function termsFor(attribute: string): string {
  const value = clean(attribute).toLowerCase().replace(/[_-]+/g, " ");
  if (/\b(price|prices|pricing|cost|billing)\b/.test(value)) return "pricing";
  if (/\bversion\b/.test(value)) return "latest version release notes";
  if (/\b(release|releases|update|updates)\b/.test(value)) return "release notes";
  return value;
}

/** One stable query per subject. The caller batches these into the single search tool. */
export function hints(claims: readonly HintClaim[], clock: Clock): string[] {
  const year = new Intl.DateTimeFormat("en-US", { timeZone: clock.tz, year: "numeric" }).format(clock.instant);
  const subjects = new Map<string, { subject: string; terms: Set<string> }>();
  for (const claim of claims) {
    const subject = clean(claim.subject);
    if (!subject) continue;
    const key = subject.toLowerCase();
    if (!subjects.has(key)) subjects.set(key, { subject, terms: new Set() });
    const term = termsFor(claim.attribute);
    if (term) subjects.get(key)!.terms.add(term);
  }
  return [...subjects.values()].map(({ subject, terms }) => {
    // Version hints already include release notes; avoid repeating that phrase.
    if (terms.has("latest version release notes")) terms.delete("release notes");
    const attributes = [...terms].join(" ").slice(0, 200).trim() || "official updates";
    const suffix = ` ${attributes} ${year}`;
    return `${subject.slice(0, 500 - suffix.length).trimEnd()}${suffix}`;
  });
}
