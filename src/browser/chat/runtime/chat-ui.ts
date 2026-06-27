// Browser Agent v86 - LLM chat UI helpers.
// DOM/bubble helpers for the chat runtime agent loop.

import { t } from "../../app/i18n";
import { scrollChatLogToBottom } from "../rendering/chat-scroll";
import { createMarkdownStreamRenderer, type MarkdownStreamRenderer } from "../rendering/markdown-renderer";
import { llmAgentRouting } from "./agent-routing";
import { llmArtifacts, type LlmArtifact } from "./artifact-store";
import { llmToolRegistry } from "../tools/tool-registry";
import type { NormalizedToolCall, ToolArgValue, ToolExecutionResult } from "../tools/types";

interface ToolDisclosure {
  details: HTMLDetailsElement;
  titleEl: HTMLElement;
  stateEl: HTMLElement;
  body: HTMLElement;
}

interface ToolDisclosureOptions {
  open?: boolean;
}

interface ToolDisclosureSummaryOptions {
  stateText?: string;
  toolResult?: ToolExecutionResult | null;
}

interface ChatToolCall {
  type?: string;
  tool?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  reason?: string;
  riskLevel?: number;
}

interface LlmChatUiApi {
  createAssistantMessageShell: (extraClass?: string) => HTMLElement;
  removeAssistantMessage: (bubble: Element | null | undefined) => void;
  hidePlanningShell: (bubble: Element | null | undefined) => void;
  showAssistantMessage: (bubble: Element | null | undefined) => void;
  pickFinalAssistantText: (streamText: unknown, lastToolUi: { answer?: unknown } | null | undefined) => string;
  appendFinalAgentBubble: (markdown: unknown) => Promise<HTMLElement | null>;
  flushAssistantBubbleText: (bubble: HTMLElement | null | undefined, mdHost: HTMLElement, renderer: MarkdownStreamRenderer, markdown: unknown) => void;
  ensureThinkingBlock: (bubble: HTMLElement) => HTMLDetailsElement;
  appendThinkingChunk: (bubble: HTMLElement, chunk: string) => void;
  detachThinkingBlock: (bubble: HTMLElement | null | undefined) => HTMLDetailsElement | null;
  attachThinkingBlock: (bubble: HTMLElement | null | undefined, details: HTMLDetailsElement | null | undefined) => HTMLDetailsElement | null;
  bubbleHasThinkingContent: (bubble: HTMLElement | null | undefined) => boolean;
  createInferenceSpinner: (label?: string) => HTMLDivElement;
  setChatTailIndicator: (label?: string) => HTMLElement | null;
  clearChatTailIndicator: () => void;
  getToolDisclosure: (bubble: HTMLElement, options?: ToolDisclosureOptions) => ToolDisclosure;
  setToolDisclosureSummary: (bubble: HTMLElement, toolCall: ChatToolCall | NormalizedToolCall | null | undefined, options?: ToolDisclosureSummaryOptions) => void;
  renderToolCallBubble: (bubble: HTMLElement, toolCall: ChatToolCall | NormalizedToolCall, stateText?: string) => void;
  appendToolResultToBubble: (bubble: HTMLElement, result: ToolExecutionResult, artifact?: LlmArtifact | null) => void;
  buildDeterministicToolTitle: (toolCall: ChatToolCall | NormalizedToolCall | null | undefined, toolResult: ToolExecutionResult | null | undefined) => string;
  buildDeterministicToolAnswer: (toolCall: ChatToolCall | NormalizedToolCall, toolResult: ToolExecutionResult, artifact?: LlmArtifact | null) => string;
  renderDeterministicToolAnswer: (toolCall: ChatToolCall | NormalizedToolCall, toolResult: ToolExecutionResult, artifact?: LlmArtifact | null, targetBubble?: HTMLElement | null) => Promise<string>;
}

function isToolArgValue(value: unknown): value is ToolArgValue {
  if (value == null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
}

function plainText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol") {
    return String(value);
  }
  if (Array.isArray(value) && value.every(isToolArgValue)) return value.map((item) => plainText(item)).join(",");
  if (typeof value === "function") return value.name ? `[function ${value.name}]` : "[function]";
  return Object.prototype.toString.call(value);
}

