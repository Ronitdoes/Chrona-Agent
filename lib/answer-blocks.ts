import { z } from "zod";
import { canonicalUrl } from "./tools/results";
import type { Source } from "./agent/events";

const id = z.string().min(1).max(80);
const pageUrl = z.string().max(2048).refine(value => canonicalUrl(value) === value);
const mediaUrl = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
});
export const richAnswerSchema = z.strictObject({
  version: z.literal(1),
  externalStart: z.number().int().nonnegative().optional(),
  sources: z.array(z.strictObject({ id, url: pageUrl, title: z.string().max(240), domain: z.string().max(253), publishedDate: z.string().nullable(), isOfficial: z.boolean() })).max(20),
  images: z.array(z.strictObject({ id, sourceId: id, thumbnailUrl: mediaUrl, alt: z.string().min(1).max(500), credit: z.string().max(300).optional() })).max(4),
  blocks: z.array(z.strictObject({ id, kind: z.literal("gallery"), placement: z.literal("lead"), imageIds: z.array(id).min(1).max(4) })).max(1),
}).superRefine((answer, context) => {
  const sources = new Set(answer.sources.map(source => source.id));
  const images = new Set(answer.images.map(image => image.id));
  const ids = [...sources, ...images, ...answer.blocks.map(block => block.id)];
  if (sources.size !== answer.sources.length || images.size !== answer.images.length || new Set(ids).size !== ids.length
    || new Set(answer.sources.map(source => source.url)).size !== answer.sources.length
    || answer.images.some(image => !sources.has(image.sourceId))
    || answer.blocks.some(block => new Set(block.imageIds).size !== block.imageIds.length || block.imageIds.some(image => !images.has(image)))) {
    context.addIssue({ code: "custom", message: "Invalid presentation references" });
  }
  if (new TextEncoder().encode(JSON.stringify(answer)).length > 64_000) context.addIssue({ code: "custom", message: "Presentation exceeds 64 KB" });
});
export type RichAnswerV1 = z.infer<typeof richAnswerSchema>;
export function readRichAnswer(value: unknown): RichAnswerV1 | undefined {
  const parsed = richAnswerSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export function buildRichAnswer(sources: Source[], candidates: Record<string, { url: string; alt?: string }[]>, previous?: RichAnswerV1): RichAnswerV1 {
  const admitted = sources.map((source, index) => ({ ...source, id: `s${index + 1}` }));
  const images = [...(previous?.images ?? [])];
  for (const source of admitted) {
    if (images.length >= 4) break;
    if (images.some(image => image.sourceId === source.id)) continue;
    const candidate = candidates[source.url]?.find(image => mediaUrl.safeParse(image.url).success
      && !images.some(existing => existing.thumbnailUrl === image.url));
    if (!candidate) continue;
    images.push({ id: `i${images.length + 1}`, sourceId: source.id, thumbnailUrl: candidate.url,
      alt: (candidate.alt?.trim() || `Image from ${source.title || source.domain}`).slice(0, 500),
    });
  }
  return richAnswerSchema.parse({ version: 1, sources: admitted, images,
    blocks: images.length ? [{ id: "gallery", kind: "gallery", placement: "lead", imageIds: images.map(image => image.id) }] : [],
  });
}
