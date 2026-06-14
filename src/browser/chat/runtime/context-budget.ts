// Browser Agent v86 - LLM context budget.
// Single source of truth for prompt/output budgets. contextWindowTokens comes
// from the model catalog; this module reserves part of that window for input
// and derives max output from the remaining room.

import { t } from "../../app/i18n";
import { getLlmState, llmModels, type LlmContextPolicy, type LlmModelConfig } from "../state/chat-state";
import { llmArtifacts, type LlmArtifact } from "./artifact-store";
import { llmResourceGovernor } from "./resource-governor";
import { llmToolRegistry } from "../tools/tool-registry";

type OutputKind = "chat" | "synthesis" | "plan";
type SystemMode = "chat" | "synthesis";

interface ChatMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

interface ContextBudgetPolicy extends LlmContextPolicy {
  provider: string;
  contextWindowTokens: number;
  safeInputTokens: number;
  reservedOutputTokens: number;
  maxSystemChars: number;
  maxRuntimeChars: number;
  maxHistoryMessages: number;
  maxHistoryChars: number;
  maxToolResultChars: number;
  maxToolResultCharsForSynthesis: number;
  maxArtifacts: number;
  maxOutputTokens?: number;
  maxNewTokensDefault?: number;
  maxNewTokensForSynthesis?: number;
  maxNewTokensForPlan?: number;
}

interface TruncatedText {
  text: string;
  truncated: boolean;
}

export interface AgentTurnPrompt {
  system?: string;
  messages: ChatMessage[];
  chatOnly: boolean;
  nativeTools?: boolean;
}

interface ContextInspection {
  chars: number;
  estimatedTokens: number;
  safeInputTokens: number;
  reservedOutputTokens: number;
  messages: number;
}

interface LlmContextBudgetApi {
  MODEL_POLICIES: Record<string, Partial<ContextBudgetPolicy>>;
  getRawPolicy: (modelConfig?: LlmModelConfig | null) => ContextBudgetPolicy;
  getPolicy: (modelConfig?: LlmModelConfig | null) => ContextBudgetPolicy;
  resolveMaxOutputTokens: (modelConfig?: LlmModelConfig | null, kind?: OutputKind) => number;
  estimateTokens: (text: unknown) => number;
  truncateChars: (text: unknown, maxChars: unknown, suffix?: string) => TruncatedText;
  compactHistory: (messages?: unknown[], policy?: ContextBudgetPolicy) => ChatMessage[];
  buildSystemMessage: (options?: { mode?: SystemMode; nativeTools?: boolean; appToolTurn?: boolean; activeToolNames?: string[] }) => string;
  buildChatMessages: (userText: string, options?: { artifact?: LlmArtifact | null; nativeTools?: boolean; appToolTurn?: boolean; activeToolNames?: string[] }) => ChatMessage[];
  buildMinimalChatSystem: () => string;
  buildAgentTurnPrompt: (userText: string, options?: { artifact?: LlmArtifact | null; chatOnly?: boolean; nativeTools?: boolean; appToolTurn?: boolean; activeToolNames?: string[] }) => AgentTurnPrompt;
  mergeSystemIntoUserMessages: (messages?: unknown[]) => ChatMessage[];
  adaptPromptForLocalWeak: (prompt: AgentTurnPrompt, modelConfig?: LlmModelConfig | null) => AgentTurnPrompt;
  enforceBudget: (messages: ChatMessage[], policy?: ContextBudgetPolicy) => ChatMessage[];
  inspectMessages: (messages: ChatMessage[], policy?: ContextBudgetPolicy) => ContextInspection;
}

const DEFAULT_LOCAL_POLICY: ContextBudgetPolicy = {
  provider: "transformersjs",
  contextWindowTokens: 4096,
  // Local browser inference runs beside v86, so these values are deliberately
  // below the theoretical model context. They reduce GPU memory spikes at the
  // beginning of generation in ONNX Runtime/WebGPU.
  safeInputTokens: 1800,
  reservedOutputTokens: 2048,
  maxSystemChars: 900,
  maxRuntimeChars: 420,
  maxHistoryMessages: 2,
  maxHistoryChars: 1000,
  maxToolResultChars: 2400,
  maxToolResultCharsForSynthesis: 1400,
  maxArtifacts: 1,
};

