// Browser Agent v86 - AI SDK bridge (ESM)
// Carga el bundle generado de chat y exporta una API ESM para el runtime LLM.
// El loop de agente (tools + multi-step) vive en runAgentStreamTurn (AI SDK).

import type { LanguageModel } from "ai";
import { initI18n, t } from "../../app/i18n";
import type { LlmModelConfig } from "../state/chat-state";
import type { ModelInspection } from "../models/model-types";
import { buildWasmFallbackConfig, isGpuRuntimeFailure } from "../models/transformers-runtime";
import type { AiSdkBridgeApi, AiSdkRunAgentStreamTurnOptions, AiSdkRunAgentStreamTurnResult, AiSdkToolConfig } from "./ai-sdk-runtime";
import {
  tool,
  wrapLanguageModel,
  transformersJS,
  ollamaBrowser,
  z,
  runAgentStreamTurn,
  textChunkFromStreamPart,
  reasoningChunkFromStreamPart,
  transformersReasoningMiddleware,
  transformersTextToolMiddleware,
} from "./chat/ai-sdk-browser.mjs";

type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: "v4" }>;

type BrowserSessionLanguageModel = LanguageModelV4 & {
  availability?: () => Promise<string>;
  createSessionWithProgress?: (onProgress?: (progress: unknown) => void) => Promise<unknown>;
};

interface ActiveModelHandle {
  base: BrowserSessionLanguageModel;
  model: LanguageModelV4;
  modelConfig: LlmModelConfig;
}

interface LoadModelOptions {
  signal?: AbortSignal;
  onProgress?: (detail: Record<string, unknown>) => void;
}

type TransformersSettings = NonNullable<Parameters<typeof transformersJS>[1]>;
type TransformersDevice = Extract<TransformersSettings["device"], string>;
type TransformersDtype = Extract<TransformersSettings["dtype"], string>;

void initI18n();

let workerUrl: URL | null = null;
let activeWorker: Worker | null = null;
let activeModelHandle: ActiveModelHandle | null = null;

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}

function mapDevice(device: unknown): TransformersDevice {
  const value = (textValue(device) || "webgpu").toLowerCase();
  const supported: TransformersDevice[] = ["auto", "cpu", "gpu", "webgpu", "wasm", "cuda", "dml", "coreml", "webnn", "webnn-npu", "webnn-gpu", "webnn-cpu"];
  return supported.includes(value as TransformersDevice) ? value as TransformersDevice : "webgpu";
}

function mapDtype(dtype: unknown): TransformersDtype {
  const value = (textValue(dtype) || "auto").toLowerCase();
  const supported: TransformersDtype[] = ["auto", "fp32", "fp16", "q8", "q4", "q4f16", "int8", "uint8", "bnb4", "q2", "q2f16", "q1", "q1f16"];
  if (supported.includes(value as TransformersDtype)) return value as TransformersDtype;
  return "auto";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Error";
}

function modelLoadAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(typeof signal.reason === "string" ? signal.reason : t("common.operationCancelled"));
  error.name = "AbortError";
  return error;
}

function abortableModelLoad<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    unloadModel();
    return Promise.reject(modelLoadAbortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      unloadModel();
      reject(modelLoadAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      },
    );
  });
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