function toolArgs(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function createAssistantMessageShell(extraClass = ""): HTMLElement {
  const log = document.getElementById("chat-log");
  if (!log) throw new Error("chat-log element is missing");
  const msg = document.createElement("div");
  msg.className = `msg agent ba-llm-msg ${extraClass}`.trim();
  const bubble = document.createElement("div");
  bubble.className = "bubble ba-llm-bubble";
  msg.appendChild(bubble);
  log.appendChild(msg);
  scrollChatLogToBottom(log);
  return bubble;
}

function removeAssistantMessage(bubble: Element | null | undefined): void {
  bubble?.closest?.(".msg")?.remove();
}

function hidePlanningShell(bubble: Element | null | undefined): void {
  const shell = bubble?.closest?.<HTMLElement>(".msg");
  if (shell) shell.style.display = "none";
}

function showAssistantMessage(bubble: Element | null | undefined): void {
  const shell = bubble?.closest?.<HTMLElement>(".msg");
  if (shell) shell.style.display = "";
}

function pickFinalAssistantText(streamText: unknown, lastToolUi: { answer?: unknown } | null | undefined): string {
  const raw = plainText(streamText).trim();
  if (raw && !llmAgentRouting.isLikelyToolPlanText(raw)) return raw;
  return plainText(lastToolUi?.answer).trim();
}

async function appendFinalAgentBubble(markdown: unknown): Promise<HTMLElement | null> {
  const text = plainText(markdown).trim();
  if (!text) return null;
  const bubble = createAssistantMessageShell("ba-llm-final-after-tool");
  const mdHost = document.createElement("div");
  mdHost.className = "ba-llm-md-host";
  bubble.appendChild(mdHost);
  const renderer = await createMarkdownStreamRenderer(mdHost);
  renderer.write(text);
  renderer.end();
  const log = document.getElementById("chat-log");
  scrollChatLogToBottom(log);
  return bubble;
}

function flushAssistantBubbleText(bubble: HTMLElement | null | undefined, mdHost: HTMLElement, renderer: MarkdownStreamRenderer, markdown: unknown): void {
  const text = plainText(markdown).trim();
  if (!text) return;
  bubble?.classList?.remove("ba-llm-planning");
  mdHost.hidden = false;
  const visible = mdHost.querySelector(".ba-md-stream") || mdHost;
  if (!visible.textContent?.trim()) {
    renderer.write(text);
  }
  renderer.end();
}

function ensureThinkingBlock(bubble: HTMLElement): HTMLDetailsElement {
  let details = bubble.querySelector<HTMLDetailsElement>("details.ba-llm-thinking");
  if (details) return details;

  details = document.createElement("details");
  details.className = "ba-llm-thinking";

  const summary = document.createElement("summary");
  summary.textContent = t("chat.ui.thinkingTitle");

  const body = document.createElement("div");
  body.className = "ba-llm-thinking-body";

  details.append(summary, body);
  bubble.insertBefore(details, bubble.firstChild);
  return details;
}

function appendThinkingChunk(bubble: HTMLElement, chunk: string): void {
  const details = ensureThinkingBlock(bubble);
  const body = details.querySelector(".ba-llm-thinking-body");
  if (body) body.append(document.createTextNode(chunk));
}

function detachThinkingBlock(bubble: HTMLElement | null | undefined): HTMLDetailsElement | null {
  const details = bubble?.querySelector<HTMLDetailsElement>("details.ba-llm-thinking");
  if (!details) return null;
  const body = details.querySelector(".ba-llm-thinking-body");
  if (!body?.textContent?.trim()) {
    details.remove();
    return null;
  }
  details.remove();
  return details;
}

function attachThinkingBlock(bubble: HTMLElement | null | undefined, details: HTMLDetailsElement | null | undefined): HTMLDetailsElement | null {
  if (!bubble || !details) return null;
  bubble.insertBefore(details, bubble.firstChild);
  return details;
}

function bubbleHasThinkingContent(bubble: HTMLElement | null | undefined): boolean {
  return Boolean(bubble?.querySelector(".ba-llm-thinking-body")?.textContent?.trim());
}

function createInferenceSpinner(label = t("common.generatingResponse")): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "ba-llm-inference-indicator";
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-live", "polite");
  const spinner = document.createElement("span");
  spinner.className = "ba-llm-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "ba-llm-inference-label";
  text.textContent = label;
  wrap.append(spinner, text);
  return wrap;
}

function setChatTailIndicator(label = t("common.generatingResponse")): HTMLElement | null {
  const log = document.getElementById("chat-log");
  if (!log) return null;
  let indicator = document.getElementById("ba-chat-tail-indicator");
  let created = false;
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "ba-chat-tail-indicator";
    indicator.className = "msg agent ba-chat-tail-indicator";
    const bubble = document.createElement("div");
    bubble.className = "bubble ba-chat-tail-indicator-bubble";
    indicator.appendChild(bubble);
    created = true;
  }
  const bubble = indicator.querySelector(".ba-chat-tail-indicator-bubble");
  if (bubble) {
    let status = bubble.querySelector(".ba-llm-inference-indicator");
    if (!status) {
      status = createInferenceSpinner(label);
      bubble.replaceChildren(status);
    } else {
      const text = status.querySelector(".ba-llm-inference-label");
      if (text && text.textContent !== label) {
        text.textContent = label;
      }
    }
  }
  if (created || indicator.parentElement !== log || log.lastElementChild !== indicator) {
    log.appendChild(indicator);
  }
  scrollChatLogToBottom(log);
  return indicator;
}

