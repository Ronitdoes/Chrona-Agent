import { z } from "zod";

export const providerSchema = z.enum(["anthropic", "groq", "gemini"]);
export const modelIdSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/).refine(value => !value.includes(".."), "Invalid model ID");
export const modelSelectionSchema = z.object({ provider: providerSchema, model: modelIdSchema });
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type Provider = ModelSelection["provider"];
export const providerNames: Record<Provider, string> = { anthropic: "Anthropic", groq: "Groq", gemini: "Google AI Studio" };
export const modelCatalogSchema = z.object({
  default: modelSelectionSchema,
  providers: z.array(z.object({ id: providerSchema, available: z.boolean(), models: z.array(z.object({ id: modelIdSchema, name: z.string() })) })),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
