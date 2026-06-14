// Browser Agent v86 - LLM tool execution coordinator.
//
// VM execution stays on the main thread because it talks to the v86 serial
// adapter and console state. execVm returns a Promise and completes from serial
// events/timeouts, so browser rendering remains non-blocking.

import { NL } from "../../app/state";
import { t } from "../../app/i18n";
import { getLlmState, llmEventsApi } from "../state/chat-state";
import { showBaModal } from "../../ui/modal";
import { logTool } from "../../ui/status-controls";
import { execVm } from "../../vm/operations";
import { llmToolRegistry } from "./tool-registry";
import type { NormalizedToolCall, ToolDefinition, ToolExecutionResult, ToolExecutorApi, RunToolOptions } from "./types";

const STORAGE_KEY = "ba.llm.toolAutonomyMaxLevel";

function nowId(prefix = "tool"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Error";
}

function getAutonomyMaxLevel(): number {
  const fromState = Number(getLlmState()?.settings?.toolAutonomyMaxLevel);
  if (Number.isFinite(fromState)) return fromState;
  const stored = Number(localStorage.getItem(STORAGE_KEY) || "1");
  return Number.isFinite(stored) ? stored : 1;
}

function setAutonomyMaxLevel(level: unknown): number {
  const value = Math.max(0, Math.min(99, Number(level) || 0));
  const llmState = getLlmState();
  if (llmState?.settings) llmState.settings.toolAutonomyMaxLevel = value;
  localStorage.setItem(STORAGE_KEY, String(value));
  llmEventsApi.emit("tool-policy", { autonomyMaxLevel: value });
  return value;
}

function shouldConfirm(toolCall: NormalizedToolCall): boolean {
  return Number(toolCall.riskLevel || 0) > getAutonomyMaxLevel();
}

function shortJson(value: unknown, max = 900): string {
  const text = JSON.stringify(value, null, 2) || "";
  return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

async function confirmToolCall(toolCall: NormalizedToolCall, toolDef: ToolDefinition): Promise<boolean> {
  if (!shouldConfirm(toolCall)) return true;
  const decision = await showBaModal({
    title: t("tools.exec.confirm.title"),
    message: t("common.levelChip", { name: toolDef.label || toolDef.name, level: toolDef.riskLevel }),
    detail: `${toolCall.reason || t("tools.exec.confirm.noReason")}\n\n${t("tools.exec.confirm.argsLabel")}\n${shortJson(toolCall.arguments)}`,
    buttons: [
      { id: "cancel", label: t("common.cancel"), variant: "secondary", cancel: true },
      { id: "run", label: t("tools.exec.confirm.run"), variant: toolDef.riskLevel >= 3 ? "danger" : "primary" },
    ],
  });
  return decision === "run";
}

async function runTool(toolCall: unknown, { source = "agent" }: RunToolOptions = {}): Promise<ToolExecutionResult> {
  const normalized = llmToolRegistry.normalizeToolCall(toolCall);
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

  const allowed = await confirmToolCall(normalized, toolDef);
  if (!allowed) {
    return {
      id: nowId("tool-cancelled"),
      ok: false,
      cancelled: true,
      code: 130,
      stdout: "",
      stderr: t("common.toolCancelledByUser"),
      summary: t("common.toolCancelledByUser"),
      toolCall: normalized,
    };
  }

  const command = toolDef.buildCommand(normalized.arguments);
  const id = nowId("tool-run");
  llmEventsApi.emit("tool-start", { id, toolCall: normalized, tool: toolDef, source });
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
    llmEventsApi.emit("tool-done", { id, result });
    return result;
  } catch (error) {
    const result: ToolExecutionResult = {
      id,
      ok: false,
      code: 1,
      stdout: "",
      stderr: errorMessage(error),
      summary: t("tools.exec.errorRunning", { tool: toolDef.name }),
      toolCall: normalized,
    };
    llmEventsApi.emit("tool-error", { id, result });
    return result;
  }
}

export const llmToolExecutor: ToolExecutorApi = {
  getAutonomyMaxLevel,
  setAutonomyMaxLevel,
  runTool,
};

// Keep persisted setting synchronized at boot.
setAutonomyMaxLevel(getAutonomyMaxLevel());
