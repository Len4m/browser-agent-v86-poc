// Browser Agent v86 - LLM state.
// The model catalog is imported as typed data and runtime state is owned by
// this module.

import { t } from "../../app/i18n";
import { appEvents } from "../../core/events";
import llmModelsRaw from "../../../../data/llm-models.json";

interface LlmAgentMeta {
  maxSteps: number;
  maxNativeTools: number;
  toolCalling: "weak" | "fair" | "good";
  selfSelectTools?: boolean;
}

type LlmAgentInput = Partial<LlmAgentMeta>;

interface LlmReasoningExtract {
  tagName: string;
  startWithReasoning?: boolean;
  separator?: string;
}

interface LlmThinkingMeta {
  // Catalog input.
  mode?: "off" | "optional" | "on";
  // Derived runtime fields (filled by mergeThinkingMeta).
  enabled?: boolean;
  generate?: boolean;
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
  engine: string;
  notes?: string[];
  ramGB?: number;
  vramGB?: number;
  sizeLabel?: string;
  model?: string;
  device?: string;
  dtype?: string;
  custom?: boolean;
  requiresShaderF16?: boolean;
  agentProfile?: string;
  temperature?: number;
  topP?: number;
  contextWindowTokens?: number;
  reuseGenerationCache?: boolean;
  contextPreset?: string;
  contextOverride?: LlmContextPolicy;
  contextPolicy?: LlmContextPolicy;
  agentOverride?: LlmAgentInput;
  agent?: LlmAgentInput | LlmAgentMeta;
  thinking?: LlmThinkingMeta;
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
  | "artifact"
  | "artifact-clear"
  | "artifact-context"
  | "artifact-remove"
  | "capabilities"
  | "context"
  | "native-tools"
  | "progress"
  | "resource"
  | "status"
  | "tool-done"
  | "tool-error"
  | "tool-policy"
  | "tool-start";

interface LlmEventsApi {
  emit: (type: LlmEventType, detail?: Record<string, unknown>) => void;
  on: (type: LlmEventType, listener: (detail: Record<string, unknown>) => void) => () => void;
}

function transformersContextPolicy(policy: LlmContextPolicy): LlmContextPolicy {
  return {
    contextWindowTokens: 4096,
    maxHistoryMessages: 1,
    ...policy,
  };
}

const CONTEXT_POLICY_PRESETS: Record<string, LlmContextPolicy> = {
  "browser-tools-sm": transformersContextPolicy({
    safeInputTokens: 1100,
    maxSystemChars: 780,
    maxRuntimeChars: 300,
    maxHistoryChars: 350,
    maxToolResultChars: 1800,
    maxToolResultCharsForSynthesis: 1000,
  }),
  "browser-tools-md": transformersContextPolicy({
    safeInputTokens: 1250,
    maxSystemChars: 820,
    maxRuntimeChars: 320,
    maxHistoryChars: 550,
    maxToolResultChars: 2200,
    maxToolResultCharsForSynthesis: 1300,
  }),
  "browser-tools-xs": transformersContextPolicy({
    safeInputTokens: 1050,
    maxSystemChars: 740,
    maxRuntimeChars: 280,
    maxHistoryChars: 320,
    maxToolResultChars: 1600,
    maxToolResultCharsForSynthesis: 900,
  }),
  "browser-tools-lg": transformersContextPolicy({
    safeInputTokens: 1350,
    maxSystemChars: 860,
    maxRuntimeChars: 340,
    maxHistoryChars: 650,
    maxToolResultChars: 2400,
    maxToolResultCharsForSynthesis: 1400,
  }),
  "browser-tools-xl": transformersContextPolicy({
    safeInputTokens: 1400,
    maxSystemChars: 900,
    maxRuntimeChars: 360,
    maxHistoryChars: 700,
    maxToolResultChars: 2600,
    maxToolResultCharsForSynthesis: 1500,
  }),
  "browser-chat-fallback": transformersContextPolicy({
    safeInputTokens: 900,
    maxSystemChars: 560,
    maxRuntimeChars: 220,
    maxHistoryMessages: 0,
    maxHistoryChars: 0,
    maxToolResultChars: 0,
    maxToolResultCharsForSynthesis: 0,
  }),
};

const rawModels = llmModelsRaw as unknown as LlmModelConfig[];
let llmState: LlmState | null = null;

function defaultAgentMeta(model: LlmModelConfig): LlmAgentMeta {
  if (model.engine === "ollama") {
    return {
      maxSteps: 4,
      maxNativeTools: 10,
      toolCalling: "good",
    };
  }
  if (model.agentProfile === "tools-weak") {
    return {
      maxSteps: 1,
      maxNativeTools: 1,
      toolCalling: "weak",
    };
  }
  if (model.agentProfile === "tools-light-good") {
    return {
      maxSteps: 3,
      maxNativeTools: 4,
      toolCalling: "good",
    };
  }
  if (model.agentProfile === "tools-good") {
    return {
      maxSteps: 3,
      maxNativeTools: 10,
      toolCalling: "good",
    };
  }
  if (model.agentProfile === "tools-fair") {
    return {
      maxSteps: 3,
      maxNativeTools: 5,
      toolCalling: "fair",
    };
  }
  return {
    maxSteps: 3,
    maxNativeTools: 5,
    toolCalling: "fair",
  };
}

function mergeAgentMeta(model: LlmModelConfig): LlmAgentMeta {
  const base = defaultAgentMeta(model);
  const override = model.agentOverride || {};
  return {
    ...base,
    ...override,
  };
}

const LOW_TEMPERATURE_PROFILES = new Set(["tools-good", "tools-fair"]);

function defaultSampling(model: LlmModelConfig): { temperature: number; topP: number } {
  const temperature = model.agentProfile && LOW_TEMPERATURE_PROFILES.has(model.agentProfile) ? 0.1 : 0.15;
  return { temperature, topP: 0.85 };
}

function mergeThinkingMeta(model: LlmModelConfig): LlmThinkingMeta {
  const mode = model.thinking?.mode;
  const extract = model.thinking?.extract;
  return {
    enabled: mode === "optional" || mode === "on",
    generate: mode === undefined ? undefined : mode === "on",
    extract: extract?.tagName
      ? {
          tagName: extract.tagName,
          startWithReasoning: extract.startWithReasoning,
          separator: extract.separator,
        }
      : undefined,
  };
}

function llmEngineLabel(engine: unknown): string {
  return engine === "ollama" ? "Ollama local HTTP" : "Transformers.js v4";
}

function llmModelName(model: LlmModelConfig): string {
  const value = typeof model.model === "string" && model.model.trim() ? model.model.trim() : "custom";
  return model.engine === "ollama" ? value : value.split("/").pop() || value;
}

function llmTransformersDeviceLabel(model: Pick<LlmModelConfig, "engine" | "device" | "runtime">): string {
  if (model.engine !== "transformersjs") return "";
  const device = model.runtime?.device || model.device || "webgpu";
  if (device === "wasm") return t("common.wasm");
  if (device === "webgpu") return t("checks.item.webgpu");
  return device;
}

export function llmEngineMetaLabel(model: LlmModelConfig): string {
  const base = llmEngineLabel(model.engine);
  if (model.engine !== "transformersjs") return base;
  return `${base} · ${llmTransformersDeviceLabel(model)}`;
}

export function llmModelLabel(model: LlmModelConfig): string {
  const base = `${model.engine === "ollama" ? "Ollama" : "Transformers.js"} · ${llmModelName(model)}`;
  if (model.engine !== "transformersjs") return base;
  return `${base} · ${llmTransformersDeviceLabel(model)}`;
}

export function llmModelShortLabel(model: LlmModelConfig): string {
  return llmModelName(model);
}

export function llmModelRequiresWebGPU(model: LlmModelConfig | null | undefined): boolean {
  return (model?.engine || "transformersjs") === "transformersjs" && (model?.device || "webgpu") === "webgpu";
}

const customModels: LlmModelConfig[] = [
  {
    id: "custom-ollama",
    engine: "ollama",
    model: "",
    custom: true,
    contextWindowTokens: 8192,
  },
  {
    id: "custom-transformersjs",
    engine: "transformersjs",
    model: "",
    dtype: "auto",
    custom: true,
  },
];

function defaultContextMeta(model: LlmModelConfig): Pick<LlmModelConfig, "contextWindowTokens" | "contextPolicy"> {
  const contextWindowTokens = Number(model.contextWindowTokens) || (model.engine === "ollama" ? 8192 : 4096);
  if (model.engine === "ollama") {
    return {
      contextWindowTokens,
      contextPolicy: {
        contextWindowTokens,
        safeInputTokens: Math.min(6000, Math.max(2400, contextWindowTokens - 2200)),
        reservedOutputTokens: 2048,
        maxSystemChars: 2600,
        maxRuntimeChars: 1200,
        maxHistoryMessages: 8,
        maxHistoryChars: 12000,
        maxToolResultChars: 20000,
        maxToolResultCharsForSynthesis: 8000,
        maxArtifacts: 4,
      },
    };
  }
  return {
    contextWindowTokens,
    contextPolicy: { contextWindowTokens, safeInputTokens: 1800 },
  };
}

function withModelCapabilities(model: LlmModelConfig): LlmModelConfig {
  const ctx = defaultContextMeta(model);
  const preset = typeof model.contextPreset === "string" ? CONTEXT_POLICY_PRESETS[model.contextPreset] : null;
  const sampling = defaultSampling(model);
  return {
    ...model,
    temperature: model.temperature ?? sampling.temperature,
    topP: model.topP ?? sampling.topP,
    contextWindowTokens: model.contextWindowTokens ?? ctx.contextWindowTokens,
    contextPolicy: { ...(ctx.contextPolicy || {}), ...(preset || {}), ...(model.contextOverride || {}) },
    agent: mergeAgentMeta(model),
    thinking: mergeThinkingMeta(model),
  };
}

function createInitialLlmState(models: LlmModelConfig[]): LlmState {
  return {
    version: "v9.38.0-ai-sdk-browser",
    providerName: "transformersjs",
    providerLabel: "AI SDK + Transformers.js",
    available: true,
    loaded: false,
    loading: false,
    generating: false,
    selectedModelId: models.find((model) => model.engine === "transformersjs")?.id || models[0]?.id || "",
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
      // Maximum security level the agent may run without confirmation.
      // 1 = safe reads inside the VM; higher levels are reserved for future tools.
      toolAutonomyMaxLevel: Number(window.localStorage.getItem("ba.llm.toolAutonomyMaxLevel") || "1"),
      maxToolStepsPerTurn: 4,
      nativeToolNames: [],
      showThinking: false,
      systemPrompt: [
        t("prompt.system.role"),
        t("prompt.system.realData"),
        t("prompt.system.toolFallback"),
        t("prompt.system.artifacts"),
        t("prompt.system.style"),
      ].join(" "),
    },
  };
}

export const llmModels: LlmModelConfig[] = rawModels.map(withModelCapabilities);
export const llmCustomModels: LlmModelConfig[] = customModels.map(withModelCapabilities);
export const llmModelOptions: LlmModelConfig[] = [...llmModels, ...llmCustomModels];

function appLlmEventName(type: LlmEventType): `llm:${LlmEventType}` {
  return `llm:${type}`;
}

export const llmEventsApi: LlmEventsApi = {
  emit(type, detail = {}) {
    appEvents.emit(appLlmEventName(type), detail);
  },
  on(type, listener) {
    return appEvents.on(appLlmEventName(type), listener);
  },
};

export function getLlmState(): LlmState | null {
  return llmState;
}

export function installLlmState(): void {
  if (llmState) return;
  llmState = createInitialLlmState(llmModels);
}