const DEFAULT_OLLAMA_POLICY: ContextBudgetPolicy = {
  provider: "ollama",
  contextWindowTokens: 8192,
  safeInputTokens: 5200,
  reservedOutputTokens: 2048,
  maxSystemChars: 2400,
  maxRuntimeChars: 1100,
  maxHistoryMessages: 6,
  maxHistoryChars: 10000,
  maxToolResultChars: 18000,
  maxToolResultCharsForSynthesis: 7000,
  maxArtifacts: 4,
};

const MODEL_POLICIES: Record<string, Partial<ContextBudgetPolicy>> = {
  "gemma-3-270m-it-onnx-wasm-fp32": {
    ...DEFAULT_LOCAL_POLICY,
    safeInputTokens: 900,
    maxSystemChars: 560,
    maxRuntimeChars: 220,
    maxHistoryMessages: 0,
    maxHistoryChars: 0,
    maxToolResultChars: 900,
    maxToolResultCharsForSynthesis: 700,
  },
  "llama-3.2-1b-instruct-onnx-q4": {
    ...DEFAULT_LOCAL_POLICY,
    safeInputTokens: 1200,
    maxSystemChars: 720,
    maxRuntimeChars: 280,
    maxHistoryMessages: 1,
    maxHistoryChars: 400,
    maxToolResultChars: 2200,
    maxToolResultCharsForSynthesis: 1400,
  },
  "llama-3.2-1b-instruct-onnx-q4f16": {
    ...DEFAULT_LOCAL_POLICY,
    safeInputTokens: 1200,
    maxSystemChars: 720,
    maxRuntimeChars: 280,
    maxHistoryMessages: 1,
    maxHistoryChars: 400,
    maxToolResultChars: 2200,
    maxToolResultCharsForSynthesis: 1400,
  },
  "llama-3.2-3b-instruct-onnx-q4": {
    ...DEFAULT_LOCAL_POLICY,
    safeInputTokens: 1400,
    maxToolResultChars: 2200,
    maxToolResultCharsForSynthesis: 1200,
    maxHistoryMessages: 1,
    maxHistoryChars: 600,
  },
  "llama-3.2-3b-instruct-onnx-q4f16": {
    ...DEFAULT_LOCAL_POLICY,
    safeInputTokens: 1400,
    maxToolResultChars: 2200,
    maxToolResultCharsForSynthesis: 1200,
    maxHistoryMessages: 1,
    maxHistoryChars: 600,
  },
  "qwen2.5-coder-0.5b-instruct-q4": {
    ...DEFAULT_LOCAL_POLICY,
    safeInputTokens: 1100,
    maxSystemChars: 780,
    maxRuntimeChars: 300,
    maxHistoryMessages: 1,
    maxHistoryChars: 350,
    maxToolResultChars: 1800,
    maxToolResultCharsForSynthesis: 1000,
  },
  "qwen3-0.6b-onnx-q4f16": {
    ...DEFAULT_LOCAL_POLICY,
    safeInputTokens: 1100,
    maxSystemChars: 780,
    maxRuntimeChars: 300,
    maxHistoryMessages: 1,
    maxHistoryChars: 350,
    maxToolResultChars: 1800,
    maxToolResultCharsForSynthesis: 1000,
  },
  "qwen2.5-1.5b-instruct-q4": {
    ...DEFAULT_LOCAL_POLICY,
    safeInputTokens: 1350,
    maxSystemChars: 900,
    maxRuntimeChars: 360,
    maxHistoryMessages: 1,
    maxHistoryChars: 700,
    maxToolResultChars: 2600,
    maxToolResultCharsForSynthesis: 1600,
  },
  "smollm2-1.7b-instruct-q4f16": {
    ...DEFAULT_LOCAL_POLICY,
    safeInputTokens: 1300,
    maxSystemChars: 820,
    maxRuntimeChars: 320,
    maxHistoryMessages: 1,
    maxHistoryChars: 600,
    maxToolResultChars: 2200,
    maxToolResultCharsForSynthesis: 1400,
  },
  "custom-transformersjs": {
    ...DEFAULT_LOCAL_POLICY,
  },
  "ollama-qwen3-4b": {
    ...DEFAULT_OLLAMA_POLICY,
    safeInputTokens: 5600,
    maxSystemChars: 2600,
    maxRuntimeChars: 1200,
    maxHistoryMessages: 8,
    maxHistoryChars: 12000,
    maxToolResultChars: 20000,
    maxToolResultCharsForSynthesis: 8000,
  },
  "ollama-qwen3-1.7b": {
    ...DEFAULT_OLLAMA_POLICY,
    safeInputTokens: 5000,
    maxSystemChars: 2200,
    maxRuntimeChars: 1000,
    maxHistoryMessages: 6,
    maxHistoryChars: 9000,
    maxToolResultChars: 16000,
    maxToolResultCharsForSynthesis: 6000,
  },
  "ollama-llama3.2-latest": {
    ...DEFAULT_OLLAMA_POLICY,
    safeInputTokens: 5600,
    maxSystemChars: 2600,
    maxRuntimeChars: 1200,
    maxHistoryMessages: 8,
    maxHistoryChars: 12000,
    maxToolResultChars: 20000,
    maxToolResultCharsForSynthesis: 8000,
  },
  "custom-ollama": {
    ...DEFAULT_OLLAMA_POLICY,
  },
};

