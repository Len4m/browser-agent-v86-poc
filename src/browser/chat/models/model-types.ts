export type LlmEngine = "transformersjs" | "ollama";
export type ToolStrategy = "off" | "heuristic" | "model-first";
export type ToolCallingQuality = "weak" | "fair" | "good";
export type OllamaThinkMode = "auto" | "off" | "on" | "low" | "medium" | "high" | "max";

export interface DiscoveredModel {
  key: string;
  engine: LlmEngine;
  modelId: string;
  label: string;
  sizeBytes?: number;
  downloads?: number;
  modifiedAt?: string;
  gated?: boolean;
  private?: boolean;
  metadata: Record<string, unknown>;
}

export interface ModelCapabilitySignals {
  chat: boolean | null;
  tools: boolean | null;
  thinking: boolean | null;
  vision: boolean | null;
}

export interface ModelInspection {
  modelId: string;
  availableDtypes: string[];
  files: string[];
  downloadSizeBytes?: number;
  selectedDtype?: string;
  contextWindowTokens?: number;
  chatTemplate?: string;
  capabilities: ModelCapabilitySignals;
  warnings: string[];
  inspected: boolean;
  error?: string;
}

export interface TransformersThinkingProfile {
  enabled: boolean;
  tagName: string;
  startWithReasoning: boolean;
}

export interface LlmUserProfile {
  engine: LlmEngine;
  modelId: string;
  toolStrategy: ToolStrategy;
  toolCalling: ToolCallingQuality;
  maxSteps: number;
  maxNativeTools: number;
  activeToolNames: string[];
  temperature: number;
  topP: number;
  contextWindowTokens: number;
  safeInputTokens: number;
  maxOutputTokens: number;
  maxNewTokensForPlan: number;
  showThinking: boolean;
  device?: string;
  dtype?: string;
  reuseGenerationCache?: boolean;
  transformersThinking?: TransformersThinkingProfile;
  ollamaThink?: OllamaThinkMode;
}

export function modelKey(engine: LlmEngine, modelId: string): string {
  return `${engine}:${modelId.trim()}`;
}
