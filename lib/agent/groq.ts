import { z } from "zod";
import type { ContentBlock, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { AgentModel, ModelReply, ModelRequest, ModelStream } from "./model";
import { inputTokenLimit, ModelProviderError, retryAfterMs, type ModelFailure } from "./errors";
import { fitGroqRequest, GROQ_INPUT_BUDGET, GROQ_OUTPUT_BUDGET } from "./groq-budget";

const chunkSchema = z.object({ choices: z.array(z.object({
  delta: z.object({
    content: z.string().nullish(),
    tool_calls: z.array(z.object({
      index: z.number().int().nonnegative(), id: z.string().optional(),
      function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
    })).optional(),
  }),
  finish_reason: z.string().nullish(),
})) });
type GroqMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] };

function textOf(content: string | ContentBlockParam[]): string {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type !== "text") throw new Error("Unsupported model message block");
    return block.text;
  }).join("\n");
}

function convertMessage(message: MessageParam): GroqMessage[] {
  if (typeof message.content === "string") return [{ role: message.role, content: message.content }];
  const blocks: ContentBlockParam[] = message.content;
  if (message.role === "assistant") {
    const tools = blocks.filter((block) => block.type === "tool_use").map((block) => ({
      id: block.id, type: "function" as const, function: { name: block.name, arguments: JSON.stringify(block.input) },
    }));
    const text = textOf(blocks.filter((block) => block.type !== "tool_use"));
    return [{ role: "assistant", content: text || null, ...(tools.length ? { tool_calls: tools } : {}) }];
  }
  const results: GroqMessage[] = [];
  const userText: ContentBlockParam[] = [];
  for (const block of blocks) {
    if (block.type === "tool_result") {
      const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      results.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.is_error ? `Tool error: ${content}` : content });
    } else userText.push(block);
  }
  if (userText.length) results.push({ role: message.role, content: textOf(userText) });
  return results;
}

export function groqRequest(request: ModelRequest, model: string) {
  if (request.tool_choice?.type === "tool" && request.tool_choice.name !== "web_search") throw new Error("Only web_search is available");
  const tools = request.tools?.map((tool) => {
    if (!("name" in tool) || tool.name !== "web_search" || !("input_schema" in tool)) throw new Error("Only web_search is available");
    return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } };
  });
  const system = request.system ? textOf(request.system) : "";
  return {
    model, stream: true, max_completion_tokens: request.max_tokens,
    messages: [...(system ? [{ role: "system" as const, content: system }] : []), ...request.messages.flatMap(convertMessage)],
    tools,
    tool_choice: request.tool_choice?.type === "none" ? "none" : request.tool_choice?.type === "tool"
      ? { type: "function", function: { name: "web_search" } } : "auto",
    parallel_tool_calls: false,
    // Qwen's instruct mode avoids spending the answer budget on hidden reasoning.
    ...(model.startsWith("qwen/") ? { reasoning_effort: "none" } : {}),
  };
}

export type GroqRequest = ReturnType<typeof groqRequest>;

