/**
 * Middleware AI SDK: convierte JSON de tools en texto → eventos tool-call del provider.
 */

import type { LanguageModelMiddleware } from "ai";
import { parseTextToolCalls, looksLikeTextToolPlan, type ParsedTextToolCall } from "./text-tool-parser";

type WrapGenerateInput = Parameters<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>[0];
type WrapStreamInput = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];
type GenerateResult = Awaited<ReturnType<WrapGenerateInput["doGenerate"]>>;
type GenerateContent = GenerateResult["content"][number];
type StreamResult = Awaited<ReturnType<WrapStreamInput["doStream"]>>;
type StreamChunk = StreamResult["stream"] extends ReadableStream<infer Chunk> ? Chunk : never;
type FinishChunk = Extract<StreamChunk, { type: "finish" }>;
type ProviderUsage = FinishChunk["usage"];
type ProviderMetadata = FinishChunk extends { providerMetadata?: infer Metadata } ? Metadata : never;
type CallParams = WrapStreamInput["params"];

interface NamedToolLike {
  name?: unknown;
  toolName?: unknown;
  function?: {
    name?: unknown;
  };
}

interface TextDeltaLike {
  delta?: unknown;
  text?: unknown;
  textDelta?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Formato LanguageModelV3 que espera el AI SDK (asLanguageModelUsage). */
function defaultProviderUsage(): ProviderUsage {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: undefined,
      text: undefined,
      reasoning: undefined,
    },
  };
}

function normalizeProviderUsage(usage: unknown): ProviderUsage {
  if (!isRecord(usage)) return defaultProviderUsage();
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (input != null && output != null && typeof input === "object" && typeof output === "object") {
    const inputRecord = input as Record<string, unknown>;
    const outputRecord = output as Record<string, unknown>;
    return {
      inputTokens: {
        total: typeof inputRecord.total === "number" ? inputRecord.total : undefined,
        noCache: typeof inputRecord.noCache === "number" ? inputRecord.noCache : undefined,
        cacheRead: typeof inputRecord.cacheRead === "number" ? inputRecord.cacheRead : undefined,
        cacheWrite: typeof inputRecord.cacheWrite === "number" ? inputRecord.cacheWrite : undefined,
      },
      outputTokens: {
        total: typeof outputRecord.total === "number" ? outputRecord.total : undefined,
        text: typeof outputRecord.text === "number" ? outputRecord.text : undefined,
        reasoning: typeof outputRecord.reasoning === "number" ? outputRecord.reasoning : undefined,
      },
    };
  }
  return defaultProviderUsage();
}

function getAllowedToolNames(params: CallParams): string[] {
  const tools = params?.tools;
  if (!tools) return [];
  if (Array.isArray(tools)) {
    return tools
      .map((toolItem: unknown) => {
        if (typeof toolItem === "string") return toolItem;
        const item = toolItem as NamedToolLike | null;
        return item?.name ?? item?.toolName ?? item?.function?.name;
      })
      .filter((name): name is string => typeof name === "string" && name.length > 0);
  }
  if (typeof tools === "object") {
    return Object.keys(tools);
  }
  return [];
}

function streamTextDelta(chunk: unknown): string {
  const value = chunk as TextDeltaLike | null;
  const text = value?.delta ?? value?.text ?? value?.textDelta ?? "";
  return typeof text === "string" ? text : "";
}

function enqueueProviderChunk(
  controller: TransformStreamDefaultController<StreamChunk>,
  chunk: Record<string, unknown>,
): void {
  controller.enqueue(chunk as StreamChunk);
}

function emitTextToolCall(
  controller: TransformStreamDefaultController<StreamChunk>,
  call: ParsedTextToolCall,
  usage: ProviderUsage | undefined,
  providerMetadata: ProviderMetadata | undefined,
): void {
  const argsJson = JSON.stringify(call.args ?? {});
  const { toolCallId, toolName } = call;
  enqueueProviderChunk(controller, { type: "tool-input-start", id: toolCallId, toolName });
  if (argsJson.length > 0) {
    enqueueProviderChunk(controller, { type: "tool-input-delta", id: toolCallId, delta: argsJson });
  }
  enqueueProviderChunk(controller, { type: "tool-input-end", id: toolCallId });
  enqueueProviderChunk(controller, {
    type: "tool-call",
    toolCallId,
    toolName,
    input: argsJson,
    providerExecuted: false,
  });
  enqueueProviderChunk(controller, {
    type: "finish",
    finishReason: { unified: "tool-calls", raw: "tool-calls" },
    usage: normalizeProviderUsage(usage),
    providerMetadata,
  });
}

