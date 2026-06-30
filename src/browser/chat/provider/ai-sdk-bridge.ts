// Browser Agent v86 - AI SDK bridge (ESM)
// Carga el bundle generado de chat y exporta una API ESM para el runtime LLM.
// El loop de agente (tools + multi-step) vive en runAgentStreamTurn (AI SDK).

import type { LanguageModel } from "ai";
import { initI18n, t } from "../../app/i18n";
import type { LlmModelConfig } from "../state/chat-state";
import type { AiSdkBridgeApi, AiSdkRunAgentStreamTurnOptions, AiSdkRunAgentStreamTurnResult, AiSdkToolConfig } from "./ai-sdk-runtime";
import {
  tool,
  wrapLanguageModel,
  extractReasoningMiddleware,
  transformersWorker,
  ollamaBrowser,
  z,
  runAgentStreamTurn,
  textChunkFromStreamPart,
  reasoningChunkFromStreamPart,
  transformersTextToolMiddleware,
} from "./chat/ai-sdk-browser.mjs";

type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: "v3" }>;

type BrowserSessionLanguageModel = LanguageModelV3 & {
  availability?: () => Promise<string>;
  createSessionWithProgress?: (onProgress?: (progress: unknown) => void) => Promise<unknown>;
};

interface ActiveModelHandle {
  base: BrowserSessionLanguageModel;
  model: LanguageModelV3;
  modelConfig: LlmModelConfig;
}

interface LoadModelOptions {
  onProgress?: (detail: Record<string, unknown>) => void;
}

void initI18n();

let workerUrl: URL | null = null;
let activeWorker: Worker | null = null;
let activeModelHandle: ActiveModelHandle | null = null;
let activeAbortController: AbortController | null = null;

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}

function messageText(value: unknown): string {
  if (value instanceof Error) return value.message;
  return textValue(value);
}

function mapDtype(dtype: unknown): string {
  const value = (textValue(dtype) || "auto").toLowerCase();
  if (["auto", "fp32", "fp16", "q8", "q4", "q4f16"].includes(value)) return value;
  return "auto";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: typeof error.stack === "string" ? error.stack.slice(0, 1600) : "",
    };
  }
  return {
    name: typeof error,
    message: errorMessage(error),
  };
}

function emitDiagnostic(message: string, data: Record<string, unknown> = {}): void {
  const detail = {
    source: "ai-sdk-bridge",
    message,
    ...data,
  };
  try {
    window.dispatchEvent(new CustomEvent("ba:llm-diagnostic", { detail }));
  } catch {
    // Diagnostics are best-effort and must not affect inference.
  }
  try {
    const log = message.includes("error") || message.includes("unhandled") ? console.warn : console.debug;
    log.call(console, "[llm:diagnostic]", detail);
  } catch {
    // ignore
  }
}

function terminateActiveWorker(): void {
  if (!activeWorker) return;
  try {
    activeWorker.terminate();
  } catch {
    // ignore
  }
  activeWorker = null;
}

function forwardWorkerDiagnostic(value: unknown): void {
  if (!isRecord(value) || value.status !== "diagnostic") return;
  emitDiagnostic(textValue(value.event) || "worker diagnostic", {
    source: textValue(value.source) || "llm-browser-ai.worker",
    data: isRecord(value.data) ? value.data : undefined,
  });
}

function createWorker({ disposeGenerationCacheBeforeGenerate = false }: { disposeGenerationCacheBeforeGenerate?: boolean } = {}): Worker {
  terminateActiveWorker();
  if (!workerUrl) {
    workerUrl = new URL("./chat/workers/llm-browser-ai.worker.mjs", import.meta.url);
  }
  const url = new URL(workerUrl.href);
  if (disposeGenerationCacheBeforeGenerate) {
    url.searchParams.set("disposeGenerationCacheBeforeGenerate", "1");
  }
  activeWorker = new Worker(url, { type: "module" });
  activeWorker.addEventListener("message", (event) => {
    forwardWorkerDiagnostic(event.data);
  });
  activeWorker.addEventListener("error", (event) => {
    emitDiagnostic("worker error event", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: errorDetails(event.error),
    });
  });
  activeWorker.addEventListener("messageerror", (event) => {
    emitDiagnostic("worker messageerror", {
      dataType: typeof event.data,
    });
  });
  return activeWorker;
}

function shouldUseReasoningMiddleware(modelConfig: LlmModelConfig): boolean {
  const thinking = modelConfig?.thinking;
  if (!thinking?.enabled || !thinking?.tagName) return false;
  // Ollama expone message.thinking como reasoning-delta cuando el modelo lo devuelve.
  // El middleware por tags solo aplica a texto generado por Transformers.js.
  if (modelConfig.engine === "ollama") return false;
  return true;
}