function createWorker({
  disposeGenerationCacheBeforeGenerate = false,
  onProgress,
}: {
  disposeGenerationCacheBeforeGenerate?: boolean;
  onProgress?: LoadModelOptions["onProgress"];
} = {}): Worker {
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
    const detail = isRecord(event.data) ? event.data : null;
    if (detail && ["initiate", "download", "progress", "progress_total", "done", "ready", "loading"].includes(textValue(detail.status))) {
      onProgress?.(detail);
    }
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

function workerBundleUrl(): URL {
  workerUrl ||= new URL("./chat/workers/llm-browser-ai.worker.mjs", import.meta.url);
  return new URL(workerUrl.href);
}

function createInspectionWorker(): Worker {
  const worker = new Worker(workerBundleUrl(), { type: "module" });
  worker.addEventListener("message", (event) => forwardWorkerDiagnostic(event.data));
  return worker;
}

async function inspectModel(
  modelId: string,
  { dtype, timeoutMs = 120_000 }: { dtype?: string; timeoutMs?: number } = {},
): Promise<ModelInspection> {
  const normalized = modelId.trim();
  if (!normalized) throw new Error("Modelo no configurado.");
  unloadModel();
  const worker = createInspectionWorker();
  const requestId = globalThis.crypto?.randomUUID?.() || `inspect-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    return await new Promise<ModelInspection>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Model inspection timed out")), timeoutMs);
      const finish = (callback: () => void): void => {
        window.clearTimeout(timeout);
        callback();
      };
      worker.addEventListener("message", (event) => {
        const value = isRecord(event.data) ? event.data : null;
        if (!value || value.status !== "model-inspection" || value.requestId !== requestId) return;
        if (typeof value.error === "string") {
          finish(() => reject(new Error(value.error as string)));
          return;
        }
        if (!isRecord(value.result)) {
          finish(() => reject(new Error("Model inspection returned an invalid result")));
          return;
        }
        finish(() => resolve(value.result as ModelInspection));
      });
      worker.addEventListener("error", (event) => {
        const reason = event.error instanceof Error
          ? event.error
          : new Error(event.message || "Model inspection worker failed");
        finish(() => reject(reason));
      }, { once: true });
      worker.postMessage({ type: "inspect-model", requestId, modelId: normalized, dtype });
    });
  } finally {
    worker.terminate();
  }
}

function shouldUseReasoningMiddleware(modelConfig: LlmModelConfig): boolean {
  const thinking = modelConfig?.thinking;
  if (!thinking?.enabled || !thinking?.extract?.tagName) return false;
  // Ollama expone message.thinking como reasoning-delta cuando el modelo lo devuelve.
  // El middleware por tags solo aplica a texto generado por Transformers.js.
  if (modelConfig.engine === "ollama") return false;
  return true;
}

function wrapAgentModel(baseModel: LanguageModelV4, modelConfig: LlmModelConfig): LanguageModelV4 {
  const engine = modelConfig?.engine || "transformersjs";
  const extract = modelConfig?.thinking?.extract;
  let model = baseModel;
  if (shouldUseReasoningMiddleware(modelConfig) && extract?.tagName) {
    model = wrapLanguageModel({
      model,
      middleware: transformersReasoningMiddleware({
        tagName: extract.tagName,
        ...(extract.startWithReasoning !== undefined ? { startWithReasoning: extract.startWithReasoning } : {}),
        ...(extract.separator !== undefined ? { separator: extract.separator } : {}),
      }),
    });
  }
  if (engine === "transformersjs") {
    model = wrapLanguageModel({
      model,
      middleware: transformersTextToolMiddleware({
        stripToolChoice: true,
        parseTextTools: true,
      }),
    });
  }
  return model;
}

function resolveOllamaEndpoint(): string {
  return String(
    window.localStorage?.getItem("ba.llm.ollama.endpoint")
      || "http://127.0.0.1:11434",
  ).replace(/\/+$/g, "");
}

function createModel(modelConfig: LlmModelConfig, onProgress?: LoadModelOptions["onProgress"]): LanguageModelV4 {
  if (!modelConfig?.model) throw new Error("Modelo no configurado.");

  let base: BrowserSessionLanguageModel;
  let runtime: NonNullable<LlmModelConfig["runtime"]>;
  if (modelConfig.engine === "ollama") {
    terminateActiveWorker();
    const endpoint = resolveOllamaEndpoint();
    base = ollamaBrowser(modelConfig.model, {
      endpoint,
      think: modelConfig.thinking?.generate,
    });
    runtime = {
      provider: "ollama",
      device: "remote",
      dtype: "host",
      endpoint,
      worker: false,
    };
  } else {
    const device = mapDevice(modelConfig.device);
    const dtype = mapDtype(modelConfig.dtype);
    const disposeGenerationCacheBeforeGenerate = device === "webgpu" && modelConfig.reuseGenerationCache !== true;
    base = transformersJS(modelConfig.model, {
      device,
      dtype,
      worker: createWorker({ disposeGenerationCacheBeforeGenerate, onProgress }),
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

async function loadModel(modelConfig: LlmModelConfig, { signal, onProgress }: LoadModelOptions = {}): Promise<LanguageModelV4> {
  async function loadWithConfig(config: LlmModelConfig): Promise<LanguageModelV4> {
    const model = createModel(config, onProgress);
    // wrapLanguageModel solo envuelve doGenerate/doStream; sesión y descarga viven en el modelo base.
    const sessionModel = activeModelHandle?.base;
    const availability = await sessionModel?.availability?.();

    if (availability === "unavailable") {
      throw new Error(config.engine === "ollama"
        ? t("chat.error.ollamaUnavailable")
        : t("chat.error.transformersUnavailable"));
    }

    if (availability !== "available" && config.engine === "ollama") {
      await sessionModel?.createSessionWithProgress?.((progress: unknown) => {
        onProgress?.({
          status: "progress",
          progress,
          file: config.model,
          model: config.model,
        });
      });
    } else if (availability !== "available") {
      await sessionModel?.createSessionWithProgress?.();
    }

    return model;
  }

  const loadAttempt = (config: LlmModelConfig): Promise<LanguageModelV4> => abortableModelLoad(loadWithConfig(config), signal);

  try {
    return await loadAttempt(modelConfig);
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      unloadModel();
      throw signal?.aborted ? modelLoadAbortError(signal) : error;
    }
    const msg = errorMessage(error);
    const fallbackConfig = isGpuRuntimeFailure(msg) ? buildWasmFallbackConfig(modelConfig) : null;
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
      const model = await loadAttempt(fallbackConfig);
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
  activeModelHandle = null;
  terminateActiveWorker();
}

function getActiveModel(): LanguageModelV4 | null {
  return activeModelHandle?.model || null;
}

function getActiveModelConfig(): LlmModelConfig | null {
  return activeModelHandle?.modelConfig || null;
}

function isModelReady(): boolean {
  return Boolean(activeModelHandle?.model);
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
  inspectModel,
  unloadModel,
  getActiveModel,
  getActiveModelConfig,
  isModelReady,
  runAgentStreamTurn: runBridgeAgentStreamTurn,
  textChunkFromStreamPart,
  reasoningChunkFromStreamPart,
} satisfies AiSdkBridgeApi;
