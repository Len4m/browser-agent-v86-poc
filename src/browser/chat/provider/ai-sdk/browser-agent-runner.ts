// @ts-nocheck
/**
 * Turno de agente unificado sobre AI SDK (streamText + stopWhen + prepareStep).
 * Sin quickInfer, plan weak ni segunda pasada de síntesis: el loop es el de la librería.
 */

import { smoothStream, streamText, stepCountIs } from "ai";
import { looksLikeTextToolPlan } from "./text-tool-parser";

const STREAM_SMOOTHING = smoothStream();

// This module ships in a separate bundle, so the global t() from the app bundle
// is not in scope; bridge through window.BA_I18N when available.
function t(key, esDefault, vars) {
  const fn = typeof window !== "undefined" && window.BA_I18N?.t;
  return fn ? fn(key, esDefault, vars) : esDefault;
}

export function textChunkFromStreamPart(part) {
  if (!part) return "";
  if (part.type === "text-delta") return part.text ?? part.textDelta ?? part.delta ?? "";
  if (part.type === "text") return part.text ?? "";
  return "";
}

export function reasoningChunkFromStreamPart(part) {
  if (!part) return "";
  if (part.type === "reasoning-delta" || part.type === "reasoning") {
    return part.text ?? part.textDelta ?? part.delta ?? "";
  }
  return "";
}

function isGpuInferenceFailure(message) {
  return /out of device memory|VK_ERROR_OUT_OF_DEVICE_MEMORY|WebGPU validation failed|Invalid Buffer|Device lost|failed to call OrtRun|CreateBuffer|null function|function signature mismatch|unaligned accesses|Instance reference no longer exists|memoria GPU agotada|WebGPU inválido|RuntimeError:/i.test(String(message || ""));
}

function toolOutputToText(output) {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object" && typeof output.modelText === "string") return output.modelText;
  if (output.type === "text") return String(output.value || "");
  if (output.type === "json") return JSON.stringify(output.value ?? {});
  if (output.type === "content") return JSON.stringify(output.value ?? []);
  if (output.type === "error-text") return String(output.value || "");
  if (output.type === "error-json") return JSON.stringify(output.value ?? {});
  if (output.type === "execution-denied") return `execution denied: ${output.reason || ""}`.trim();
  return JSON.stringify(output);
}

function collectToolResultText(steps = []) {
  const chunks = [];
  for (const step of steps || []) {
    for (const result of step?.toolResults || []) {
      const output = toolOutputToText(result.output ?? result.result);
      if (!output.trim()) continue;
      chunks.push([
        `Tool: ${result.toolName || result.tool || "tool"}`,
        `Tool call id: ${result.toolCallId || "sin-id"}`,
        "---BEGIN_TOOL_PAYLOAD---",
        output,
        "---END_TOOL_PAYLOAD---",
      ].join("\n"));
    }
  }
  return chunks.join("\n\n");
}

function buildExplicitToolSynthesisMessages({ messages = [], toolResultText = "" }) {
  const originalUser = [...(messages || [])].reverse().find((msg) => msg?.role === "user")?.content || "";
  return [
    {
      role: "user",
      content: [
        originalUser
          ? t("prompt.synth.originalUser", "Petición original del usuario:\n{user}", { user: originalUser })
          : t("prompt.synth.originalUserFallback", "Petición original del usuario: responder con el resultado real de la tool."),
        "",
        t("prompt.synth.toolContext", "Contexto real devuelto por la tool ya ejecutada:"),
        "",
        toolResultText || t("prompt.synth.noOutput", "(sin salida útil)"),
        "",
        t("prompt.synth.respond", "Responde en español breve usando solo ese contexto real. No generes JSON ni llames tools."),
      ].join("\n"),
    },
  ];
}

async function consumeTextStream(result, { onStreamPart, phase = "main" } = {}) {
  let text = "";
  for await (const part of result.fullStream) {
    onStreamPart?.({ ...part, phase });
    const chunk = textChunkFromStreamPart(part);
    if (chunk) text += chunk;
  }
  if (!text.trim()) {
    try {
      const resolved = await result.text;
      if (resolved) text = String(resolved);
    } catch {
      // ignore
    }
  }
  return text;
}

/**
 * @param {object} options
 * @param {import('ai').LanguageModel} options.model
 * @param {string} [options.system]
 * @param {Array<{role:string,content:string}>} options.messages
 * @param {Record<string, import('ai').Tool>} [options.tools]
 * @param {number} [options.maxSteps]
 * @param {number} [options.maxTokens]
 * @param {number} [options.synthesisMaxTokens]
 * @param {number} [options.temperature]
 * @param {number} [options.topP]
 * @param {boolean} [options.needsVm] - si false, prepareStep fuerza toolChoice 'none' (solo chat)
 * @param {"weak"|"fair"|"good"} [options.toolCalling] - controla cuántos pasos pueden exponer tools.
 * @param {string[]} [options.activeToolNames] - subconjunto de tools para activeTools
 * @param {AbortSignal} [options.abortSignal]
 * @param {(part: object) => void} [options.onStreamPart]
 * @param {(event: object) => void|Promise<void>} [options.onStepFinish]
 */
