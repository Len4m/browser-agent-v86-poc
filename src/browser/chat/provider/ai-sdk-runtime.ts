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
  model: unknown;
  modelConfig?: LlmModelConfig | null;
  system?: string;
  messages: unknown[];
  tools?: Record<string, unknown>;
  maxSteps?: number;
  maxTokens?: number;
  synthesisMaxTokens?: number;
  temperature?: number;
  topP?: number;
  needsVm?: boolean;
  enableThinking?: boolean;
  toolCalling?: "weak" | "fair" | "good";
  activeToolNames?: string[] | null;
  abortSignal?: AbortSignal;
  onStreamPart?: (part: unknown) => void;
  onStepFinish?: (event: unknown) => PromiseLike<void> | void;
}

export interface AiSdkRunAgentStreamTurnResult {
  text: string;
  finishReason?: unknown;
  hadToolWork: boolean;
}

export interface AiSdkBridgeApi {
  z: AiSdkZodLike;
  tool: (config: AiSdkToolConfig) => unknown;
  abortActive: () => void;
  unloadModel: () => void;
  loadModel: (modelConfig: LlmModelConfig, options?: { onProgress?: (detail: Record<string, unknown>) => void }) => Promise<void>;
  getActiveModel: () => unknown;
  getActiveModelConfig: () => LlmModelConfig | null;
  isModelReady: () => boolean;
  runAgentStreamTurn: (options: AiSdkRunAgentStreamTurnOptions) => Promise<AiSdkRunAgentStreamTurnResult>;
  textChunkFromStreamPart: (part: unknown) => string;
  reasoningChunkFromStreamPart: (part: unknown) => string;
}

declare const __BA_AI_SDK_BRIDGE_URL__: string;

interface AiSdkBridgeModule {
  aiSdkApi: AiSdkBridgeApi;
}

let aiSdkApi: AiSdkBridgeApi | null = null;
let bridgeReady: Promise<AiSdkBridgeApi | null> | null = null;

async function importAiSdkBridge(): Promise<AiSdkBridgeApi | null> {
  if (aiSdkApi) return aiSdkApi;
  try {
    const bridgeUrl = new URL(__BA_AI_SDK_BRIDGE_URL__, import.meta.url).href;
    const module = await import(bridgeUrl) as Partial<AiSdkBridgeModule>;
    if (!module.aiSdkApi) throw new Error("AI SDK bridge module did not export aiSdkApi");
    aiSdkApi = module.aiSdkApi;
    return aiSdkApi;
  } catch (error) {
    console.error("[llm] AI SDK bridge import failed", error);
    return null;
  }
}

export function getAiSdk(): AiSdkBridgeApi | null {
  return aiSdkApi;
}

export async function getAiSdkReady(): Promise<AiSdkBridgeApi | null> {
  if (aiSdkApi) return aiSdkApi;
  bridgeReady ||= importAiSdkBridge();
  const api = await bridgeReady;
  if (!api) bridgeReady = null;
  return api;
}
