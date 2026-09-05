// Browser Agent v86 - LLM agent loop (AI SDK + Transformers.js).
// Orchestrates UI, context and tool execution. Tool planning stays inside the
// AI SDK loop; this module coordinates runtime state and rendering.

import { state } from "../../app/state";
import { t } from "../../app/i18n";
import { getEffectiveVmProfileId } from "../../vm/profile-config";
import { originApi } from "../../app/origin-awareness";
import { appEvents } from "../../core/events";
import { addMessage, makeAbortError, throwIfAborted } from "../../vm/runtime-assets";
import { backgroundToolsApi } from "../../vm/background-tools-serial1";
import { resolveTurnModelConfig } from "../models/model-config";
import { detectLLMCapabilities, type LlmCapabilities } from "../state/capabilities";
import { defaultModelConfig, getLlmState, getSelectedLlmModel, llmEventsApi, llmModelRequiresWebGPU, llmModelShortLabel, type LlmModelConfig, type LlmState } from "../state/chat-state";
import {
  getAiSdk,
  getAiSdkReady,
  type AiSdkApprovalDecision,
  type AiSdkApprovalRequest,
  type AiSdkBridgeApi,
  type AiSdkRunAgentStreamTurnResult,
  type AiSdkToolCall,
} from "../provider/ai-sdk-runtime";
import { resolveTransformersRuntimeConfig } from "../models/transformers-runtime";
import { buildAiSdkTools } from "../tools/ai-tools";
import { llmToolExecutor } from "../tools/tool-executor";
import { llmToolRegistry } from "../tools/tool-registry";
import { llmToolResultPolicy } from "./tool-result-policy";
import { llmArtifacts, type LlmArtifact } from "./artifact-store";
import { llmResourceGovernor } from "./resource-governor";
import { llmContextBudget, type AgentTurnPrompt } from "./context-budget";
import { createMarkdownStreamRenderer, type MarkdownStreamRenderer } from "../rendering/markdown-renderer";
import { llmAgentDebug } from "./agent-debug";
import { llmAgentRouting } from "./agent-routing";
import { llmChatUi } from "./chat-ui";
import type { NormalizedToolCall, ToolExecutionResult } from "../tools/types";

type ToolCallingMode = "weak" | "fair" | "good";

type LlmDiagnosticEvent = CustomEvent<Record<string, unknown>>;

interface RuntimeModelInfo {
  provider?: string;
  device?: string;
  dtype?: string;
}

interface EmptyResponseOptions {
  modelConfig?: LlmModelConfig | null;
  hadReasoningStream?: boolean;
  showThinking?: boolean;
  streamIsToolPlan?: boolean;
  toolPhaseSeen?: boolean;
  runnerInfo?: AiSdkRunAgentStreamTurnResult | Record<string, unknown>;
}

interface HandleToolUiOptions {
  userText: string;
  toolCall: NormalizedToolCall;
  toolResult: ToolExecutionResult;
  artifact?: LlmArtifact | null;
  bubble: HTMLElement;
  abortSignal?: AbortSignal;
}

interface ToolUiResult {
  toolResult: ToolExecutionResult;
  artifact: LlmArtifact | null;
  answer: string;
  decision?: unknown;
}

interface RunAgentTurnOptions {
  userText: string;
  source?: string;
  abortSignal?: AbortSignal;
  turnGeneration?: number;
}

interface LlmAgentApi {
  getSelectedModelConfig: () => LlmModelConfig;
  loadSelectedModel: () => Promise<void>;
  cancelModelLoad: () => boolean;
  isModelLoadActive: () => boolean;
  handleUserMessage: (userText: string) => Promise<void>;
  clearHistory: () => void;
  unloadModel: (options?: { force?: boolean }) => boolean;
  updateChatAvailability: () => void;
  isModelReady: () => boolean;
  isChatOperationActive: () => boolean;
  stopActiveTurn: () => void;
}

let activeTurnAbortController: AbortController | null = null;
let activeModelLoadAbortController: AbortController | null = null;
let activeTurnGeneration = 0;
let stopRequested = false;
let streamDeltaLogCount = 0;
let initialized = false;

const {
  createAssistantMessageShell,
  removeAssistantMessage,
  hidePlanningShell,
  showAssistantMessage,
  pickFinalAssistantText,
  appendFinalAgentBubble,
  flushAssistantBubbleText,
  appendThinkingChunk,
  detachThinkingBlock,
  attachThinkingBlock,
  bubbleHasThinkingContent,
  setChatTailIndicator,
  clearChatTailIndicator,
  renderToolCallBubble,
  appendToolResultToBubble,
  renderDeterministicToolAnswer,
} = llmChatUi;

const {
  flattenErrorMessage,
  isRecoverableGpuMemoryError,
  shouldEnableNativeTools,
  resolveNativeToolNames,
  isLikelyToolPlanText,
  resolveToolNeedHeuristic,
  resolveToolRoute,
} = llmAgentRouting;

