// Browser Agent v86 - dynamic LLM state.

import { t } from "../../app/i18n";
import { appEvents } from "../../core/events";
import type { DiscoveredModel, LlmEngine, LlmUserProfile, ModelInspection, ToolStrategy } from "../models/model-types";
import { modelKey } from "../models/model-types";
import { defaultProfile, loadLastProfile, resolveProfile, saveLastProfile } from "../models/model-profiles";

export interface LlmAgentMeta {
  maxSteps: number;
  maxNativeTools: number;
  toolCalling: "weak" | "fair" | "good";
  toolStrategy?: ToolStrategy;
  selfSelectTools?: boolean;
  activeToolNames?: string[];
}

interface LlmReasoningExtract {
  tagName: string;
  startWithReasoning?: boolean;
  separator?: string;
}

interface LlmThinkingMeta {
  enabled?: boolean;
  generate?: boolean | "low" | "medium" | "high" | "max";
  extract?: LlmReasoningExtract;
}

export interface LlmContextPolicy {
  contextWindowTokens?: number;
  safeInputTokens?: number;
  reservedOutputTokens?: number;
  maxSystemChars?: number;
  maxRuntimeChars?: number;
  maxHistoryMessages?: number;
  maxHistoryChars?: number;
  maxToolResultChars?: number;
  maxToolResultCharsForSynthesis?: number;
  maxArtifacts?: number;
  maxOutputTokens?: number;
  maxNewTokensForPlan?: number;
  maxNewTokensForSynthesis?: number;
  [key: string]: unknown;
}

export interface LlmModelConfig {
  id: string;
  engine: LlmEngine;
  model?: string;
  label?: string;
  sizeLabel?: string;
  sizeBytes?: number;
  device?: string;
  dtype?: string;
  wasmDtype?: string;
  temperature?: number;
  topP?: number;
  contextWindowTokens?: number;
  reuseGenerationCache?: boolean;
  contextPolicy?: LlmContextPolicy;
  agent?: LlmAgentMeta;
  thinking?: LlmThinkingMeta;
  profile?: LlmUserProfile;
  inspection?: ModelInspection | null;
  discovered?: DiscoveredModel | null;
  capabilities?: unknown;
  runtime?: {
    provider?: string;
    endpoint?: string;
    device?: string;
    dtype?: string;
    fallback?: boolean;
    worker?: unknown;
    [key: string]: unknown;
  };
  fallbackFrom?: string;
  fallbackReason?: unknown;
  [key: string]: unknown;
}

