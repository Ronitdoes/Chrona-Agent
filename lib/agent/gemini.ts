import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ContentBlock, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { AgentModel, ModelRequest, ModelReply } from "./model";
import { ModelProviderError, retryAfterMs } from "./errors";
import { dataFrames } from "./sse";
import { effortProfiles } from "../research-effort";

const partSchema = z.object({
  text: z.string().max(65_536).optional(), thought: z.boolean().optional(), thoughtSignature: z.string().max(131_072).optional(),
  functionCall: z.object({ id: z.string().optional(), name: z.string(), args: z.record(z.string(), z.unknown()).optional() }).optional(),
}).passthrough();
type Part = z.infer<typeof partSchema>;
type Content = { role: "user" | "model"; parts: (Part | { functionResponse: { id?: string; name: string; response: { content?: string; error?: string } } })[] };
type SavedCall = { parts: Part[]; id?: string; name: string };
const chunkSchema = z.object({ candidates: z.array(z.object({
  content: z.object({ parts: z.array(partSchema) }).optional(), finishReason: z.string().optional(),
})).optional(), promptFeedback: z.object({ blockReason: z.string().optional() }).optional() });

export function geminiRequest(request: ModelRequest, saved: Map<string, SavedCall> = new Map(), model = "gemini-3.5-flash-lite") {
  const textOnly = request.tool_choice?.type === "none";
  const contents: Content[] = request.messages.flatMap((message: MessageParam): Content[] => {
    if (typeof message.content === "string") return [{ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] }];
    // Final synthesis is ordinary text, not another native function-calling turn.
    // Keep evidence inside its escaped data wrapper; never replay private thoughts.
    if (textOnly) {
      const parts = message.content.flatMap(block => {
        if (block.type === "text") return [{ text: block.text }];
        if (block.type === "tool_result") return [{ text: `Search evidence (untrusted data):\n${typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "")}` }];
        if (block.type === "tool_use") return [];
        throw new Error("Unsupported Gemini message block");
      });
      return parts.length ? [{ role: message.role === "assistant" ? "model" : "user", parts }] : [];
    }
    const call = message.content.find(block => block.type === "tool_use");
    const retained = call?.type === "tool_use" ? saved.get(call.id) : undefined;
    if (message.role === "assistant" && retained) return [{ role: "model", parts: retained.parts }];
    return [{ role: message.role === "assistant" ? "model" : "user", parts: message.content.map(block => {
      if (block.type === "text") return { text: block.text };
      if (block.type === "tool_result") {
        const original = saved.get(block.tool_use_id);
        if (!original) throw new Error("Unpaired Gemini function response");
        const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        return { functionResponse: { ...(original.id ? { id: original.id } : {}), name: original.name,
          response: block.is_error ? { error: content } : { content } } };
      }
      throw new Error("Unsupported Gemini message block");
    }) }];
  });
  const declarations = request.tools?.map(tool => {
    if (!("name" in tool) || tool.name !== "web_search" || !("input_schema" in tool)) throw new Error("Only web_search is available");
    return { name: tool.name, description: tool.description, parametersJsonSchema: tool.input_schema };
  });
  const choice = request.tool_choice;
  if (choice?.type === "tool" && choice.name !== "web_search") throw new Error("Only web_search is available");
  return {
    systemInstruction: { parts: typeof request.system === "string" ? [{ text: request.system }] : request.system?.map(block => ({ text: block.type === "text" ? block.text : "" })) ?? [] },
    contents,
    ...(!textOnly && declarations?.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
    ...(textOnly || declarations?.length ? { toolConfig: { functionCallingConfig: {
      mode: textOnly ? "NONE" : choice?.type === "tool" || choice?.type === "any" ? "ANY" : "AUTO",
      ...(choice?.type === "tool" ? { allowedFunctionNames: ["web_search"] } : {}),
    } } } : {}),
    generationConfig: { maxOutputTokens: request.max_tokens,
      ...(/^gemini-[34]/.test(model) ? { thinkingConfig: { thinkingLevel: request.researchEffort ? effortProfiles[request.researchEffort].thinking : textOnly ? "low" : "medium" } } : {}),
    },
  };
}