function clearChatTailIndicator(): void {
  document.getElementById("ba-chat-tail-indicator")?.remove();
}

function getToolDisclosure(bubble: HTMLElement, { open = false }: ToolDisclosureOptions = {}): ToolDisclosure {
  let details = bubble.querySelector<HTMLDetailsElement>(":scope > details.ba-tool-disclosure");
  if (!details) {
    details = document.createElement("details");
    details.className = "ba-tool-disclosure";

    const summary = document.createElement("summary");
    summary.className = "ba-tool-disclosure-summary";

    const title = document.createElement("span");
    title.className = "ba-tool-disclosure-title";

    const state = document.createElement("span");
    state.className = "ba-tool-disclosure-state";

    summary.append(title, state);

    const body = document.createElement("div");
    body.className = "ba-tool-disclosure-body";

    details.append(summary, body);
    bubble.appendChild(details);
  }
  details.open = Boolean(open);
  const titleEl = details.querySelector<HTMLElement>(".ba-tool-disclosure-title");
  const stateEl = details.querySelector<HTMLElement>(".ba-tool-disclosure-state");
  const body = details.querySelector<HTMLElement>(".ba-tool-disclosure-body");
  if (!titleEl || !stateEl || !body) throw new Error("Invalid tool disclosure DOM");
  return { details, titleEl, stateEl, body };
}

function toolName(toolCall: ChatToolCall | NormalizedToolCall | null | undefined): string {
  if (!toolCall) return "";
  return plainText(toolCall.tool || ("name" in toolCall ? toolCall.name : ""));
}

function setToolDisclosureSummary(
  bubble: HTMLElement,
  toolCall: ChatToolCall | NormalizedToolCall | null | undefined,
  { stateText = "", toolResult = null }: ToolDisclosureSummaryOptions = {},
): void {
  const tool = toolName(toolCall);
  const toolDef = llmToolRegistry.getTool(tool);
  const { details, titleEl, stateEl } = getToolDisclosure(bubble);
  titleEl.textContent = toolDef?.label || tool || t("common.tool");

  if (toolResult) {
    if (toolResult.ok) {
      stateEl.textContent = toolResult.summary || t("chat.ui.tool.completed");
      stateEl.className = "ba-tool-disclosure-state ok";
      details.open = true;
    } else {
      stateEl.textContent = toolResult.stderr || toolResult.summary || t("common.error");
      stateEl.className = "ba-tool-disclosure-state bad";
      details.open = true;
    }
    return;
  }

  stateEl.textContent = stateText || t("chat.ui.tool.preparing");
  stateEl.className = "ba-tool-disclosure-state pending";
  details.open = false;
}

function renderToolCallBubble(bubble: HTMLElement, toolCall: ChatToolCall | NormalizedToolCall, stateText = t("chat.ui.tool.preparingTool")): void {
  const tool = toolName(toolCall);
  const args = toolArgs(toolCall.arguments);
  const toolDef = llmToolRegistry.getTool(tool);
  bubble.classList.add("ba-tool-card");
  bubble.innerHTML = "";

  bubble.dataset.toolName = tool;

  const { body } = getToolDisclosure(bubble, { open: false });
  setToolDisclosureSummary(bubble, toolCall, { stateText });

  const meta = document.createElement("div");
  meta.className = "ba-tool-meta";
  meta.textContent = t("chat.ui.tool.level", { level: toolCall.riskLevel ?? toolDef?.riskLevel ?? "—", tool });

  const reason = document.createElement("p");
  reason.className = "ba-tool-disclosure-reason";
  reason.textContent = plainText(toolCall.reason) || t("chat.ui.tool.defaultReason");

  const argsWrap = document.createElement("details");
  argsWrap.className = "ba-tool-args-wrap";

  const argsSummary = document.createElement("summary");
  argsSummary.textContent = t("chat.ui.tool.argsJson");

  const code = document.createElement("pre");
  code.className = "ba-tool-args";
  code.textContent = JSON.stringify(args, null, 2);

  argsWrap.append(argsSummary, code);
  body.replaceChildren(meta, reason, argsWrap);
}

