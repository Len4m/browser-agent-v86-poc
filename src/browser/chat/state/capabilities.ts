// Browser Agent v86 - LLM capability detector.
// This service requests a GPUAdapter to know whether WebGPU and optional
// features such as shader-f16 are exposed. It does not create a GPUDevice.

import { t } from "../../app/i18n";
import { appEvents } from "../../core/events";
import { setBadge } from "../../ui/status-controls";
import { getLlmState, llmEventsApi } from "./chat-state";

export interface LlmCapabilities {
  secureContext: boolean;
  webgpu: boolean;
  adapter: { info: unknown } | null;
  features: string[];
  limits: {
    maxBufferSize?: number;
    maxStorageBufferBindingSize?: number;
    maxComputeWorkgroupStorageSize?: number;
    maxComputeInvocationsPerWorkgroup?: number;
  };
  shaderF16: boolean;
  recommendedDtype: "q4" | "q4f16";
  reason: string;
  checkedAt: number;
}

interface CapabilityBadge {
  text: string;
  tone: string;
  title: string;
}

interface EnsureCapabilitiesOptions {
  force?: boolean;
  source?: string;
}

type GpuAdapterLike = {
  info?: unknown;
  features?: Set<string> | Iterable<string>;
  limits?: {
    maxBufferSize?: number;
    maxStorageBufferBindingSize?: number;
    maxComputeWorkgroupStorageSize?: number;
    maxComputeInvocationsPerWorkgroup?: number;
  };
};

type GpuNavigator = Navigator & {
  gpu?: {
    requestAdapter?: (options?: { powerPreference?: string }) => Promise<GpuAdapterLike | null>;
  };
};

let initialized = false;

function baseResult(): LlmCapabilities {
  return {
    secureContext: Boolean(window.isSecureContext),
    webgpu: false,
    adapter: null,
    features: [],
    limits: {},
    shaderF16: false,
    recommendedDtype: "q4",
    reason: "",
    checkedAt: 0,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Error";
}

function isCapabilitiesResult(value: unknown): value is LlmCapabilities {
  return typeof value === "object"
    && value !== null
    && "secureContext" in value
    && "webgpu" in value
    && "shaderF16" in value;
}

function currentCapabilities(): LlmCapabilities | null {
  const capabilities = getLlmState()?.capabilities;
  return isCapabilitiesResult(capabilities) ? capabilities : null;
}

function navigatorGpu(): GpuNavigator["gpu"] | null {
  return (navigator as GpuNavigator).gpu || null;
}

function capabilityBadgeFor(result: LlmCapabilities | null, state = "ready"): CapabilityBadge {
  if (state === "checking") return { text: t("caps.badge.checking"), tone: "warn", title: t("caps.badge.checkingTitle") };
  if (!result) return { text: t("caps.badge.pending"), tone: "warn", title: t("common.inferencePending") };
  if (result.webgpu) {
    return {
      text: result.shaderF16 ? t("caps.badge.webgpuF16") : t("caps.badge.webgpuReady"),
      tone: "good",
      title: result.shaderF16
        ? t("caps.badge.webgpuF16Title")
        : t("caps.badge.webgpuReadyTitle"),
    };
  }
  return {
    text: t("common.wasm"),
    tone: "warn",
    title: result.reason ? t("caps.badge.wasmReasonTitle", { reason: result.reason }) : t("caps.badge.wasmTitle"),
  };
}

export function syncLLMCapabilityBadges(result: LlmCapabilities | null = currentCapabilities(), state = "ready"): CapabilityBadge {
  const badgeInfo = capabilityBadgeFor(result, state);
  const targets = [
    document.getElementById("badge-gpu"),
    document.getElementById("ba-llm-summary-compat"),
  ].filter((target): target is HTMLElement => Boolean(target));

  for (const target of targets) {
    setBadge(target, badgeInfo.text, badgeInfo.tone);
    if (target.id === "ba-llm-summary-compat") {
      target.classList.add("ba-llm-summary-compat");
    }
    target.title = badgeInfo.title;
  }

  return badgeInfo;
}

export async function detectLLMCapabilities(): Promise<LlmCapabilities> {
  const result = baseResult();

  if (!result.secureContext) {
    result.reason = t("caps.reason.secureContext");
    result.checkedAt = Date.now();
    return result;
  }

  const gpu = navigatorGpu();
  if (!gpu?.requestAdapter) {
    result.reason = t("caps.reason.noGpu");
    result.checkedAt = Date.now();
    return result;
  }

  try {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      result.reason = t("caps.reason.noAdapter");
      result.checkedAt = Date.now();
      return result;
    }

    const features = adapter.features ? Array.from(adapter.features) : [];
    result.webgpu = true;
    result.adapter = { info: adapter.info || null };
    result.features = features;
    result.shaderF16 = features.includes("shader-f16");
    result.recommendedDtype = result.shaderF16 ? "q4f16" : "q4";
    result.limits = {
      maxBufferSize: adapter.limits?.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits?.maxStorageBufferBindingSize,
      maxComputeWorkgroupStorageSize: adapter.limits?.maxComputeWorkgroupStorageSize,
      maxComputeInvocationsPerWorkgroup: adapter.limits?.maxComputeInvocationsPerWorkgroup,
    };
    result.reason = t("caps.reason.available");
  } catch (error) {
    result.reason = t("caps.reason.browserError", { message: errorMessage(error) });
  }

  result.checkedAt = Date.now();
  return result;
}

function emitCapabilities(result: LlmCapabilities, source = "unknown"): void {
  llmEventsApi.emit("capabilities", { capabilities: result, source });
}

export async function ensureLLMCapabilities(options: EnsureCapabilitiesOptions = {}): Promise<LlmCapabilities> {
  const { force = false, source = "unknown" } = options;
  const llm = getLlmState();
  const existing = currentCapabilities();

  if (llm?.capabilitiesChecked && existing && !force) {
    syncLLMCapabilityBadges(existing, "ready");
    return existing;
  }

  if (llm?.capabilitiesChecking && !force) {
    const checked = await llm.capabilitiesChecking;
    return isCapabilitiesResult(checked) ? checked : (currentCapabilities() || baseResult());
  }

  syncLLMCapabilityBadges(existing, "checking");

  const promise = (async (): Promise<LlmCapabilities> => {
    const result = await detectLLMCapabilities();
    const currentLlm = getLlmState();
    if (currentLlm) {
      currentLlm.capabilities = result;
      currentLlm.capabilitiesChecked = true;
    }
    syncLLMCapabilityBadges(result, "ready");
    emitCapabilities(result, source);
    return result;
  })();

  if (llm) llm.capabilitiesChecking = promise;

  try {
    return await promise;
  } finally {
    const currentLlm = getLlmState();
    if (currentLlm?.capabilitiesChecking === promise) {
      currentLlm.capabilitiesChecking = null;
    }
  }
}

export function initLlmCapabilities(): void {
  if (initialized) return;
  initialized = true;
  appEvents.on("app:language-changed", () => syncLLMCapabilityBadges(currentCapabilities(), "ready"));
}
