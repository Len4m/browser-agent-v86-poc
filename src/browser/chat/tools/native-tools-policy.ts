// Browser Agent v86 - native tools policy.
// Per-model caps on how many AI SDK tools are registered. User picks subset in
// the LLM panel through direct ESM imports.

import { getEffectiveVmProfileId } from "../../vm/profile-config";
import { defaultModelConfig, getLlmState, getSelectedLlmModel, llmEventsApi, type LlmModelConfig } from "../state/chat-state";
import { saveLastProfile } from "../models/model-profiles";
import { normalizeToolName } from "./shared";
import { llmToolRegistry } from "./tool-registry";

const FALLBACK_MODEL: LlmModelConfig = defaultModelConfig("transformersjs", "");

export interface NativeToolsPolicyApi {
  getMaxNativeTools: (modelConfig?: LlmModelConfig | null) => number;
  getDefaultToolNames: (modelConfig?: LlmModelConfig | null, profileId?: string) => string[];
  resolveActiveToolNames: (modelConfig?: LlmModelConfig | null, profileId?: string) => string[];
  setActiveToolNames: (modelConfig: LlmModelConfig | null | undefined, names: string[], profileId?: string) => string[];
  toggleToolName: (modelConfig: LlmModelConfig | null | undefined, name: string, enabled: boolean, profileId?: string) => string[];
  listAvailableToolNames: (modelConfig?: LlmModelConfig | null, profileId?: string) => string[];
}

function getModelConfig(modelConfig?: LlmModelConfig | null): LlmModelConfig {
  const llmState = getLlmState();
  return modelConfig
    || llmState?.activeModel
    || getSelectedLlmModel()
    || FALLBACK_MODEL;
}

function getMaxNativeTools(modelConfig?: LlmModelConfig | null): number {
  const agent = getModelConfig(modelConfig).agent;
  const max = Number(agent?.maxNativeTools);
  if (Number.isFinite(max) && max > 0) return Math.min(12, Math.floor(max));
  return 4;
}

function listAvailableToolNames(_modelConfig?: LlmModelConfig | null, profileId = getEffectiveVmProfileId()): string[] {
  return llmToolRegistry.listToolNames({ profileId });
}

function filterProfileOrdered(names: string[], modelConfig?: LlmModelConfig | null, profileId = getEffectiveVmProfileId()): string[] {
  const selected = new Set(names.map(normalizeToolName));
  return listAvailableToolNames(modelConfig, profileId).filter((name) => selected.has(name));
}

function getDefaultToolNames(modelConfig?: LlmModelConfig | null, profileId = getEffectiveVmProfileId()): string[] {
  return listAvailableToolNames(modelConfig, profileId).slice(0, getMaxNativeTools(modelConfig));
}

function syncStateNativeTools(names: string[]): void {
  const llmState = getLlmState();
  if (llmState?.settings) llmState.settings.nativeToolNames = names;
}

function resolveActiveToolNames(modelConfig?: LlmModelConfig | null, profileId = getEffectiveVmProfileId()): string[] {
  const cfg = getModelConfig(modelConfig);
  const max = getMaxNativeTools(cfg);
  const configured = cfg.profile?.activeToolNames || cfg.agent?.activeToolNames || [];
  const compatible = configured.length ? filterProfileOrdered(configured, cfg, profileId) : [];
  const out = (compatible.length ? compatible : listAvailableToolNames(cfg, profileId)).slice(0, max);
  syncStateNativeTools(out);
  return out;
}

function setActiveToolNames(modelConfig: LlmModelConfig | null | undefined, names: string[], profileId = getEffectiveVmProfileId()): string[] {
  const cfg = getModelConfig(modelConfig);
  const max = getMaxNativeTools(cfg);
  const clean = filterProfileOrdered(names, cfg, profileId).slice(0, max);
  if (cfg.profile) {
    cfg.profile.activeToolNames = clean;
    if (cfg.agent) cfg.agent.activeToolNames = clean;
    saveLastProfile(localStorage, cfg.profile);
  }
  syncStateNativeTools(clean);
  llmEventsApi.emit("native-tools", { names: clean, max, modelId: cfg.id });
  return clean;
}

function toggleToolName(modelConfig: LlmModelConfig | null | undefined, name: string, enabled: boolean, profileId = getEffectiveVmProfileId()): string[] {
  const cfg = getModelConfig(modelConfig);
  const max = getMaxNativeTools(cfg);
  const current = resolveActiveToolNames(cfg, profileId);
  let next: string[];
  const normalizedName = normalizeToolName(name);
  if (enabled) {
    if (current.includes(normalizedName)) return current;
    if (current.length >= max) return current;
    next = [...current, normalizedName];
  } else {
    next = current.filter((item) => item !== normalizedName);
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
