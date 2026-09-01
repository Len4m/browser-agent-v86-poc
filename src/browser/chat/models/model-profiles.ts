import type {
  LlmEngine,
  LlmUserProfile,
  ModelInspection,
  OllamaThinkMode,
  ProfilesExportV1,
  ToolCallingQuality,
  ToolStrategy,
} from "./model-types";
import { modelKey } from "./model-types";

export const PROFILES_STORAGE_KEY = "ba.llm.profiles.v1";
export const HF_RECENTS_STORAGE_KEY = "ba.llm.hfRecents.v1";
export const PROFILE_SCHEMA_VERSION = 1 as const;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ImportProfilesResult {
  profiles: Record<string, LlmUserProfile>;
  imported: number;
  invalid: number;
  conflicts: string[];
}

const TOOL_STRATEGIES = new Set<ToolStrategy>(["off", "heuristic", "model-first"]);
const TOOL_QUALITIES = new Set<ToolCallingQuality>(["weak", "fair", "good"]);
const OLLAMA_THINK_MODES = new Set<OllamaThinkMode>(["auto", "off", "on", "low", "medium", "high", "max"]);

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function integer(value: unknown, min: number, max: number): number | null {
  const number = finiteNumber(value);
  return number === null ? null : Math.round(clamp(number, min, max));
}

function numberInRange(value: unknown, min: number, max: number): number | null {
  const number = finiteNumber(value);
  return number === null ? null : clamp(number, min, max);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function defaultProfile(engine: LlmEngine, modelId: string): LlmUserProfile {
  const common = {
    engine,
    modelId: modelId.trim(),
    toolStrategy: "model-first" as const,
    toolCalling: "good" as const,
    activeToolNames: [],
    temperature: 0.15,
    topP: 0.85,
    showThinking: false,
  };
  if (engine === "ollama") {
    return {
      ...common,
      maxSteps: 4,
      maxNativeTools: 10,
      contextWindowTokens: 8192,
      safeInputTokens: 5200,
      maxOutputTokens: 2048,
      maxNewTokensForPlan: 1024,
      ollamaThink: "auto",
    };
  }
  return {
    ...common,
    maxSteps: 3,
    maxNativeTools: 4,
    contextWindowTokens: 4096,
    safeInputTokens: 1800,
    maxOutputTokens: 2048,
    maxNewTokensForPlan: 1024,
    device: "auto",
    dtype: "auto",
    reuseGenerationCache: true,
    transformersThinking: {
      enabled: false,
      tagName: "think",
      startWithReasoning: false,
    },
  };
}

export function validateProfile(value: unknown): LlmUserProfile | null {
  const input = record(value);
  if (!input) return null;
  const engine = input.engine === "ollama" || input.engine === "transformersjs" ? input.engine : null;
  const modelId = typeof input.modelId === "string" ? input.modelId.trim() : "";
  const toolStrategy = TOOL_STRATEGIES.has(input.toolStrategy as ToolStrategy) ? input.toolStrategy as ToolStrategy : null;
  const toolCalling = TOOL_QUALITIES.has(input.toolCalling as ToolCallingQuality) ? input.toolCalling as ToolCallingQuality : null;
  const maxSteps = integer(input.maxSteps, 1, 8);
  const maxNativeTools = integer(input.maxNativeTools, 1, 12);
  const activeToolNames = stringArray(input.activeToolNames);
  const temperature = numberInRange(input.temperature, 0, 2);
  const topP = numberInRange(input.topP, 0, 1);
  const contextWindowTokens = integer(input.contextWindowTokens, 256, 2_000_000);
  const safeInputTokens = integer(input.safeInputTokens, 128, 2_000_000);
  const maxOutputTokens = integer(input.maxOutputTokens, 1, 131_072);
  const maxNewTokensForPlan = integer(input.maxNewTokensForPlan, 1, 131_072);
  if (!engine || !modelId || !toolStrategy || !toolCalling || maxSteps === null || maxNativeTools === null
    || activeToolNames === null || temperature === null || topP === null || contextWindowTokens === null
    || safeInputTokens === null || maxOutputTokens === null || maxNewTokensForPlan === null
    || typeof input.showThinking !== "boolean") return null;

  const base: LlmUserProfile = {
    engine,
    modelId,
    toolStrategy,
    toolCalling,
    maxSteps,
    maxNativeTools,
    activeToolNames,
    temperature,
    topP,
    contextWindowTokens,
    safeInputTokens: Math.min(safeInputTokens, contextWindowTokens),
    maxOutputTokens,
    maxNewTokensForPlan,
    showThinking: input.showThinking,
  };

  if (engine === "ollama") {
    if (!OLLAMA_THINK_MODES.has(input.ollamaThink as OllamaThinkMode)) return null;
    return { ...base, ollamaThink: input.ollamaThink as OllamaThinkMode };
  }

  const thinking = record(input.transformersThinking);
  if (typeof input.device !== "string" || typeof input.dtype !== "string"
    || typeof input.reuseGenerationCache !== "boolean" || !thinking
    || typeof thinking.enabled !== "boolean" || typeof thinking.tagName !== "string"
    || !thinking.tagName.trim() || typeof thinking.startWithReasoning !== "boolean") return null;
  return {
    ...base,
    device: input.device,
    dtype: input.dtype,
    reuseGenerationCache: input.reuseGenerationCache,
    transformersThinking: {
      enabled: thinking.enabled,
      tagName: thinking.tagName.trim(),
      startWithReasoning: thinking.startWithReasoning,
    },
  };
}

export function resolveProfile(
  engine: LlmEngine,
  modelId: string,
  inspection?: ModelInspection | null,
  saved?: LlmUserProfile | null,
  selection?: Partial<LlmUserProfile> | null,
): LlmUserProfile {
  const defaults = defaultProfile(engine, modelId);
  const discovered = inspection?.contextWindowTokens
    ? {
        contextWindowTokens: inspection.contextWindowTokens,
        safeInputTokens: Math.min(defaults.safeInputTokens, Math.max(128, inspection.contextWindowTokens - defaults.maxOutputTokens)),
      }
    : {};
  const merged = { ...defaults, ...discovered, ...(saved || {}), ...(selection || {}), engine, modelId };
  return validateProfile(merged) || defaults;
}

export function effectiveMaxSteps(profile: Pick<LlmUserProfile, "toolCalling" | "maxSteps">): number {
  if (profile.toolCalling === "weak") return 1;
  if (profile.toolCalling === "fair") return Math.min(2, profile.maxSteps);
  return profile.maxSteps;
}

export function loadProfiles(storage: StorageLike): Record<string, LlmUserProfile> {
  try {
    const value = record(JSON.parse(storage.getItem(PROFILES_STORAGE_KEY) || "{}"));
    if (!value) return {};
    const profiles: Record<string, LlmUserProfile> = {};
    for (const candidate of Object.values(value)) {
      const profile = validateProfile(candidate);
      if (profile) profiles[modelKey(profile.engine, profile.modelId)] = profile;
    }
    return profiles;
  } catch {
    return {};
  }
}

export function saveProfile(storage: StorageLike, profile: LlmUserProfile): void {
  const valid = validateProfile(profile);
  if (!valid) throw new Error("Invalid LLM profile");
  const profiles = loadProfiles(storage);
  profiles[modelKey(valid.engine, valid.modelId)] = valid;
  storage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles));
}

