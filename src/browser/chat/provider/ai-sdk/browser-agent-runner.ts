/**
 * Turno de agente unificado sobre AI SDK (streamText + stopWhen + prepareStep).
 * El loop principal es el de la libreria; solo se reanuda para approvals y
 * mantiene una sintesis de contingencia cuando un modelo local no la produce.
 */

import {
  isStepCount,
  streamText,
  type FinishReason,
  type GenerateTextStepEndEvent,
  type LanguageModel,
  type ModelMessage,
  type PrepareStepFunction,
  type StepResult,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { isRecord } from "../../../app/value-utils";
import { initI18n, t } from "../../../app/i18n";
import type {
  AiSdkApprovalDecision,
  AiSdkApprovalRequest,
  AiSdkToolApprovalCallback,
  AiSdkToolApprovalRequestHandler,
} from "../ai-sdk-runtime";
import { looksLikeTextToolPlan } from "./text-tool-parser";

type StreamPhase = "main" | "synthesis";
type AgentStep = StepResult<ToolSet>;
type AgentStreamResult = ReturnType<typeof streamText<ToolSet>>;
type AgentStreamPart = TextStreamPart<ToolSet> & { phase: StreamPhase };
type AgentProviderOptions = NonNullable<Parameters<typeof streamText<ToolSet>>[0]["providerOptions"]>;

void initI18n();

interface LlmModelConfig {
  engine?: string;
  thinking?: {
    enabled?: boolean;
  };
}

export interface RunAgentStreamTurnOptions {
  model: LanguageModel;
  modelConfig?: LlmModelConfig | null;
  instructions?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
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
  toolApproval?: AiSdkToolApprovalCallback;
  onToolApprovalRequest?: AiSdkToolApprovalRequestHandler;
  onStreamPart?: (part: AgentStreamPart) => PromiseLike<void> | void;
  onStepEnd?: (event: GenerateTextStepEndEvent<ToolSet>) => PromiseLike<void> | void;
}

export interface RunAgentStreamTurnResult {
  text: string;
  result: AgentStreamResult;
  steps: AgentStep[];
  finishReason: FinishReason | null;
  hadToolWork: boolean;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}

function jsonStringify(value: unknown): string {
  try {
    const out = JSON.stringify(value);
    return typeof out === "string" ? out : "";
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const text = textFromUnknown(error);
  return text || "Error";
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: typeof error.stack === "string" ? error.stack.slice(0, 1600) : "",
      cause: error.cause instanceof Error
        ? { name: error.cause.name, message: error.cause.message, stack: error.cause.stack?.slice(0, 1200) }
        : undefined,
    };
  }
  return {
    name: typeof error,
    message: errorMessage(error),
    value: jsonStringify(error).slice(0, 1200),
  };
}

function emitDiagnostic(message: string, data: Record<string, unknown> = {}): void {
  const detail = {
    source: "browser-agent-runner",
    message,
    ...data,
  };
  try {
    if (typeof globalThis.dispatchEvent === "function" && typeof CustomEvent === "function") {
      globalThis.dispatchEvent(new CustomEvent("ba:llm-diagnostic", { detail }));
    }
  } catch {
    // Diagnostics are best-effort and must not affect inference.
  }
  try {
    const log = message.includes("error") ? console.warn : console.debug;
    log.call(console, "[llm:diagnostic]", detail);
  } catch {
    // ignore
  }
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

export function textChunkFromStreamPart(part: unknown): string {
  if (!isRecord(part)) return "";
  if (part.type === "text-delta") {
    return textFromUnknown(part.text) || textFromUnknown(part.textDelta) || textFromUnknown(part.delta);
  }
  if (part.type === "text") return textFromUnknown(part.text);
  return "";
}

export function reasoningChunkFromStreamPart(part: unknown): string {
  if (!isRecord(part)) return "";
  if (part.type === "reasoning-delta" || part.type === "reasoning") {
    return textFromUnknown(part.text) || textFromUnknown(part.textDelta) || textFromUnknown(part.delta);
  }
  return "";
}

function isGpuInferenceFailure(message: string): boolean {
  return /out of device memory|VK_ERROR_OUT_OF_DEVICE_MEMORY|WebGPU validation failed|Invalid Buffer|Device lost|failed to call OrtRun|CreateBuffer|null function|function signature mismatch|unaligned accesses|Instance reference no longer exists|memoria GPU agotada|WebGPU inválido|RuntimeError:/i.test(message);
}

function toolOutputToText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (!isRecord(output)) return jsonStringify(output);
  if (typeof output.modelText === "string") return output.modelText;

  switch (output.type) {
    case "text":
    case "error-text":
      return textFromUnknown(output.value);
    case "json":
    case "content":
    case "error-json":
      return jsonStringify(output.value ?? {});
    case "execution-denied":
      return `execution denied: ${textFromUnknown(output.reason)}`.trim();
    default:
      return jsonStringify(output);
  }
}

