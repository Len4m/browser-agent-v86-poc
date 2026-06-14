import type { LlmModelConfig } from "../state/chat-state";

export interface AiSdkSchemaLike {
  describe: (text: string) => AiSdkSchemaLike;
  optional: () => AiSdkSchemaLike;
  nullable?: () => AiSdkSchemaLike;
  passthrough?: () => AiSdkSchemaLike;
}

export interface AiSdkZodLike {
  string: () => AiSdkSchemaLike;
  number: () => AiSdkSchemaLike;
  boolean: () => AiSdkSchemaLike;
  array: (schema: AiSdkSchemaLike) => AiSdkSchemaLike;
  object: (shape: Record<string, AiSdkSchemaLike>) => AiSdkSchemaLike;
}

export interface AiSdkToolConfig {
  description: string;
  inputSchema: AiSdkSchemaLike;
  outputSchema: AiSdkSchemaLike;
  toModelOutput: (args: { output?: unknown }) => { type: "text"; value: string };
  execute: (args: unknown) => Promise<unknown>;
}

export interface AiSdkRunAgentStreamTurnOptions {
  [key: string]: unknown;
  onStreamPart?: (part: unknown) => void;
  onStepFinish?: (event: unknown) => PromiseLike<void> | void;
}

export interface AiSdkRunAgentStreamTurnResult {
  [key: string]: unknown;
  text?: string;
  finishReason?: unknown;
  hadToolWork?: boolean;
}

export interface AiSdkGlobalApi {
  z: AiSdkZodLike;
  tool: (config: AiSdkToolConfig) => unknown;
  abortActive?: () => void;
  unloadModel: () => void;
  loadModel: (modelConfig: LlmModelConfig, options?: { onProgress?: (detail: Record<string, unknown>) => void }) => Promise<void>;
  getActiveModel: () => unknown;
  getActiveModelConfig?: () => LlmModelConfig | null;
  isModelReady?: () => boolean;
  runAgentStreamTurn: (options: AiSdkRunAgentStreamTurnOptions) => Promise<AiSdkRunAgentStreamTurnResult>;
  textChunkFromStreamPart: (part: unknown) => string;
  reasoningChunkFromStreamPart: (part: unknown) => string;
  [key: string]: unknown;
}

type AiSdkWindow = Window & typeof globalThis & {
  BA_AISDK?: AiSdkGlobalApi;
  BA_AISDK_READY?: Promise<unknown>;
};

export function getAiSdk(): AiSdkGlobalApi | null {
  return (window as AiSdkWindow).BA_AISDK || null;
}

export function getAiSdkReady(): Promise<unknown> {
  return (window as AiSdkWindow).BA_AISDK_READY || Promise.resolve(false);
}