export async function* dataFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frameData = (frame: string) => frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = frameData(frame);
        if (data === "[DONE]") return;
        if (data) yield data;
      }
      if (buffer.length > 65_536) throw new Error("Model stream frame exceeded its limit");
      if (done) { const data = frameData(buffer); if (data && data !== "[DONE]") yield data; return; }
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export function createGroqModel(apiKey: string, model = "qwen/qwen3.8-27b", options: { fetch?: typeof globalThis.fetch; inputBudget?: number; outputBudget?: number } = {}): AgentModel {
  const fetcher = options.fetch ?? globalThis.fetch;
  let inputBudget = options.inputBudget ?? GROQ_INPUT_BUDGET;
  const outputBudget = options.outputBudget ?? GROQ_OUTPUT_BUDGET;
  return {
    stream(request, { signal }): ModelStream {
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, controller.signal]);
      let resolve!: (reply: ModelReply) => void;
      let reject!: (error: unknown) => void;
      const final = new Promise<ModelReply>((yes, no) => { resolve = yes; reject = no; });
      // finalMessage is read after iteration; observe an earlier stream rejection too.
      void final.catch(() => undefined);
      return {
        abort: () => controller.abort(), finalMessage: () => final,
        async *[Symbol.asyncIterator]() {
          try {
            combined.throwIfAborted();
            const body = fitGroqRequest(groqRequest({ ...request, max_tokens: Math.min(request.max_tokens, outputBudget) }, model), inputBudget);
            const response = await fetcher("https://api.groq.com/openai/v1/chat/completions", {
              method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify(body), signal: combined,
            });
            if (!response.ok) {
              const errorBody: unknown = response.status === 400 || response.status === 413 ? await response.json().catch(() => null) : null;
              const toolError = z.object({ error: z.object({ code: z.literal("tool_use_failed") }) }).safeParse(errorBody).success;
              const inputLimit = inputTokenLimit(errorBody);
              const kind: ModelFailure["kind"] = response.status === 429 ? "rate_limit"
                : response.status === 401 || response.status === 403 ? "authentication"
                : response.status === 413 ? "request_size" : toolError ? "tool_generation" : response.status >= 500 || response.status === 408 ? "unavailable" : "invalid_request";
              // A 413 recovery must send a smaller payload. This changes the budget
              // for the loop's single allowed recovery; the transport never retries.
              if (response.status === 413) inputBudget = Math.max(512, Math.min(Math.floor(inputBudget * (inputLimit ? 0.9 : 0.7)), Math.floor((inputLimit ?? inputBudget) * 0.9)));
              const retry = response.status === 429 ? retryAfterMs(response.headers.get("retry-after")) : undefined;
              if (response.body && response.status !== 400 && response.status !== 413) await response.body.cancel().catch(() => undefined);
              throw new ModelProviderError({ provider: "groq", kind, status: response.status,
                ...(retry !== undefined ? { retryAfterMs: retry } : {}),
                ...(response.status === 413 && inputLimit !== undefined ? { inputTokenLimit: inputLimit } : {}),
              });
            }
            if (!response.body) throw new ModelProviderError({ provider: "groq", kind: "stream" });
            let text = "";
            let finished: string | null = null;
            const calls = new Map<number, { id: string; name: string; arguments: string }>();
            for await (const data of dataFrames(response.body)) {
              combined.throwIfAborted();
              const chunk = chunkSchema.parse(JSON.parse(data));
              const choice = chunk.choices[0];
              if (!choice) continue;
              if (choice.delta.content) {
                text += choice.delta.content;
                yield { type: "content_block_delta" as const, index: 0, delta: { type: "text_delta" as const, text: choice.delta.content } };
              }
              for (const tool of choice.delta.tool_calls ?? []) {
                const previous = calls.get(tool.index) ?? { id: "", name: "", arguments: "" };
                previous.id += tool.id ?? "";
                previous.name += tool.function?.name ?? "";
                previous.arguments += tool.function?.arguments ?? "";
                if (previous.arguments.length > 32_768 || !calls.has(tool.index) && calls.size >= 10) throw new Error("Model tool input exceeded its limit");
                calls.set(tool.index, previous);
              }
              finished = choice.finish_reason ?? finished;
            }
            combined.throwIfAborted();
            if (!finished) throw new Error("Model stream ended before completion");
            const content: ContentBlock[] = text ? [{ type: "text", text, citations: null }] : [];
            for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
              if (!call.id || !call.name) throw new Error("Incomplete model tool call");
              let input: unknown;
              try { input = JSON.parse(call.arguments); } catch { input = call.arguments; }
              content.push({ type: "tool_use", id: call.id, name: call.name, input, caller: { type: "direct" } });
            }
            resolve({ content, stop_reason: finished === "length" ? "max_tokens" : finished === "content_filter" ? "refusal" : calls.size ? "tool_use" : "end_turn" });
          } catch (cause) {
            const error = combined.aborted ? new ModelProviderError({ provider: "groq", kind: "cancelled" })
              : cause instanceof ModelProviderError ? cause : new ModelProviderError({ provider: "groq", kind: cause instanceof TypeError ? "network" : "stream" });
            reject(error);
            throw error;
          }
        },
      };
    },
  };
}
