// Built to public/assets/chat/workers/llm-browser-ai.worker.mjs via pnpm build
import { TransformersJSWorkerHandler } from "@browser-ai/transformers-js";
import { ModelRegistry } from "@huggingface/transformers";
import { inspectTransformersModel } from "../../models/transformers-inspection";

const handler = new TransformersJSWorkerHandler();
type WorkerHandlerMessage = Parameters<TransformersJSWorkerHandler["onmessage"]>[0];
type WorkerHandlerWithGenerationCache = {
  clearGenerationCache?: () => void;
  past_key_values_cache?: {
    dispose?: () => Promise<void> | void;
  } | null;
};

const disposeGenerationCacheBeforeGenerate = new URL(self.location.href)
  .searchParams
  .get("disposeGenerationCacheBeforeGenerate") === "1";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) || "Unknown error";
  } catch {
    return String(error);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function errorStack(error: unknown): string {
  return error instanceof Error && typeof error.stack === "string"
    ? error.stack.slice(0, 1600)
    : "";
}

function postDiagnostic(event: string, data: Record<string, unknown> = {}): void {
  self.postMessage({
    status: "diagnostic",
    source: "llm-browser-ai.worker",
    event,
    data,
  });
}

function generateSummary(message: unknown): Record<string, unknown> {
  if (typeof message !== "object" || message === null) return { kind: typeof message };
  const record = message as Record<string, unknown>;
  const data = typeof record.data === "object" && record.data !== null
    ? record.data as Record<string, unknown>
    : null;
  const generationOptions = typeof record.generationOptions === "object" && record.generationOptions !== null
    ? record.generationOptions as Record<string, unknown>
    : null;
  return {
    type: record.type,
    messageCount: Array.isArray(record.data) ? record.data.length : undefined,
    modelId: data?.modelId,
    device: data?.device,
    dtype: data?.dtype,
    tools: Array.isArray(record.tools) ? record.tools.length : undefined,
    maxNewTokens: generationOptions?.max_new_tokens,
    enableThinking: record.enableThinking,
  };
}

function isGenerateMessage(message: unknown): boolean {
  return typeof message === "object"
    && message !== null
    && (message as Record<string, unknown>).type === "generate";
}

function inspectionMessage(message: unknown): { requestId: string; modelId: string; dtype?: string } | null {
  if (typeof message !== "object" || message === null) return null;
  const value = message as Record<string, unknown>;
  if (value.type !== "inspect-model" || typeof value.requestId !== "string" || typeof value.modelId !== "string") return null;
  return {
    requestId: value.requestId,
    modelId: value.modelId,
    dtype: typeof value.dtype === "string" ? value.dtype : undefined,
  };
}

async function inspectModel(message: { requestId: string; modelId: string; dtype?: string }): Promise<void> {
  try {
    const result = await inspectTransformersModel(ModelRegistry, message.modelId, { dtype: message.dtype });
    self.postMessage({ status: "model-inspection", requestId: message.requestId, result });
  } catch (error) {
    self.postMessage({
      status: "model-inspection",
      requestId: message.requestId,
      error: errorMessage(error),
    });
  }
}

async function disposeGenerationCache(message: unknown): Promise<void> {
  if (!disposeGenerationCacheBeforeGenerate || !isGenerateMessage(message)) return;
  const cacheHandler = handler as unknown as WorkerHandlerWithGenerationCache;
  const cache = cacheHandler.past_key_values_cache;
  if (cache && typeof cache.dispose === "function") {
    try {
      await cache.dispose();
    } catch (error) {
      postDiagnostic("generation-cache-dispose-failed", {
        ...generateSummary(message),
        errorName: errorName(error),
        errorMessage: errorMessage(error),
        stack: errorStack(error),
      });
    }
  }
  if (typeof cacheHandler.clearGenerationCache !== "function") {
    postDiagnostic("generation-cache-clear-unavailable", generateSummary(message));
    return;
  }
  cacheHandler.clearGenerationCache();
}

self.addEventListener("error", (event) => {
  postDiagnostic("worker-error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    errorName: errorName(event.error),
    errorMessage: errorMessage(event.error),
    stack: errorStack(event.error),
  });
});

self.addEventListener("unhandledrejection", (event) => {
  postDiagnostic("worker-unhandledrejection", {
    errorName: errorName(event.reason),
    errorMessage: errorMessage(event.reason),
    stack: errorStack(event.reason),
  });
});

self.onmessage = async (msg: MessageEvent<unknown>) => {
  try {
    const inspection = inspectionMessage(msg.data);
    if (inspection) {
      await inspectModel(inspection);
      return;
    }
    await disposeGenerationCache(msg.data);
    handler.onmessage(msg as WorkerHandlerMessage);
  } catch (error) {
    postDiagnostic("handler-sync-error", {
      errorName: errorName(error),
      errorMessage: errorMessage(error),
      stack: errorStack(error),
    });
    throw error;
  }
};
