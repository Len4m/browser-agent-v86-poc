import type { LanguageModel } from "ai";
import { looksLikeTextToolPlan, parseTextToolCalls, type ParsedTextToolCall } from "./text-tool-parser";

type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: "v3" }>;
type CallOptions = Parameters<LanguageModelV3["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<LanguageModelV3["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<LanguageModelV3["doStream"]>>;
type StreamChunk = StreamResult["stream"] extends ReadableStream<infer Chunk> ? Chunk : never;
type ProviderUsage = GenerateResult["usage"];
type ProviderContent = GenerateResult["content"][number];

type ProgressCallback = (progress: unknown) => void;

export interface TransformersWorkerModelSettings {
  device?: unknown;
  dtype?: unknown;
  use_external_data_format?: boolean;
  isVisionModel?: boolean;
  worker: Worker;
  initProgressCallback?: ProgressCallback;
  rawInitProgressCallback?: ProgressCallback;
}

export type TransformersWorkerLanguageModel = LanguageModelV3 & {
  availability: () => Promise<"unavailable" | "downloadable" | "available">;
  createSessionWithProgress: (onProgress?: ProgressCallback) => Promise<TransformersWorkerLanguageModel>;
};

interface TransformerMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image?: string }>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface FunctionTool {
  name: string;
  description?: string;
  parameters: unknown;
}

interface FunctionToolLike {
  type: "function";
  name: string;
  description?: unknown;
  inputSchema?: unknown;
}

interface CallArgs {
  messages: TransformerMessage[];
  warnings: unknown[];
  generationOptions: Record<string, unknown>;
  functionTools: FunctionTool[];
  enableThinking: boolean;
}

interface WorkerGenerateResult {
  text: string;
  usage: {
    inputTokens?: unknown;
    outputTokens?: unknown;
  };
  toolCalls: ParsedTextToolCall[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}

function jsonStringify(value: unknown): string {
  try {
    const out = JSON.stringify(value);
    return typeof out === "string" ? out : "";
  } catch {
    return "";
  }
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function enqueueProviderChunk(
  controller: ReadableStreamDefaultController<StreamChunk>,
  chunk: Record<string, unknown>,
): void {
  controller.enqueue(chunk as StreamChunk);
}

function providerUsage(inputTokens: unknown, outputTokens: unknown): ProviderUsage {
  return {
    inputTokens: {
      total: typeof inputTokens === "number" ? inputTokens : undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: typeof outputTokens === "number" ? outputTokens : undefined,
      text: undefined,
      reasoning: undefined,
    },
  };
}

function normalizeToolArguments(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as unknown;
    } catch {
      return input;
    }
  }
  return input ?? {};
}

function outputToText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (!isRecord(output)) return jsonStringify(output);
  if (typeof output.modelText === "string") return output.modelText;

  switch (output.type) {
    case "text":
    case "error-text":
      return textValue(output.value);
    case "json":
    case "content":
    case "error-json":
      return jsonStringify(output.value ?? {});
    case "execution-denied":
      return `execution denied: ${textValue(output.reason)}`.trim();
    default:
      return jsonStringify(output);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function convertDataToUrl(data: unknown, mediaType: unknown): string {
  const type = textValue(mediaType) || "application/octet-stream";
  if (typeof data === "string") {
    return data.startsWith("data:") ? data : `data:${type};base64,${data}`;
  }
  if (data instanceof ArrayBuffer) {
    return `data:${type};base64,${bytesToBase64(new Uint8Array(data))}`;
  }
  if (ArrayBuffer.isView(data)) {
    return `data:${type};base64,${bytesToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))}`;
  }
  return "";
}

function processVisionContent(content: unknown[]): Array<{ type: string; text?: string; image?: string }> {
  const contentParts: Array<{ type: string; text?: string; image?: string }> = [];
  let textParts: string[] = [];

  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text") {
      textParts.push(textValue(part.text));
      continue;
    }
    if (part.type === "file" && textValue(part.mediaType).startsWith("image/")) {
      if (textParts.length > 0) {
        contentParts.push({ type: "text", text: textParts.join("\n") });
        textParts = [];
      }
      contentParts.push({
        type: "image",
        image: convertDataToUrl(part.data, part.mediaType),
      });
      continue;
    }
    if (part.type === "file") {
      throw new Error("Transformers.js worker model does not support non-image file input.");
    }
  }

  if (textParts.length > 0) {
    contentParts.push({ type: "text", text: textParts.join("\n") });
  }
  return contentParts;
}

