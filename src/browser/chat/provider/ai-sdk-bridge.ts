// @ts-nocheck
// Browser Agent v86 - AI SDK bridge (ESM)
// Carga el bundle generado de chat y expone window.BA_AISDK.
// El loop de agente (tools + multi-step) vive en runAgentStreamTurn (AI SDK).

import {
  streamText,
  tool,
  stepCountIs,
  ToolLoopAgent,
  convertToModelMessages,
  wrapLanguageModel,
  extractReasoningMiddleware,
  transformersJS,
  doesBrowserSupportTransformersJS,
  ollamaBrowser,
  z,
  runAgentStreamTurn,
  textChunkFromStreamPart,
  reasoningChunkFromStreamPart,
  transformersTextToolMiddleware,
} from "./chat/ai-sdk-browser.mjs?v=0.2.2-tools-ui3";

let workerUrl = null;
let activeWorker = null;
let activeModelHandle = null;
let activeAbortController = null;

function mapDtype(dtype) {
  const value = String(dtype || "q4").toLowerCase();
  if (["auto", "fp32", "fp16", "q8", "q4", "q4f16"].includes(value)) return value;
  return "q4";
}

function terminateActiveWorker() {
  if (!activeWorker) return;
  try {
    activeWorker.terminate();
  } catch {
    // ignore
  }
  activeWorker = null;
}

function createWorker() {
  terminateActiveWorker();
  if (!workerUrl) {
    workerUrl = new URL("./chat/workers/llm-browser-ai.worker.mjs", import.meta.url);
  }
  activeWorker = new Worker(workerUrl, { type: "module" });
  return activeWorker;
}

function shouldUseReasoningMiddleware(modelConfig) {
  const thinking = modelConfig?.thinking;
  if (!thinking?.enabled || !thinking?.tagName) return false;
  // Ollama expone message.thinking como reasoning-delta cuando el modelo lo devuelve.
  // El middleware por tags solo aplica a texto generado por Transformers.js.
  if (modelConfig.engine === "ollama") return false;
  return true;
}

function wrapAgentModel(baseModel, modelConfig) {
  const engine = modelConfig?.engine || "transformersjs";
  const toolCalling = modelConfig?.agent?.toolCalling || "fair";
  const parseTextTools = engine === "transformersjs" && (toolCalling === "weak" || toolCalling === "fair");
  const thinking = modelConfig?.thinking;
  let model = baseModel;
  if (shouldUseReasoningMiddleware(modelConfig)) {
    model = wrapLanguageModel({
      model,
      middleware: extractReasoningMiddleware({
        tagName: thinking.tagName,
        startWithReasoning: Boolean(thinking.startWithReasoning),
      }),
    });
  }
  model = wrapLanguageModel({
    model,
    middleware: transformersTextToolMiddleware({
      stripToolChoice: engine === "transformersjs",
      parseTextTools,
    }),
  });
  return model;
}

function resolveOllamaEndpoint(modelConfig) {
  return String(
    window.localStorage?.getItem("ba.llm.ollama.endpoint")
      || "http://127.0.0.1:11434",
  ).replace(/\/+$/g, "");
}

async function createModel(modelConfig) {
  if (!modelConfig?.model) throw new Error("Modelo no configurado.");

  let base;
  let runtime;
  if (modelConfig.engine === "ollama") {
    terminateActiveWorker();
    base = ollamaBrowser(modelConfig.model, {
      endpoint: resolveOllamaEndpoint(modelConfig),
      think: modelConfig.ollamaThink,
    });
    runtime = {
      provider: "ollama",
      device: "remote",
      dtype: "host",
      endpoint: resolveOllamaEndpoint(modelConfig),
      worker: false,
    };
  } else {
    const device = modelConfig.device || "webgpu";
    const dtype = mapDtype(modelConfig.dtype);
    base = transformersJS(modelConfig.model, {
      device,
      dtype,
      worker: createWorker(),
    });
    runtime = {
      provider: "transformersjs",
      device,
      dtype,
      worker: true,
      fallback: Boolean(modelConfig.fallbackReason),
    };
  }

  const activeConfig = {
    ...modelConfig,
    runtime,
  };
  const model = wrapAgentModel(base, activeConfig);
  activeModelHandle = { base, model, modelConfig: activeConfig };
  return model;
}

function buildWasmFallbackConfig(modelConfig) {
  if ((modelConfig?.engine || "transformersjs") !== "transformersjs") return null;
  if ((modelConfig.device || "webgpu") !== "webgpu") return null;
  return {
    ...modelConfig,
    id: `${modelConfig.id || "custom-transformersjs"}-wasm-fallback`,
    device: "wasm",
    dtype: modelConfig.wasmDtype || "auto",
    fallbackFrom: modelConfig.id || modelConfig.model,
    fallbackReason: "webgpu-runtime-failure",
    shortLabel: modelConfig.shortLabel || modelConfig.label || modelConfig.model,
    compatibilityLabel: "alternativa WASM tras fallo WebGPU",
  };
}

