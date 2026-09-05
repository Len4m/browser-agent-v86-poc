// Browser Agent v86 - LLM artifact store.
// Separates visible tool output from compact model context and keeps the model
// focused on payload, not tool metadata.

import { normalizeNewlines, stripAnsiAndControls } from "../../app/text-utils";
import { t } from "../../app/i18n";
import { isRecord } from "../../app/value-utils";
import { getLlmState, llmEventsApi, type LlmState } from "../state/chat-state";
import type { NormalizedToolCall, ToolArgs, ToolExecutionResult } from "../tools/types";

const MAX_ARTIFACTS = 10;
const MAX_TOTAL_ARTIFACT_BYTES = 1024 * 1024;
const MAX_STORED_RAW_CHARS = 64 * 1024;
const DISPLAY_PREVIEW_CHARS = 12000;
const COMPACT_PREVIEW_CHARS = 5000;

interface TruncatedText {
  text: string;
  truncated: boolean;
  omittedChars: number;
}

interface PreviewText {
  text: string;
  truncated: boolean;
}

interface StoreToolResultMeta {
  userText?: unknown;
  source?: unknown;
  maxStoredRawChars?: unknown;
  displayMaxChars?: unknown;
  compactMaxChars?: unknown;
  localMaxChars?: unknown;
  remoteMaxChars?: unknown;
}

interface ArtifactToolCall {
  tool?: string;
  arguments?: ToolArgs | Record<string, unknown>;
}

export interface LlmArtifact {
  id: string;
  type: "tool_result";
  tool: string;
  args: Record<string, unknown>;
  userText: string;
  source: string;
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  modelText: string;
  summary: string;
  truncated: boolean;
  sizeBytes: number;
  storedSizeBytes: number;
  displayPreview: string;
  displayPreviewTruncated: boolean;
  compactText: string;
  compactTruncated: boolean;
  omittedChars: number;
  tags: string[];
  createdAt: number;
  contextPolicy: {
    includeRawByDefault: boolean;
    includePreviewByDefault: boolean;
    allowRawOnDemand: boolean;
    localMaxChars: number;
    remoteMaxChars: number;
  };
}

export interface LlmArtifactSummary {
  id: string;
  type: LlmArtifact["type"];
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  code: number | null;
  summary: string;
  sizeBytes: number;
  storedSizeBytes: number;
  truncated: boolean;
  tags: string[];
  createdAt: number;
  contextAttached: boolean;
}

interface ArtifactUsage {
  artifacts: number;
  maxArtifacts: number;
  storedBytes: number;
  maxStoredBytes: number;
}

interface LlmArtifactsApi {
  storeToolResult: (toolCall: ArtifactToolCall | NormalizedToolCall | null | undefined, result: ToolExecutionResult | null | undefined, meta?: StoreToolResultMeta) => LlmArtifact;
  summarizeArtifact: (artifact: LlmArtifact | null | undefined) => LlmArtifactSummary | null;
  listSummaries: (options?: { limit?: unknown }) => Array<LlmArtifactSummary | null>;
  findById: (id: unknown) => LlmArtifact | null;
  getContextArtifact: () => LlmArtifact | null;
  attachToContext: (id: unknown) => LlmArtifact | null;
  clearContextArtifact: () => void;
  consumeContextArtifact: () => LlmArtifact | null;
  getUsage: () => ArtifactUsage;
  last: () => LlmArtifact | null;
  remove: (id: unknown) => LlmArtifact | null;
  clear: () => void;
  formatArtifactForModel: (artifact: LlmArtifact | null | undefined, options?: { maxChars?: unknown }) => string;
  formatArtifactForDisplay: (artifact: LlmArtifact | null | undefined, options?: { maxChars?: unknown }) => string;
  truncateMiddle: (text: unknown, maxChars?: unknown) => TruncatedText;
}

