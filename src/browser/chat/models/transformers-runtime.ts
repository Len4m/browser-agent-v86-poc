import type { LlmModelConfig } from "../state/chat-state";
import { compatibleDtypes } from "./transformers-inspection";

const WASM_DTYPE_PREFERENCES = ["q8", "q4", "int8", "uint8", "fp32", "q2", "q1"];

function messageText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "";
}

export function selectWasmDtype(modelConfig: LlmModelConfig): string {
  const available = compatibleDtypes(modelConfig.inspection?.availableDtypes || [], false);
  const configured = typeof modelConfig.wasmDtype === "string" ? modelConfig.wasmDtype : "";
  if (configured && compatibleDtypes([configured], false).length && (!available.length || available.includes(configured))) {
    return configured;
  }
  const current = typeof modelConfig.dtype === "string" ? modelConfig.dtype : "";
  if (current && current !== "auto" && compatibleDtypes([current], false).length && (!available.length || available.includes(current))) {
    return current;
  }
  return WASM_DTYPE_PREFERENCES.find((dtype) => available.includes(dtype))
    || available[0]
    || "q8";
}

export function buildWasmFallbackConfig(modelConfig: LlmModelConfig): LlmModelConfig | null {
  if ((modelConfig.engine || "transformersjs") !== "transformersjs") return null;
  const device = modelConfig.device || "auto";
  if (device !== "auto" && device !== "webgpu") return null;
  return {
    ...modelConfig,
    id: `${modelConfig.id || "custom-transformersjs"}-wasm-fallback`,
    device: "wasm",
    dtype: selectWasmDtype(modelConfig),
    fallbackFrom: modelConfig.id || modelConfig.model,
    fallbackReason: "webgpu-runtime-failure",
  };
}

export function resolveTransformersRuntimeConfig(
  modelConfig: LlmModelConfig,
  capabilities: { webgpu: boolean },
): LlmModelConfig {
  if (modelConfig.engine !== "transformersjs" || capabilities.webgpu) return modelConfig;
  const device = modelConfig.device || "auto";
  if (device !== "auto" && device !== "webgpu") return modelConfig;
  const fallback = buildWasmFallbackConfig(modelConfig);
  return fallback
    ? { ...fallback, fallbackReason: "webgpu-unavailable" }
    : modelConfig;
}

export function isGpuRuntimeFailure(error: unknown): boolean {
  const message = messageText(error);
  if (/fetch|network|timeout|abort(ed)?|404|403|failed to fetch|download|indexeddb|quota|enotfound|connection refused|unexpected token|json\.parse|modelo no configurado/i.test(message)) {
    return false;
  }
  return /out of device memory|VK_ERROR_OUT_OF_DEVICE_MEMORY|WebGPU validation failed|Invalid Buffer|Device lost|failed to call OrtRun|CreateBuffer|null function|function signature mismatch|unaligned accesses|Instance reference no longer exists|memoria GPU agotada|WebGPU inválido|shader[- ]?f16|f16 not supported|unsupported device:\s*["']?webgpu|webgpu (?:is )?(?:not supported|unavailable)|navigator\.gpu/i.test(message);
}