const FALLBACK_MODEL: LlmModelConfig = {
  id: "custom-transformersjs",
  engine: "transformersjs",
};

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function messageFromUnknown(value: unknown): ChatMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const role = textValue(record.role);
  const content = textValue(record.content);
  if (!role || !content) return null;
  return { ...record, role, content };
}

function getModelConfig(): LlmModelConfig {
  const llmState = getLlmState();
  return llmState?.activeModel
    || llmModels.find((item) => item.id === llmState?.selectedModelId)
    || llmModels[0]
    || FALLBACK_MODEL;
}

function getRawPolicy(modelConfig: LlmModelConfig | null = getModelConfig()): ContextBudgetPolicy {
  const selected = modelConfig || getModelConfig();
  return {
    ...DEFAULT_LOCAL_POLICY,
    ...(selected.contextPolicy || {}),
    ...(MODEL_POLICIES[selected.id] || {}),
  };
}

function localOutputCeiling(policy: ContextBudgetPolicy, safeInput: number): number {
  if (policy.provider !== "transformersjs") return Infinity;
  if (safeInput <= 1000) return 512;
  if (safeInput <= 1200) return 1024;
  return 1536;
}

function resolveMaxOutputTokens(modelConfig: LlmModelConfig | null = getModelConfig(), kind: OutputKind = "chat"): number {
  const selected = modelConfig || getModelConfig();
  const policy = getRawPolicy(selected);
  const contextWindow = numberValue(
    selected.contextWindowTokens
      ?? policy.contextWindowTokens
      ?? DEFAULT_LOCAL_POLICY.contextWindowTokens,
    DEFAULT_LOCAL_POLICY.contextWindowTokens,
  );
  const safeInput = numberValue(policy.safeInputTokens, DEFAULT_LOCAL_POLICY.safeInputTokens);
  const fromWindow = Math.max(128, contextWindow - safeInput - 48);

  let target = fromWindow;
  const runtimeCap = localOutputCeiling(policy, safeInput);
  if (Number.isFinite(runtimeCap) && runtimeCap > 0) {
    target = Math.min(target, runtimeCap);
  }

  const policyCap = Number(policy.maxOutputTokens);
  if (Number.isFinite(policyCap) && policyCap > 0) {
    target = Math.min(target, policyCap);
  }

  const catalogCap = Number(selected.maxNewTokens);
  if (Number.isFinite(catalogCap) && catalogCap > 0) {
    target = Math.min(target, catalogCap);
  }

  if (kind === "plan") {
    return Math.min(target, policy.provider === "ollama" ? 768 : 192);
  }
  return target;
}

function mergeSystemIntoUserMessages(messages: unknown[] = []): ChatMessage[] {
  const list = messages.map(messageFromUnknown).filter((msg): msg is ChatMessage => Boolean(msg));
  const systemIdx = list.findIndex((msg) => msg.role === "system");
  if (systemIdx < 0) return list;
  const systemText = list[systemIdx].content.trim();
  list.splice(systemIdx, 1);
  if (!systemText) return list.filter((msg) => msg.role !== "system");
  const userIdx = list.findIndex((msg) => msg.role === "user");
  if (userIdx >= 0) {
    list[userIdx] = {
      ...list[userIdx],
      content: `${systemText}\n\n${list[userIdx].content}`,
    };
  } else {
    list.unshift({ role: "user", content: systemText });
  }
  return list;
}