export function convertPromptToTransformersMessages(
  prompt: CallOptions["prompt"] = [],
  isVisionModel = false,
): TransformerMessage[] {
  const messages: TransformerMessage[] = [];

  for (const message of prompt || []) {
    if (message.role === "system") {
      messages.push({ role: "system", content: message.content });
      continue;
    }

    if (message.role === "user") {
      const content = Array.isArray(message.content) ? message.content : [];
      if (isVisionModel) {
        messages.push({ role: "user", content: processVisionContent(content) });
        continue;
      }
      const text = content.map((part) => {
        if (!isRecord(part)) return "";
        if (part.type === "text") return textValue(part.text);
        if (part.type === "file") throw new Error("Transformers.js worker model does not support file input.");
        return "";
      }).filter(Boolean).join("\n");
      messages.push({ role: "user", content: text });
      continue;
    }

    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const textParts = content
        .filter((part) => isRecord(part) && part.type === "text")
        .map((part) => textValue((part as unknown as Record<string, unknown>).text))
        .filter(Boolean);
      const toolCalls = content
        .filter((part) => isRecord(part) && part.type === "tool-call")
        .map((part) => {
          const item = part as unknown as Record<string, unknown>;
          return {
            id: textValue(item.toolCallId),
            type: "function" as const,
            function: {
              name: textValue(item.toolName),
              arguments: typeof item.input === "string" ? item.input : jsonStringify(normalizeToolArguments(item.input)),
            },
          };
        })
        .filter((call) => call.id && call.function.name);
      messages.push({
        role: "assistant",
        content: textParts.join("\n"),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (message.role === "tool") {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const part of content) {
        if (!isRecord(part) || part.type !== "tool-result") continue;
        const output = outputToText(part.output);
        if (!output) continue;
        messages.push({
          role: "tool",
          tool_call_id: textValue(part.toolCallId),
          name: textValue(part.toolName),
          content: output,
        });
      }
      continue;
    }

    throw new Error(`Unsupported message role: ${textValue((message as { role?: unknown }).role)}`);
  }

  return messages.filter((message) => Boolean(message.content) || Boolean(message.tool_calls?.length));
}

function isFunctionTool(tool: unknown): tool is FunctionToolLike {
  return isRecord(tool) && tool.type === "function" && typeof tool.name === "string";
}

function unsupportedSettingWarning(feature: string, details: string): Record<string, unknown> {
  return { type: "unsupported", feature, details };
}

function unsupportedToolWarning(tool: unknown, details: string): Record<string, unknown> {
  const name = isRecord(tool) ? textValue(tool.name) : "";
  return { type: "unsupported", feature: `tool:${name || "unknown"}`, details };
}

export function buildTransformersWorkerCallArgs(options: CallOptions, isVisionModel = false): CallArgs {
  const warnings: unknown[] = [];
  const functionTools: FunctionTool[] = [];

  for (const tool of options.tools || []) {
    if (!isFunctionTool(tool)) {
      warnings.push(unsupportedToolWarning(tool, "Only function tools are supported by Transformers.js."));
      continue;
    }
    functionTools.push({
      name: tool.name,
      description: textValue(tool.description),
      parameters: tool.inputSchema,
    });
  }

  if (options.frequencyPenalty != null) warnings.push(unsupportedSettingWarning("frequencyPenalty", "Frequency penalty is not supported by Transformers.js."));
  if (options.presencePenalty != null) warnings.push(unsupportedSettingWarning("presencePenalty", "Presence penalty is not supported by Transformers.js."));
  if (options.stopSequences != null) warnings.push(unsupportedSettingWarning("stopSequences", "Stop sequences are not supported by Transformers.js."));
  if (options.responseFormat?.type === "json") warnings.push(unsupportedSettingWarning("responseFormat", "JSON response format is not supported by Transformers.js."));
  if (options.seed != null) warnings.push(unsupportedSettingWarning("seed", "Seed is not supported by Transformers.js."));
  if (options.toolChoice != null) warnings.push(unsupportedSettingWarning("toolChoice", "Tool choice is not supported by Transformers.js."));

  const providerOptions = isRecord(options.providerOptions) ? options.providerOptions : {};
  const transformersOptions = isRecord(providerOptions["transformers-js"])
    ? providerOptions["transformers-js"]
    : {};
  const enableThinking = transformersOptions.enableThinking === true;

  return {
    messages: convertPromptToTransformersMessages(options.prompt, isVisionModel),
    warnings,
    generationOptions: {
      max_new_tokens: options.maxOutputTokens || (enableThinking ? 8192 : 4096),
      temperature: options.temperature ?? 0.7,
      top_p: options.topP,
      top_k: options.topK,
      do_sample: options.temperature === undefined || Number(options.temperature) > 0,
    },
    functionTools,
    enableThinking,
  };
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => textValue(item)).join("");
  return textValue(value);
}

