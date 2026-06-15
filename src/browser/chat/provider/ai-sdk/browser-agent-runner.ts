/**
 * Turno de agente unificado sobre AI SDK (streamText + stopWhen + prepareStep).
 * Sin quickInfer, plan weak ni segunda pasada de sintesis: el loop es el de la libreria.
 */

import {
  streamText,
  stepCountIs,
  type FinishReason,
  type LanguageModel,
  type ModelMessage,
  type OnStepFinishEvent,
  type PrepareStepFunction,
  type StepResult,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { initI18n, t } from "../../../app/i18n";
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
  system?: string;
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
  onStreamPart?: (part: AgentStreamPart) => void;
  onStepFinish?: (event: OnStepFinishEvent<ToolSet>) => PromiseLike<void> | void;
}

export interface RunAgentStreamTurnResult {
  text: string;
  result: AgentStreamResult;
  steps: AgentStep[];
  finishReason: FinishReason | null;
  hadToolWork: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function collectToolResultText(steps: AgentStep[] = []): string {
  const chunks: string[] = [];
  for (const step of steps) {
    for (const result of step.toolResults) {
      const output = toolOutputToText(result.output);
      if (!output.trim()) continue;
      chunks.push([
        `Tool: ${result.toolName || "tool"}`,
        `Tool call id: ${result.toolCallId || "sin-id"}`,
        "---BEGIN_TOOL_PAYLOAD---",
        output,
        "---END_TOOL_PAYLOAD---",
      ].join("\n"));
    }
  }
  return chunks.join("\n\n");
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

async function consumeTextStream(
  result: AgentStreamResult,
  { onStreamPart, phase = "main" }: { onStreamPart?: (part: AgentStreamPart) => void; phase?: StreamPhase } = {},
): Promise<string> {
  let text = "";
  try {
    for await (const part of result.fullStream) {
      if (isRecord(part) && part.type === "error") {
        emitDiagnostic("stream error part", {
          phase,
          error: errorDetails(part.error),
          keys: Object.keys(part).slice(0, 12),
        });
      }
      onStreamPart?.({ ...part, phase });
      const chunk = textChunkFromStreamPart(part);
      if (chunk) text += chunk;
    }
  } catch (error) {
    emitDiagnostic("fullStream threw", {
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
  return text;
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

export async function runAgentStreamTurn({
  model,
  modelConfig = null,
  system,
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
  onStreamPart,
  onStepFinish,
}: RunAgentStreamTurnOptions): Promise<RunAgentStreamTurnResult> {
  if (!model) throw new Error("No hay modelo AI SDK cargado.");

  const providerOptions = resolveProviderOptions(modelConfig, { enableThinking });

  const controller = new AbortController();
  let onParentAbort: (() => void) | null = null;
  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort(abortSignal.reason);
    } else {
      onParentAbort = (): void => controller.abort(abortSignal.reason);
      abortSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  const signal = controller.signal;
  if (signal.aborted) {
    const error = new Error(t("common.operationCancelled"));
    error.name = "AbortError";
    throw error;
  }

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
  const noTools: ToolSet = {};
  const toolDefs: ToolSet | undefined = useToolsThisTurn ? Object.fromEntries(toolEntries) : undefined;

  const prepareStep: PrepareStepFunction<ToolSet> = ({ stepNumber }) => {
    if (!useToolsThisTurn) {
      return { tools: noTools };
    }
    // Modelos debiles: un paso de tool y luego sintesis. Modelos fair pueden
    // encadenar una segunda tool si el AI SDK lo decide; good mantiene el loop.
    if (toolCalling === "weak" && stepNumber > 0) {
      return { tools: noTools };
    }
    if (toolCalling === "fair" && stepNumber > 1) {
      return { tools: noTools };
    }
    if (activeTools.length > 0) {
      return { activeTools };
    }
    return {};
  };

  const result = streamText({
    model,
    system: system || undefined,
    messages: messages || [],
    tools: toolDefs,
    stopWhen: stepCountIs(Math.max(1, Number(maxSteps) || 2)),
    maxOutputTokens: maxTokens,
    temperature,
    topP,
    abortSignal: signal,
    prepareStep,
    onStepFinish,
    providerOptions,
  });

  let fullText = "";
  let steps: AgentStep[] = [];
  try {
    fullText = await consumeTextStream(result, { onStreamPart, phase: "main" });
    try {
      steps = await result.steps;
    } catch (error) {
      emitDiagnostic("result.steps failed", {
        error: errorDetails(error),
        fullTextLen: fullText.length,
      });
      steps = [];
    }
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

    const hadToolWork = steps.some(
      (step) => step.toolCalls.length > 0 || step.toolResults.length > 0,
    );
    const needsSynthesis = useToolsThisTurn
      && hadToolWork
      && (!fullText.trim() || looksLikeTextToolPlan(fullText));
    const step2Failed = steps.length >= 2 && steps[steps.length - 1]?.finishReason === "error";
    const missingStep2 = useToolsThisTurn && hadToolWork && steps.length < 2;

    if (needsSynthesis || step2Failed || missingStep2) {
      if (looksLikeTextToolPlan(fullText)) {
        fullText = "";
      }
      const toolResultText = collectToolResultText(steps);
      const continuationMessages = toolResultText
        ? buildExplicitToolSynthesisMessages({ messages, toolResultText })
        : (steps[steps.length - 1]?.response.messages ?? messages);
      const synthMaxOutputTokens = Number.isFinite(Number(synthesisMaxTokens)) && Number(synthesisMaxTokens) > 0
        ? Number(synthesisMaxTokens)
        : Math.min(Number(maxTokens) || 256, 320);
      try {
        const synth = streamText({
          model,
          system: [
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
        const synthText = await consumeTextStream(synth, { onStreamPart, phase: "synthesis" });
        if (synthText.trim() && !looksLikeTextToolPlan(synthText)) {
          fullText = synthText.trim();
        }
      } catch (error) {
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
  } finally {
    if (onParentAbort && abortSignal) {
      try {
        abortSignal.removeEventListener("abort", onParentAbort);
      } catch {
        // Parent signal cleanup is best-effort.
      }
    }
  }

  const hadToolWork = steps.some(
    (step) => step.toolCalls.length > 0 || step.toolResults.length > 0,
  );

  return {
    text: fullText,
    result,
    steps,
    finishReason: steps[steps.length - 1]?.finishReason || null,
    hadToolWork,
  };
}
