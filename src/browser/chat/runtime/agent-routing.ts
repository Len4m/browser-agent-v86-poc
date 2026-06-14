// Browser Agent v86 - LLM agent routing heuristics.

import { getLlmState, type LlmModelConfig } from "../state/chat-state";
import { llmNativeToolsPolicy } from "../tools/native-tools-policy";

interface AgentRoutingApi {
  flattenErrorMessage: (error: unknown) => string;
  isRecoverableGpuMemoryError: (message: unknown) => boolean;
  shouldEnableNativeTools: (options?: { referencedArtifact?: unknown }) => boolean;
  resolveNativeToolNames: (modelConfig?: LlmModelConfig | null) => string[];
  isLikelyToolPlanText: (text: unknown) => boolean;
  userRequestLikelyNeedsVm: (userText: unknown) => boolean;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function flattenErrorMessage(error: unknown): string {
  const parts = [
    isRecord(error) ? error.message : null,
    isRecord(error) && isRecord(error.cause) ? error.cause.message : null,
    error instanceof Error ? error.message : textValue(error),
  ].map(textValue).filter(Boolean);
  return Array.from(new Set(parts)).join(" | ");
}

function isRecoverableGpuMemoryError(message: unknown): boolean {
  return /out of device memory|VK_ERROR_OUT_OF_DEVICE_MEMORY|WebGPU validation failed|Invalid Buffer|Device lost|failed to call OrtRun|CreateBuffer|null function|function signature mismatch|unaligned accesses|Instance reference no longer exists|memoria GPU agotada|WebGPU inválido/i.test(textValue(message));
}

function shouldEnableNativeTools({ referencedArtifact = null }: { referencedArtifact?: unknown } = {}): boolean {
  if (referencedArtifact) return false;
  const modelConfig = getLlmState()?.activeModel || null;
  const names = llmNativeToolsPolicy.resolveActiveToolNames(modelConfig);
  return names.length > 0;
}

function resolveNativeToolNames(modelConfig?: LlmModelConfig | null): string[] {
  return llmNativeToolsPolicy.resolveActiveToolNames(modelConfig);
}

function isLikelyToolPlanText(text: unknown): boolean {
  const sample = textValue(text);
  if (!sample) return false;
  if (/```(?:tool[_-]?call|json)/i.test(sample)) return true;
  return /"(?:name|tool)"\s*:\s*"(?:vm|web|net|tls)\.[A-Za-z0-9_.]+"/.test(sample);
}

function userRequestLikelyNeedsVm(userText: unknown): boolean {
  const sample = textValue(userText).toLowerCase();
  return /\b(vm|lista|listar|listado|archivos?|ficheros?|directorios?|carpetas?|\/etc|\/var|\/home|serial|curl|wget|ip\b|red\b|docker|alpine|kernel|ejecuta|comando|which|leer|lee\b|muestra|mostrar|contenido|ruta)\b/i.test(sample)
    || /\bde\s+\/[\w./-]+/.test(sample)
    || /\ben\s+\/[\w./-]+/.test(sample);
}

export const llmAgentRouting: AgentRoutingApi = {
  flattenErrorMessage,
  isRecoverableGpuMemoryError,
  shouldEnableNativeTools,
  resolveNativeToolNames,
  isLikelyToolPlanText,
  userRequestLikelyNeedsVm,
};
