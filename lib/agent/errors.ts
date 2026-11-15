export type ModelFailure = {
  provider: "gemini" | "unknown";
  kind: "rate_limit" | "tool_generation" | "authentication" | "invalid_request" | "request_size" | "unavailable" | "network" | "stream" | "cancelled" | "unknown";
  status?: number;
  retryAfterMs?: number;
};

// Carries only allowlisted diagnostics, never a provider body, prompt, URL or API key.
export class ModelProviderError extends Error {
  constructor(readonly failure: ModelFailure) {
    super(failure.kind === "cancelled" ? "Model request cancelled" : failure.provider === "gemini" ? "Gemini response failed" : "Model response failed");
    this.name = "ModelProviderError";
  }
}

export function retryAfterMs(value: string | null): number | undefined {
  if (!value?.trim() || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const milliseconds = Math.ceil(Number(value) * 1000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

export function modelFailure(error: unknown): ModelFailure {
  return error instanceof ModelProviderError ? error.failure : { provider: "unknown", kind: "unknown" };
}

export function recoveryDelay(failure: ModelFailure): number | null {
  if (failure.kind === "request_size") return null;
  if (failure.kind === "rate_limit") return failure.retryAfterMs ?? null;
  return ["tool_generation", "unavailable", "network", "stream"].includes(failure.kind) ? 0 : null;
}

export function modelFailureMessage(failure: ModelFailure, searched: boolean): string {
  const prefix = searched ? "The web search completed, but " : "";
  if (failure.kind === "request_size") return `${prefix}${searched ? "the" : "The"} conversation and search evidence exceed the model provider's input limit. Try a shorter question or start a new conversation. Available sources are preserved.`;
  if (failure.kind === "rate_limit") return `${prefix}${searched ? "the" : "The"} model provider is rate-limiting requests. Please try again shortly.`;
  if (failure.kind === "authentication") return `${prefix}${searched ? "the" : "The"} model provider rejected authentication. Check the configured provider key.`;
  if (failure.kind === "unavailable" || failure.kind === "network") return `${prefix}${searched ? "the" : "The"} model provider is temporarily unavailable. Please try again.`;
  if (failure.kind === "tool_generation") return `${prefix}${searched ? "the" : "The"} model could not generate ${searched ? "a valid follow-up" : "a valid search request"}. Please try again.`;
  if (failure.kind === "invalid_request") return searched ? `${prefix}the model provider rejected the follow-up request. Your available sources are preserved.` : "The model provider rejected the request. Please try again.";
  return searched ? "The web search completed, but the model could not finish the answer. Your sources and partial text are preserved." : "The agent could not finish the response. Any partial answer is preserved.";
}
