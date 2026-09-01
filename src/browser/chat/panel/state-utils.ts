import type { LlmCapabilities } from "../state/capabilities";
import {
  defaultModelConfig,
  getLlmState,
  getSelectedLlmModel,
  type LlmModelConfig,
  type LlmState,
} from "../state/chat-state";
import { isRecord } from "./dom-utils";

export function ensureLlmState(): LlmState {
  const llm = getLlmState();
  if (!llm) throw new Error("LLM state is not initialized");
  return llm;
}

export function getSelectedModel(): LlmModelConfig {
  return getSelectedLlmModel() || defaultModelConfig("transformersjs", "");
}

export function isLlmCapabilities(value: unknown): value is LlmCapabilities {
  return isRecord(value) && "webgpu" in value && "shaderF16" in value;
}