function buildExplicitToolSynthesisMessages({
  messages = [],
  toolResultText = "",
}: {
  messages?: ModelMessage[];
  toolResultText?: string;
}): ModelMessage[] {
  const originalUser = [...messages].reverse().find((msg) => msg.role === "user")?.content || "";
  const originalUserText = typeof originalUser === "string" ? originalUser : jsonStringify(originalUser);
  return [
    {
      role: "user",
      content: [
        originalUserText
          ? t("prompt.synth.originalUser", { user: originalUserText })
          : t("prompt.synth.originalUserFallback"),
        "",
        t("prompt.synth.toolContext"),
        "",
        toolResultText || t("prompt.synth.noOutput"),
        "",
        t("prompt.synth.respond"),
      ].join("\n"),
    },
  ];
}

interface ConsumedStream {
  text: string;
  approvalRequests: AiSdkApprovalRequest[];
}

function approvalRequestFromStreamPart(part: TextStreamPart<ToolSet>): AiSdkApprovalRequest | null {
  return part.type === "tool-approval-request" && part.isAutomatic !== true ? part : null;
}

async function consumeTextStream(
  result: AgentStreamResult,
  { onStreamPart, phase = "main" }: { onStreamPart?: (part: AgentStreamPart) => PromiseLike<void> | void; phase?: StreamPhase } = {},
): Promise<ConsumedStream> {
  let text = "";
  const approvalRequests: AiSdkApprovalRequest[] = [];
  try {
    for await (const part of result.stream) {
      if (isRecord(part) && part.type === "error") {
        emitDiagnostic("stream error part", {
          phase,
          error: errorDetails(part.error),
          keys: Object.keys(part).slice(0, 12),
        });
      }
      await onStreamPart?.({ ...part, phase });
      const approvalRequest = approvalRequestFromStreamPart(part);
      if (approvalRequest) approvalRequests.push(approvalRequest);
      const chunk = textChunkFromStreamPart(part);
      if (chunk) text += chunk;
    }
  } catch (error) {
    emitDiagnostic("stream threw", {
      phase,
      error: errorDetails(error),
      textLenBeforeError: text.length,
    });
    throw error;
  }
  if (!text.trim()) {
    try {
      const resolved = await result.text;
      if (resolved) text = String(resolved);
    } catch (error) {
      emitDiagnostic("result.text fallback failed", {
        phase,
        error: errorDetails(error),
      });
      // The stream itself is the primary source; text is a fallback.
    }
  }
  return { text, approvalRequests };
}

function resolveProviderOptions(modelConfig: LlmModelConfig | null, { enableThinking = false }: { enableThinking?: boolean } = {}): AgentProviderOptions | undefined {
  if ((modelConfig?.engine || "transformersjs") !== "transformersjs") return undefined;
  if (!modelConfig?.thinking?.enabled || !enableThinking) return undefined;
  return {
    "transformers-js": {
      enableThinking: true,
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error(t("common.operationCancelled"));
  error.name = "AbortError";
  throw error;
}

function collectToolResultTextFromMessages(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const chunks: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "tool-result") continue;
      const output = toolOutputToText(part.output);
      if (!output.trim()) continue;
      chunks.push([
        `Tool: ${textFromUnknown(part.toolName) || "tool"}`,
        `Tool call id: ${textFromUnknown(part.toolCallId) || "sin-id"}`,
        "---BEGIN_TOOL_PAYLOAD---",
        output,
        "---END_TOOL_PAYLOAD---",
      ].join("\n"));
    }
  }
  return chunks;
}