export async function runAgentStreamTurn({
  model,
  system,
  messages,
  tools = {},
  maxSteps = 2,
  maxTokens,
  synthesisMaxTokens,
  temperature,
  topP,
  needsVm = true,
  toolCalling = "fair",
  activeToolNames = null,
  abortSignal,
  onStreamPart,
  onStepFinish,
}) {
  if (!model) throw new Error("No hay modelo AI SDK cargado.");

  const controller = new AbortController();
  let onParentAbort = null;
  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort(abortSignal.reason);
    } else {
      onParentAbort = () => controller.abort(abortSignal.reason);
      abortSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  const signal = controller.signal;
  if (signal.aborted) {
    const error = new Error("Operación cancelada");
    error.name = "AbortError";
    throw error;
  }

  const rawToolEntries = tools && typeof tools === "object" ? Object.entries(tools) : [];
  const allToolKeys = rawToolEntries.map(([name]) => name);
  const hasExplicitActiveToolFilter = Array.isArray(activeToolNames);
  const activeTools = hasExplicitActiveToolFilter
    ? activeToolNames.filter((n) => allToolKeys.includes(n))
    : allToolKeys;
  const useToolsThisTurn = Boolean(needsVm && activeTools.length > 0);
  const toolEntries = useToolsThisTurn
    ? rawToolEntries.filter(([name]) => activeTools.includes(name))
    : [];
  const toolDefs = useToolsThisTurn ? Object.fromEntries(toolEntries) : undefined;

  const prepareStep = async ({ stepNumber }) => {
    if (!useToolsThisTurn) {
      return { tools: {} };
    }
    // Modelos débiles: un paso de tool y luego síntesis. Modelos fair pueden
    // encadenar una segunda tool si el AI SDK lo decide; good mantiene el loop.
    if (toolCalling === "weak" && stepNumber > 0) {
      return { tools: {} };
    }
    if (toolCalling === "fair" && stepNumber > 1) {
      return { tools: {} };
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
    experimental_transform: STREAM_SMOOTHING,
  });

  let fullText = "";
  let steps = [];
  try {
    fullText = await consumeTextStream(result, { onStreamPart, phase: "main" });
    try {
      steps = await result.steps;
    } catch {
      steps = [];
    }

    const hadToolWork = steps.some(
      (s) => (s.toolCalls?.length ?? 0) > 0 || (s.toolResults?.length ?? 0) > 0,
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
        : (steps[steps.length - 1]?.response?.messages ?? messages ?? []);
      const synthMaxOutputTokens = Number.isFinite(Number(synthesisMaxTokens)) && Number(synthesisMaxTokens) > 0
        ? Number(synthesisMaxTokens)
        : Math.min(Number(maxTokens) || 256, 320);
      try {
        const synth = streamText({
          model,
          system: [
            t("prompt.synth.youAre", "Eres Browser Agent."),
            t("prompt.synth.toolExecuted", "Ya se ejecutó una tool y el resultado real está en el contexto."),
            t("prompt.synth.proseOnly", "Responde en español breve solo con prosa o una lista corta."),
            t("prompt.synth.noJson", "No generes JSON, no generes tool_call y no pidas otra tool."),
          ].join(" "),
          messages: continuationMessages,
          maxOutputTokens: synthMaxOutputTokens,
          temperature,
          topP,
          abortSignal: signal,
          experimental_transform: STREAM_SMOOTHING,
        });
        const synthText = await consumeTextStream(synth, { onStreamPart, phase: "synthesis" });
        if (synthText.trim() && !looksLikeTextToolPlan(synthText)) {
          fullText = synthText.trim();
        }
      } catch {
        // La UI puede mostrar respuesta determinista de la tool.
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const msg = error?.message || String(error);
    if (isGpuInferenceFailure(msg)) {
      throw new Error(`Inferencia local falló (memoria GPU agotada o WebGPU inválido): ${msg}`);
    }
    throw error;
  } finally {
    if (onParentAbort && abortSignal) {
      try { abortSignal.removeEventListener("abort", onParentAbort); } catch { /* ignore */ }
    }
  }

  const hadToolWork = steps.some(
    (s) => (s.toolCalls?.length ?? 0) > 0 || (s.toolResults?.length ?? 0) > 0,
  );

  return {
    text: fullText,
    result,
    steps,
    finishReason: steps[steps.length - 1]?.finishReason || null,
    hadToolWork,
  };
}