function normalizeWorkerToolCalls(value: unknown, allowedToolNames: string[]): ParsedTextToolCall[] {
  if (!Array.isArray(value)) return [];
  const allowed = allowedToolNames.length ? new Set(allowedToolNames) : null;
  return value
    .filter(isRecord)
    .map((call) => ({
      toolCallId: textValue(call.toolCallId) || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      toolName: textValue(call.toolName),
      args: isRecord(call.args) ? call.args : {},
    }))
    .filter((call) => call.toolName && (!allowed || allowed.has(call.toolName)))
    .slice(0, 1);
}

function firstToolCallFromText(text: string, allowedToolNames: string[]): { call: ParsedTextToolCall | null; textContent: string } {
  if (!allowedToolNames.length) return { call: null, textContent: text };
  const parsed = parseTextToolCalls(text, { allowedToolNames });
  return {
    call: parsed.toolCalls[0] || null,
    textContent: parsed.textContent,
  };
}

function toolCallContent(call: ParsedTextToolCall): ProviderContent {
  return {
    type: "tool-call",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: jsonStringify(call.args ?? {}),
    providerExecuted: false,
  };
}

function emitToolCall(controller: ReadableStreamDefaultController<StreamChunk>, call: ParsedTextToolCall): void {
  const input = jsonStringify(call.args ?? {});
  enqueueProviderChunk(controller, { type: "tool-input-start", id: call.toolCallId, toolName: call.toolName });
  if (input) enqueueProviderChunk(controller, { type: "tool-input-delta", id: call.toolCallId, delta: input });
  enqueueProviderChunk(controller, { type: "tool-input-end", id: call.toolCallId });
  enqueueProviderChunk(controller, {
    type: "tool-call",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input,
    providerExecuted: false,
  });
}

function createProgressTracker(onProgress?: ProgressCallback, onRawProgress?: ProgressCallback): ProgressCallback {
  const fileProgress = new Map<string, { loaded: number; total: number }>();
  return (progress: unknown) => {
    onRawProgress?.(progress);
    if (!onProgress) return;
    if (!isRecord(progress)) return;
    const file = textValue(progress.file);
    if (!file) return;
    if (progress.status === "progress") {
      fileProgress.set(file, {
        loaded: typeof progress.loaded === "number" ? progress.loaded : 0,
        total: typeof progress.total === "number" ? progress.total : 0,
      });
    } else if (progress.status === "done") {
      const prev = fileProgress.get(file);
      if (prev?.total) fileProgress.set(file, { loaded: prev.total, total: prev.total });
    } else {
      return;
    }

    let totalLoaded = 0;
    let totalBytes = 0;
    for (const item of fileProgress.values()) {
      if (item.total > 0) {
        totalLoaded += item.loaded;
        totalBytes += item.total;
      }
    }
    if (totalBytes > 0) onProgress(Math.min(1, totalLoaded / totalBytes));
  };
}