function nowId(prefix = "art"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function textValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function textBytesApprox(text: unknown): number {
  return new Blob([textValue(text)]).size;
}

function ensureLlmState(): LlmState {
  const llm = getLlmState();
  if (!llm) throw new Error("LLM state is not initialized");
  return llm;
}

function ensureStore(): LlmArtifact[] {
  const llm = ensureLlmState();
  if (!Array.isArray(llm.artifacts)) llm.artifacts = [];
  return llm.artifacts as LlmArtifact[];
}

function artifactArgs(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function collapseInterleavedBlankLines(text: unknown): string {
  const value = normalizeNewlines(text);
  const lines = value.split("\n");
  if (lines.length < 8) return value;

  let blankOdd = 0;
  let blankEven = 0;
  let totalOdd = 0;
  let totalEven = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (i % 2) {
      totalOdd += 1;
      if (!lines[i].trim()) blankOdd += 1;
    } else {
      totalEven += 1;
      if (!lines[i].trim()) blankEven += 1;
    }
  }

  const oddRatio = totalOdd ? blankOdd / totalOdd : 0;
  const evenRatio = totalEven ? blankEven / totalEven : 0;
  const oddInterleaved = oddRatio > 0.75 && evenRatio < 0.35;
  const evenInterleaved = evenRatio > 0.75 && oddRatio < 0.35;
  if (!oddInterleaved && !evenInterleaved) return value;

  return lines.filter((line, index) => {
    if (oddInterleaved && index % 2 === 1 && !line.trim()) return false;
    if (evenInterleaved && index % 2 === 0 && !line.trim()) return false;
    return true;
  }).join("\n");
}

function sanitizeTerminalOutput(text: unknown): string {
  const cleaned = collapseInterleavedBlankLines(stripAnsiAndControls(text));
  return cleaned
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^BA_(?:TOOL|FILE|FS)_[A-Z0-9_:-]+/.test(trimmed)) return false;
      if (/^__BAGENT_[A-Za-z0-9_]+___(?:START|END(?::\d+)?)$/.test(trimmed)) return false;
      if (/^browser-[^#%$>]*[#$>]\s*/.test(trimmed)) return false;
      if (/^>\s*(?:__ba_tty=|echo BA_|p=|tmp=|rc=|if \[|head -c|ls -la|printf|cat "\$tmp"|rm -f "\$tmp"|exit \$rc)/.test(trimmed)) return false;
      if (/^(?:__ba_tty=|echo BA_|p=|tmp=|rc=|if \[|head -c|ls -la|printf|cat "\$tmp"|rm -f "\$tmp"|exit \$rc|__rc=)/.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .replace(/^\n+|\n+$/g, "");
}

function stripHtmlForModel(html: unknown): string {
  const raw = textValue(html);
  if (!/<\s*html|<!doctype|<\s*(head|body|div|main|section|h1|p|script|style|meta|title)\b/i.test(raw)) {
    return raw;
  }

  const withoutScripts = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n")
    .replace(/<!--([\s\S]*?)-->/g, "\n");

  const title = (withoutScripts.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
    .replace(/<[^>]+>/g, " ")
    .trim();
  const metaDescription = (withoutScripts.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i)?.[1] || "")
    .trim();

  const headings: string[] = [];
  withoutScripts.replace(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match: string, level: string, content: string) => {
    const text = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text) headings.push(`H${level}: ${text}`);
    return "";
  });

  const bodyMatch = withoutScripts.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const bodySource = bodyMatch?.[1] || withoutScripts;
  const text = bodySource
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|header|footer|li|ul|ol|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return [
    title ? `TITLE: ${title}` : "",
    metaDescription ? `META_DESCRIPTION: ${metaDescription}` : "",
    headings.slice(0, 20).join("\n"),
    text ? `TEXT:\n${text}` : "",
  ].filter(Boolean).join("\n").trim() || raw;
}

function truncateMiddle(text: unknown, maxChars: unknown = COMPACT_PREVIEW_CHARS): TruncatedText {
  const value = normalizeNewlines(textValue(text));
  const limit = Math.max(0, Math.trunc(numberValue(maxChars, COMPACT_PREVIEW_CHARS)));
  if (value.length <= limit) {
    return { text: value, truncated: false, omittedChars: 0 };
  }
  if (limit <= 0) {
    return { text: "", truncated: value.length > 0, omittedChars: value.length };
  }
  if (limit < 80) {
    return { text: value.slice(0, limit), truncated: true, omittedChars: value.length - limit };
  }

  const markerFor = (omitted: number): string => `\n\n...[contenido omitido: ${omitted} caracteres]...\n\n`;
  let marker = markerFor(value.length);
  let remaining = limit - marker.length;
  if (remaining <= 0) {
    return { text: value.slice(0, limit), truncated: true, omittedChars: value.length - limit };
  }
  let head = Math.max(1, Math.floor(remaining * 0.68));
  let tail = Math.max(0, remaining - head);
  let omitted = value.length - head - tail;
  marker = markerFor(omitted);
  remaining = limit - marker.length;
  if (remaining <= 0) {
    return { text: value.slice(0, limit), truncated: true, omittedChars: value.length - limit };
  }
  head = Math.max(1, Math.floor(remaining * 0.68));
  tail = Math.max(0, remaining - head);
  omitted = value.length - head - tail;
  return {
    text: [
      value.slice(0, head),
      markerFor(omitted),
      value.slice(-tail),
    ].join(""),
    truncated: true,
    omittedChars: omitted,
  };
}

function preview(text: unknown, maxChars: unknown = DISPLAY_PREVIEW_CHARS): PreviewText {
  const value = normalizeNewlines(textValue(text));
  const limit = Math.max(0, Math.trunc(numberValue(maxChars, DISPLAY_PREVIEW_CHARS)));
  if (value.length <= limit) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, limit)}\n...${t("artifact.previewTruncated", { max: limit })}`,
    truncated: true,
  };
}

function inferTags(toolCall: ArtifactToolCall | NormalizedToolCall | null | undefined, result: ToolExecutionResult | null | undefined): string[] {
  const tags = new Set(["tool", "vm"]);
  const tool = textValue(toolCall?.tool);
  if (tool) tags.add(tool);
  if (tool.startsWith("vm_fs_")) tags.add("file-system");
  if (tool === "vm_fs_read") tags.add("file-read");
  if (tool === "vm_fs_list") tags.add("file-list");
  const path = toolCall?.arguments?.path;
  if (path) tags.add(textValue(path));
  if (/\.html?$/i.test(textValue(path))) tags.add("html");
  if (result?.ok) tags.add("ok");
  if (result?.truncated) tags.add("truncated");
  return Array.from(tags);
}

function artifactStoredBytes(artifact: LlmArtifact | null | undefined): number {
  if (!artifact) return 0;
  const textValues = [
    artifact.stdout,
    artifact.stderr,
    artifact.displayPreview,
    artifact.modelText,
    artifact.compactText,
    artifact.summary,
    artifact.userText,
  ].map((value) => textValue(value)).filter(Boolean);
  const uniqueTextValues = Array.from(new Set(textValues));
  return uniqueTextValues.reduce((sum, value) => sum + textBytesApprox(value), 0);
}

function totalArtifactsStoredBytes(store = ensureStore()): number {
  return store.reduce((sum, artifact) => sum + artifactStoredBytes(artifact), 0);
}

function clearContextIfRemoved(artifact: LlmArtifact | null | undefined): void {
  const llm = getLlmState();
  if (!llm || !artifact || artifact.id !== llm.contextArtifactId) return;
  llm.contextArtifactId = null;
  llmEventsApi.emit("artifact-context", { artifact: null, id: null });
}

function pruneStore(store: LlmArtifact[]): void {
  while (store.length > MAX_ARTIFACTS) {
    clearContextIfRemoved(store.shift());
  }
  while (store.length > 1 && totalArtifactsStoredBytes(store) > MAX_TOTAL_ARTIFACT_BYTES) {
    clearContextIfRemoved(store.shift());
  }
}

function getUsage(): ArtifactUsage {
  const store = ensureStore();
  return {
    artifacts: store.length,
    maxArtifacts: MAX_ARTIFACTS,
    storedBytes: totalArtifactsStoredBytes(store),
    maxStoredBytes: MAX_TOTAL_ARTIFACT_BYTES,
  };
}

function storeToolResult(
  toolCall: ArtifactToolCall | NormalizedToolCall | null | undefined,
  result: ToolExecutionResult | null | undefined,
  meta: StoreToolResultMeta = {},
): LlmArtifact {
  const llm = ensureLlmState();
  const store = ensureStore();
  const rawStdout = sanitizeTerminalOutput(result?.stdout || "");
  const rawStderr = sanitizeTerminalOutput(result?.stderr || "");
  const stdoutStored = truncateMiddle(rawStdout, meta.maxStoredRawChars || MAX_STORED_RAW_CHARS);
  const stderrStored = truncateMiddle(rawStderr, meta.maxStoredRawChars || MAX_STORED_RAW_CHARS);
  const stdout = stdoutStored.text;
  const stderr = stderrStored.text;
  const display = preview(stdout || stderr, meta.displayMaxChars || DISPLAY_PREVIEW_CHARS);
  const rawForModel = rawStdout || rawStderr;
  const sourceArgs = artifactArgs(toolCall?.arguments || result?.toolCall?.arguments);
  const modelSource = /\.html?$/i.test(textValue(sourceArgs.path)) ? stripHtmlForModel(rawForModel) : rawForModel;
  const compact = truncateMiddle(modelSource, meta.compactMaxChars || COMPACT_PREVIEW_CHARS);
  const originalSizeBytes = textBytesApprox(rawStdout) + textBytesApprox(rawStderr);
  const storedSizeBytes = textBytesApprox(stdout) + textBytesApprox(stderr);

  const artifact: LlmArtifact = {
    id: result?.id || nowId("tool-artifact"),
    type: "tool_result",
    tool: toolCall?.tool || result?.toolCall?.tool || "unknown",
    args: sourceArgs,
    userText: textValue(meta.userText),
    source: textValue(meta.source, "agent"),
    ok: Boolean(result?.ok),
    code: result?.code ?? null,
    stdout,
    stderr,
    modelText: compact.text,
    summary: textValue(result?.summary),
    truncated: Boolean(result?.truncated || stdoutStored.truncated || stderrStored.truncated || display.truncated || compact.truncated),
    sizeBytes: originalSizeBytes,
    storedSizeBytes,
    displayPreview: display.text,
    displayPreviewTruncated: display.truncated,
    compactText: compact.text,
    compactTruncated: compact.truncated,
    omittedChars: stdoutStored.omittedChars + stderrStored.omittedChars + compact.omittedChars,
    tags: inferTags(toolCall, result),
    createdAt: Date.now(),
    contextPolicy: {
      includeRawByDefault: false,
      includePreviewByDefault: true,
      allowRawOnDemand: true,
      localMaxChars: numberValue(meta.localMaxChars, COMPACT_PREVIEW_CHARS),
      remoteMaxChars: numberValue(meta.remoteMaxChars, 100000),
    },
  };

  store.push(artifact);
  pruneStore(store);
  llm.lastArtifactId = artifact.id;
  llmEventsApi.emit("artifact", { artifact: summarizeArtifact(artifact) });
  return artifact;
}

function summarizeArtifact(artifact: LlmArtifact | null | undefined): LlmArtifactSummary | null {
  if (!artifact) return null;
  return {
    id: artifact.id,
    type: artifact.type,
    tool: artifact.tool,
    args: artifact.args,
    ok: artifact.ok,
    code: artifact.code,
    summary: artifact.summary,
    sizeBytes: artifact.sizeBytes,
    storedSizeBytes: artifactStoredBytes(artifact),
    truncated: artifact.truncated,
    tags: artifact.tags,
    createdAt: artifact.createdAt,
    contextAttached: artifact.id === getLlmState()?.contextArtifactId,
  };
}

function last(): LlmArtifact | null {
  const store = ensureStore();
  return store.length ? store[store.length - 1] : null;
}

function listSummaries({ limit = MAX_ARTIFACTS }: { limit?: unknown } = {}): Array<LlmArtifactSummary | null> {
  const store = ensureStore();
  const max = Math.max(0, numberValue(limit, MAX_ARTIFACTS));
  return store.slice(-max).map(summarizeArtifact);
}

function findById(id: unknown): LlmArtifact | null {
  const target = textValue(id);
  if (!target) return null;
  return ensureStore().find((artifact) => artifact.id === target) || null;
}

function getContextArtifact(): LlmArtifact | null {
  const llm = ensureLlmState();
  const target = textValue(llm.contextArtifactId);
  if (!target) return null;
  const artifact = findById(target);
  if (!artifact) {
    llm.contextArtifactId = null;
    llmEventsApi.emit("artifact-context", { artifact: null, id: null });
    return null;
  }
  return artifact;
}

function attachToContext(id: unknown): LlmArtifact | null {
  const artifact = findById(id);
  if (!artifact) return null;
  const llm = ensureLlmState();
  llm.contextArtifactId = artifact.id;
  llmEventsApi.emit("artifact-context", { artifact: summarizeArtifact(artifact), id: artifact.id });
  return artifact;
}

function clearContextArtifact(): void {
  const llm = getLlmState();
  if (!llm?.contextArtifactId) return;
  llm.contextArtifactId = null;
  llmEventsApi.emit("artifact-context", { artifact: null, id: null });
}

function consumeContextArtifact(): LlmArtifact | null {
  const artifact = getContextArtifact();
  if (artifact) clearContextArtifact();
  return artifact;
}

function remove(id: unknown): LlmArtifact | null {
  const target = textValue(id);
  if (!target) return null;
  const llm = ensureLlmState();
  const store = ensureStore();
  const index = store.findIndex((artifact) => artifact.id === target);
  if (index < 0) return null;
  const [removed] = store.splice(index, 1);
  if (llm.lastArtifactId === target) {
    llm.lastArtifactId = last()?.id || null;
  }
  clearContextIfRemoved(removed);
  llmEventsApi.emit("artifact-remove", { artifact: summarizeArtifact(removed), id: target });
  llmEventsApi.emit("resource", {});
  return removed;
}

function clear(): void {
  const llm = ensureLlmState();
  llm.artifacts = [];
  llm.lastArtifactId = null;
  llm.contextArtifactId = null;
  llmEventsApi.emit("artifact-clear", {});
}

function formatArtifactForModel(artifact: LlmArtifact | null | undefined, { maxChars = COMPACT_PREVIEW_CHARS }: { maxChars?: unknown } = {}): string {
  if (!artifact) return "";
  const payload = artifact.modelText || artifact.compactText || artifact.stdout || artifact.stderr || "";
  const body = truncateMiddle(payload, maxChars);
  const path = artifact.args.path ? textValue(artifact.args.path) : "resultado de tool";
  const label = artifact.tool === "vm_fs_read"
    ? `Contenido real leído de ${path}`
    : artifact.tool === "vm_fs_list"
      ? `Listado real de ${path}`
      : `Salida real de ${artifact.tool || "tool"}`;

  return [
    `${label}:`,
    "---BEGIN_TOOL_PAYLOAD---",
    body.text || t("common.noUsefulOutput"),
    "---END_TOOL_PAYLOAD---",
    body.truncated ? "Nota: la salida fue recortada; no asumas contenido no visible." : "",
  ].filter(Boolean).join("\n");
}

function formatArtifactForDisplay(artifact: LlmArtifact | null | undefined, { maxChars = DISPLAY_PREVIEW_CHARS }: { maxChars?: unknown } = {}): string {
  if (!artifact) return "";
  const out = preview(artifact.stdout || artifact.stderr || "", maxChars);
  return out.text || t("common.noOutputParen");
}

export const llmArtifacts: LlmArtifactsApi = {
  storeToolResult,
  summarizeArtifact,
  listSummaries,
  findById,
  getContextArtifact,
  attachToContext,
  clearContextArtifact,
  consumeContextArtifact,
  getUsage,
  last,
  remove,
  clear,
  formatArtifactForModel,
  formatArtifactForDisplay,
  truncateMiddle,
};
