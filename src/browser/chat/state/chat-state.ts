// Browser Agent v86 - LLM state.
// The model catalog is imported as typed data and runtime state is owned by
// this module.

import { t } from "../../app/i18n";
import llmModelsRaw from "../../../../data/llm-models.json";

export interface LlmAgentMeta {
  maxSteps: number;
  maxNativeTools: number;
  toolCalling: "weak" | "fair" | "good";
  defaultNativeTools: string[];
}

export interface LlmThinkingMeta {
  enabled: boolean;
  tagName: string;
  startWithReasoning: boolean;
  [key: string]: unknown;
}

export interface LlmContextPolicy {
  contextWindowTokens?: number;
  safeInputTokens?: number;
  provider?: string;
  reservedOutputTokens?: number;
  maxSystemChars?: number;
  maxRuntimeChars?: number;
  maxHistoryMessages?: number;
  maxHistoryChars?: number;
  maxToolResultChars?: number;
  maxToolResultCharsForSynthesis?: number;
  maxArtifacts?: number;
  [key: string]: unknown;
}

export interface LlmModelConfig {
  id: string;
  label?: string;
  shortLabel?: string;
  engine: string;
  engineLabel?: string;
  description?: string;
  sizeLabel?: string;
  minMemoryLabel?: string;
  compatibilityLabel?: string;
  languageLabel?: string;
  model?: string;
  task?: string;
  device?: string;
  dtype?: string;
  custom?: boolean;
  requiresShaderF16?: boolean;
  requiresWebGPU?: boolean;
  toolProfile?: string;
  temperature?: number;
  topP?: number;
  contextWindowTokens?: number;
  maxNewTokens?: number;
  contextPolicy?: LlmContextPolicy;
  agent?: LlmAgentMeta;
  thinking?: Partial<LlmThinkingMeta>;
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

export interface LlmEventsApi {
  emit: (type: string, detail?: Record<string, unknown>) => void;
}

const DEFAULT_TOOLS = [
  "vm.python.exec",
  "vm.sh.exec",
  "vm.fs.list",
  "vm.fs.read",
  "vm.fs.write",
  "vm.cmd.which",
  "web.curl.head",
];

const rawModels = llmModelsRaw as unknown as LlmModelConfig[];
let llmState: LlmState | null = null;

function defaultAgentMeta(model: LlmModelConfig): LlmAgentMeta {
  const id = model.id || "";
  if (model.engine === "ollama") {
    return {
      maxSteps: 4,
      maxNativeTools: 10,
      toolCalling: "good",
      defaultNativeTools: DEFAULT_TOOLS,
    };
  }
  if (model.toolProfile === "tiny-fallback" || id.includes("270m")) {
    return {
      maxSteps: 1,
      maxNativeTools: 1,
      toolCalling: "weak",
      defaultNativeTools: DEFAULT_TOOLS,
    };
  }
  if (id.includes("0.5b") || (id.includes("qwen3") && id.includes("0.6"))) {
    return {
      maxSteps: 2,
      maxNativeTools: 2,
      toolCalling: "weak",
      defaultNativeTools: DEFAULT_TOOLS,
    };
  }
  if (id.includes("3b")) {
    return {
      maxSteps: 3,
      maxNativeTools: 8,
      toolCalling: "fair",
      defaultNativeTools: DEFAULT_TOOLS,
    };
  }
  if (id.includes("llama") && (id.includes("1b-instruct") || id.includes("1b-instruct-onnx"))) {
    return {
      maxSteps: 2,
      maxNativeTools: 2,
      toolCalling: "weak",
      defaultNativeTools: DEFAULT_TOOLS,
    };
  }
  if (id.includes("1.5b") || id.includes("1b") || id.includes("1.7b")) {
    return {
      maxSteps: 3,
      maxNativeTools: 5,
      toolCalling: "fair",
      defaultNativeTools: DEFAULT_TOOLS,
    };
  }
  if (model.toolProfile === "reasoning-light" || id.includes("qwen3")) {
    return {
      maxSteps: 3,
      maxNativeTools: 4,
      toolCalling: "good",
      defaultNativeTools: DEFAULT_TOOLS,
    };
  }
  if (model.toolProfile === "middle-tools" || model.toolProfile === "strong-json") {
    return {
      maxSteps: 3,
      maxNativeTools: 6,
      toolCalling: "good",
      defaultNativeTools: DEFAULT_TOOLS,
    };
  }
  return {
    maxSteps: 3,
    maxNativeTools: 5,
    toolCalling: "fair",
    defaultNativeTools: DEFAULT_TOOLS,
  };
}

function mergeThinkingMeta(model: LlmModelConfig): LlmThinkingMeta {
  return {
    enabled: false,
    tagName: "think",
    startWithReasoning: false,
    ...(model.thinking || {}),
  };
}

function defaultContextMeta(model: LlmModelConfig): Pick<LlmModelConfig, "contextWindowTokens" | "maxNewTokens" | "contextPolicy"> {
  const id = model.id || "";
  const contextWindowTokens = Number(model.contextWindowTokens) || (model.engine === "ollama" ? 8192 : 4096);
  if (model.engine === "ollama") {
    return {
      contextWindowTokens,
      maxNewTokens: model.maxNewTokens,
      contextPolicy: {
        provider: "ollama",
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
  let safeInputTokens = 1800;
  if (id.includes("3b")) safeInputTokens = 1400;
  else if (id.includes("0.5b") || (id.includes("qwen3") && id.includes("0.6")) || id.includes("270m")) {
    safeInputTokens = 1100;
  }
  return {
    contextWindowTokens,
    contextPolicy: { contextWindowTokens, safeInputTokens },
  };
}

function withModelCapabilities(model: LlmModelConfig): LlmModelConfig {
  const ctx = defaultContextMeta(model);
  return {
    ...model,
    contextWindowTokens: model.contextWindowTokens ?? ctx.contextWindowTokens,
    maxNewTokens: model.maxNewTokens ?? ctx.maxNewTokens,
    contextPolicy: { ...(ctx.contextPolicy || {}), ...(model.contextPolicy || {}) },
    agent: model.agent || defaultAgentMeta(model),
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

export const llmEventsApi: LlmEventsApi = {
  emit(type, detail = {}) {
    window.dispatchEvent(new CustomEvent(`ba-llm:${type}`, { detail }));
  },
};

export function getLlmState(): LlmState | null {
  return llmState;
}

export function installLlmState(): void {
  if (llmState) return;
  llmState = createInitialLlmState(llmModels);
}
