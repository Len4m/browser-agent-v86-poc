// Browser Agent v86 - LLM tool result policy.
// Decides if a tool result should be shown directly, synthesized by the local
// model, or kept as an artifact only. The current policy is conservative:
// show/store the real result and avoid hallucinated summaries.

import { t } from "../../app/i18n";
import { llmArtifacts, type LlmArtifact } from "./artifact-store";
import type { NormalizedToolCall, ToolExecutionResult } from "../tools/types";

export interface ToolResultDecision {
  mode: "direct" | "synthesize" | "artifact";
  reason: string;
}

export interface DecideAfterToolOptions {
  userText?: unknown;
  toolCall?: NormalizedToolCall | null;
  result?: ToolExecutionResult | null;
  artifact?: LlmArtifact | null;
}

export interface ToolResultPolicyApi {
  decideAfterTool: (options?: DecideAfterToolOptions) => ToolResultDecision;
  selectArtifactForUserText: (userText: unknown) => LlmArtifact | null;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function normalizeText(text: unknown): string {
  return textValue(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function wantsDirectOnly(userText: unknown): boolean {
  const text = normalizeText(userText);
  return hasAny(text, [
    /\bsolo muestra\b/, /\bsin resumen\b/, /\bsin sintesis\b/, /\bsin comentar\b/,
    /\btal cual\b/, /\braw\b/, /\bunicamente la salida\b/, /\bonly show\b/, /\bno (?:resumas|comentes)\b/,
  ]);
}

function findExplicitArtifact(userText: unknown): LlmArtifact | null {
  const text = normalizeText(userText);
  const artifacts = llmArtifacts.listSummaries({ limit: 100 });
  for (const summary of artifacts.slice().reverse()) {
    const id = normalizeText(summary?.id);
    if (id && text.includes(id)) {
      return llmArtifacts.findById(summary?.id);
    }
  }
  return null;
}

function decideAfterTool({ userText, result }: DecideAfterToolOptions = {}): ToolResultDecision {
  if (!result?.ok) return { mode: "direct", reason: t("panel.llm.toolPolicy.failedShowError") };
  if (result.cancelled) return { mode: "direct", reason: t("panel.llm.toolPolicy.toolCancelled") };
  if (wantsDirectOnly(userText)) {
    return { mode: "direct", reason: t("panel.llm.toolPolicy.rawOutputRequested") };
  }
  return {
    mode: "direct",
    reason: t("panel.llm.toolPolicy.aiLoopDirect"),
  };
}

function selectArtifactForUserText(userText: unknown): LlmArtifact | null {
  return findExplicitArtifact(userText);
}

export const llmToolResultPolicy: ToolResultPolicyApi = {
  decideAfterTool,
  selectArtifactForUserText,
};