function tryInjectToolCallsFromText({
  text,
  allowedToolNames,
  controller,
  usage,
  providerMetadata,
}: {
  text: string;
  allowedToolNames: string[];
  controller: TransformStreamDefaultController<StreamChunk>;
  usage?: ProviderUsage;
  providerMetadata?: ProviderMetadata;
}): boolean {
  if (!text?.trim() || !allowedToolNames.length) return false;
  const { toolCalls } = parseTextToolCalls(text, { allowedToolNames });
  if (!toolCalls.length) return false;
  emitTextToolCall(controller, toolCalls[0], usage, providerMetadata);
  return true;
}

/**
 */
function withoutToolChoice(params: CallParams): CallParams {
  if (!params || params.toolChoice == null) return params;
  const { toolChoice: _toolChoice, ...rest } = params;
  return rest;
}

export function transformersTextToolMiddleware({
  stripToolChoice = false,
  parseTextTools = true,
}: { stripToolChoice?: boolean; parseTextTools?: boolean } = {}): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const generate = () => stripToolChoice ? model.doGenerate(withoutToolChoice(params)) : doGenerate();
      const allowedToolNames = getAllowedToolNames(params);
      if (!parseTextTools || !allowedToolNames.length) return generate();

      const result = await generate();
      const textParts = (result.content || [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      if ((result.content || []).some((p) => p.type === "tool-call")) return result;

      const { toolCalls, textContent } = parseTextToolCalls(textParts, { allowedToolNames });
      if (!toolCalls.length) return result;

      const call = toolCalls[0];
      const argsJson = JSON.stringify(call.args ?? {});
      const content = [];
      if (textContent) content.push({ type: "text", text: textContent });
      content.push({
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: argsJson,
        providerExecuted: false,
      });
      return {
        ...result,
        content: content as GenerateContent[],
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
      };
    },

    wrapStream: async ({ doStream, params, model }) => {
      const stream = () => stripToolChoice ? model.doStream(withoutToolChoice(params)) : doStream();
      const allowedToolNames = getAllowedToolNames(params);
      if (!parseTextTools || !allowedToolNames.length) return stream();

      const { stream: baseStream, ...rest } = await stream();
      let accumulated = "";
      let toolCallEmitted = false;
      let suppressText = false;
      let pendingFinish: FinishChunk | null = null;

      const transformed = baseStream.pipeThrough(
        new TransformStream<StreamChunk, StreamChunk>({
          transform(chunk, controller) {
            if (
              chunk.type === "reasoning-start"
              || chunk.type === "reasoning-delta"
              || chunk.type === "reasoning-end"
            ) {
              controller.enqueue(chunk);
              return;
            }

            if (toolCallEmitted) {
              // El modelo base puede emitir otro finish (stop) tras el nuestro (tool-calls).
              if (chunk.type === "text-delta" || chunk.type === "finish") return;
              controller.enqueue(chunk);
              return;
            }

            if (chunk.type === "tool-call") {
              toolCallEmitted = true;
              controller.enqueue(chunk);
              return;
            }
            if (chunk.type === "tool-input-start" || chunk.type === "tool-input-delta" || chunk.type === "tool-input-end") {
              controller.enqueue(chunk);
              return;
            }

            if (chunk.type === "text-delta") {
              const delta = streamTextDelta(chunk);
              accumulated += delta;
              if (!suppressText && looksLikeTextToolPlan(accumulated)) {
                suppressText = true;
              }
              if (suppressText) {
                if (
                  tryInjectToolCallsFromText({
                    text: accumulated,
                    allowedToolNames,
                    controller,
                    usage: pendingFinish?.usage,
                    providerMetadata: pendingFinish?.providerMetadata,
                  })
                ) {
                  toolCallEmitted = true;
                }
                return;
              }
              controller.enqueue(chunk);
              return;
            }

            if (chunk.type === "finish" && !toolCallEmitted) {
              pendingFinish = chunk;
              if (
                tryInjectToolCallsFromText({
                  text: accumulated,
                  allowedToolNames,
                  controller,
                  usage: chunk.usage,
                  providerMetadata: chunk.providerMetadata,
                })
              ) {
                toolCallEmitted = true;
                return;
              }
              if (suppressText && accumulated.trim()) {
                // No parseable tool: devolver texto acumulado una vez
                enqueueProviderChunk(controller, {
                  type: "text-delta",
                  id: "text-recovered",
                  delta: accumulated,
                });
              }
              controller.enqueue(chunk);
              return;
            }

            controller.enqueue(chunk);
          },
        }),
      );

      return { stream: transformed, ...rest };
    },
  };
}
