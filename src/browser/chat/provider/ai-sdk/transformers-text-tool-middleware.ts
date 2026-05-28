// @ts-nocheck
/**
 * Middleware AI SDK: convierte JSON de tools en texto → eventos tool-call del provider.
 */

import { parseTextToolCalls, looksLikeTextToolPlan } from "./text-tool-parser";

/** Formato LanguageModelV3 que espera el AI SDK (asLanguageModelUsage). */
function defaultProviderUsage() {
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

function normalizeProviderUsage(usage) {
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  if (input != null && output != null && typeof input === "object" && typeof output === "object") {
    return {
      inputTokens: {
        total: input.total,
        noCache: input.noCache,
        cacheRead: input.cacheRead,
        cacheWrite: input.cacheWrite,
      },
      outputTokens: {
        total: output.total,
        text: output.text,
        reasoning: output.reasoning,
      },
    };
  }
  return defaultProviderUsage();
}

function getAllowedToolNames(params) {
  const tools = params?.tools;
  if (!tools) return [];
  if (Array.isArray(tools)) {
    return tools
      .map((t) => {
        if (typeof t === "string") return t;
        return t?.name ?? t?.toolName ?? t?.function?.name;
      })
      .filter((name) => typeof name === "string" && name.length > 0);
  }
  if (typeof tools === "object") {
    return Object.keys(tools);
  }
  return [];
}

function streamTextDelta(chunk) {
  return chunk?.delta ?? chunk?.text ?? chunk?.textDelta ?? "";
}

function emitTextToolCall(controller, call, usage, providerMetadata) {
  const argsJson = JSON.stringify(call.args ?? {});
  const { toolCallId, toolName } = call;
  controller.enqueue({ type: "tool-input-start", id: toolCallId, toolName });
  if (argsJson.length > 0) {
    controller.enqueue({ type: "tool-input-delta", id: toolCallId, delta: argsJson });
  }
  controller.enqueue({ type: "tool-input-end", id: toolCallId });
  controller.enqueue({
    type: "tool-call",
    toolCallId,
    toolName,
    input: argsJson,
    providerExecuted: false,
  });
  controller.enqueue({
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
}) {
  if (!text?.trim() || !allowedToolNames.length) return false;
  const { toolCalls } = parseTextToolCalls(text, { allowedToolNames });
  if (!toolCalls.length) return false;
  emitTextToolCall(controller, toolCalls[0], usage, providerMetadata);
  return true;
}

/**
 * @returns {import('ai').LanguageModelV3Middleware}
 */
function withoutToolChoice(params) {
  if (!params || params.toolChoice == null) return params;
  const { toolChoice: _toolChoice, ...rest } = params;
  return rest;
}

export function transformersTextToolMiddleware({ stripToolChoice = false, parseTextTools = true } = {}) {
  return {
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
        content,
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
      let pendingFinish = null;

      const transformed = baseStream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
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
                controller.enqueue({
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
