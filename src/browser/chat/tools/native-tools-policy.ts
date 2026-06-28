// Browser Agent v86 - native tools policy.
// Per-model caps on how many AI SDK tools are registered. User picks subset in
// the LLM panel through direct ESM imports.

import { state } from "../../app/state";
import { getLlmState, llmEventsApi, llmModels, type LlmModelConfig } from "../state/chat-state";
import { llmToolRegistry } from "./tool-registry";

const STORAGE_PREFIX = "ba.llm.nativeTools.";

const FALLBACK_MODEL: LlmModelConfig = {
  id: "custom-transformersjs",
  engine: "transformersjs",
  agent: {
    maxSteps: 3,
    maxNativeTools: 4,
    toolCalling: "fair",
    defaultNativeTools: [],
  },
};

export interface NativeToolsPolicyApi {
  getMaxNativeTools: (modelConfig?: LlmModelConfig | null) => number;
  getDefaultToolNames: (modelConfig?: LlmModelConfig | null, profileId?: string) => string[];
  resolveActiveToolNames: (modelConfig?: LlmModelConfig | null, profileId?: string) => string[];
  setActiveToolNames: (modelConfig: LlmModelConfig | null | undefined, names: string[], profileId?: string) => string[];
  toggleToolName: (modelConfig: LlmModelConfig | null | undefined, name: string, enabled: boolean, profileId?: string) => string[];
  listAvailableToolNames: (modelConfig?: LlmModelConfig | null, profileId?: string) => string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function activeRuntimeProfileId(): string {
  if (isRecord(state.activeRuntime) && isRecord(state.activeRuntime.profile)) {
    return textValue(state.activeRuntime.profile.id);
  }
  return "";
}

function getProfileId(): string {
  const stateProfile = activeRuntimeProfileId();
  if (stateProfile && stateProfile !== "manual") return stateProfile;
  const profileSelect = document.getElementById("vm-profile");
  return profileSelect instanceof HTMLSelectElement ? profileSelect.value : "manual";
}

function getModelConfig(modelConfig?: LlmModelConfig | null): LlmModelConfig {
  const llmState = getLlmState();
  return modelConfig
    || llmState?.activeModel
    || llmModels.find((model) => model.id === llmState?.selectedModelId)
    || llmModels[0]
    || FALLBACK_MODEL;
}

function getMaxNativeTools(modelConfig?: LlmModelConfig | null): number {
  const agent = getModelConfig(modelConfig).agent;
  const max = Number(agent?.maxNativeTools);
  if (Number.isFinite(max) && max > 0) return Math.min(12, Math.floor(max));
  return 4;
}

function listAvailableToolNames(_modelConfig?: LlmModelConfig | null, profileId = getProfileId()): string[] {
  return llmToolRegistry.listToolNames({ profileId });
}

function getDefaultToolNames(modelConfig?: LlmModelConfig | null, profileId = getProfileId()): string[] {
  return listAvailableToolNames(modelConfig, profileId).slice(0, getMaxNativeTools(modelConfig));
}

function loadStored(modelId: string): string[] | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${modelId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => textValue(item)).filter(Boolean) : null;
  } catch {
    return null;
  }
}

function saveStored(modelId: string, names: string[]): void {
  localStorage.setItem(`${STORAGE_PREFIX}${modelId}`, JSON.stringify(names));
}

function syncStateNativeTools(names: string[]): void {
  const llmState = getLlmState();
  if (llmState?.settings) llmState.settings.nativeToolNames = names;
}

function resolveActiveToolNames(modelConfig?: LlmModelConfig | null, profileId = getProfileId()): string[] {
  const cfg = getModelConfig(modelConfig);
  const max = getMaxNativeTools(cfg);
  const available = new Set(listAvailableToolNames(cfg, profileId));
  const stored = loadStored(cfg.id);
  const defaults = getDefaultToolNames(cfg, profileId);
  const source = stored !== null ? stored : defaults;
  let chosen = source.filter((name) => available.has(name));
  if (!chosen.length && stored === null) chosen = defaults.filter((name) => available.has(name));
  const out = chosen.slice(0, max);
  syncStateNativeTools(out);
  return out;
}

function setActiveToolNames(modelConfig: LlmModelConfig | null | undefined, names: string[], profileId = getProfileId()): string[] {
  const cfg = getModelConfig(modelConfig);
  const max = getMaxNativeTools(cfg);
  const available = new Set(listAvailableToolNames(cfg, profileId));
  const clean = [...new Set(names.filter((name) => available.has(name)))].slice(0, max);
  saveStored(cfg.id, clean);
  syncStateNativeTools(clean);
  llmEventsApi.emit("native-tools", { names: clean, max, modelId: cfg.id });
  return clean;
}

function toggleToolName(modelConfig: LlmModelConfig | null | undefined, name: string, enabled: boolean, profileId = getProfileId()): string[] {
  const cfg = getModelConfig(modelConfig);
  const max = getMaxNativeTools(cfg);
  const current = resolveActiveToolNames(cfg, profileId);
  let next: string[];
  if (enabled) {
    if (current.includes(name)) return current;
    if (current.length >= max) return current;
    next = [...current, name];
  } else {
    next = current.filter((item) => item !== name);
  }
  return setActiveToolNames(cfg, next, profileId);
}

export const llmNativeToolsPolicy: NativeToolsPolicyApi = {
  getMaxNativeTools,
  getDefaultToolNames,
  resolveActiveToolNames,
  setActiveToolNames,
  toggleToolName,
  listAvailableToolNames,
};