function appendToolResultToBubble(bubble: HTMLElement, result: ToolExecutionResult, artifact: LlmArtifact | null = null): void {
  const fallbackCall: ChatToolCall = artifact
    ? { tool: artifact.tool, arguments: artifact.args || {} }
    : { tool: bubble.dataset.toolName || "tool", arguments: {} };
  const toolCall = result.toolCall || fallbackCall;
  setToolDisclosureSummary(bubble, toolCall, { toolResult: result });

  const { body } = getToolDisclosure(bubble);
  const status = document.createElement("div");
  status.className = result.ok ? "ba-tool-result ok" : "ba-tool-result bad";
  status.textContent = result.ok
    ? t("chat.ui.tool.completedDetail", { summary: result.summary || "" })
    : t("chat.ui.tool.failedDetail", { detail: result.stderr || result.summary || "" });
  body.appendChild(status);

  if (artifact) {
    const meta = document.createElement("div");
    meta.className = "ba-tool-meta";
    const truncated = artifact.truncated ? t("chat.ui.artifact.truncatedSuffix") : "";
    meta.textContent = t("chat.ui.artifact.meta", { id: artifact.id, kb: Math.ceil((artifact.sizeBytes || 0) / 1024), truncated });
    body.appendChild(meta);
  }
}

function buildDeterministicToolTitle(toolCall: ChatToolCall | NormalizedToolCall | null | undefined, toolResult: ToolExecutionResult | null | undefined): string {
  const tool = toolName(toolCall);
  const args = toolArgs(toolCall?.arguments);
  const path = plainText(args.path);
  const toolDef = llmToolRegistry.getTool(tool);

  const summary = plainText(toolResult?.summary).trim();
  if (summary) return summary;

  if (tool === "vm.fs.read") return path ? t("chat.ui.title.fileReadPath", { path }) : t("chat.ui.title.fileRead");
  if (tool === "vm.fs.list") return path ? t("chat.ui.title.fileListPath", { path }) : t("chat.ui.title.fileList");
  return toolDef?.label || tool || t("chat.ui.title.toolResult");
}

function buildDeterministicToolAnswer(toolCall: ChatToolCall | NormalizedToolCall, toolResult: ToolExecutionResult, artifact: LlmArtifact | null = null): string {
  const tool = toolName(toolCall);
  const path = plainText(toolArgs(toolCall.arguments).path);
  if (!toolResult.ok) {
    const onPath = path ? t("chat.ui.answer.onPath", { path }) : "";
    return [
      t("chat.ui.answer.cannotRun", { tool, onPath }),
      "",
      t("chat.ui.answer.errorLabel", { error: toolResult.stderr || toolResult.summary || t("chat.ui.answer.unknownError") }),
    ].join("\n");
  }

  const title = buildDeterministicToolTitle(toolCall, toolResult);
  const output = artifact
    ? llmArtifacts.formatArtifactForDisplay(artifact)
    : (toolResult.stdout || t("common.noOutputParen"));

  return [
    t("chat.ui.answer.titleHeading", { title }),
    "",
    "```txt",
    output || t("common.noOutputParen"),
    "```",
    (toolResult.truncated || artifact?.displayPreviewTruncated) ? t("chat.ui.answer.truncatedNote") : "",
  ].join("\n");
}

async function renderDeterministicToolAnswer(
  toolCall: ChatToolCall | NormalizedToolCall,
  toolResult: ToolExecutionResult,
  artifact: LlmArtifact | null = null,
  targetBubble: HTMLElement | null = null,
): Promise<string> {
  const text = buildDeterministicToolAnswer(toolCall, toolResult, artifact);
  if (targetBubble) {
    const host = document.createElement("div");
    host.className = "ba-llm-md-host ba-tool-answer";
    const { body } = getToolDisclosure(targetBubble);
    body.appendChild(host);
    const renderer = await createMarkdownStreamRenderer(host);
    renderer.write(text);
    renderer.end();
    return text;
  }
  const bubble = createAssistantMessageShell("ba-llm-final-after-tool");
  const renderer = await createMarkdownStreamRenderer(bubble);
  renderer.write(text);
  renderer.end();
  return text;
}

export const llmChatUi: LlmChatUiApi = {
  createAssistantMessageShell,
  removeAssistantMessage,
  hidePlanningShell,
  showAssistantMessage,
  pickFinalAssistantText,
  appendFinalAgentBubble,
  flushAssistantBubbleText,
  ensureThinkingBlock,
  appendThinkingChunk,
  detachThinkingBlock,
  attachThinkingBlock,
  bubbleHasThinkingContent,
  createInferenceSpinner,
  setChatTailIndicator,
  clearChatTailIndicator,
  getToolDisclosure,
  setToolDisclosureSummary,
  renderToolCallBubble,
  appendToolResultToBubble,
  buildDeterministicToolTitle,
  buildDeterministicToolAnswer,
  renderDeterministicToolAnswer,
};
