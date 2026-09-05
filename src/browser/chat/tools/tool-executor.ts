// Browser Agent v86 - LLM tool execution coordinator.
//
// VM execution stays on the main thread because it talks to the v86 serial
// adapter and console state. execVm returns a Promise and completes from serial
// events/timeouts, so browser rendering remains non-blocking.

import { NL } from "../../app/state";
import { t } from "../../app/i18n";
import { errorMessage } from "../../app/value-utils";
import { getLlmState, llmEventsApi } from "../state/chat-state";
import { showBaModal } from "../../ui/modal";
import { logTool } from "../../ui/status-controls";
import { execVm } from "../../vm/operations";
import type { AiSdkApprovalDecision, AiSdkApprovalRequest, AiSdkToolApprovalStatus } from "../provider/ai-sdk-runtime";
import { isRecord, normalizeToolName, textValue, throwIfAborted, toToolArgs } from "./shared";
import { llmToolRegistry } from "./tool-registry";
import type {
  NormalizedToolCall,
  RequestToolApprovalOptions,
  RunToolOptions,
  ToolApprovalPolicyOptions,
  ToolExecutionResult,
  ToolExecutorApi,
} from "./types";

const STORAGE_KEY = "ba.llm.toolAutonomyMaxLevel";
let inMemoryAutonomyMaxLevel: number | null = null;

