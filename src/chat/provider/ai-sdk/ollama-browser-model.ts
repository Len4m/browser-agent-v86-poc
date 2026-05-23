// @ts-nocheck
/**
 * Minimal Ollama chat model for the AI SDK browser bundle.
 *
 * The browser talks to the host Ollama HTTP API directly. This requires Ollama
 * to allow the page origin through CORS, e.g. OLLAMA_ORIGINS=http://localhost:8080.
 */

function normalizeEndpoint(endpoint) {
  return String(endpoint || "http://127.0.0.1:11434").replace(/\/+$/g, "");
}

function endpointAddressSpace(endpoint) {
  let url;
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

function localNetworkFetchOptions(endpoint) {
  const addressSpace = endpointAddressSpace(endpoint);
  return addressSpace ? { targetAddressSpace: addressSpace } : {};
}

function asTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part?.type === "text") return part.text || "";
      if (part?.type === "reasoning") return part.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseJsonMaybe(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function outputToText(output) {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (output.type === "text") return String(output.value || "");
  if (output.type === "json") return JSON.stringify(output.value ?? {});
  if (output.type === "content") return JSON.stringify(output.value ?? []);
  if (output.type === "error-text") return String(output.value || "");
  if (output.type === "error-json") return JSON.stringify(output.value ?? {});
  if (output.type === "execution-denied") return `execution denied: ${output.reason || ""}`.trim();
  return JSON.stringify(output);
}

function convertPromptToOllamaMessages(prompt = []) {
  const messages = [];
  for (const message of prompt || []) {
    if (message.role === "system") {
      messages.push({ role: "system", content: String(message.content || "") });
      continue;
    }
    if (message.role === "user") {
      messages.push({ role: "user", content: asTextContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = [];
      const contentParts = Array.isArray(message.content) ? message.content : [];
      for (const part of contentParts) {
        if (part?.type !== "tool-call") continue;
        toolCalls.push({
          id: part.toolCallId,
          type: "function",
          function: {
            name: sanitizeToolName(part.toolName),
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
      const toolResults = (message.content || [])
        .filter((part) => part?.type === "tool-result")
        .map((part) => ({
          role: "tool",
          tool_call_id: part.toolCallId,
          name: sanitizeToolName(part.toolName),
          content: outputToText(part.output),
        }))
        .filter((part) => part.content);
      messages.push(...toolResults);
    }
  }
  return messages.filter((message) => message.content || message.tool_calls?.length);
}

function sanitizeToolName(name) {
  return String(name || "").replace(/[^A-Za-z0-9_-]/g, "__");
}

function convertToolsToOllama(tools = []) {
  const nameMap = new Map();
  const ollamaTools = [];
  for (const item of tools || []) {
    if (item?.type !== "function") continue;
    const safeName = sanitizeToolName(item.name);
    nameMap.set(safeName, item.name);
    ollamaTools.push({
      type: "function",
      function: {
        name: safeName,
        description: [
          item.description || "",
          item.name !== safeName ? `Original Browser Agent tool name: ${item.name}.` : "",
        ].filter(Boolean).join(" "),
        parameters: item.inputSchema || { type: "object", properties: {} },
      },
    });
  }
  return { tools: ollamaTools, nameMap };
}

function mapOllamaToolCall(call, nameMap) {
  const fn = call?.function || call;
  const rawName = fn?.name || call?.name || "";
  const toolName = nameMap.get(rawName) || rawName;
  const args = parseJsonMaybe(fn?.arguments ?? call?.arguments);
  return {
    toolCallId: call?.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    toolName,
    input: JSON.stringify(args || {}),
  };
}

function usageFromOllama(data) {
  return {
    inputTokens: {
      total: data?.prompt_eval_count,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: data?.eval_count,
      text: undefined,
      reasoning: undefined,
    },
  };
}

async function fetchJson(endpoint, path, options = {}) {
  let response;
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
    throw new Error(`No se pudo conectar con Ollama en ${endpoint}. Revisa que esté arrancado y permita CORS para este origen. Detalle: ${error?.message || error}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama respondió HTTP ${response.status}: ${text || response.statusText}`);
  }
  return response.json();
}

export function ollamaBrowser(modelId, options = {}) {
  const endpoint = normalizeEndpoint(options.endpoint);
  const think = typeof options.think === "boolean" ? options.think : undefined;

  async function assertAvailable() {
    const tags = await fetchJson(endpoint, "/api/tags", { method: "GET", headers: {} });
    const models = Array.isArray(tags?.models) ? tags.models : [];
    const exists = models.some((item) => item?.name === modelId || item?.model === modelId);
    if (!exists) {
      throw new Error(`Ollama está activo, pero no tiene el modelo "${modelId}". Ejecuta en el host: ollama pull ${modelId}`);
    }
  }

  async function callChat({ prompt, tools, maxOutputTokens, temperature, topP, abortSignal, stream }) {
    const { tools: ollamaTools, nameMap } = convertToolsToOllama(tools);
    const body = {
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

    let response;
    try {
      response = await fetch(`${endpoint}/api/chat`, {
        method: "POST",
        ...localNetworkFetchOptions(endpoint),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: abortSignal,
      });
    } catch (error) {
      throw new Error(`No se pudo llamar a Ollama en ${endpoint}. Si es CORS, arranca Ollama con OLLAMA_ORIGINS incluyendo este origen. Detalle: ${error?.message || error}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Ollama /api/chat HTTP ${response.status}: ${text || response.statusText}`);
    }
    return { response, nameMap, requestBody: body };
  }

  return {
    specificationVersion: "v3",
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
      return this;
    },

    async doGenerate(options2) {
      const { response, nameMap, requestBody } = await callChat({ ...options2, stream: false });
      const data = await response.json();
      if (data?.error) throw new Error(String(data.error));
      const content = [];
      const thinking = data?.message?.thinking || "";
      if (thinking) content.push({ type: "reasoning", text: thinking });
      const text = data?.message?.content || "";
      if (text) content.push({ type: "text", text });
      const toolCalls = (data?.message?.tool_calls || []).map((call) => mapOllamaToolCall(call, nameMap));
      for (const call of toolCalls.slice(0, 1)) {
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
          raw: data?.done_reason || (toolCalls.length ? "tool-calls" : "stop"),
        },
        usage: usageFromOllama(data),
        request: { body: requestBody },
        warnings: [],
      };
    },

    async doStream(options2) {
      const { response, nameMap, requestBody } = await callChat({ ...options2, stream: true });
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          const reader = response.body?.getReader();
          if (!reader) {
            controller.enqueue({ type: "error", error: new Error("Ollama no devolvió stream de respuesta.") });
            controller.close();
            return;
          }

          const decoder = new TextDecoder();
          let buffer = "";
          let textStarted = false;
          let reasoningStarted = false;
          let lastDone = {};
          const textId = "text-0";
          const reasoningId = "reasoning-0";
          const toolCalls = [];

          const emitText = (delta) => {
            if (!delta) return;
            if (!textStarted) {
              controller.enqueue({ type: "text-start", id: textId });
              textStarted = true;
            }
            controller.enqueue({ type: "text-delta", id: textId, delta });
          };

          const emitReasoning = (delta) => {
            if (!delta) return;
            if (!reasoningStarted) {
              controller.enqueue({ type: "reasoning-start", id: reasoningId });
              reasoningStarted = true;
            }
            controller.enqueue({ type: "reasoning-delta", id: reasoningId, delta });
          };

          const processLine = (line) => {
            if (!line.trim()) return;
            const data = JSON.parse(line);
            if (data.error) throw new Error(String(data.error));
            const thinkingDelta = data?.message?.thinking || "";
            if (thinkingDelta) emitReasoning(thinkingDelta);
            const delta = data?.message?.content || "";
            if (delta) emitText(delta);
            for (const call of data?.message?.tool_calls || []) {
              toolCalls.push(mapOllamaToolCall(call, nameMap));
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

            if (reasoningStarted) controller.enqueue({ type: "reasoning-end", id: reasoningId });
            if (textStarted) controller.enqueue({ type: "text-end", id: textId });
            const firstToolCall = toolCalls[0];
            if (firstToolCall) {
              controller.enqueue({ type: "tool-input-start", id: firstToolCall.toolCallId, toolName: firstToolCall.toolName });
              controller.enqueue({ type: "tool-input-delta", id: firstToolCall.toolCallId, delta: firstToolCall.input });
              controller.enqueue({ type: "tool-input-end", id: firstToolCall.toolCallId });
              controller.enqueue({
                type: "tool-call",
                toolCallId: firstToolCall.toolCallId,
                toolName: firstToolCall.toolName,
                input: firstToolCall.input,
                providerExecuted: false,
              });
            }
            controller.enqueue({
              type: "finish",
              finishReason: {
                unified: firstToolCall ? "tool-calls" : "stop",
                raw: lastDone?.done_reason || (firstToolCall ? "tool-calls" : "stop"),
              },
              usage: usageFromOllama(lastDone),
            });
            controller.close();
          } catch (error) {
            controller.enqueue({ type: "error", error });
            controller.close();
          }
        },
      });
      return { stream, request: { body: requestBody } };
    },
  };
}
