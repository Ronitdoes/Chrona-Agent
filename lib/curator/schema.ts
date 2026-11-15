import { z } from "zod";
import { dateFrom } from "../clock";
import { diffClaim } from "../recall/diff";
import type { Memory, Thread, Turn } from "../store/schema";
import { normalizePublishedDate, type SearchResult } from "../tools/results";

const text = (max: number) => z.string().trim().min(1).max(max);
const url = z.url({ protocol: /^https?$/ }).max(2048);
export const extractionSchema = z.strictObject({
  claims: z.array(z.strictObject({
    subject: text(200), attribute: text(100), value: text(500),
    asOf: z.iso.datetime({ offset: true }), sourceUrls: z.array(url).min(1).max(6),
    volatility: z.enum(["low", "medium", "high"]),
    quote: text(2000), evidenceQuote: text(2000),
  })).max(20),
  memory: z.array(z.strictObject({ key: text(80), value: text(500), quote: text(2000) })).max(20),
  threads: z.array(z.strictObject({ title: text(160), summary: text(1500) })).max(5),
});
export type Extraction = z.infer<typeof extractionSchema>;
export type Conversation = { user: Turn; assistant: Turn; evidence: SearchResult[] };
export type CuratorInput = Conversation & { memory: Memory[]; threads: Thread[] };

export const keyOf = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();
export const memoryKey = (value: string): string => keyOf(value).replace(/[ -]+/g, "_");
export function sameValue(left: string, right: string): boolean {
  return keyOf(left) === keyOf(right) || diffClaim(left, right).verdict === "unchanged";
}
function supports(value: string, quote: string): boolean {
  const comparison = diffClaim(value, quote);
  return comparison.oldParsed ? comparison.verdict === "unchanged" : keyOf(quote).includes(keyOf(value));
}
export function supportingSources(claim: Extraction["claims"][number], evidence: SearchResult[]): SearchResult[] {
  return evidence.filter((source) => claim.sourceUrls.includes(source.url) &&
    [source.snippet, source.content ?? ""].some((text) => text.includes(claim.evidenceQuote)));
}

/** Validate the entire batch before any writes. Model-provided IDs and URLs cannot establish ownership. */
export function validateExtraction(output: unknown, conversation: Conversation): Extraction | null {
  const parsed = extractionSchema.safeParse(output);
  if (!parsed.success) return null;
  const { user, assistant, evidence } = conversation;
  const data = parsed.data;
  const claims = new Map<string, Extraction["claims"][number]>();
  const memory = new Map<string, Extraction["memory"][number]>();
  const threads = new Map<string, Extraction["threads"][number]>();
  for (const claim of data.claims) {
    if (dateFrom(claim.asOf).getTime() > assistant.ts.getTime() ||
      !assistant.content.includes(claim.quote) || !supports(claim.value, claim.quote) ||
      !supports(claim.value, claim.evidenceQuote) ||
      claim.sourceUrls.some((url) => !evidence.some((source) => source.url === url)) ||
      !supportingSources(claim, evidence).some((source) => {
        const published = normalizePublishedDate(source.published_date);
        return !published || dateFrom(published) <= dateFrom(claim.asOf);
      })) return null;
    const key = JSON.stringify([keyOf(claim.subject), keyOf(claim.attribute)]);
    const previous = claims.get(key);
    if (previous && !sameValue(previous.value, claim.value)) return null;
    claims.set(key, { ...claim, sourceUrls: [...new Set(claim.sourceUrls)] });
  }
  for (const fact of data.memory) {
    if (!user.content.includes(fact.quote) || !supports(fact.value, fact.quote)) return null;
    const key = memoryKey(fact.key);
    if (memory.has(key) && keyOf(memory.get(key)!.value) !== keyOf(fact.value)) return null;
    memory.set(key, { ...fact, key });
  }
  for (const thread of data.threads) threads.set(keyOf(thread.title), thread);
  return { claims: [...claims.values()], memory: [...memory.values()], threads: [...threads.values()] };
}

// Keep persisted retry payloads and curator context bounded, retaining source metadata.
export function boundEvidence(evidence: SearchResult[]): SearchResult[] {
  let remaining = 24_000;
  return [...new Map(evidence.map((source) => [source.url, source])).values()].slice(0, 80).map((source) => {
    const snippet = source.snippet.slice(0, Math.min(1200, remaining));
    remaining -= snippet.length;
    const content = source.content?.slice(0, Math.min(6000, remaining));
    remaining -= content?.length ?? 0;
    return { ...source, snippet, ...(source.content !== undefined ? { content } : {}) };
  });
}