export function transformersWorker(
  modelId: string,
  settings: TransformersWorkerModelSettings,
): TransformersWorkerLanguageModel {
  const worker = settings.worker;
  let workerReady = false;
  let operationQueue: Promise<void> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = operationQueue.then(task, task);
    operationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function loadWorker(onProgress?: ProgressCallback): Promise<void> {
    if (workerReady) {
      onProgress?.(1);
      return;
    }

    const trackProgress = createProgressTracker((progress) => {
      settings.initProgressCallback?.(progress);
      onProgress?.(progress);
    }, settings.rawInitProgressCallback);

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        worker.removeEventListener("message", onMessage);
      };
      const onMessage = (event: MessageEvent<unknown>): void => {
        const msg = event.data;
        if (!isRecord(msg)) return;
        if (msg.status === "ready") {
          cleanup();
          workerReady = true;
          settings.initProgressCallback?.(1);
          onProgress?.(1);
          resolve();
          return;
        }
        if (msg.status === "error") {
          cleanup();
          reject(new Error(textValue(msg.data) || "Worker initialization failed."));
          return;
        }
        if ("status" in msg) trackProgress(msg);
      };
      worker.addEventListener("message", onMessage);
      worker.postMessage({
        type: "load",
        data: {
          modelId,
          dtype: settings.dtype,
          device: settings.device,
          use_external_data_format: settings.use_external_data_format,
          isVisionModel: settings.isVisionModel === true,
        },
      });
    });
  }

  async function runWorkerGenerate(
    args: CallArgs,
    abortSignal?: AbortSignal,
    onDelta?: (delta: string) => void,
  ): Promise<WorkerGenerateResult> {
    if (abortSignal?.aborted) throw createAbortError();

    const allowedToolNames = args.functionTools.map((tool) => tool.name);
    await loadWorker();

    return await new Promise<WorkerGenerateResult>((resolve, reject) => {
      let generatedText = "";
      let completeOutput = "";
      let usage: WorkerGenerateResult["usage"] = {};
      let toolCalls: ParsedTextToolCall[] = [];
      let aborted = false;

      const cleanup = (): void => {
        worker.removeEventListener("message", onMessage);
        abortSignal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn: () => void): void => {
        cleanup();
        fn();
      };
      const onAbort = (): void => {
        aborted = true;
        try {
          worker.postMessage({ type: "interrupt" });
        } catch {
          // Ignore failed best-effort interrupt.
        }
      };
      const onMessage = (event: MessageEvent<unknown>): void => {
        const msg = event.data;
        if (!isRecord(msg)) return;
        if (msg.status === "update") {
          const delta = textValue(msg.output);
          if (delta) {
            generatedText += delta;
            onDelta?.(delta);
          }
          return;
        }
        if (msg.status === "complete") {
          completeOutput = outputText(msg.output);
          usage = {
            inputTokens: msg.inputLength,
            outputTokens: msg.numTokens,
          };
          toolCalls = normalizeWorkerToolCalls(msg.toolCalls, allowedToolNames);
          settle(() => {
            if (aborted) reject(createAbortError());
            else resolve({
              text: generatedText || completeOutput,
              usage,
              toolCalls,
            });
          });
          return;
        }
        if (msg.status === "error") {
          settle(() => reject(new Error(textValue(msg.data) || "Worker generation failed.")));
        }
      };

      abortSignal?.addEventListener("abort", onAbort, { once: true });
      worker.addEventListener("message", onMessage);
      worker.postMessage({
        type: "generate",
        data: args.messages,
        generationOptions: args.generationOptions,
        tools: args.functionTools.length ? args.functionTools : undefined,
        enableThinking: args.enableThinking,
      });
    });
  }

  const model: TransformersWorkerLanguageModel = {
    specificationVersion: "v3",
    provider: "transformers-js",
    modelId,
    supportedUrls: {},

    availability() {
      return Promise.resolve(workerReady ? "available" : "downloadable");
    },

    async createSessionWithProgress(onProgress) {
      await enqueue(() => loadWorker(onProgress));
      return model;
    },

    async doGenerate(options): Promise<GenerateResult> {
      const args = buildTransformersWorkerCallArgs(options, settings.isVisionModel === true);
      try {
        const result = await enqueue(() => runWorkerGenerate(args, options.abortSignal));
        const allowedToolNames = args.functionTools.map((tool) => tool.name);
        const workerCall = result.toolCalls[0] || null;
        const parsedText = firstToolCallFromText(result.text, allowedToolNames);
        const parsed = { call: workerCall || parsedText.call, textContent: parsedText.textContent };
        const content: ProviderContent[] = [];
        if (parsed.textContent) content.push({ type: "text", text: parsed.textContent });
        if (parsed.call) content.push(toolCallContent(parsed.call));
        if (!content.length) content.push({ type: "text", text: "" });
        return {
          content,
          finishReason: {
            unified: parsed.call ? "tool-calls" : "stop",
            raw: parsed.call ? "tool-calls" : "stop",
          },
          usage: providerUsage(result.usage.inputTokens, result.usage.outputTokens),
          request: { body: { messages: args.messages, ...args.generationOptions } },
          warnings: args.warnings as GenerateResult["warnings"],
        };
      } catch (error) {
        throw new Error(`TransformersJS generation failed: ${error instanceof Error ? error.message : textValue(error) || "Unknown error"}`);
      }
    },

    doStream(options): Promise<StreamResult> {
      const args = buildTransformersWorkerCallArgs(options, settings.isVisionModel === true);
      const allowedToolNames = args.functionTools.map((tool) => tool.name);

      const stream = new ReadableStream<StreamChunk>({
        async start(controller) {
          await enqueue(async () => {
            let textStarted = false;
            let accumulatedText = "";
            let suppressTextToolPlan = false;
            const textId = "text-0";

            const emitText = (delta: string): void => {
              if (!delta) return;
              if (!textStarted) {
                enqueueProviderChunk(controller, { type: "text-start", id: textId });
                textStarted = true;
              }
              enqueueProviderChunk(controller, { type: "text-delta", id: textId, delta });
            };

            enqueueProviderChunk(controller, { type: "stream-start", warnings: args.warnings });
            try {
              const result = await runWorkerGenerate(args, options.abortSignal, (delta) => {
                accumulatedText += delta;
                if (!suppressTextToolPlan && looksLikeTextToolPlan(accumulatedText)) {
                  suppressTextToolPlan = true;
                  return;
                }
                if (!suppressTextToolPlan) emitText(delta);
              });

              const workerCall = result.toolCalls[0] || null;
              const parsedText = firstToolCallFromText(result.text, allowedToolNames);
              const parsed = { call: workerCall || parsedText.call, textContent: parsedText.textContent };
              if (parsed.call) {
                if (!textStarted && parsed.textContent) emitText(parsed.textContent);
                emitToolCall(controller, parsed.call);
              } else if (suppressTextToolPlan && result.text) {
                emitText(result.text);
              }

              if (textStarted) enqueueProviderChunk(controller, { type: "text-end", id: textId });
              enqueueProviderChunk(controller, {
                type: "finish",
                finishReason: {
                  unified: parsed.call ? "tool-calls" : "stop",
                  raw: parsed.call ? "tool-calls" : "stop",
                },
                usage: providerUsage(result.usage.inputTokens, result.usage.outputTokens),
              });
              controller.close();
            } catch (error) {
              enqueueProviderChunk(controller, { type: "error", error });
              controller.close();
            }
          });
        },
        cancel() {
          try {
            worker.postMessage({ type: "interrupt" });
          } catch {
            // Ignore failed best-effort interrupt.
          }
        },
      });

      return Promise.resolve({
        stream,
        request: { body: { messages: args.messages, ...args.generationOptions } },
      });
    },
  };

  return model;
}