export function exportProfiles(profiles: Record<string, LlmUserProfile>): ProfilesExportV1 {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profiles: Object.values(profiles).flatMap((profile) => {
      const valid = validateProfile(profile);
      return valid ? [valid] : [];
    }),
  };
}

export function importProfiles(
  value: unknown,
  existing: Record<string, LlmUserProfile>,
  overwrite = false,
): ImportProfilesResult {
  const root = record(value);
  if (!root || root.schemaVersion !== PROFILE_SCHEMA_VERSION || !Array.isArray(root.profiles)) {
    throw new Error("Invalid LLM profiles root schema");
  }
  const profiles = { ...existing };
  const conflicts: string[] = [];
  let imported = 0;
  let invalid = 0;
  for (const candidate of root.profiles) {
    const profile = validateProfile(candidate);
    if (!profile) {
      invalid += 1;
      continue;
    }
    const key = modelKey(profile.engine, profile.modelId);
    if (profiles[key] && !overwrite) {
      conflicts.push(key);
      continue;
    }
    profiles[key] = profile;
    imported += 1;
  }
  return { profiles, imported, invalid, conflicts };
}

export function loadHfRecents(storage: StorageLike): string[] {
  try {
    const value = JSON.parse(storage.getItem(HF_RECENTS_STORAGE_KEY) || "[]");
    return stringArray(value)?.slice(0, 20) || [];
  } catch {
    return [];
  }
}

export function recordHfRecent(storage: StorageLike, modelId: string): string[] {
  const normalized = modelId.trim();
  const recents = [normalized, ...loadHfRecents(storage).filter((item) => item !== normalized)]
    .filter(Boolean)
    .slice(0, 20);
  storage.setItem(HF_RECENTS_STORAGE_KEY, JSON.stringify(recents));
  return recents;
}
