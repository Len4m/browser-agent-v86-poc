// Browser Agent v86 - LLM agent routing heuristics.

import { getLlmState, type LlmModelConfig } from "../state/chat-state";
import { llmNativeToolsPolicy } from "../tools/native-tools-policy";

interface ToolNeedHeuristicOptions {
  activeToolNames?: string[] | null;
}

interface ToolNeedHeuristicResult {
  matched: boolean;
  rule: string;
}

interface AgentRoutingApi {
  flattenErrorMessage: (error: unknown) => string;
  isRecoverableGpuMemoryError: (message: unknown) => boolean;
  shouldEnableNativeTools: (options?: { referencedArtifact?: unknown }) => boolean;
  resolveNativeToolNames: (modelConfig?: LlmModelConfig | null) => string[];
  isLikelyToolPlanText: (text: unknown) => boolean;
  resolveToolNeedHeuristic: (userText: unknown, options?: ToolNeedHeuristicOptions) => ToolNeedHeuristicResult;
  userRequestLikelyNeedsVm: (userText: unknown, options?: ToolNeedHeuristicOptions) => boolean;
}

interface HeuristicRule {
  id: string;
  pattern: RegExp;
}

const NEUTRAL_TOOL_RULES: HeuristicRule[] = [
  { id: "explicit-command", pattern: /\b(curl|wget|httpx|nmap|ffuf|nikto|dig|openssl|whoami|which|uname|ifconfig|netstat|ss)\b/i },
  { id: "ip-command", pattern: /\bip\s+(?:a|addr|address|route|link|neigh)\b/i },
  { id: "absolute-path", pattern: /(?:^|\s)\/(?:etc|var|home|tmp|usr|bin|sbin|opt|root|run|proc|sys)(?:\/[\w.-]+)*\b/i },
  { id: "explicit-tool-name", pattern: /\b(?:vm|web|net|tls)_[a-z0-9_]+\b/i },
  { id: "serial-device", pattern: /\b(?:serial[0-9]+|ttyS[0-9]+)\b/i },
];

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
  return /"(?:name|tool)"\s*:\s*"(?:vm|web|net|tls)_[A-Za-z0-9_]+"/.test(sample);
}

function matchRule(sample: string, rules: HeuristicRule[]): HeuristicRule | null {
  return rules.find((rule) => rule.pattern.test(sample)) || null;
}

function matchesActiveToolName(sample: string, activeToolNames: string[] = []): boolean {
  const lower = sample.toLowerCase();
  return activeToolNames
    .filter((name) => typeof name === "string" && name.includes("_"))
    .some((name) => lower.includes(name.toLowerCase()));
}

function resolveToolNeedHeuristic(userText: unknown, options: ToolNeedHeuristicOptions = {}): ToolNeedHeuristicResult {
  const sample = textValue(userText);
  if (!sample.trim()) return { matched: false, rule: "empty" };

  if (matchesActiveToolName(sample, options.activeToolNames || [])) {
    return { matched: true, rule: "active-tool-name" };
  }
  const neutral = matchRule(sample, NEUTRAL_TOOL_RULES);
  if (neutral) return { matched: true, rule: neutral.id };

  return { matched: false, rule: "none" };
}

function userRequestLikelyNeedsVm(userText: unknown, options: ToolNeedHeuristicOptions = {}): boolean {
  return resolveToolNeedHeuristic(userText, options).matched;
}

export const llmAgentRouting: AgentRoutingApi = {
  flattenErrorMessage,
  isRecoverableGpuMemoryError,
  shouldEnableNativeTools,
  resolveNativeToolNames,
  isLikelyToolPlanText,
  resolveToolNeedHeuristic,
  userRequestLikelyNeedsVm,
};