function adaptPromptForLocalWeak(prompt: AgentTurnPrompt, modelConfig: LlmModelConfig | null = getModelConfig()): AgentTurnPrompt {
  const selected = modelConfig || getModelConfig();
  if (selected.agent?.toolCalling !== "weak") return prompt;
  const system = textValue(prompt.system).trim();
  const baseMessages = prompt.messages || [];
  if (!system) {
    return { ...prompt, messages: mergeSystemIntoUserMessages(baseMessages) };
  }
  const withUser = baseMessages.length
    ? baseMessages
    : [{ role: "user", content: t("prompt.respondLang") }];
  return {
    ...prompt,
    system: undefined,
    messages: mergeSystemIntoUserMessages([
      { role: "system", content: system },
      ...withUser,
    ]),
  };
}

function getPolicy(modelConfig: LlmModelConfig | null = getModelConfig()): ContextBudgetPolicy {
  const selected = modelConfig || getModelConfig();
  const base = getRawPolicy(selected);
  const maxChat = resolveMaxOutputTokens(selected, "chat");
  const maxSynth = resolveMaxOutputTokens(selected, "synthesis");
  return {
    ...base,
    maxNewTokensDefault: maxChat,
    maxNewTokensForSynthesis: maxSynth,
    maxNewTokensForPlan: resolveMaxOutputTokens(selected, "plan"),
    reservedOutputTokens: maxChat,
  };
}

function estimateTokens(text: unknown): number {
  const value = textValue(text);
  if (!value) return 0;
  return Math.ceil(value.length / 3);
}

function truncateChars(text: unknown, maxChars: unknown, suffix = t("prompt.contextTrimmed")): TruncatedText {
  const value = textValue(text);
  const limit = Math.max(0, Math.trunc(numberValue(maxChars, 0)));
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, Math.max(0, limit - suffix.length))}${suffix}`, truncated: true };
}

function compactHistory(messages: unknown[] = [], policy = getPolicy()): ChatMessage[] {
  const selected: ChatMessage[] = [];
  let chars = 0;
  const maxMessages = Math.max(0, numberValue(policy.maxHistoryMessages, 0));
  const maxChars = Math.max(0, numberValue(policy.maxHistoryChars, 0));
  if (!maxMessages || !maxChars) return selected;

  const candidates = messages
    .slice(-maxMessages * 2)
    .map(messageFromUnknown)
    .filter((msg): msg is ChatMessage => Boolean(msg));
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const msg = candidates[i];
    if (msg.content.length > maxChars) continue;
    if (chars + msg.content.length > maxChars) break;
    selected.unshift({ role: msg.role, content: msg.content });
    chars += msg.content.length;
  }
  return selected.slice(-maxMessages);
}

function buildRuntimeContext({ nativeTools = false, activeToolNames = null }: { nativeTools?: boolean; activeToolNames?: string[] | null } = {}): string {
  const notReady = t("prompt.toolsNotReady");
  const registryCtx = nativeTools
    ? (llmToolRegistry.buildPromptRuntimeContextCompact({ toolNames: activeToolNames }) || notReady)
    : (llmToolRegistry.buildPromptRuntimeContext() || notReady);
  if (nativeTools) return registryCtx;
  const budget = llmResourceGovernor.getSnapshot();
  return [
    registryCtx,
    t("prompt.resources", {
      llm: budget.llmBusy ? t("common.busy") : t("prompt.free"),
      tool: budget.toolBusy ? t("common.busy") : t("prompt.free"),
      artifact: getLlmState()?.lastArtifactId || "-",
    }),
  ].join("\n");
}

function buildAppToolFormatRule(activeToolNames: string[] = []): string {
  const list = (activeToolNames || []).filter(Boolean).join(", ") || t("prompt.none");
  return [
    t("prompt.appTool.general"),
    t("prompt.appTool.onlyIf"),
    "```tool_call",
    "{\"name\":\"vm.fs.list\",\"arguments\":{\"path\":\"/\",\"maxEntries\":120}}",
    "```",
    t("prompt.appTool.replaceName", { list }),
    t("prompt.appTool.noOutside"),
  ].join("\n");
}