const NATIVE_TOOL_STREAM_SKIP = new Set([
  "tool-call",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-available",
  "tool-result",
  "tool-error",
  "tool-output-available",
  "tool-output-error",
  "tool-approval-request",
  "tool-approval-response",
  "tool-output-denied",
  "start-step",
  "finish-step",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return fallback;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function isStaleTurn(turnGeneration: number | undefined): boolean {
  return turnGeneration !== activeTurnGeneration;
}

function ensureLlmState(): LlmState {
  const llm = getLlmState();
  if (!llm) throw new Error("LLM state is not initialized");
  return llm;
}

function streamPartType(part: unknown): string {
  return isRecord(part) ? textValue(part.type) : "";
}

function streamPartSample(part: unknown): string {
  if (!isRecord(part)) return "";
  return textValue(part.text) || textValue(part.textDelta) || textValue(part.delta);
}

function runtimeInfo(modelConfig: LlmModelConfig): RuntimeModelInfo {
  const runtime = isRecord(modelConfig.runtime) ? modelConfig.runtime : null;
  return runtime
    ? {
        provider: textValue(runtime.provider),
        device: textValue(runtime.device),
        dtype: textValue(runtime.dtype),
      }
    : {};
}

function isLlmCapabilities(value: unknown): value is LlmCapabilities {
  return isRecord(value) && "webgpu" in value && "shaderF16" in value;
}

function agentDebug(category: string, message: string, data: unknown = null): void {
  llmAgentDebug.log(category, message, data);
}

function diagnosticMessage(detail: Record<string, unknown>): string {
  return textValue(detail.message)
    || textValue(detail.event)
    || textValue(detail.source)
    || "llm diagnostic";
}

function handleLlmDiagnosticEvent(event: Event): void {
  const detail = (event as LlmDiagnosticEvent).detail;
  if (!isRecord(detail)) return;
  agentDebug("diag", diagnosticMessage(detail), detail);
}

function agentDebugStreamPart(part: unknown, extra = ""): void {
  const summary = llmAgentDebug.summarizeStreamPart(part) ?? { type: streamPartType(part) };
  const type = streamPartType(part);
  if (type === "text-delta") {
    streamDeltaLogCount += 1;
    const sample = streamPartSample(part);
    const interesting = /[{`]|tool|vm_|arguments|name"/i.test(sample);
    if (streamDeltaLogCount <= 2 || interesting || streamDeltaLogCount % 10 === 0) {
      agentDebug("stream", `text-delta #${streamDeltaLogCount}${extra}`, summary);
    }
    return;
  }
  agentDebug("stream", `${type || "?"}${extra}`, summary);
}

function normalizeAiSdkToolCall(toolCall: AiSdkToolCall, reason = ""): NormalizedToolCall {
  const normalized = llmToolRegistry.normalizeToolCall({
    type: "tool_call",
    tool: toolCall.toolName,
    arguments: toolCall.input as unknown,
    reason,
  });
  return {
    ...normalized,
    toolCallId: toolCall.toolCallId,
  };
}

function isAbortError(error: unknown): boolean {
  if (isRecord(error) && error.name === "AbortError") return true;
  const msg = isRecord(error) ? textValue(error.message) : textValue(error);
  return /\baborted\b|The user aborted a request/i.test(msg);
}

function getToolCallingMode(modelConfig: LlmModelConfig | null | undefined): ToolCallingMode {
  return modelConfig?.agent?.toolCalling || "good";
}

function buildEmptyResponseMessage({
  modelConfig = null,
  hadReasoningStream = false,
  showThinking = false,
  streamIsToolPlan = false,
  toolPhaseSeen = false,
  runnerInfo = {},
}: EmptyResponseOptions = {}): string {
  const finishReason = runnerInfo.finishReason;
  if (hadReasoningStream) {
    return showThinking
      ? t("chat.empty.reasoningOnly.thinking")
      : t("chat.empty.reasoningOnly.noThinking");
  }
  if (streamIsToolPlan) return t("chat.empty.toolPlan");
  if (toolPhaseSeen || runnerInfo.hadToolWork) return t("chat.empty.toolNoSynthesis");
  if (/length|max|token/i.test(textValue(finishReason))) return t("chat.empty.lengthLimit");
  const label = modelConfig ? llmModelShortLabel(modelConfig) : t("chat.empty.defaultModelLabel");
  return t("chat.empty.noVisibleText", { label });
}

function isChatOperationActive(): boolean {
  const llm = getLlmState();
  const governor = llmResourceGovernor.getSnapshot();
  return Boolean(
    llm?.generating
    || activeTurnAbortController
    || governor.llmBusy
    || governor.toolBusy
    || governor.backgroundToolBusy
  );
}

function stopActiveTurn(): void {
  agentDebug("stop", "stopActiveTurn", {
    generation: activeTurnGeneration,
    governor: llmResourceGovernor.getSnapshot(),
  });
  stopRequested = true;
  activeTurnGeneration += 1;
  activeTurnAbortController?.abort();
  backgroundToolsApi.cancelPending(t("bgtools.reason.user"));
  const llm = getLlmState();
  if (llm) llm.generating = false;
  llmResourceGovernor.forceReleaseWork();
  clearChatTailIndicator();
  document.querySelectorAll(".ba-llm-inference-indicator").forEach((el) => el.remove());
  document.querySelectorAll(".ba-llm-bubble[aria-busy='true']").forEach((el) => {
    el.setAttribute("aria-busy", "false");
  });
  updateChatAvailability();
  llmEventsApi.emit("status", { text: t("chat.status.stopped"), tone: "warn" });
}

function bindChatSubmitButton(): void {
  const submit = document.getElementById("chat-submit-btn");
  if (!(submit instanceof HTMLButtonElement) || submit.dataset.baStopBound === "1") return;
  submit.dataset.baStopBound = "1";
  submit.addEventListener("click", (event) => {
    if (!submit.classList.contains("is-stop")) return;
    event.preventDefault();
    event.stopPropagation();
    stopActiveTurn();
  });
}

function getSelectedModelConfig(): LlmModelConfig {
  return { ...(getSelectedLlmModel() || defaultModelConfig("transformersjs", "")) };
}

function modelRequiresUnavailableF16(modelConfig: LlmModelConfig, capabilities: LlmCapabilities | null): boolean {
  return Boolean(modelConfig.requiresShaderF16 || /f16/i.test(modelConfig.dtype || ""))
    && Boolean(capabilities?.webgpu)
    && !capabilities?.shaderF16;
}

async function ensureCapabilities(): Promise<LlmCapabilities> {
  const llm = ensureLlmState();
  if (isLlmCapabilities(llm.capabilities)) return llm.capabilities;
  const capabilities = await detectLLMCapabilities();
  llm.capabilities = capabilities;
  return capabilities;
}

async function ensureAiSdk(): Promise<AiSdkBridgeApi> {
  const sdk = await getAiSdkReady();
  if (!sdk) throw new Error(t("chat.error.aiSdkNotLoaded"));
  return sdk;
}

function isModelReady(): boolean {
  const llm = getLlmState();
  return Boolean(llm?.loaded && llm.aiModelReady && getAiSdk()?.isModelReady?.());
}

async function loadSelectedModel(): Promise<void> {
  const loadController = new AbortController();
  activeModelLoadAbortController = loadController;
  try {
    await loadSelectedModelWithSignal(loadController.signal);
  } finally {
    if (activeModelLoadAbortController === loadController) activeModelLoadAbortController = null;
  }
}

async function loadSelectedModelWithSignal(signal: AbortSignal): Promise<void> {
  const llm = ensureLlmState();
  const caps = await ensureCapabilities();
  throwIfAborted(signal);
  const modelConfig = resolveTransformersRuntimeConfig(getSelectedModelConfig(), caps);
  const sdk = await ensureAiSdk();
  throwIfAborted(signal);

  const needsWebGPU = llmModelRequiresWebGPU(modelConfig);
  if (!modelConfig.model) {
    throw new Error(modelConfig.engine === "ollama"
      ? t("chat.error.ollamaModelMissing")
      : t("chat.error.transformersModelMissing"));
  }
  if (needsWebGPU && !caps.webgpu) {
    throw new Error(caps.reason || t("chat.error.webgpuUnavailable"));
  }
  if (needsWebGPU && modelRequiresUnavailableF16(modelConfig, caps)) {
    throw new Error(t("chat.error.shaderF16", { dtype: modelConfig.dtype || "" }));
  }

  if (!llmResourceGovernor.canStart("model-load")) {
    throw new Error(t("chat.error.llmBusy"));
  }

  llmResourceGovernor.start("model-load", t("chat.governor.modelLoad"));
  llm.loading = true;
  llm.loaded = false;
  llm.aiModelReady = false;
  llm.lastError = "";
  llmEventsApi.emit("status", {
    text: modelConfig.engine === "ollama" && originApi.isPublishedOrigin()
      ? t("chat.status.ollamaPermission")
      : (modelConfig.engine === "ollama" ? t("common.connectingOllama") : t("chat.status.loadingModel")),
    tone: "warn",
  });

  try {
    sdk.unloadModel();
    await sdk.loadModel(modelConfig, {
      signal,
      onProgress(detail) {
        llmEventsApi.emit("progress", detail);
        if (detail.status === "fallback") {
          llmEventsApi.emit("status", { text: t("chat.status.webgpuFallback"), tone: "warn" });
        }
      },
    });
    throwIfAborted(signal);

    const activeConfig = sdk.getActiveModelConfig?.() || modelConfig;
    const activeRuntime = runtimeInfo(activeConfig);
    llm.loaded = true;
    llm.aiModelReady = true;
    llm.activeModel = activeConfig;
    agentDebug("load", "model loaded", {
      id: activeConfig.id,
      model: activeConfig.model,
      device: activeRuntime.device,
      dtype: activeRuntime.dtype,
      fallback: Boolean(activeConfig.fallbackReason),
      fallbackFrom: activeConfig.fallbackFrom || null,
    });
    updateChatAvailability();
    const statusLabel = llmModelShortLabel(activeConfig);
    const backendHint = activeRuntime.provider === "transformersjs"
      ? ` · ${activeRuntime.device === "wasm" ? "WASM" : "WebGPU"}${activeRuntime.dtype ? `/${activeRuntime.dtype}` : ""}`
      : "";
    llmEventsApi.emit("status", {
      text: `${statusLabel}${backendHint}`,
      tone: activeConfig.fallbackReason ? "warn" : "good",
    });
  } finally {
    llm.loading = false;
    llmResourceGovernor.finish("model-load");
    updateChatAvailability();
  }
}

function isModelLoadActive(): boolean {
  return Boolean(activeModelLoadAbortController && !activeModelLoadAbortController.signal.aborted);
}

function cancelModelLoad(): boolean {
  const controller = activeModelLoadAbortController;
  if (!controller || controller.signal.aborted) return false;
  controller.abort(makeAbortError(t("common.operationCancelled")));
  unloadModel({ force: true });
  return true;
}

async function handleToolUiAfterExecute({
  userText,
  toolCall,
  toolResult,
  artifact = null,
  bubble,
  abortSignal,
}: HandleToolUiOptions): Promise<ToolUiResult> {
  throwIfAborted(abortSignal);
  appendToolResultToBubble(bubble, toolResult, artifact);

  if (toolResult.cancelled) {
    const answer = t("common.toolCancelledByUser");
    return { toolResult, artifact, answer };
  }

  const decision = llmToolResultPolicy.decideAfterTool({
    userText,
    toolCall,
    result: toolResult,
    artifact,
  });

  let answer = "";
  if (toolResult.ok) {
    answer = await renderDeterministicToolAnswer(toolCall, toolResult, artifact, bubble);
  }

  return { toolResult, artifact, answer, decision };
}

function requireResponseStream(
  bubble: HTMLElement | null,
  mdHost: HTMLElement | null,
  renderer: MarkdownStreamRenderer | null,
): { bubble: HTMLElement; mdHost: HTMLElement; renderer: MarkdownStreamRenderer } {
  if (!bubble || !mdHost || !renderer) throw new Error("LLM response stream is not initialized");
  return { bubble, mdHost, renderer };
}

async function runAgentTurn({
  userText,
  source = "agent",
  abortSignal,
  turnGeneration = activeTurnGeneration,
}: RunAgentTurnOptions): Promise<{ text: string; lastToolUi: ToolUiResult | null }> {
  throwIfAborted(abortSignal);
  if (isStaleTurn(turnGeneration)) {
    const err = new Error(t("common.operationCancelled"));
    err.name = "AbortError";
    throw err;
  }
  const llm = ensureLlmState();
  const selectedModel = getSelectedLlmModel();
  const modelConfig = llm.activeModel
    ? resolveTurnModelConfig(llm.activeModel, selectedModel)
    : getSelectedModelConfig();
  const policy = llmContextBudget.getPolicy(modelConfig);
  const thinkingEnabled = Boolean(modelConfig.thinking?.enabled);
  const showThinking = Boolean(thinkingEnabled && llm.settings?.showThinking);
  const sdk = await ensureAiSdk();

  const attachedArtifact = llmArtifacts.consumeContextArtifact();
  const referencedArtifact = attachedArtifact
    || llmToolResultPolicy.selectArtifactForUserText(userText)
    || null;
  const toolStrategy = modelConfig.agent?.toolStrategy || "model-first";
  const nativeToolsMode = toolStrategy !== "off" && shouldEnableNativeTools({ referencedArtifact });
  const activeToolNames = nativeToolsMode ? resolveNativeToolNames(modelConfig) : [];
  const toolNeedHeuristic = resolveToolNeedHeuristic(userText, { activeToolNames });
  const needsVm = toolNeedHeuristic.matched;
  const { modelMayChooseTools, heuristicFallback, useToolLoop } = resolveToolRoute(toolStrategy, needsVm, nativeToolsMode);
  const toolCallingMode = getToolCallingMode(modelConfig);
  const routeMode = !useToolLoop
    ? "chat"
    : (modelMayChooseTools ? "model-first" : "heuristic-fallback");
  streamDeltaLogCount = 0;
  agentDebug("route", "runAgentTurn", {
    modelId: modelConfig.id,
    toolCalling: toolCallingMode,
    nativeToolsMode,
    needsVm,
    toolNeedHeuristic,
    modelMayChooseTools,
    heuristicFallback,
    routeMode,
    useToolLoop,
    activeToolNames,
    turnMaxStepsPreview: modelConfig.agent?.maxSteps,
  });

  const prompt = llmContextBudget.buildAgentTurnPrompt(userText, {
    artifact: referencedArtifact,
    chatOnly: !useToolLoop,
    nativeTools: nativeToolsMode,
    activeToolNames,
  });

  const inspected = llmContextBudget.inspectMessages([
    { role: "system", content: prompt.system || "" },
    ...prompt.messages,
  ], policy);
  llmEventsApi.emit("context", { ...inspected });

  const streamRef: {
    bubble: HTMLElement | null;
    mdHost: HTMLElement | null;
    renderer: MarkdownStreamRenderer | null;
  } = {
    bubble: null,
    mdHost: null,
    renderer: null,
  };
  let sdkAssistantText = "";
  let preToolText = "";
  let hadReasoningStream = false;
  let floatingThinkingBlock: HTMLDetailsElement | null = null;
  let toolPhaseSeen = false;

  async function createResponseStream(extraClass = ""): Promise<{ bubble: HTMLElement; mdHost: HTMLElement; renderer: MarkdownStreamRenderer }> {
    const nextBubble = createAssistantMessageShell(extraClass);
    const nextMdHost = document.createElement("div");
    nextMdHost.className = "ba-llm-md-host";
    nextBubble.appendChild(nextMdHost);
    const nextRenderer = await createMarkdownStreamRenderer(nextMdHost);
    streamRef.bubble = nextBubble;
    streamRef.mdHost = nextMdHost;
    streamRef.renderer = nextRenderer;
    if (floatingThinkingBlock) {
      attachThinkingBlock(nextBubble, floatingThinkingBlock);
      floatingThinkingBlock = null;
    }
    return { bubble: nextBubble, mdHost: nextMdHost, renderer: nextRenderer };
  }

  const initialStream = await createResponseStream();

  const spinnerLabel = useToolLoop && needsVm
    ? t("chat.spinner.agentLoop")
    : t("common.generatingResponse");
  setChatTailIndicator(spinnerLabel);
  initialStream.bubble.setAttribute("aria-busy", "true");

  const toolBubbles = new Map<string, HTMLElement>();
  const deniedOperationKeys = new Set<string>();
  const turnState: { lastToolUi: ToolUiResult | null } = { lastToolUi: null };
  let toolSeq = 0;

  function toolUiKey(toolCall: NormalizedToolCall): string {
    toolCall.toolCallId ||= `${toolCall.tool}-${++toolSeq}`;
    return toolCall.toolCallId;
  }

  function renderToolState(toolCall: NormalizedToolCall, stateText: string): HTMLElement {
    const key = toolUiKey(toolCall);
    let bubble = toolBubbles.get(key);
    if (!bubble) {
      bubble = createAssistantMessageShell("ba-llm-tool-step");
      toolBubbles.set(key, bubble);
    }
    renderToolCallBubble(bubble, toolCall, stateText);
    return bubble;
  }

  function beginApprovalUi(request: AiSdkApprovalRequest): NormalizedToolCall {
    const toolCall = normalizeAiSdkToolCall(request.toolCall, request.reason);
    toolPhaseSeen = true;
    if (showThinking) {
      floatingThinkingBlock = detachThinkingBlock(streamRef.bubble) || floatingThinkingBlock;
    }
    removeAssistantMessage(streamRef.bubble);
    renderToolState(toolCall, t("chat.tool.awaitingApprovalState"));
    setChatTailIndicator(t("chat.tool.awaitingApprovalState"));
    return toolCall;
  }

  async function finishDeniedApproval(
    request: AiSdkApprovalRequest,
    decision: AiSdkApprovalDecision,
    toolCall = normalizeAiSdkToolCall(request.toolCall, request.reason),
  ): Promise<void> {
    const reason = decision.reason || t("common.toolCancelledByUser");
    const bubble = renderToolState(toolCall, t("chat.tool.awaitingApprovalState"));
    const toolResult: ToolExecutionResult = {
      id: `tool-denied-${request.approvalId}`,
      ok: false,
      cancelled: true,
      code: 130,
      stdout: "",
      stderr: reason,
      summary: reason,
      toolCall,
    };
    appendToolResultToBubble(bubble, toolResult, null);
    toolPhaseSeen = true;
    turnState.lastToolUi = {
      toolResult,
      artifact: null,
      answer: reason,
    };
    await createResponseStream("ba-llm-synthesis-after-tool");
    setChatTailIndicator(t("chat.spinner.finalResponse"));
  }

  let maxSteps = modelConfig.agent?.maxSteps || 2;
  if (toolCallingMode === "weak") maxSteps = 1;
  else if (toolCallingMode === "fair") maxSteps = Math.min(maxSteps, 2);
  const turnMaxSteps = useToolLoop ? maxSteps : 1;

  const tools = nativeToolsMode
    ? buildAiSdkTools({
        userText,
        source,
        toolNames: activeToolNames,
        onToolStart({ toolCall }) {
          agentDebug("tool", "SDK onToolStart", toolCall);
          if (showThinking) {
            floatingThinkingBlock = detachThinkingBlock(streamRef.bubble) || floatingThinkingBlock;
          }
          removeAssistantMessage(streamRef.bubble);
          toolPhaseSeen = true;
          renderToolState(toolCall, t("chat.tool.executingState"));
          setChatTailIndicator(t("chat.spinner.executingTool", { tool: toolCall.tool || "tool" }));
        },
        async onToolEnd({ toolCall, toolResult, artifact }) {
          agentDebug("tool", "SDK onToolEnd", {
            tool: toolCall.tool,
            ok: toolResult.ok,
            code: toolResult.code,
            summary: toolResult.summary,
            artifactId: artifact?.id,
          });
          toolPhaseSeen = true;
          const toolBubble = toolBubbles.get(toolUiKey(toolCall))
            || renderToolState(toolCall, t("chat.tool.executingState"));
          turnState.lastToolUi = await handleToolUiAfterExecute({
            userText,
            toolCall,
            toolResult,
            artifact,
            bubble: toolBubble,
            abortSignal,
          });
          await createResponseStream("ba-llm-synthesis-after-tool");
          setChatTailIndicator(t("chat.spinner.finalResponse"));
        },
      })
    : {};
  const registeredToolNames = Object.keys(tools);
  const sentActiveToolNames = activeToolNames.filter((name) => registeredToolNames.includes(name));
  const toolApproval = ({ toolCall }: { toolCall: AiSdkToolCall }) => llmToolExecutor.getToolApprovalStatus(toolCall, {
    allowedToolNames: sentActiveToolNames,
    deniedOperationKeys,
  });
  async function onToolApprovalRequest(request: AiSdkApprovalRequest): Promise<AiSdkApprovalDecision> {
    throwIfAborted(abortSignal);
    const operationKey = llmToolExecutor.getToolOperationKey(request.toolCall);
    beginApprovalUi(request);
    if (deniedOperationKeys.has(operationKey)) {
      const repeatedDenial: AiSdkApprovalDecision = {
        type: "tool-approval-response",
        approvalId: request.approvalId,
        approved: false,
        reason: t("common.toolCancelledByUser"),
      };
      return repeatedDenial;
    }
    const decision = await llmToolExecutor.requestToolApproval(request, { abortSignal });
    throwIfAborted(abortSignal);
    if (!decision.approved) {
      deniedOperationKeys.add(operationKey);
    }
    return decision;
  }
  agentDebug("tools", "selección vs tools enviadas", {
    selected: activeToolNames,
    registered: registeredToolNames,
    sentActiveTools: sentActiveToolNames,
    profileId: getEffectiveVmProfileId(),
    modelId: modelConfig.id,
  });

  if (nativeToolsMode && !activeToolNames.length) {
    throw new Error(t("chat.error.noToolsEnabled"));
  }

  const turnMaxTokens = llmContextBudget.resolveMaxOutputTokens(modelConfig, useToolLoop && needsVm ? "plan" : "chat")
    ?? policy.maxNewTokensDefault
    ?? (useToolLoop ? 192 : 512);
  const synthesisMaxTokens = llmContextBudget.resolveMaxOutputTokens(modelConfig, "synthesis")
    ?? policy.maxNewTokensForSynthesis
    ?? turnMaxTokens;
  agentDebug("context", "límites de salida resueltos", {
    provider: modelConfig.engine,
    modelId: modelConfig.id,
    turnKind: useToolLoop && needsVm ? "plan" : "chat",
    turnMaxTokens,
    synthesisMaxTokens,
  });

  const llmLabel = useToolLoop
    ? t("chat.governor.aiLoop", { tools: activeToolNames.length, steps: turnMaxSteps })
    : t("chat.governor.chat");
  llmResourceGovernor.start("llm", llmLabel);
  try {
    const streamPrompt: AgentTurnPrompt = llmContextBudget.adaptPromptForLocalWeak(prompt, modelConfig) || prompt;
    const runnerOutput = await sdk.runAgentStreamTurn({
      model: sdk.getActiveModel(),
      modelConfig,
      instructions: streamPrompt.system,
      messages: streamPrompt.messages,
      tools: useToolLoop ? tools : undefined,
      maxSteps: turnMaxSteps,
      maxTokens: turnMaxTokens,
      synthesisMaxTokens,
      temperature: modelConfig.temperature ?? 0.15,
      topP: modelConfig.topP ?? 0.85,
      needsVm: useToolLoop,
      enableThinking: thinkingEnabled,
      toolCalling: toolCallingMode,
      activeToolNames: sentActiveToolNames,
      abortSignal,
      toolApproval,
      onToolApprovalRequest,
      onStepEnd(event) {
        const entry = isRecord(event) ? event : {};
        agentDebug("step", "onStepEnd", {
          stepNumber: entry.stepNumber,
          finishReason: entry.finishReason,
          toolCalls: arrayLength(entry.toolCalls),
          toolResults: arrayLength(entry.toolResults),
          textLen: textValue(entry.text).length,
          warnings: arrayLength(entry.warnings),
          error: entry.error ? flattenErrorMessage(entry.error) : undefined,
          cause: isRecord(entry.error) && entry.error.cause ? flattenErrorMessage(entry.error.cause) : undefined,
          keys: Object.keys(entry).slice(0, 16),
        });
      },
      async onStreamPart(part) {
        const type = streamPartType(part);
        if (part.type === "tool-approval-response" && part.approved === false) {
          const { approvalId, toolCall } = part;
          if (approvalId && toolCall) {
            const request: AiSdkApprovalRequest = {
              type: "tool-approval-request",
              approvalId,
              toolCall,
              reason: textValue(part.reason) || undefined,
            };
            const normalized = beginApprovalUi(request);
            await finishDeniedApproval(request, {
              type: "tool-approval-response",
              approvalId,
              approved: false,
              reason: textValue(part.reason) || t("common.toolCancelledByUser"),
            }, normalized);
          }
        }
        if (nativeToolsMode && NATIVE_TOOL_STREAM_SKIP.has(type)) {
          agentDebugStreamPart(part, " (skip UI, native)");
          if ((type === "tool-call" || type === "tool-input-start") && streamRef.mdHost) {
            streamRef.mdHost.hidden = true;
          }
          return;
        }

        const textChunk = sdk.textChunkFromStreamPart(part);
        if (textChunk) {
          if (useToolLoop && needsVm && !toolPhaseSeen) {
            preToolText += textChunk;
            agentDebugStreamPart(part, isLikelyToolPlanText(preToolText) ? " (buffer tool-plan)" : " (buffer pre-tool)");
            return;
          }
          if (useToolLoop && toolPhaseSeen && isLikelyToolPlanText(textChunk)) return;

          const current = requireResponseStream(streamRef.bubble, streamRef.mdHost, streamRef.renderer);
          sdkAssistantText += textChunk;
          setChatTailIndicator(t("common.generatingResponse"));
          showAssistantMessage(current.bubble);
          current.mdHost.hidden = false;
          current.bubble.classList.remove("ba-llm-planning");
          agentDebugStreamPart(part);
          current.renderer.write(textChunk);
          return;
        }

        const reasoningChunk = sdk.reasoningChunkFromStreamPart(part);
        if (reasoningChunk) {
          hadReasoningStream = true;
          if (showThinking) {
            const current = requireResponseStream(streamRef.bubble, streamRef.mdHost, streamRef.renderer);
            appendThinkingChunk(current.bubble, reasoningChunk);
          }
        }
      },
    });
    const text = runnerOutput.text || "";

    const runnerText = text.trim();
    const streamRaw = sdkAssistantText.trim()
      || (runnerText && !isLikelyToolPlanText(runnerText) ? runnerText : "")
      || preToolText.trim();
    const lastToolUi = turnState.lastToolUi;
    const streamFollowUp = pickFinalAssistantText(streamRaw, lastToolUi);
    const streamIsToolPlan = isLikelyToolPlanText(streamRaw);

    agentDebug("end", "runAgentStreamTurn fin", {
      streamFollowUpLen: streamFollowUp.length,
      streamFollowUpSample: streamFollowUp.slice(0, 220),
      toolPhaseSeen,
      streamWasToolPlan: streamIsToolPlan,
      hasLastToolUi: Boolean(lastToolUi),
      answerLen: lastToolUi?.answer.length ?? 0,
    });

    const renderedStreamText = (sdkAssistantText.trim() || (streamRef.mdHost?.textContent || "").trim());
    const canKeepStreamedBubble = Boolean(renderedStreamText) && !isLikelyToolPlanText(renderedStreamText);
    const finalText = streamFollowUp
      || (toolPhaseSeen && lastToolUi?.answer ? lastToolUi.answer : "")
      || (toolPhaseSeen && lastToolUi?.toolResult && !lastToolUi.toolResult.ok
        ? t("chat.error.toolFailed", { error: lastToolUi.toolResult.stderr || lastToolUi.toolResult.summary || "error" })
        : "");
    const hasVisibleAnswer = canKeepStreamedBubble
      || Boolean(finalText && !isLikelyToolPlanText(finalText));
    const hasThinkingContent = showThinking
      && bubbleHasThinkingContent(streamRef.bubble)
      && !hasVisibleAnswer;

    if (hasVisibleAnswer) {
      const current = requireResponseStream(streamRef.bubble, streamRef.mdHost, streamRef.renderer);
      showAssistantMessage(current.bubble);
      if (canKeepStreamedBubble) {
        current.renderer.end();
        agentDebug("ui", "keepStreamedBubble", { len: renderedStreamText.length });
      } else {
        flushAssistantBubbleText(current.bubble, current.mdHost, current.renderer, finalText);
        agentDebug("ui", "flushAssistantBubbleText", { len: finalText.length });
      }
    } else if (hasThinkingContent) {
      const current = requireResponseStream(streamRef.bubble, streamRef.mdHost, streamRef.renderer);
      showAssistantMessage(current.bubble);
      const fallback = buildEmptyResponseMessage({
        modelConfig,
        hadReasoningStream: true,
        showThinking,
        streamIsToolPlan,
        toolPhaseSeen,
        runnerInfo: runnerOutput,
      });
      flushAssistantBubbleText(current.bubble, current.mdHost, current.renderer, fallback);
      agentDebug("ui", "reasoningOnlyBubble", {
        hadReasoningStream: true,
        toolPhaseSeen,
        streamIsToolPlan,
      });
    } else {
      hidePlanningShell(streamRef.bubble);
      removeAssistantMessage(streamRef.bubble);
      floatingThinkingBlock = null;
      const fallback = buildEmptyResponseMessage({
        modelConfig,
        hadReasoningStream,
        showThinking,
        streamIsToolPlan,
        toolPhaseSeen,
        runnerInfo: runnerOutput,
      });
      agentDebug("ui", "chat vacío → aviso", {
        modelId: modelConfig.id,
        finishReason: runnerOutput.finishReason,
        hadReasoningStream,
        streamIsToolPlan,
        hadToolWork: runnerOutput.hadToolWork,
      });
      await appendFinalAgentBubble(fallback);
    }

    return {
      text: streamFollowUp,
      lastToolUi,
    };
  } finally {
    floatingThinkingBlock = null;
    clearChatTailIndicator();
    streamRef.bubble?.setAttribute("aria-busy", "false");
    llmResourceGovernor.finish("llm");
  }
}

async function handleUserMessage(userText: string): Promise<void> {
  const llm = ensureLlmState();
  if (!isModelReady()) {
    addMessage("agent", t("chat.msg.loadModelFirst"));
    updateChatAvailability();
    return;
  }

  if (llm.generating) {
    stopActiveTurn();
    return;
  }

  if (activeTurnAbortController) return;

  if (!llmResourceGovernor.canStart("llm")) {
    addMessage("agent", t("chat.msg.busyTryLater"));
    updateChatAvailability();
    return;
  }

  stopRequested = false;
  const turnGeneration = activeTurnGeneration + 1;
  activeTurnGeneration = turnGeneration;
  agentDebug("turn", "handleUserMessage inicio", { userText, turnGeneration });
  llm.generating = true;
  const turnAbort = new AbortController();
  activeTurnAbortController = turnAbort;
  updateChatAvailability();
  llmEventsApi.emit("status", { text: t("chat.status.agentWorking"), tone: "warn" });

  try {
    llmEventsApi.emit("status", { text: t("chat.status.generating"), tone: "warn" });

    const { text, lastToolUi } = await runAgentTurn({
      userText,
      source: "agent",
      abortSignal: turnAbort.signal,
      turnGeneration,
    });

    if (isStaleTurn(turnGeneration)) return;

    const assistantContent = text || lastToolUi?.answer || "";

    llm.messages.push({ role: "user", content: userText });
    if (assistantContent.trim()) llm.messages.push({ role: "assistant", content: assistantContent });
    llm.messages = llm.messages.slice(-8);

    llmEventsApi.emit("status", { text: lastToolUi ? t("chat.status.toolExecuted") : t("chat.status.localModelReady"), tone: "good" });
  } catch (error) {
    if (isAbortError(error) || isStaleTurn(turnGeneration)) {
      if (!stopRequested) {
        addMessage("agent", t("common.operationCancelled"));
        llmEventsApi.emit("status", { text: t("common.operationCancelled"), tone: "warn" });
      }
      return;
    }
    const message = flattenErrorMessage(error);
    const bubble = createAssistantMessageShell("ba-llm-error");
    const renderer = await createMarkdownStreamRenderer(bubble);
    const recovery = isRecoverableGpuMemoryError(message)
      ? t("chat.error.gpuRecovery")
      : "";
    renderer.write(t("chat.error.llmTools", { message, recovery }));
    renderer.end();
    llm.lastError = message;
    if (isRecoverableGpuMemoryError(message)) {
      llmResourceGovernor.markGpuMemoryPressure();
      unloadModel({ force: true });
    }
    llmEventsApi.emit("status", { text: t("chat.status.errorLlmTools"), tone: "bad" });
  } finally {
    if (activeTurnAbortController === turnAbort) activeTurnAbortController = null;
    if (activeTurnGeneration === turnGeneration) {
      llm.generating = false;
    }
    updateChatAvailability();
  }
}

function clearHistory(): void {
  const llm = ensureLlmState();
  llm.messages = [];
  llm.lastContextInspect = null;
  llmArtifacts.clear();

  const log = document.getElementById("chat-log");
  if (log) log.replaceChildren();

  llmEventsApi.emit("context", {});
  llmEventsApi.emit("resource", {});
  llmEventsApi.emit("status", { text: t("chat.status.historyCleared"), tone: "good" });
  updateChatAvailability();
}

function unloadModel({ force = false }: { force?: boolean } = {}): boolean {
  const llm = ensureLlmState();
  if (!force && activeTurnAbortController) return false;
  const sdk = getAiSdk();
  sdk?.unloadModel?.();
  llm.loaded = false;
  llm.loading = false;
  llm.generating = false;
  llm.aiModelReady = false;
  llm.activeModel = null;
  updateChatAvailability();
  llmEventsApi.emit("status", { text: t("chat.status.modelUnloaded"), tone: "warn" });
  return true;
}

function setChatSubmitStopMode(submit: HTMLButtonElement | null, isStop: boolean): void {
  if (!submit) return;
  if (isStop) {
    submit.type = "button";
    submit.classList.add("is-stop");
    submit.setAttribute("aria-label", t("chat.submit.stop.aria"));
    submit.title = t("chat.submit.stop.title");
    submit.textContent = t("chat.submit.stop.label");
    submit.disabled = false;
    return;
  }
  submit.type = "submit";
  submit.classList.remove("is-stop");
  submit.setAttribute("aria-label", t("chat.submit.send.aria"));
  submit.title = t("chat.submit.send.title");
  submit.textContent = t("chat.submit.send.label");
}

function chatInputElement(): HTMLTextAreaElement | HTMLInputElement | null {
  const input = document.getElementById("chat-input");
  return input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input : null;
}

function updateChatAvailability(): void {
  const input = chatInputElement();
  const submitNode = document.getElementById("chat-submit-btn");
  const submit = submitNode instanceof HTMLButtonElement ? submitNode : null;
  const llm = getLlmState();
  const busy = isChatOperationActive();
  const canSend = Boolean(
    llm
    && isModelReady()
    && !busy
    && !llm.loading
    && !state.agentBusy
  );

  if (input) {
    input.disabled = !canSend;
    input.placeholder = canSend
      ? t("chat.placeholder.ask")
      : (busy
        ? t("chat.placeholder.pressStop")
        : (llm?.loaded ? t("chat.placeholder.waitOperation") : t("chat.placeholder.loadModel")));
    if (!canSend && input.value === "muestra el kernel") input.value = "";
  }
  if (submit) {
    if (busy) setChatSubmitStopMode(submit, true);
    else {
      setChatSubmitStopMode(submit, false);
      submit.disabled = !canSend;
    }
  }
  llmEventsApi.emit("activity", {
    busy,
    generating: Boolean(llm?.generating),
    loading: Boolean(llm?.loading),
  });
}

function refreshChatAvailabilityWithResourceTelemetry(): void {
  updateChatAvailability();
  llmEventsApi.emit("resource", llmResourceGovernor.getSnapshot());
}

export const llmAgent: LlmAgentApi = {
  getSelectedModelConfig,
  loadSelectedModel,
  cancelModelLoad,
  isModelLoadActive,
  handleUserMessage,
  clearHistory,
  unloadModel,
  updateChatAvailability,
  isModelReady,
  isChatOperationActive,
  stopActiveTurn,
};

export function initLlmAgentLoop(): void {
  if (initialized) return;
  initialized = true;
  appEvents.on("llm:availability-refresh-requested", refreshChatAvailabilityWithResourceTelemetry);
  llmEventsApi.on("resource", () => updateChatAvailability());
  appEvents.on("app:language-changed", () => updateChatAvailability());
  window.addEventListener("ba:llm-diagnostic", handleLlmDiagnosticEvent);
  bindChatSubmitButton();
  window.requestAnimationFrame(updateChatAvailability);
}
