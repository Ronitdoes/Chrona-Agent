import type { Env } from "./env";
import { modelSelectionSchema, type ModelCatalog, type ModelSelection, type Provider } from "./model-selection";

const keyNames = { anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" } as const;
export function modelCatalog(config: Env): ModelCatalog {
  const defaults = { anthropic: config.ANTHROPIC_MODEL, gemini: config.GEMINI_MODEL };
  return {
    default: { provider: config.MODEL_PROVIDER, model: defaults[config.MODEL_PROVIDER] },
    providers: (["anthropic", "gemini"] as Provider[]).map(id => ({
      id, available: Boolean(config[keyNames[id]]),
      models: [{ id: defaults[id], name: defaults[id] === "gemini-3.5-flash-lite" ? "Gemini 3.5 Flash Lite" : defaults[id] === "claude-sonnet-5-5" ? "Claude Sonnet 5.5" : defaults[id] }],
    })),
  };
}

export async function resolveModelSelection(requested?: ModelSelection, config?: Env): Promise<ModelSelection> {
  config ??= (await import("./env")).env;
  const selection = modelSelectionSchema.parse(requested ?? modelCatalog(config).default);
  if (!config[keyNames[selection.provider]]) throw new Error(`Add ${keyNames[selection.provider]} to the server environment to use this provider.`);
  return selection;
}