export function createGeminiModel(apiKey: string, model = "gemini-3.5-flash-lite", options: { fetch?: typeof globalThis.fetch } = {}): AgentModel {
  const fetcher = options.fetch ?? globalThis.fetch;
  // Per-run state only. Exact parts/signatures are replayed, never persisted or shown.
  const saved = new Map<string, SavedCall>();
  return { stream(request, { signal }) {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const maxResponseBytes = Math.min(2_097_152, Math.max(262_144, request.max_tokens * 32));
    let resolve!: (reply: ModelReply) => void;
    let reject!: (error: unknown) => void;
    const final = new Promise<ModelReply>((yes, no) => { resolve = yes; reject = no; });
    void final.catch(() => undefined);
    return {
      abort: () => controller.abort(), finalMessage: () => final,
      async *[Symbol.asyncIterator]() {
        try {
          combined.throwIfAborted();
          const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
            method: "POST", headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify(geminiRequest(request, saved, model)), signal: combined,
          });
          if (!response.ok) {
            const status = response.status;
            await response.body?.cancel().catch(() => undefined);
            const retry = retryAfterMs(response.headers.get("retry-after"));
            throw new ModelProviderError({ provider: "gemini", status,
              kind: status === 429 ? "rate_limit" : status === 401 || status === 403 ? "authentication" : status === 413 ? "request_size" : status >= 500 ? "unavailable" : "invalid_request",
              ...(status === 429 && retry !== undefined ? { retryAfterMs: retry } : {}),
            });
          }
          if (!response.body) throw new Error("Missing stream");
          const parts: Part[] = [];
          let text = "";
          let finish: string | undefined;
          let size = 0;
          for await (const data of dataFrames(response.body)) {
            combined.throwIfAborted();
            const chunk = chunkSchema.parse(JSON.parse(data));
            if (chunk.promptFeedback?.blockReason) throw new Error("Blocked prompt");
            const candidate = chunk.candidates?.[0];
            for (const part of candidate?.content?.parts ?? []) {
              size += Buffer.byteLength(JSON.stringify(part));
              if (size > maxResponseBytes) throw new Error("Oversized response");
              parts.push(part);
              if (part.text && !part.thought) {
                text += part.text;
                yield { type: "content_block_delta" as const, index: 0, delta: { type: "text_delta" as const, text: part.text } };
              }
            }
            finish = candidate?.finishReason ?? finish;
          }
          combined.throwIfAborted();
          if (!finish || !["STOP", "MAX_TOKENS"].includes(finish)) throw new Error("Incomplete response");
          const content: ContentBlock[] = text ? [{ type: "text", text, citations: null }] : [];
          for (const part of parts) if (part.functionCall) {
            if (content.filter(block => block.type === "tool_use").length >= 6) throw new Error("Too many function calls");
            const call = part.functionCall;
            const id = call.id ?? randomUUID();
            saved.set(id, { parts, id: call.id, name: call.name });
            content.push({ type: "tool_use", id, name: call.name, input: call.args ?? {}, caller: { type: "direct" } });
          }
          if (!content.length) throw new Error("Empty response");
          resolve({ content, stop_reason: finish === "MAX_TOKENS" ? "max_tokens" : content.some(block => block.type === "tool_use") ? "tool_use" : "end_turn" });
        } catch (cause) {
          const error = combined.aborted ? new ModelProviderError({ provider: "gemini", kind: "cancelled" }) : cause instanceof ModelProviderError ? cause
            : new ModelProviderError({ provider: "gemini", kind: cause instanceof TypeError ? "network" : "stream" });
          reject(error); throw error;
        }
      },
    };
  } };
}