function buildSystemMessage({ mode = "chat", nativeTools = false, appToolTurn = false, activeToolNames = [] }: { mode?: SystemMode; nativeTools?: boolean; appToolTurn?: boolean; activeToolNames?: string[] } = {}): string {
  const policy = getPolicy();
  const baseRaw = textValue(getLlmState()?.settings?.systemPrompt).trim();
  const runtimeRaw = buildRuntimeContext({
    nativeTools,
    activeToolNames: appToolTurn ? activeToolNames : null,
  });

  if (appToolTurn && mode === "chat") {
    const format = buildAppToolFormatRule(activeToolNames);
    const budget = Math.max(180, numberValue(policy.maxSystemChars, DEFAULT_LOCAL_POLICY.maxSystemChars) - format.length - 4);
    const base = truncateChars(baseRaw, Math.floor(budget * 0.55)).text;
    const runtime = truncateChars(runtimeRaw, Math.min(numberValue(policy.maxRuntimeChars, DEFAULT_LOCAL_POLICY.maxRuntimeChars), Math.floor(budget * 0.45))).text;
    const tail = [base, runtime].filter(Boolean).join("\n\n");
    const tailTrim = truncateChars(tail, budget).text;
    return format + (tailTrim ? `\n\n${tailTrim}` : "");
  }

  const toolRules: string[] = [];
  if (nativeTools) {
    toolRules.push(
      t("prompt.native.invokeOne"),
      t("prompt.native.onlyActive"),
      t("prompt.native.preferSpecific"),
      t("prompt.native.explainFail"),
      t("prompt.native.fallbackFormat"),
      "```tool_call",
      "{\"name\":\"vm.fs.list\",\"arguments\":{\"path\":\"/\",\"maxEntries\":120}}",
      "```",
      t("prompt.native.keys"),
    );
  }
  if (mode === "synthesis") {
    toolRules.push(t("prompt.synthesis.rule"));
  }

  const maxBase = Math.floor(numberValue(policy.maxSystemChars, DEFAULT_LOCAL_POLICY.maxSystemChars) * 0.5);
  const parts = [truncateChars(baseRaw, maxBase).text];
  if (toolRules.length) parts.push(toolRules.join("\n"));
  if (runtimeRaw) {
    parts.push(truncateChars(runtimeRaw, numberValue(policy.maxRuntimeChars, DEFAULT_LOCAL_POLICY.maxRuntimeChars)).text);
  }
  return truncateChars(parts.join("\n\n"), numberValue(policy.maxSystemChars, DEFAULT_LOCAL_POLICY.maxSystemChars)).text;
}