export interface LlmState {
  version: string;
  providerName: string;
  providerLabel: string;
  available: boolean;
  loaded: boolean;
  loading: boolean;
  generating: boolean;
  selectedModelId: string;
  activeModel: LlmModelConfig | null;
  capabilities: unknown;
  capabilitiesChecked: boolean;
  capabilitiesChecking: Promise<unknown> | null;
  provider: unknown;
  aiModelReady: boolean;
  messages: Array<{ role: string; content: string; [key: string]: unknown }>;
  artifacts: unknown[];
  lastArtifactId: string | null;
  contextArtifactId: string | null;
  lastError: string;
  settings: {
    toolAutonomyMaxLevel: number;
    maxToolStepsPerTurn: number;
    nativeToolNames: string[];
    showThinking: boolean;
    systemPrompt: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

type LlmEventType =
  | "activity" | "artifact" | "artifact-clear" | "artifact-context" | "artifact-remove"
  | "capabilities" | "context" | "native-tools" | "progress" | "resource"
  | "status" | "tool-done" | "tool-error" | "tool-policy" | "tool-start";

interface LlmEventsApi {
  emit: (type: LlmEventType, detail?: Record<string, unknown>) => void;
  on: (type: LlmEventType, listener: (detail: Record<string, unknown>) => void) => () => void;
}

const dynamicModels = new Map<string, LlmModelConfig>();
let llmState: LlmState | null = null;

function storedProfile(): LlmUserProfile | null {
  try { return loadLastProfile(window.localStorage); } catch { return null; }
}

function thinkGenerate(profile: LlmUserProfile): LlmThinkingMeta["generate"] {
  if (profile.engine !== "ollama") return profile.transformersThinking?.enabled;
  if (profile.ollamaThink === "auto") return undefined;
  if (profile.ollamaThink === "off") return false;
  if (profile.ollamaThink === "on") return true;
  return profile.ollamaThink;
}

export function modelConfigFromProfile(
  profile: LlmUserProfile,
  discovered: DiscoveredModel | null = null,
  inspection: ModelInspection | null = null,
): LlmModelConfig {
  const contextWindowTokens = profile.contextWindowTokens;
  const enginePolicy: LlmContextPolicy = profile.engine === "ollama"
    ? {
        contextWindowTokens,
        safeInputTokens: profile.safeInputTokens,
        reservedOutputTokens: profile.maxOutputTokens,
        maxSystemChars: 2600,
        maxRuntimeChars: 1200,
        maxHistoryMessages: 8,
        maxHistoryChars: 12000,
        maxToolResultChars: 20000,
        maxToolResultCharsForSynthesis: 8000,
        maxArtifacts: 4,
      }
    : {
        contextWindowTokens,
        safeInputTokens: profile.safeInputTokens,
        reservedOutputTokens: profile.maxOutputTokens,
        maxSystemChars: 900,
        maxRuntimeChars: 420,
        maxHistoryMessages: 2,
        maxHistoryChars: 1000,
        maxToolResultChars: 2400,
        maxToolResultCharsForSynthesis: 1400,
        maxArtifacts: 1,
      };
  return {
    id: modelKey(profile.engine, profile.modelId),
    engine: profile.engine,
    model: profile.modelId,
    label: discovered?.label || profile.modelId,
    sizeBytes: inspection?.downloadSizeBytes || discovered?.sizeBytes,
    device: profile.device,
    dtype: profile.dtype,
    temperature: profile.temperature,
    topP: profile.topP,
    contextWindowTokens,
    reuseGenerationCache: profile.reuseGenerationCache,
    contextPolicy: {
      ...enginePolicy,
      maxOutputTokens: profile.maxOutputTokens,
      maxNewTokensForPlan: profile.maxNewTokensForPlan,
    },
    agent: {
      maxSteps: profile.maxSteps,
      maxNativeTools: profile.maxNativeTools,
      toolCalling: profile.toolCalling,
      toolStrategy: profile.toolStrategy,
      selfSelectTools: profile.toolStrategy === "model-first",
      activeToolNames: profile.activeToolNames,
    },
    thinking: {
      enabled: profile.engine === "ollama" ? profile.ollamaThink !== "off" : profile.transformersThinking?.enabled,
      generate: thinkGenerate(profile),
      extract: profile.engine === "transformersjs" && profile.transformersThinking?.tagName
        ? { tagName: profile.transformersThinking.tagName, startWithReasoning: profile.transformersThinking.startWithReasoning }
        : undefined,
    },
    profile,
    inspection,
    discovered,
    capabilities: inspection?.capabilities,
  };
}

export function registerDiscoveredModel(
  discovered: DiscoveredModel,
  inspection: ModelInspection | null = null,
  selection: Partial<LlmUserProfile> | null = null,
): LlmModelConfig {
  const lastProfile = storedProfile();
  const saved = lastProfile && modelKey(lastProfile.engine, lastProfile.modelId) === discovered.key
    ? lastProfile
    : null;
  const profile = resolveProfile(discovered.engine, discovered.modelId, inspection, saved, saved ? null : selection);
  const config = modelConfigFromProfile(profile, discovered, inspection);
  dynamicModels.set(config.id, config);
  return config;
}

export function getLlmModels(): LlmModelConfig[] { return [...dynamicModels.values()]; }
export function findLlmModel(id: string | null | undefined): LlmModelConfig | null { return id ? dynamicModels.get(id) || null : null; }
export function getSelectedLlmModel(): LlmModelConfig | null { return findLlmModel(llmState?.selectedModelId) || llmState?.activeModel || null; }

export function selectLlmModel(config: LlmModelConfig): void {
  dynamicModels.set(config.id, config);
  if (config.profile) {
    try { saveLastProfile(window.localStorage, config.profile); } catch { /* Storage may be unavailable. */ }
  }
  if (llmState) {
    llmState.selectedModelId = config.id;
    llmState.settings.nativeToolNames = [...(config.agent?.activeToolNames || [])];
    llmState.settings.showThinking = Boolean(config.profile?.showThinking);
  }
  llmEventsApi.emit("status", { selectedModelId: config.id });
}

export function defaultModelConfig(engine: LlmEngine, modelId: string): LlmModelConfig {
  return modelConfigFromProfile(defaultProfile(engine, modelId));
}

function llmEngineLabel(engine: unknown): string { return engine === "ollama" ? "Ollama local HTTP" : "Transformers.js v4"; }
function llmModelName(model: LlmModelConfig): string {
  const name = model.model || "";
  return model.engine === "ollama" ? name : name.split("/").pop() || name;
}

function llmTransformersDeviceLabel(model: Pick<LlmModelConfig, "engine" | "device" | "runtime">): string {
  if (model.engine !== "transformersjs") return "";
  const device = model.runtime?.device || model.device || "auto";
  if (device === "wasm") return t("common.wasm");
  if (device === "webgpu") return t("checks.item.webgpu");
  return device;
}

export function llmEngineMetaLabel(model: LlmModelConfig): string {
  const base = llmEngineLabel(model.engine);
  return model.engine === "transformersjs" ? `${base} · ${llmTransformersDeviceLabel(model)}` : base;
}
export function llmModelLabel(model: LlmModelConfig): string {
  const base = `${model.engine === "ollama" ? "Ollama" : "Transformers.js"} · ${llmModelName(model)}`;
  return model.engine === "transformersjs" ? `${base} · ${llmTransformersDeviceLabel(model)}` : base;
}
export function llmModelShortLabel(model: LlmModelConfig): string { return llmModelName(model); }
export function llmModelRequiresWebGPU(model: LlmModelConfig | null | undefined): boolean { return model?.engine === "transformersjs" && model.device === "webgpu"; }

function createInitialLlmState(): LlmState {
  const restoredProfile = storedProfile();
  const restoredModel = restoredProfile ? modelConfigFromProfile(restoredProfile) : null;
  if (restoredModel) dynamicModels.set(restoredModel.id, restoredModel);
  return {
    version: "v9.39.0-dynamic-models",
    providerName: "dynamic",
    providerLabel: "AI SDK + dynamic local models",
    available: true,
    loaded: false,
    loading: false,
    generating: false,
    selectedModelId: restoredModel?.id || "",
    activeModel: null,
    capabilities: null,
    capabilitiesChecked: false,
    capabilitiesChecking: null,
    provider: null,
    aiModelReady: false,
    messages: [],
    artifacts: [],
    lastArtifactId: null,
    contextArtifactId: null,
    lastError: "",
    settings: {
      toolAutonomyMaxLevel: Number(window.localStorage.getItem("ba.llm.toolAutonomyMaxLevel") || "1"),
      maxToolStepsPerTurn: 4,
      nativeToolNames: [...(restoredModel?.agent?.activeToolNames || [])],
      showThinking: Boolean(restoredProfile?.showThinking),
      systemPrompt: [t("prompt.system.role"), t("prompt.system.realData"), t("prompt.system.toolFallback"), t("prompt.system.artifacts"), t("prompt.system.style")].join(" "),
    },
  };
}

function appLlmEventName(type: LlmEventType): `llm:${LlmEventType}` { return `llm:${type}`; }
export const llmEventsApi: LlmEventsApi = {
  emit(type, detail = {}) { appEvents.emit(appLlmEventName(type), detail); },
  on(type, listener) { return appEvents.on(appLlmEventName(type), listener); },
};
export function getLlmState(): LlmState | null { return llmState; }
export function installLlmState(): void { llmState ||= createInitialLlmState(); }
