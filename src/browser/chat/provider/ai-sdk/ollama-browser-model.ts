/**
 * Minimal Ollama chat model for the AI SDK browser bundle.
 *
 * The browser talks to the host Ollama HTTP API directly. This requires Ollama
 * to allow the page origin through CORS, e.g. OLLAMA_ORIGINS=http://localhost:8080.
 */

import type { LanguageModel } from "ai";
import { t } from "../../../app/i18n";
import { isRecord } from "../../../app/value-utils";

type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: "v4" }>;
type CallOptions = Parameters<LanguageModelV4["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<LanguageModelV4["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<LanguageModelV4["doStream"]>>;
type StreamChunk = StreamResult["stream"] extends ReadableStream<infer Chunk> ? Chunk : never;
type ProviderUsage = GenerateResult["usage"];
type ProviderContent = GenerateResult["content"][number];

type LocalNetworkRequestInit = RequestInit & {
  targetAddressSpace?: string;
};

export interface OllamaBrowserOptions {
  endpoint?: string;
  think?: boolean | "low" | "medium" | "high" | "max";
}

export type OllamaBrowserModel = LanguageModelV4 & {
  availability: () => Promise<"available">;
  createSessionWithProgress: (
    onProgress?: (event: { status: "ready"; model: string; progress: number }) => void,
  ) => Promise<OllamaBrowserModel>;
};

interface OllamaFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface OllamaToolCall {
  toolCallId: string;
  toolName: string;
  input: string;
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: unknown;
    };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface OllamaChatResponse {
  error?: unknown;
  done?: boolean;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  message?: {
    content?: unknown;
    thinking?: unknown;
    tool_calls?: unknown;
  };
}

function textValue(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}

function errorMessage(error: unknown): string {
  return textValue(error) || "Error";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeEndpoint(endpoint: unknown): string {
  return (textValue(endpoint) || "http://127.0.0.1:11434").replace(/\/+$/g, "");
}

function endpointAddressSpace(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "";
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]" || host.endsWith(".localhost")) return "loopback";
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return "loopback";
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return "";
  const [a, b] = parts;
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "private";
  return "";
}

function localNetworkFetchOptions(endpoint: string): LocalNetworkRequestInit {
  const addressSpace = endpointAddressSpace(endpoint);
  return addressSpace ? { targetAddressSpace: addressSpace } : {};
}

function asTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text") return textValue(part.text);
      if (part.type === "reasoning") return textValue(part.text);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseJsonMaybe(value: unknown, fallback: Record<string, unknown> = {}): unknown {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

function outputToText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (!isRecord(output)) return JSON.stringify(output);
  if (output.type === "text") return textValue(output.value);
  if (output.type === "json") return JSON.stringify(output.value ?? {});
  if (output.type === "content") return JSON.stringify(output.value ?? []);
  if (output.type === "error-text") return textValue(output.value);
  if (output.type === "error-json") return JSON.stringify(output.value ?? {});
  if (output.type === "execution-denied") return `execution denied: ${textValue(output.reason)}`.trim();
  return JSON.stringify(output);
}

function convertPromptToOllamaMessages(prompt: CallOptions["prompt"] = []): OllamaChatMessage[] {
  const messages: OllamaChatMessage[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      messages.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role === "user") {
      messages.push({ role: "user", content: asTextContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = [];
      for (const part of message.content) {
        if (part.type !== "tool-call") continue;
        toolCalls.push({
          id: part.toolCallId,
          type: "function" as const,
          function: {
            name: part.toolName,
            arguments: parseJsonMaybe(part.input),
          },
        });
      }
      messages.push({
        role: "assistant",
        content: asTextContent(message.content),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (message.role === "tool") {
      const toolResults = message.content
        .filter((part) => part.type === "tool-result")
        .map((part) => ({
          role: "tool" as const,
          tool_call_id: part.toolCallId,
          name: part.toolName,
          content: outputToText(part.output),
        }))
        .filter((part) => part.content);
      messages.push(...toolResults);
    }
  }
  return messages.filter((message) => message.content || message.tool_calls?.length);
}

function convertToolsToOllama(tools: CallOptions["tools"] = []): OllamaFunctionTool[] {
  const ollamaTools: OllamaFunctionTool[] = [];
  for (const item of tools || []) {
    if (!isRecord(item) || item.type !== "function") continue;
    const name = textValue(item.name);
    if (!name) continue;
    ollamaTools.push({
      type: "function",
      function: {
        name,
        description: textValue(item.description),
        parameters: item.inputSchema || { type: "object", properties: {} },
      },
    });
  }
  return ollamaTools;
}

function mapOllamaToolCall(call: unknown): OllamaToolCall {
  const callRecord = isRecord(call) ? call : {};
  const fn = isRecord(callRecord.function) ? callRecord.function : callRecord;
  const toolName = textValue(fn.name) || textValue(callRecord.name);
  const args = parseJsonMaybe(fn.arguments ?? callRecord.arguments);
  return {
    toolCallId: textValue(callRecord.id) || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    toolName,
    input: JSON.stringify(args || {}),
  };
}

function usageFromOllama(data: unknown): ProviderUsage {
  const record = isRecord(data) ? data : {};
  return {
    inputTokens: {
      total: numberValue(record.prompt_eval_count),
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: numberValue(record.eval_count),
      text: undefined,
      reasoning: undefined,
    },
  };
}

async function fetchJson<T>(endpoint: string, path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      ...options,
      ...localNetworkFetchOptions(endpoint),
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw new Error(`No se pudo conectar con Ollama en ${endpoint}. Revisa que esté arrancado y permita CORS para este origen. Detalle: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama respondió HTTP ${response.status}: ${text || response.statusText}`);
  }
  return await response.json() as T;
}

interface CallChatOptions {
  prompt: CallOptions["prompt"];
  tools?: CallOptions["tools"];
  maxOutputTokens?: CallOptions["maxOutputTokens"];
  temperature?: CallOptions["temperature"];
  topP?: CallOptions["topP"];
  abortSignal?: CallOptions["abortSignal"];
  stream: boolean;
}

interface CallChatResult {
  response: Response;
  requestBody: Record<string, unknown>;
}

function enqueueProviderChunk(
  controller: ReadableStreamDefaultController<StreamChunk>,
  chunk: StreamChunk,
): void {
  controller.enqueue(chunk);
}

function asOllamaChatResponse(value: unknown): OllamaChatResponse {
  return isRecord(value) ? value : {};
}

function ollamaToolCalls(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function ollamaBrowser(modelId: string, options: OllamaBrowserOptions = {}): OllamaBrowserModel {
  const endpoint = normalizeEndpoint(options.endpoint);
  const think = typeof options.think === "boolean" || ["low", "medium", "high", "max"].includes(String(options.think))
    ? options.think
    : undefined;

  async function assertAvailable(): Promise<void> {
    const tags = await fetchJson<{ models?: Array<{ name?: string; model?: string }> }>(endpoint, "/api/tags", {
      method: "GET",
      headers: {},
    });
    const models = Array.isArray(tags.models) ? tags.models : [];
    const exists = models.some((item) => item.name === modelId || item.model === modelId);
    if (!exists) {
      throw new Error(`Ollama está activo, pero no tiene el modelo "${modelId}". Ejecuta en el host: ollama pull ${modelId}`);
    }
  }

  async function callChat({
    prompt,
    tools,
    maxOutputTokens,
    temperature,
    topP,
    abortSignal,
    stream,
  }: CallChatOptions): Promise<CallChatResult> {
    const ollamaTools = convertToolsToOllama(tools);
    const requestBody: Record<string, unknown> = {
      model: modelId,
      messages: convertPromptToOllamaMessages(prompt),
      stream,
      ...(think !== undefined ? { think } : {}),
      options: {
        ...(Number.isFinite(maxOutputTokens) ? { num_predict: maxOutputTokens } : {}),
        ...(temperature != null ? { temperature } : {}),
        ...(topP != null ? { top_p: topP } : {}),
      },
      ...(ollamaTools.length ? { tools: ollamaTools } : {}),
    };

    let response: Response;
    try {
      response = await fetch(`${endpoint}/api/chat`, {
        method: "POST",
        ...localNetworkFetchOptions(endpoint),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });
    } catch (error) {
      throw new Error(`No se pudo llamar a Ollama en ${endpoint}. Si es CORS, arranca Ollama con OLLAMA_ORIGINS incluyendo este origen. Detalle: ${errorMessage(error)}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Ollama /api/chat HTTP ${response.status}: ${text || response.statusText}`);
    }
    return { response, requestBody };
  }

  const model: OllamaBrowserModel = {
    specificationVersion: "v4",
    provider: "ollama-browser",
    modelId,
    supportedUrls: {},

    async availability() {
      await assertAvailable();
      return "available";
    },

    async createSessionWithProgress(onProgress) {
      onProgress?.({ status: "ready", model: modelId, progress: 1 });
      await assertAvailable();
      return model;
    },

    async doGenerate(options2): Promise<GenerateResult> {
      const { response, requestBody } = await callChat({ ...options2, stream: false });
      const data = asOllamaChatResponse(await response.json());
      if (data.error) throw new Error(errorMessage(data.error));

      const content: ProviderContent[] = [];
      const thinking = textValue(data.message?.thinking);
      if (thinking) content.push({ type: "reasoning", text: thinking });
      const text = textValue(data.message?.content);
      if (text) content.push({ type: "text", text });

      const toolCalls = ollamaToolCalls(data.message?.tool_calls).map(mapOllamaToolCall);
      for (const call of toolCalls) {
        content.push({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
          providerExecuted: false,
        });
      }
      if (!content.length) content.push({ type: "text", text: "" });
      return {
        content,
        finishReason: {
          unified: toolCalls.length ? "tool-calls" : "stop",
          raw: textValue(data.done_reason) || (toolCalls.length ? "tool-calls" : "stop"),
        },
        usage: usageFromOllama(data),
        request: { body: requestBody },
        warnings: [],
      };
    },

    async doStream(options2): Promise<StreamResult> {
      const { response, requestBody } = await callChat({ ...options2, stream: true });
      const stream = new ReadableStream<StreamChunk>({
        async start(controller) {
          enqueueProviderChunk(controller, { type: "stream-start", warnings: [] });
          const reader = response.body?.getReader();
          if (!reader) {
            enqueueProviderChunk(controller, { type: "error", error: new Error(t("chat.error.ollamaNoStream")) });
            controller.close();
            return;
          }

          const decoder = new TextDecoder();
          let buffer = "";
          let textStarted = false;
          let reasoningStarted = false;
          let lastDone: unknown = {};
          const textId = "text-0";
          const reasoningId = "reasoning-0";
          const toolCalls: OllamaToolCall[] = [];

          const emitText = (delta: string): void => {
            if (!delta) return;
            if (!textStarted) {
              enqueueProviderChunk(controller, { type: "text-start", id: textId });
              textStarted = true;
            }
            enqueueProviderChunk(controller, { type: "text-delta", id: textId, delta });
          };

          const emitReasoning = (delta: string): void => {
            if (!delta) return;
            if (!reasoningStarted) {
              enqueueProviderChunk(controller, { type: "reasoning-start", id: reasoningId });
              reasoningStarted = true;
            }
            enqueueProviderChunk(controller, { type: "reasoning-delta", id: reasoningId, delta });
          };

          const processLine = (line: string): void => {
            if (!line.trim()) return;
            const data = asOllamaChatResponse(JSON.parse(line) as unknown);
            if (data.error) throw new Error(errorMessage(data.error));
            const thinkingDelta = textValue(data.message?.thinking);
            if (thinkingDelta) emitReasoning(thinkingDelta);
            const delta = textValue(data.message?.content);
            if (delta) emitText(delta);
            for (const call of ollamaToolCalls(data.message?.tool_calls)) {
              toolCalls.push(mapOllamaToolCall(call));
            }
            if (data.done) lastDone = data;
          };

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split(/\r?\n/);
              buffer = lines.pop() || "";
              for (const line of lines) processLine(line);
            }
            buffer += decoder.decode();
            if (buffer.trim()) processLine(buffer);

            if (reasoningStarted) enqueueProviderChunk(controller, { type: "reasoning-end", id: reasoningId });
            if (textStarted) enqueueProviderChunk(controller, { type: "text-end", id: textId });
            for (const toolCall of toolCalls) {
              enqueueProviderChunk(controller, { type: "tool-input-start", id: toolCall.toolCallId, toolName: toolCall.toolName });
              enqueueProviderChunk(controller, { type: "tool-input-delta", id: toolCall.toolCallId, delta: toolCall.input });
              enqueueProviderChunk(controller, { type: "tool-input-end", id: toolCall.toolCallId });
              enqueueProviderChunk(controller, {
                type: "tool-call",
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                input: toolCall.input,
                providerExecuted: false,
              });
            }
            const hasToolCalls = toolCalls.length > 0;
            const doneRecord = asOllamaChatResponse(lastDone);
            enqueueProviderChunk(controller, {
              type: "finish",
              finishReason: {
                unified: hasToolCalls ? "tool-calls" : "stop",
                raw: textValue(doneRecord.done_reason) || (hasToolCalls ? "tool-calls" : "stop"),
              },
              usage: usageFromOllama(doneRecord),
            });
            controller.close();
          } catch (error) {
            enqueueProviderChunk(controller, { type: "error", error });
            controller.close();
          }
        },
      });
      return { stream, request: { body: requestBody } };
    },
  };

  return model;
}