function nowId(prefix = "tool"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function activeToolSet(names: string[] | null | undefined): Set<string> | null {
  return Array.isArray(names) ? new Set(names.map(normalizeToolName).filter(Boolean)) : null;
}

function getAutonomyMaxLevel(): number {
  const fromState = Number(getLlmState()?.settings?.toolAutonomyMaxLevel);
  if (Number.isFinite(fromState)) return fromState;
  if (inMemoryAutonomyMaxLevel !== null) return inMemoryAutonomyMaxLevel;
  let storedValue: string | null = null;
  try {
    storedValue = typeof window === "undefined" ? null : window.localStorage?.getItem(STORAGE_KEY) || null;
  } catch {
    // Storage can be unavailable in privacy mode and non-browser tests.
  }
  const stored = Number(storedValue || "1");
  inMemoryAutonomyMaxLevel = Number.isFinite(stored) ? stored : 1;
  return inMemoryAutonomyMaxLevel;
}

function setAutonomyMaxLevel(level: unknown): number {
  const value = Math.max(0, Math.min(99, Number(level) || 0));
  inMemoryAutonomyMaxLevel = value;
  const llmState = getLlmState();
  if (llmState?.settings) llmState.settings.toolAutonomyMaxLevel = value;
  try {
    if (typeof window !== "undefined") window.localStorage?.setItem(STORAGE_KEY, String(value));
  } catch {
    // Keep the in-memory policy even when persistence is unavailable.
  }
  llmEventsApi.emit("tool-policy", { autonomyMaxLevel: value });
  return value;
}

function shortJson(value: unknown, max = 900): string {
  const text = JSON.stringify(value, null, 2) || "";
  return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

function normalizeToolCall(toolCall: unknown, toolCallId?: string): NormalizedToolCall {
  const record = isRecord(toolCall) ? toolCall : {};
  const normalized = llmToolRegistry.normalizeToolCall({
    type: "tool_call",
    tool: record.toolName ?? record.tool ?? record.name,
    arguments: record.input ?? record.arguments,
    reason: record.reason,
  });
  const resolvedToolCallId = toolCallId || textValue(record.toolCallId);
  return resolvedToolCallId ? { ...normalized, toolCallId: resolvedToolCallId } : normalized;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

function getToolOperationKey(toolCall: unknown): string {
  try {
    const normalized = normalizeToolCall(toolCall);
    return `${normalized.tool}:${stableJson(normalized.arguments)}`;
  } catch {
    const record = isRecord(toolCall) ? toolCall : {};
    const name = normalizeToolName(record.toolName ?? record.tool ?? record.name);
    return `${name}:${stableJson(toToolArgs(record.input ?? record.arguments))}`;
  }
}

function deniedOperationSet(values: ToolApprovalPolicyOptions["deniedOperationKeys"]): ReadonlySet<string> {
  if (values instanceof Set) return values;
  return new Set(values || []);
}

function getToolApprovalStatus(
  toolCall: unknown,
  { allowedToolNames = null, deniedOperationKeys = null }: ToolApprovalPolicyOptions = {},
): AiSdkToolApprovalStatus {
  const record = isRecord(toolCall) ? toolCall : {};
  const requestedName = normalizeToolName(record.toolName ?? record.tool ?? record.name);
  const allowed = activeToolSet(allowedToolNames);
  if (allowed && !allowed.has(requestedName)) {
    return {
      type: "denied",
      reason: t("tools.error.toolNotActive", { name: requestedName }),
    };
  }

  let normalized: NormalizedToolCall;
  try {
    normalized = normalizeToolCall(toolCall);
  } catch (error) {
    return { type: "denied", reason: errorMessage(error) };
  }

  if (deniedOperationSet(deniedOperationKeys).has(getToolOperationKey(normalized))) {
    return { type: "denied", reason: t("common.toolCancelledByUser") };
  }

  if (Number(normalized.riskLevel || 0) > getAutonomyMaxLevel()) {
    return {
      type: "user-approval",
      reason: textValue(record.reason) || t("tools.exec.reasonModelRequest", { name: normalized.tool }),
    };
  }
  return "not-applicable";
}

async function requestToolApproval(
  request: AiSdkApprovalRequest,
  { abortSignal }: RequestToolApprovalOptions = {},
): Promise<AiSdkApprovalDecision> {
  throwIfAborted(abortSignal);
  let toolCall: NormalizedToolCall;
  try {
    toolCall = normalizeToolCall(request.toolCall, request.toolCall.toolCallId);
  } catch (error) {
    return {
      type: "tool-approval-response",
      approvalId: request.approvalId,
      approved: false,
      reason: errorMessage(error),
    };
  }
  const toolDef = llmToolRegistry.getTool(toolCall.tool);
  if (!toolDef) {
    return {
      type: "tool-approval-response",
      approvalId: request.approvalId,
      approved: false,
      reason: t("tools.error.toolNotAvailable", { name: toolCall.tool }),
    };
  }

  const decision = await showBaModal({
    title: t("tools.exec.confirm.title"),
    message: t("common.levelChip", { name: toolDef.label || toolDef.name, level: toolDef.riskLevel }),
    detail: `${request.reason || toolCall.reason || t("tools.exec.confirm.noReason")}\n\n${t("tools.exec.confirm.argsLabel")}\n${shortJson(toolCall.arguments)}`,
    buttons: [
      { id: "cancel", label: t("common.cancel"), variant: "secondary", cancel: true },
      { id: "run", label: t("tools.exec.confirm.run"), variant: toolDef.riskLevel >= 3 ? "danger" : "primary" },
    ],
    abortSignal,
  });
  const approved = decision === "run";
  return {
    type: "tool-approval-response",
    approvalId: request.approvalId,
    approved,
    ...(approved ? {} : { reason: t("common.toolCancelledByUser") }),
  };
}

async function runTool(
  toolCall: unknown,
  { source = "agent", allowedToolNames = null, toolCallId, abortSignal }: RunToolOptions = {},
): Promise<ToolExecutionResult> {
  throwIfAborted(abortSignal);
  const normalized = normalizeToolCall(toolCall, toolCallId);
  const allowed = activeToolSet(allowedToolNames);
  if (allowed && !allowed.has(normalized.tool)) {
    const message = t("tools.error.toolNotActive", { name: normalized.tool });
    return {
      id: nowId("tool-not-active"),
      ok: false,
      code: 126,
      stdout: "",
      stderr: message,
      summary: message,
      toolCall: normalized,
    };
  }

  const toolDef = llmToolRegistry.getTool(normalized.tool);
  if (!toolDef) throw new Error(t("tools.error.toolNotAvailable", { name: normalized.tool }));

  if (toolDef.requiresVm || toolDef.requiresConsole) {
    try {
      llmToolRegistry.assertVmToolPreconditions();
    } catch (error) {
      return {
        id: nowId("tool-precondition"),
        ok: false,
        code: 1,
        stdout: "",
        stderr: errorMessage(error),
        summary: t("tools.exec.preconditionsFailed"),
        toolCall: normalized,
      };
    }
  }

  throwIfAborted(abortSignal);
  const command = toolDef.buildCommand(normalized.arguments);
  const id = nowId("tool-run");
  llmEventsApi.emit("tool-start", { id, toolCallId: normalized.toolCallId, toolCall: normalized, tool: toolDef, source });
  logTool(`${NL}[agent-tool] ${toolDef.name} nivel=${toolDef.riskLevel} args=${JSON.stringify(normalized.arguments)}${NL}`);

  try {
    const raw = await execVm(command, {
      lock: true,
      label: t("tools.exec.runningLabel", { label: toolDef.label || toolDef.name }),
      timeoutMs: toolDef.timeoutMs || 15000,
      maxOutputBytes: toolDef.maxOutputBytes || 32768,
      log: false,
      targetTools: true,
    });
    throwIfAborted(abortSignal);
    if (raw.code === 130) {
      return {
        id,
        ok: false,
        cancelled: true,
        code: 130,
        stdout: raw.stdout || "",
        stderr: raw.stderr || t("common.toolCancelled"),
        summary: t("common.toolCancelledByUser"),
        toolCall: normalized,
      };
    }

    const result: ToolExecutionResult = toolDef.formatResult
      ? toolDef.formatResult(raw, normalized.arguments)
      : { ...raw };
    result.id = id;
    result.toolCall = normalized;
    llmEventsApi.emit("tool-done", { id, toolCallId: normalized.toolCallId, result });
    return result;
  } catch (error) {
    if (abortSignal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    const result: ToolExecutionResult = {
      id,
      ok: false,
      code: 1,
      stdout: "",
      stderr: errorMessage(error),
      summary: t("tools.exec.errorRunning", { tool: toolDef.name }),
      toolCall: normalized,
    };
    llmEventsApi.emit("tool-error", { id, toolCallId: normalized.toolCallId, result });
    return result;
  }
}

export const llmToolExecutor: ToolExecutorApi = {
  getAutonomyMaxLevel,
  setAutonomyMaxLevel,
  getToolOperationKey,
  getToolApprovalStatus,
  requestToolApproval,
  runTool,
};

// Keep persisted setting synchronized at boot.
setAutonomyMaxLevel(getAutonomyMaxLevel());
