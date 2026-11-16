import { providerConfig } from "../account-context";
import Anthropic from "@anthropic-ai/sdk";
import { createGeminiModel } from "./gemini";
import { resolveModelSelection } from "../model-config";
import type { ModelSelection } from "../model-selection";
import { effortProfiles, type ResearchEffort } from "../research-effort";
import type { ContentBlock, MessageStreamEvent, MessageCreateParamsNonStreaming, StopReason } from "@anthropic-ai/sdk/resources/messages";

export type ModelRequest = MessageCreateParamsNonStreaming & { researchEffort?: ResearchEffort };

export type ModelReply = { content: ContentBlock[]; stop_reason: StopReason | null };
export interface ModelStream extends AsyncIterable<MessageStreamEvent> {
  finalMessage(): Promise<ModelReply>;
  abort(): void;
}
export interface AgentModel {
  stream(request: ModelRequest, options: { signal: AbortSignal }): ModelStream;
}

export function createAnthropicModel(apiKey: string, options: { fetch?: typeof globalThis.fetch; model?: string } = {}): AgentModel {
  const client = new Anthropic({ apiKey, maxRetries: 0, ...options });
  return { stream(request, streamOptions) {
    const { researchEffort, ...body } = request;
    return client.messages.stream({ ...body, model: options.model ?? request.model,
      ...(researchEffort ? { output_config: { ...body.output_config, effort: effortProfiles[researchEffort].thinking } } : {}),
    }, streamOptions);
  } };
}

export async function createConfiguredModel(requested?: ModelSelection): Promise<AgentModel> {
  const env = await providerConfig();
  const selection = await resolveModelSelection(requested, env);
  return selection.provider === "gemini" ? createGeminiModel(env.GEMINI_API_KEY, selection.model)
    : createAnthropicModel(env.ANTHROPIC_API_KEY, { model: selection.model });
}