export async function runAgentStreamTurn({
  model,
  modelConfig = null,
  instructions,
  messages,
  tools = {},
  maxSteps = 2,
  maxTokens,
  synthesisMaxTokens,
  temperature,
  topP,
  needsVm = true,
  enableThinking = false,
  toolCalling = "fair",
  activeToolNames = null,
  abortSignal,
  toolApproval,
  onToolApprovalRequest,
  onStreamPart,
  onStepEnd,
}: RunAgentStreamTurnOptions): Promise<RunAgentStreamTurnResult> {
  if (!model) throw new Error("No hay modelo AI SDK cargado.");

  const providerOptions = resolveProviderOptions(modelConfig, { enableThinking });

  const signal = abortSignal || new AbortController().signal;
  throwIfAborted(signal);

  const rawToolEntries = Object.entries(tools);
  const allToolKeys = rawToolEntries.map(([name]) => name);
  const hasExplicitActiveToolFilter = Array.isArray(activeToolNames);
  const activeTools = hasExplicitActiveToolFilter
    ? activeToolNames.filter((name) => allToolKeys.includes(name))
    : allToolKeys;
  const useToolsThisTurn = Boolean(needsVm && activeTools.length > 0);
  const toolEntries = useToolsThisTurn
    ? rawToolEntries.filter(([name]) => activeTools.includes(name))
    : [];
  const toolDefs: ToolSet | undefined = useToolsThisTurn ? Object.fromEntries(toolEntries) : undefined;

  const stepLimit = Math.max(1, Number(maxSteps) || 2);
  const workingMessages: ModelMessage[] = [...(messages || [])];
  let fullText = "";
  const steps: AgentStep[] = [];
  const toolResultChunks = new Set<string>();
  let completedSteps = 0;
  let result: AgentStreamResult | null = null;
  let sawToolWork = false;
  try {
    // Cada aprobacion manual termina la llamada actual. Los mensajes de esas
    // rondas se conservan solo aqui y se reanudan con una respuesta de tool.
    for (let round = 0; round <= stepLimit + 1; round += 1) {
      throwIfAborted(signal);
      const stepOffset = completedSteps;
      const remainingSteps = stepLimit - completedSteps;
      const finalResponseOnly = remainingSteps <= 0;
      const prepareStep: PrepareStepFunction<ToolSet> = ({ stepNumber }) => {
        const absoluteStep = stepOffset + stepNumber;
        if (!useToolsThisTurn || finalResponseOnly) return { activeTools: [] };
        // Modelos debiles: un paso de tool y luego sintesis. Modelos fair
        // pueden encadenar una segunda tool; good mantiene el loop completo.
        if (toolCalling === "weak" && absoluteStep > 0) return { activeTools: [] };
        if (toolCalling === "fair" && absoluteStep > 1) return { activeTools: [] };
        if (activeTools.length > 0) return { activeTools };
        return {};
      };

      const currentResult = streamText({
        model,
        instructions: instructions || undefined,
        messages: workingMessages,
        tools: toolDefs,
        toolApproval: useToolsThisTurn ? toolApproval : undefined,
        stopWhen: isStepCount(Math.max(1, remainingSteps)),
        maxOutputTokens: maxTokens,
        temperature,
        topP,
        abortSignal: signal,
        prepareStep,
        onStepEnd,
        providerOptions,
      });
      result = currentResult;

      const consumed = await consumeTextStream(currentResult, { onStreamPart, phase: "main" });

      let roundSteps: AgentStep[] = [];
      try {
        roundSteps = await currentResult.steps;
      } catch (error) {
        emitDiagnostic("result.steps failed", {
          error: errorDetails(error),
          fullTextLen: consumed.text.length,
          round,
        });
      }
      steps.push(...roundSteps);
      completedSteps += roundSteps.length;
      sawToolWork ||= consumed.approvalRequests.length > 0 || roundSteps.some(
        (step) => step.toolCalls.length > 0 || step.toolResults.length > 0,
      );
      const responseMessages = await currentResult.responseMessages;
      for (const chunk of collectToolResultTextFromMessages(responseMessages)) {
        toolResultChunks.add(chunk);
      }

      if (consumed.approvalRequests.length === 0) {
        fullText = consumed.text;
        break;
      }

      if (!onToolApprovalRequest) {
        throw new Error("Se recibio una solicitud de aprobacion sin un manejador configurado.");
      }
      if (round >= stepLimit + 1) {
        throw new Error("Se supero el limite de rondas de aprobacion de herramientas.");
      }

      workingMessages.push(...responseMessages);
      const approvalResponses: AiSdkApprovalDecision[] = [];
      for (const request of consumed.approvalRequests) {
        throwIfAborted(signal);
        const decision = await onToolApprovalRequest(request);
        throwIfAborted(signal);
        if (
          !isRecord(decision)
          || decision.type !== "tool-approval-response"
          || decision.approvalId !== request.approvalId
          || typeof decision.approved !== "boolean"
        ) {
          throw new Error(`Respuesta de aprobacion invalida para ${request.toolCall.toolName}.`);
        }
        approvalResponses.push({
          type: "tool-approval-response",
          approvalId: request.approvalId,
          approved: decision.approved,
          ...(decision.reason ? { reason: decision.reason } : {}),
        });
      }
      workingMessages.push({
        role: "tool",
        content: approvalResponses,
      });
    }

    if (!result) throw new Error("AI SDK no produjo ninguna ronda de respuesta.");

    const lastStep = steps[steps.length - 1];
    if (lastStep?.finishReason === "error") {
      emitDiagnostic("step finished with error", {
        stepCount: steps.length,
        lastStepKeys: Object.keys(lastStep as unknown as Record<string, unknown>).slice(0, 20),
        toolCalls: lastStep.toolCalls.length,
        toolResults: lastStep.toolResults.length,
        textLen: textFromUnknown((lastStep as unknown as Record<string, unknown>).text).length,
      });
    }

    const hadToolWork = sawToolWork || toolResultChunks.size > 0;
    const needsSynthesis = useToolsThisTurn
      && hadToolWork
      && (!fullText.trim() || looksLikeTextToolPlan(fullText));
    const step2Failed = steps.length >= 2 && steps[steps.length - 1]?.finishReason === "error";
    const missingStep2 = useToolsThisTurn && hadToolWork && steps.length < 2;

    if (needsSynthesis || step2Failed || missingStep2) {
      if (looksLikeTextToolPlan(fullText)) {
        fullText = "";
      }
      const toolResultText = [...toolResultChunks].join("\n\n");
      const continuationMessages = toolResultText
        ? buildExplicitToolSynthesisMessages({ messages, toolResultText })
        : messages;
      const synthMaxOutputTokens = Number.isFinite(Number(synthesisMaxTokens)) && Number(synthesisMaxTokens) > 0
        ? Number(synthesisMaxTokens)
        : Math.min(Number(maxTokens) || 256, 320);
      try {
        const synth = streamText({
          model,
          instructions: [
            t("prompt.synth.youAre"),
            t("prompt.synth.toolExecuted"),
            t("prompt.synth.proseOnly"),
            t("prompt.synth.noJson"),
          ].join(" "),
          messages: continuationMessages,
          maxOutputTokens: synthMaxOutputTokens,
          temperature,
          topP,
          abortSignal: signal,
          providerOptions,
        });
        const synthesized = await consumeTextStream(synth, { onStreamPart, phase: "synthesis" });
        if (synthesized.text.trim() && !looksLikeTextToolPlan(synthesized.text)) {
          fullText = synthesized.text.trim();
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        emitDiagnostic("explicit synthesis failed", {
          error: errorDetails(error),
          steps: steps.length,
          toolResultTextLen: toolResultText.length,
        });
        // La UI puede mostrar respuesta determinista de la tool.
      }
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    const msg = errorMessage(error);
    emitDiagnostic("runAgentStreamTurn failed", {
      error: errorDetails(error),
      message: msg,
    });
    if (isGpuInferenceFailure(msg)) {
      throw new Error(`Inferencia local fallo (memoria GPU agotada o WebGPU invalido): ${msg}`);
    }
    throw error;
  }

  const hadToolWork = steps.some(
    (step) => step.toolCalls.length > 0 || step.toolResults.length > 0,
  ) || sawToolWork || toolResultChunks.size > 0;

  if (!result) throw new Error("AI SDK no produjo ninguna respuesta.");

  return {
    text: fullText,
    result,
    steps,
    finishReason: steps[steps.length - 1]?.finishReason || null,
    hadToolWork,
  };
}