function minSystemCharsForBudget(policy: ContextBudgetPolicy, systemContent = ""): number {
  if (/```tool_call/i.test(systemContent)) {
    return Math.max(420, Math.floor(numberValue(policy.maxSystemChars, DEFAULT_LOCAL_POLICY.maxSystemChars) * 0.95));
  }
  return Math.floor(numberValue(policy.maxSystemChars, DEFAULT_LOCAL_POLICY.maxSystemChars) * 0.75);
}

function buildChatMessages(userText: string, { artifact = null, nativeTools = false, appToolTurn = false, activeToolNames = [] }: { artifact?: LlmArtifact | null; nativeTools?: boolean; appToolTurn?: boolean; activeToolNames?: string[] } = {}): ChatMessage[] {
  const policy = getPolicy();
  const history = compactHistory(getLlmState()?.messages || [], policy);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemMessage({
        mode: artifact ? "synthesis" : "chat",
        nativeTools,
        appToolTurn,
        activeToolNames,
      }),
    },
    ...history,
  ];

  if (artifact) {
    const artifactLimit = numberValue(policy.maxToolResultCharsForSynthesis ?? policy.maxToolResultChars, DEFAULT_LOCAL_POLICY.maxToolResultCharsForSynthesis);
    const artifactText = artifactLimit > 0
      ? llmArtifacts.formatArtifactForModel(artifact, { maxChars: artifactLimit })
      : t("prompt.artifact.omittedByPolicy", { id: artifact.id || "-" });
    messages.push({
      role: "user",
      content: [
        t("prompt.artifact.refers"),
        t("prompt.artifact.onlyArtifact"),
        "",
        artifactText,
        "",
        t("prompt.artifact.currentRequest", { user: userText }),
      ].join("\n"),
    });
  } else if (appToolTurn) {
    messages.push({
      role: "user",
      content: [
        userText,
        "",
        t("prompt.appTool.turnHint"),
      ].join("\n"),
    });
  } else {
    messages.push({ role: "user", content: userText });
  }

  return enforceBudget(messages, policy);
}

function buildMinimalChatSystem(): string {
  return t("prompt.minimalChat");
}

function buildAgentTurnPrompt(userText: string, {
  artifact = null,
  chatOnly = false,
  nativeTools = false,
  activeToolNames = [],
}: { artifact?: LlmArtifact | null; chatOnly?: boolean; nativeTools?: boolean; appToolTurn?: boolean; activeToolNames?: string[] } = {}): AgentTurnPrompt {
  if (chatOnly && !artifact) {
    const policy = getPolicy();
    const history = compactHistory(getLlmState()?.messages || [], {
      ...policy,
      maxHistoryMessages: 0,
      maxHistoryChars: 0,
    });
    const messages = [
      ...history,
      { role: "user", content: userText },
    ];
    return {
      system: buildMinimalChatSystem(),
      messages: enforceBudget(messages, {
        ...policy,
        safeInputTokens: 500,
        maxSystemChars: 280,
        maxHistoryMessages: 1,
        maxHistoryChars: 400,
      }),
      chatOnly: true,
    };
  }

  if (nativeTools && !artifact) {
    const wrapped = buildChatMessages(userText, { nativeTools: true, appToolTurn: false, activeToolNames });
    const system = wrapped.find((msg) => msg.role === "system")?.content
      || buildSystemMessage({ mode: "chat", nativeTools: true, appToolTurn: false, activeToolNames });
    const messages = wrapped.filter((msg) => msg.role !== "system");
    return { system, messages, chatOnly: false, nativeTools: true };
  }

  const wrapped = buildChatMessages(userText, { artifact, nativeTools: true });
  const system = wrapped.find((msg) => msg.role === "system")?.content
    || buildSystemMessage({ mode: artifact ? "synthesis" : "chat", nativeTools: true });
  const messages = wrapped.filter((msg) => msg.role !== "system");
  return { system, messages, chatOnly: false };
}

function enforceBudget(messages: ChatMessage[], policy = getPolicy()): ChatMessage[] {
  const maxTokens = Math.max(256, numberValue(policy.safeInputTokens, DEFAULT_LOCAL_POLICY.safeInputTokens));
  let total = estimateTokens(messages.map((msg) => msg.content).join("\n"));
  if (total <= maxTokens) return messages;

  const out = messages.map((msg) => ({ ...msg }));
  const systemIndex = out.findIndex((msg) => msg.role === "system");
  if (systemIndex >= 0) {
    const systemContent = out[systemIndex].content || "";
    out[systemIndex].content = truncateChars(
      systemContent,
      minSystemCharsForBudget(policy, systemContent),
    ).text;
  }
  total = estimateTokens(out.map((msg) => msg.content).join("\n"));
  if (total <= maxTokens) return out;

  while (out.length > 2 && estimateTokens(out.map((msg) => msg.content).join("\n")) > maxTokens) {
    out.splice(1, 1);
  }
  total = estimateTokens(out.map((msg) => msg.content).join("\n"));
  if (total <= maxTokens) return out;

  const last = out[out.length - 1];
  if (!last) return out;
  const prefixTokens = estimateTokens(out.slice(0, -1).map((msg) => msg.content).join("\n"));
  const availableChars = Math.max(1000, (maxTokens - prefixTokens) * 3);
  const compact = llmArtifacts.truncateMiddle(last.content, availableChars);
  last.content = `${compact.text}\n\n${t("prompt.contextTrimmedNote")}`;
  return out;
}

function inspectMessages(messages: ChatMessage[], policy = getPolicy()): ContextInspection {
  const text = messages.map((msg) => msg.content).join("\n");
  return {
    chars: text.length,
    estimatedTokens: estimateTokens(text),
    safeInputTokens: numberValue(policy.safeInputTokens, DEFAULT_LOCAL_POLICY.safeInputTokens),
    reservedOutputTokens: numberValue(policy.reservedOutputTokens, DEFAULT_LOCAL_POLICY.reservedOutputTokens),
    messages: messages.length,
  };
}

export const llmContextBudget: LlmContextBudgetApi = {
  MODEL_POLICIES,
  getRawPolicy,
  getPolicy,
  resolveMaxOutputTokens,
  estimateTokens,
  truncateChars,
  compactHistory,
  buildSystemMessage,
  buildChatMessages,
  buildMinimalChatSystem,
  buildAgentTurnPrompt,
  mergeSystemIntoUserMessages,
  adaptPromptForLocalWeak,
  enforceBudget,
  inspectMessages,
};