function wrapAgentModel(baseModel: LanguageModelV3, modelConfig: LlmModelConfig): LanguageModelV3 {
  const engine = modelConfig?.engine || "transformersjs";
  const toolCalling = modelConfig?.agent?.toolCalling || "fair";
  const parseTextTools = engine === "transformersjs" && (toolCalling === "weak" || toolCalling === "fair");
  const thinking = modelConfig?.thinking;
  let model = baseModel;
  if (shouldUseReasoningMiddleware(modelConfig) && thinking?.tagName) {
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

function resolveOllamaEndpoint(): string {
  return String(
    window.localStorage?.getItem("ba.llm.ollama.endpoint")
      || "http://127.0.0.1:11434",
  ).replace(/\/+$/g, "");
}

function createModel(modelConfig: LlmModelConfig): LanguageModelV3 {
  if (!modelConfig?.model) throw new Error("Modelo no configurado.");

  let base: BrowserSessionLanguageModel;
  let runtime: NonNullable<LlmModelConfig["runtime"]>;
  if (modelConfig.engine === "ollama") {
    terminateActiveWorker();
    base = ollamaBrowser(modelConfig.model, {
      endpoint: resolveOllamaEndpoint(),
      think: typeof modelConfig.ollamaThink === "boolean" ? modelConfig.ollamaThink : undefined,
    });
    runtime = {
      provider: "ollama",
      device: "remote",
      dtype: "host",
      endpoint: resolveOllamaEndpoint(),
      worker: false,
    };
  } else {
    const device = modelConfig.device || "webgpu";
    const dtype = mapDtype(modelConfig.dtype);
    const disposeGenerationCacheBeforeGenerate = device === "webgpu" && modelConfig.reuseGenerationCache !== true;
    base = transformersWorker(modelConfig.model, {
      device,
      dtype,
      worker: createWorker({ disposeGenerationCacheBeforeGenerate }),
    });
    runtime = {
      provider: "transformersjs",
      device,
      dtype,
      worker: true,
      fallback: Boolean(modelConfig.fallbackReason),
      disposeGenerationCacheBeforeGenerate,
    };
  }

  const activeConfig: LlmModelConfig = {
    ...modelConfig,
    runtime,
  };
  const model = wrapAgentModel(base, activeConfig);
  activeModelHandle = { base, model, modelConfig: activeConfig };
  return model;
}

function buildWasmFallbackConfig(modelConfig: LlmModelConfig): LlmModelConfig | null {
  if ((modelConfig?.engine || "transformersjs") !== "transformersjs") return null;
  if ((modelConfig.device || "webgpu") !== "webgpu") return null;
  return {
    ...modelConfig,
    id: `${modelConfig.id || "custom-transformersjs"}-wasm-fallback`,
    device: "wasm",
    dtype: typeof modelConfig.wasmDtype === "string" ? modelConfig.wasmDtype : "auto",
    fallbackFrom: modelConfig.id || modelConfig.model,
    fallbackReason: "webgpu-runtime-failure",
  };
}

async function loadModel(modelConfig: LlmModelConfig, { onProgress }: LoadModelOptions = {}): Promise<LanguageModelV3> {
  async function loadWithConfig(config: LlmModelConfig): Promise<LanguageModelV3> {
    const model = createModel(config);
    // wrapLanguageModel solo envuelve doGenerate/doStream; sesión y descarga viven en el modelo base.
    const sessionModel = activeModelHandle?.base;
    const availability = await sessionModel?.availability?.();

    if (availability === "unavailable") {
      throw new Error(config.engine === "ollama"
        ? t("chat.error.ollamaUnavailable")
        : t("chat.error.transformersUnavailable"));
    }

    if (availability === "downloadable" || availability !== "available") {
      await sessionModel?.createSessionWithProgress?.((progress: unknown) => {
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
    const msg = errorMessage(error);
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
        console.info("[llm] WebGPU load failed; active session uses WASM fallback.", {
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
        `WASM: ${errorMessage(fallbackError)}`,
      ].join("\n"));
    }
  }
}

function unloadModel(): void {
  activeAbortController?.abort();
  activeAbortController = null;
  activeModelHandle = null;
  terminateActiveWorker();
}

function getActiveModel(): LanguageModelV3 | null {
  return activeModelHandle?.model || null;
}

function getActiveModelConfig(): LlmModelConfig | null {
  return activeModelHandle?.modelConfig || null;
}

function isModelReady(): boolean {
  return Boolean(activeModelHandle?.model);
}

function isNonFallbackLoadFailure(message: unknown): boolean {
  return /fetch|network|timeout|abort(ed)?|404|403|failed to fetch|download|indexeddb|quota|enotfound|connection refused|unexpected token|json\.parse|modelo no configurado|unavailable/i.test(messageText(message));
}

function isGpuInferenceFailure(message: unknown): boolean {
  const msg = messageText(message);
  if (isNonFallbackLoadFailure(msg)) return false;
  // No usar RuntimeError: genérico — provoca fallback WASM en fallos de descarga/init transitorios.
  return /out of device memory|VK_ERROR_OUT_OF_DEVICE_MEMORY|WebGPU validation failed|Invalid Buffer|Device lost|failed to call OrtRun|CreateBuffer|null function|function signature mismatch|unaligned accesses|Instance reference no longer exists|memoria GPU agotada|WebGPU inválido|shader[- ]?f16|f16 not supported/i.test(msg);
}

function abortActive(): void {
  activeAbortController?.abort();
  activeAbortController = null;
}

function createAiSdkTool(config: AiSdkToolConfig): unknown {
  return tool(config as unknown as Parameters<typeof tool>[0]);
}

async function loadBridgeModel(modelConfig: LlmModelConfig, options?: LoadModelOptions): Promise<void> {
  await loadModel(modelConfig, options);
}

async function runBridgeAgentStreamTurn(options: AiSdkRunAgentStreamTurnOptions): Promise<AiSdkRunAgentStreamTurnResult> {
  const output = await runAgentStreamTurn(options as unknown as Parameters<typeof runAgentStreamTurn>[0]);
  return {
    text: output.text,
    finishReason: output.finishReason,
    hadToolWork: output.hadToolWork,
  };
}

export const aiSdkApi = {
  tool: createAiSdkTool,
  z: z as unknown as AiSdkBridgeApi["z"],
  loadModel: loadBridgeModel,
  unloadModel,
  getActiveModel,
  getActiveModelConfig,
  isModelReady,
  runAgentStreamTurn: runBridgeAgentStreamTurn,
  textChunkFromStreamPart,
  reasoningChunkFromStreamPart,
  abortActive,
} satisfies AiSdkBridgeApi;
