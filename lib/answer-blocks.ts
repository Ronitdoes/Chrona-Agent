import { z } from "zod";
import { canonicalUrl } from "./tools/results";
import type { Source } from "./agent/events";

const id = z.string().min(1).max(80);
const pageUrl = z.string().max(2048).refine(value => canonicalUrl(value) === value);
export const mediaUrl = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
});
const shared = {
  externalStart: z.number().int().nonnegative().optional(),
  sources: z.array(z.strictObject({ id, url: pageUrl, title: z.string().max(240), domain: z.string().max(253), publishedDate: z.string().nullable(), isOfficial: z.boolean() })).max(20),
  images: z.array(z.strictObject({ id, sourceId: id, thumbnailUrl: mediaUrl, alt: z.string().min(1).max(500), credit: z.string().max(300).optional() })).max(4),
};
const v1 = z.strictObject({
  version: z.literal(1),
  ...shared,
  blocks: z.array(z.strictObject({ id, kind: z.literal("gallery"), placement: z.literal("lead"), imageIds: z.array(id).min(1).max(4) })).max(1),
});

const label = z.string().trim().min(1).max(72);
const citation = z.strictObject({ sourceId: id, quote: z.string().trim().min(8).max(360) });
const anchor = z.string().regex(/^a\d{1,8}$/);
const figure = { anchor, title: z.string().trim().min(1).max(120) };
const flow = z.strictObject({
  ...figure, kind: z.literal("flow"), nodes: z.array(label).min(2).max(7),
  edges: z.array(z.strictObject({ from: z.number().int().min(0).max(6), to: z.number().int().min(0).max(6),
    label: label.optional(), citation: citation.optional() })).min(1).max(10),
});
const timeline = z.strictObject({
  ...figure, kind: z.literal("timeline"),
  events: z.array(z.strictObject({ date: label, label, citation })).min(2).max(8),
});
const chart = z.strictObject({
  ...figure, kind: z.literal("chart"), style: z.enum(["bar", "line"]), unit: label, period: label.optional(),
  points: z.array(z.strictObject({ label, value: z.number().min(-1e15).max(1e15), citation })).min(2).max(10),
});
const publisherImage = z.strictObject({ kind: z.literal("image"), anchor, imageId: id });
export const visualSpec = z.discriminatedUnion("kind", [flow, timeline, chart, publisherImage]);
export type VisualSpec = z.infer<typeof visualSpec>;
const visualBlock = z.discriminatedUnion("kind", [flow.extend({ id }), timeline.extend({ id }), chart.extend({ id }), publisherImage.extend({ id })]);
const v2 = z.strictObject({ version: z.literal(2), ...shared, blocks: z.array(visualBlock).max(6) });
export type RichAnswerV1 = z.infer<typeof v1>;
export type RichAnswerV2 = z.infer<typeof v2>;
export type VisualBlock = RichAnswerV2["blocks"][number];

export function visualCitations(block: VisualSpec) {
  switch (block.kind) {
    case "flow": return block.edges.flatMap(edge => edge.citation ? [edge.citation] : []);
    case "timeline": return block.events.map(event => event.citation);
    case "chart": return block.points.map(point => point.citation);
    case "image": return [];
  }
}

export const richAnswerSchema = z.discriminatedUnion("version", [v1, v2]).superRefine((answer, context) => {
  const sources = new Set(answer.sources.map(source => source.id));
  const images = new Set(answer.images.map(image => image.id));
  const ids = [...sources, ...images, ...answer.blocks.map(block => block.id)];
  if (sources.size !== answer.sources.length || images.size !== answer.images.length || new Set(ids).size !== ids.length
    || new Set(answer.sources.map(source => source.url)).size !== answer.sources.length
    || answer.images.some(image => !sources.has(image.sourceId))
    || (answer.version === 1 && answer.blocks.some(block => new Set(block.imageIds).size !== block.imageIds.length || block.imageIds.some(image => !images.has(image))))
    || (answer.version === 2 && answer.blocks.some(block =>
      (block.kind === "image" && !images.has(block.imageId))
      || (block.kind === "flow" && block.edges.some(edge => edge.from >= block.nodes.length || edge.to >= block.nodes.length || edge.from === edge.to))
      || visualCitations(block).some(item => !sources.has(item.sourceId))))) {
    context.addIssue({ code: "custom", message: "Invalid presentation references" });
  }
  if (new TextEncoder().encode(JSON.stringify(answer)).length > 64_000) context.addIssue({ code: "custom", message: "Presentation exceeds 64 KB" });
});
export type RichAnswer = z.infer<typeof richAnswerSchema>;
export function readRichAnswer(value: unknown): RichAnswer | undefined {
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
  }) as RichAnswerV1;
}
