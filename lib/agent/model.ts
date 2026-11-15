import Anthropic from "@anthropic-ai/sdk";
import { createGroqModel } from "./groq";
import { createGeminiModel } from "./gemini";
import { resolveModelSelection } from "../model-config";
import type { ModelSelection } from "../model-selection";
import type { ContentBlock, MessageStreamEvent, MessageCreateParamsNonStreaming, StopReason } from "@anthropic-ai/sdk/resources/messages";

export type ModelRequest = MessageCreateParamsNonStreaming;

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
  return { stream: (request, streamOptions) => client.messages.stream({ ...request, model: options.model ?? request.model }, streamOptions) };
}

export async function createConfiguredModel(requested?: ModelSelection): Promise<AgentModel> {
  const { env } = await import("../env");
  const selection = await resolveModelSelection(requested, env);
  return selection.provider === "groq"
    ? createGroqModel(env.GROQ_API_KEY, selection.model, { inputBudget: env.GROQ_MAX_INPUT_TOKENS, outputBudget: env.GROQ_MAX_OUTPUT_TOKENS })
    : selection.provider === "gemini" ? createGeminiModel(env.GEMINI_API_KEY, selection.model)
      : createAnthropicModel(env.ANTHROPIC_API_KEY, { model: selection.model });
}