async function loadModel(modelConfig, { onProgress } = {}) {
  async function loadWithConfig(config) {
    const model = await createModel(config);
    // wrapLanguageModel solo envuelve doGenerate/doStream; sesión y descarga viven en el modelo base.
    const sessionModel = activeModelHandle?.base || model;
    const availability = await sessionModel.availability?.();

    if (availability === "unavailable") {
      throw new Error(config.engine === "ollama"
        ? t("chat.error.ollamaUnavailable")
        : t("chat.error.transformersUnavailable"));
    }

    if (availability === "downloadable" || availability !== "available") {
      await sessionModel.createSessionWithProgress((progress) => {
        onProgress?.({
          status: "progress",
          progress,
          file: config.model,
          model: config.model,
        });
      });
    }

    return model;
  }

  try {
    return await loadWithConfig(modelConfig);
  } catch (error) {
    const msg = error?.message || String(error);
    const fallbackConfig = isGpuInferenceFailure(msg) ? buildWasmFallbackConfig(modelConfig) : null;
    if (!fallbackConfig) {
      unloadModel();
      throw error;
    }

    onProgress?.({
      status: "fallback",
      progress: 0,
      file: fallbackConfig.model,
      model: fallbackConfig.model,
      reason: msg,
      fallbackDevice: fallbackConfig.device,
      fallbackDtype: fallbackConfig.dtype,
    });

    terminateActiveWorker();
    activeModelHandle = null;
    try {
      const model = await loadWithConfig(fallbackConfig);
      if (typeof console !== "undefined" && console.info) {
        console.info("[BA_LLM] WebGPU load failed; active session uses WASM fallback.", {
          model: fallbackConfig.model,
          device: fallbackConfig.device,
          dtype: fallbackConfig.dtype,
          fallbackFrom: fallbackConfig.fallbackFrom,
          webgpuError: msg,
        });
      }
      return model;
    } catch (fallbackError) {
      unloadModel();
      throw new Error([
        `Transformers.js WebGPU falló y la alternativa WASM tampoco pudo cargar el modelo.`,
        `WebGPU: ${msg}`,
        `WASM: ${fallbackError?.message || String(fallbackError)}`,
      ].join("\n"));
    }
  }
}

function unloadModel() {
  activeAbortController?.abort();
  activeAbortController = null;
  activeModelHandle = null;
  terminateActiveWorker();
}

function getActiveModel() {
  return activeModelHandle?.model || null;
}

function getActiveModelConfig() {
  return activeModelHandle?.modelConfig || null;
}

function isModelReady() {
  return Boolean(activeModelHandle?.model);
}

/** Core messages { role, content } from BA_LLM_CONTEXT — not UIMessage parts. */
function toCoreMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((msg) => msg && typeof msg.content === "string")
    .map((msg) => ({
      role: msg.role === "assistant" || msg.role === "system" ? msg.role : "user",
      content: String(msg.content),
    }));
}

/** AI SDK v6: system vía opción `system`, no role:system en messages. */
function splitPromptForStream(messages, explicitSystem) {
  if (explicitSystem != null && String(explicitSystem).trim()) {
    return {
      system: String(explicitSystem),
      messages: toCoreMessages(messages).filter((msg) => msg.role !== "system"),
    };
  }
  const core = toCoreMessages(messages);
  const systemParts = [];
  const chatMessages = [];
  for (const msg of core) {
    if (msg.role === "system") systemParts.push(msg.content);
    else chatMessages.push(msg);
  }
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: chatMessages,
  };
}

function isNonFallbackLoadFailure(message) {
  return /fetch|network|timeout|abort(ed)?|404|403|failed to fetch|download|indexeddb|quota|enotfound|connection refused|unexpected token|json\.parse|modelo no configurado|unavailable/i.test(String(message || ""));
}

function isGpuInferenceFailure(message) {
  const msg = String(message || "");
  if (isNonFallbackLoadFailure(msg)) return false;
  // No usar RuntimeError: genérico — provoca fallback WASM en fallos de descarga/init transitorios.
  return /out of device memory|VK_ERROR_OUT_OF_DEVICE_MEMORY|WebGPU validation failed|Invalid Buffer|Device lost|failed to call OrtRun|CreateBuffer|null function|function signature mismatch|unaligned accesses|Instance reference no longer exists|memoria GPU agotada|WebGPU inválido|shader[- ]?f16|f16 not supported/i.test(msg);
}

function abortActive() {
  activeAbortController?.abort();
  activeAbortController = null;
}

window.BA_AISDK = {
  streamText,
  tool,
  stepCountIs,
  ToolLoopAgent,
  toCoreMessages,
  splitPromptForStream,
  convertToModelMessages,
  wrapLanguageModel,
  extractReasoningMiddleware,
  transformersJS,
  doesBrowserSupportTransformersJS,
  ollamaBrowser,
  z,
  createModel,
  loadModel,
  unloadModel,
  getActiveModel,
  getActiveModelConfig,
  isModelReady,
  runAgentStreamTurn,
  textChunkFromStreamPart,
  reasoningChunkFromStreamPart,
  abortActive,
};

window.BA_AISDK_READY = Promise.resolve(true);
