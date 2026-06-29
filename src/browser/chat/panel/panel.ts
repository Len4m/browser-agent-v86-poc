// Browser Agent v86 - LLM UI panel.
// Isolated inside the existing "LLM objetivo" card. Selectors stay namespaced
// with ba-llm-* so this panel does not take ownership of the global layout.

import { state } from "../../app/state";
import { applyDomTranslations, t, tn } from "../../app/i18n";
import { originApi } from "../../app/origin-awareness";
import { appEvents } from "../../core/events";
import { showBaModal, showBaModalPanel } from "../../ui/modal";
import { getSelectedProfile, type VmProfile } from "../../vm/profile-config";
import { ensureLLMCapabilities, syncLLMCapabilityBadges, type LlmCapabilities } from "../state/capabilities";
import { getLlmState, llmEngineLabel, llmEventsApi, llmModelOptions, llmModelRequiresWebGPU, llmModelShortLabel, llmModels, type LlmModelConfig } from "../state/chat-state";
import { llmAgent } from "../runtime/agent-loop";
import { llmArtifacts, type LlmArtifactSummary } from "../runtime/artifact-store";
import { llmContextBudget } from "../runtime/context-budget";
import { llmResourceGovernor, type ResourceSnapshot } from "../runtime/resource-governor";
import { llmNativeToolsPolicy, type NativeToolsPolicyApi } from "../tools/native-tools-policy";
import { llmToolExecutor } from "../tools/tool-executor";
import { llmToolRegistry } from "../tools/tool-registry";
import type { LlmToolRegistryApi, ToolMetadata } from "../tools/types";
import { llmPanelCapabilities } from "./capabilities-view";
import { llmPanelTemplate } from "./template";

interface CompatibleFallbackOptions {
  noWebGPU?: boolean;
  noF16?: boolean;
}

interface ProgressDetail {
  status?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  file?: string;
  name?: string;
  path?: string;
  model?: string;
  fallbackDevice?: string;
  fallbackDtype?: string;
  reason?: string;
}

interface ProgressInfo {
  mode: "idle" | "indeterminate" | "determinate" | "determinate-file";
  percent: number | null;
  title: string;
  detail: string;
}

interface ResourceContext {
  estimatedTokens?: number;
  chars?: number;
}

interface ResourceUpdateExtra {
  context?: ResourceContext;
}

interface NativeToolsPickerState {
  model: LlmModelConfig;
  profileId: string;
  max: number;
  active: Set<string>;
  available: ToolMetadata[];
  policy: NativeToolsPolicyApi | null;
}

const fmt = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });
let initialized = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return textValue(error, "Error");
}

function isLlmCapabilities(value: unknown): value is LlmCapabilities {
  return isRecord(value) && "webgpu" in value && "shaderF16" in value;
}

function ensureLlmState() {
  const llm = getLlmState();
  if (!llm) throw new Error("LLM state is not initialized");
  return llm;
}

function isVmProfile(value: unknown): value is VmProfile {
  return isRecord(value) && typeof value.id === "string";
}

function setDisabled(el: Element | null, disabled: boolean): void {
  if (
    el instanceof HTMLButtonElement
    || el instanceof HTMLInputElement
    || el instanceof HTMLSelectElement
    || el instanceof HTMLTextAreaElement
  ) {
    el.disabled = disabled;
  }
}

function selectedModelSelect(): HTMLSelectElement | null {
  const select = document.getElementById("ba-llm-model");
  return select instanceof HTMLSelectElement ? select : null;
}

function inputById(id: string): HTMLInputElement | null {
  const input = document.getElementById(id);
  return input instanceof HTMLInputElement ? input : null;
}

function eventTargetElement(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null;
}

function resourceContext(value: unknown): ResourceContext | undefined {
  if (!isRecord(value)) return undefined;
  return {
    estimatedTokens: numberValue(value.estimatedTokens),
    chars: numberValue(value.chars),
  };
}

function nativeToolsPolicy(): NativeToolsPolicyApi | null {
  return llmNativeToolsPolicy;
}

function toolRegistry(): LlmToolRegistryApi | null {
  return llmToolRegistry;
}

function findLLMPanelBody(): HTMLElement | null {
  const details = Array.from(document.querySelectorAll<HTMLDetailsElement>("details.panel.small.collapsible-panel"))
    .find((item) => {
      const title = item.querySelector("summary.panel-title h2")?.textContent?.trim() || "";
      const summaryText = item.querySelector("summary.panel-title")?.textContent || "";
      return title === "LLM"
        || title === "LLM objetivo"
        || (summaryText.includes("LLM") && summaryText.includes("Transformers.js"));
    });
  const body = details?.querySelector(".collapsible-panel-body");
  return body instanceof HTMLElement ? body : null;
}

function getSelectedModel(): LlmModelConfig {
  const select = selectedModelSelect();
  return llmModelOptions.find((item) => item.id === select?.value)
    || llmModelOptions[0]
    || { id: "custom-transformersjs", engine: "transformersjs" };
}

function compatibleFallbackFor(model: LlmModelConfig, { noWebGPU = false, noF16 = false }: CompatibleFallbackOptions = {}): LlmModelConfig {
  if (noWebGPU) {
    return llmModels.find((item) => item.engine === "transformersjs" && item.device === "wasm")
      || llmModels.find((item) => item.device === "wasm")
      || model;
  }
  if (!noF16 || !model.requiresShaderF16) return model;
  const baseId = model.id.replace(/-q4f16$/, "-q4");
  return llmModels.find((item) => item.id === baseId)
    || llmModels.find((item) => item.engine === model.engine && item.model === model.model && item.device === "webgpu" && !item.requiresShaderF16)
    || llmModels.find((item) => item.engine === "transformersjs" && item.device === "webgpu" && !item.requiresShaderF16)
    || llmModels.find((item) => item.engine === "transformersjs" && item.device === "wasm")
    || llmModels[0]
    || model;
}

function updateModelOptionCompatibility(caps: LlmCapabilities | null): void {
  const select = selectedModelSelect();
  if (!select) return;

  const noWebGPU = Boolean(caps && !caps.webgpu);
  const noF16 = Boolean(caps && caps.webgpu && !caps.shaderF16);
  for (const option of Array.from(select.options)) {
    const model = llmModelOptions.find((item) => item.id === option.value);
    const needsWebGPU = llmModelRequiresWebGPU(model);
    const disabled = Boolean((noWebGPU && needsWebGPU) || (noF16 && model?.requiresShaderF16));
    option.disabled = disabled;
    if (option.dataset.originalText) {
      option.textContent = option.dataset.originalText;
      delete option.dataset.originalText;
    }
  }

  const selected = getSelectedModel();
  const selectedNeedsWebGPU = llmModelRequiresWebGPU(selected);
  if ((noWebGPU && selectedNeedsWebGPU) || (noF16 && selected.requiresShaderF16)) {
    const fallback = compatibleFallbackFor(selected, { noWebGPU, noF16 });
    select.value = fallback.id;
    ensureLlmState().selectedModelId = fallback.id;
    updateSelectedModelCard();
    setStatus(noWebGPU ? t("panel.llm.status.switchedWasm") : t("panel.llm.status.switchedQ4"), "warn");
  }
}

function setStatus(text: string, tone = ""): void {
  const status = document.getElementById("ba-llm-status");
  if (!status) return;
  status.textContent = text;
  status.className = `badge ba-llm-header-status ${tone}`.trim();
}

function updateCapabilityDetails(result: LlmCapabilities | null): void {
  const detail = document.getElementById("ba-llm-capabilities");
  if (!detail) return;
  if (!result) {
    detail.textContent = t("common.inferencePending");
    return;
  }
  const limits = result.limits || {};
  detail.textContent = result.webgpu
    ? t("panel.llm.capabilities.webgpu", {
        shaderF16: result.shaderF16 ? t("common.yes") : t("common.no"),
        dtype: result.recommendedDtype || "q4",
        maxBuffer: limits.maxBufferSize || "—",
      })
    : t("panel.llm.capabilities.noWebgpu", {
        reason: result.reason || t("panel.llm.capabilities.noWebgpuReason"),
      });
}

function applyCapabilitiesToPanel(result: LlmCapabilities | null): void {
  if (!result) return;
  updateCapabilityDetails(result);
  updateModelOptionCompatibility(result);
  syncLLMCapabilityBadges(result, "ready");
  syncLifecycleStatusAfterCapabilityCheck(result);
  llmPanelCapabilities.decorateCapabilityRecheckBadges();
}

function syncLifecycleStatusAfterCapabilityCheck(result: LlmCapabilities | null): void {
  const llm = ensureLlmState();
  if (llm.loaded) {
    setStatus(t("common.loadedLower"), "good");
  } else if (llm.loading) {
    setStatus(t("common.loadingLower"), "warn");
  } else if (result && !result.webgpu && getSelectedModel().device === "wasm") {
    setStatus(t("common.wasm"), "warn");
  } else {
    setStatus(t("common.unloadedLower"), "warn");
  }
}

function setButtonBusy(isBusy: boolean): void {
  setDisabled(document.getElementById("ba-llm-load"), isBusy);
  setDisabled(document.getElementById("ba-llm-check"), isBusy);
  setDisabled(document.getElementById("ba-llm-model"), isBusy);
  setDisabled(document.getElementById("ba-llm-custom-model"), isBusy);
  syncWorkerUnloadButton();
}

function canUnloadActiveWorker(): boolean {
  const llm = getLlmState();
  return Boolean(
    llm?.loaded
    && !llm.loading
    && llm.activeModel?.runtime?.worker,
  );
}

function syncWorkerUnloadButton(): void {
  setDisabled(document.getElementById("ba-llm-abort"), !canUnloadActiveWorker());
}

function bytesLabel(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = numeric;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${fmt.format(size)} ${units[unit]}`;
}

function normalizePercent(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric <= 1 && numeric >= 0) return Math.round(numeric * 100);
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function getProgressInfo(detail: ProgressDetail | null | undefined): ProgressInfo {
  if (!detail) return { mode: "idle", percent: null, title: "", detail: "" };

  const rawPercent = Number.isFinite(detail.progress)
    ? normalizePercent(detail.progress)
    : (Number.isFinite(detail.loaded) && Number.isFinite(detail.total) && Number(detail.total) > 0
      ? normalizePercent(Number(detail.loaded) / Number(detail.total))
      : null);

  const file = detail.file || detail.name || detail.path || "";
  const loaded = bytesLabel(detail.loaded);
  const total = bytesLabel(detail.total);
  const size = loaded && total ? `${loaded} / ${total}` : (loaded || total || "");

  switch (detail.status) {
    case "init":
      return { mode: "indeterminate", percent: null, title: t("panel.llm.progress.preparingModel"), detail: detail.model || "" };
    case "initiate":
      return { mode: "indeterminate", percent: null, title: t("panel.llm.progress.preparingFile"), detail: file || t("panel.llm.progress.initializing") };
    case "download":
      return { mode: "indeterminate", percent: null, title: t("common.downloading"), detail: file || t("panel.llm.progress.waiting") };
    case "progress_total":
      return {
        mode: "determinate",
        percent: rawPercent,
        title: rawPercent == null ? t("panel.llm.progress.downloadingModel") : t("panel.llm.progress.downloadingModelPercent", { percent: rawPercent }),
        detail: file ? `${file}${size ? ` · ${size}` : ""}` : (size || t("panel.llm.progress.globalProgress")),
      };
    case "progress":
      return {
        mode: rawPercent == null ? "indeterminate" : "determinate-file",
        percent: rawPercent,
        title: rawPercent == null ? t("panel.llm.progress.downloadingFile") : t("panel.llm.progress.currentFilePercent", { percent: rawPercent }),
        detail: file ? `${file}${size ? ` · ${size}` : ""}` : (size || t("panel.llm.progress.fileProgress")),
      };
    case "fallback":
      return {
        mode: "indeterminate",
        percent: null,
        title: t("panel.llm.progress.webgpuFailed"),
        detail: [
          detail.fallbackDevice ? `${detail.fallbackDevice}${detail.fallbackDtype ? ` · ${detail.fallbackDtype}` : ""}` : "",
          file || detail.reason || t("panel.llm.progress.restartingWorker"),
        ].filter(Boolean).join(" · "),
      };
    case "ready":
      return { mode: "determinate", percent: 100, title: t("panel.llm.progress.filesReady"), detail: file || t("panel.llm.progress.preparingExecution") };
    case "done":
      return { mode: "determinate", percent: 100, title: t("panel.llm.progress.modelDownloaded"), detail: t("panel.llm.progress.loadComplete") };
    default:
      return { mode: rawPercent == null ? "indeterminate" : "determinate", percent: rawPercent, title: detail.status || t("common.loading"), detail: file || size || "" };
  }
}

function setProgress(detail: ProgressDetail | null, force = false): void {
  const wrap = document.getElementById("ba-llm-progress-wrap");
  const bar = document.getElementById("ba-llm-progress-bar");
  const percent = document.getElementById("ba-llm-progress-percent");
  const title = document.getElementById("ba-llm-progress-title");
  const sub = document.getElementById("ba-llm-progress-detail");
  if (!wrap || !(bar instanceof HTMLElement) || !percent || !title || !sub) return;

  if (!detail && !force) return;

  const info = detail ? getProgressInfo(detail) : { mode: "idle", percent: 0, title: t("panel.llm.progress.idle"), detail: "" } satisfies ProgressInfo;
  wrap.classList.toggle("is-active", info.mode !== "idle");
  bar.classList.toggle("is-indeterminate", info.mode === "indeterminate");

  const pct = info.percent == null ? 0 : info.percent;
  bar.style.width = `${pct}%`;
  bar.setAttribute("aria-valuenow", String(pct));
  percent.textContent = info.percent == null ? "—" : `${pct}%`;
  title.textContent = info.title || t("common.loading");
  sub.textContent = info.detail || "";
}

function syncThinkingToggleUi(): void {
  const model = getSelectedModel();
  const wrap = document.getElementById("ba-llm-thinking-wrap");
  const input = document.getElementById("ba-llm-show-thinking");
  if (!wrap || !(input instanceof HTMLInputElement)) return;
  const enabled = Boolean(model.thinking?.enabled);
  wrap.hidden = !enabled;
  if (!enabled) {
    input.checked = false;
    const llm = getLlmState();
    if (llm?.settings) llm.settings.showThinking = false;
  }
}

function shouldShowActiveModel(selected: LlmModelConfig, active: LlmModelConfig | null): boolean {
  const llm = getLlmState();
  if (!llm?.loaded || !active) return false;
  return active.id === selected.id || active.fallbackFrom === selected.id;
}

function activeBackendLabel(model: LlmModelConfig): string {
  const runtime = model.runtime;
  if (!runtime) return "";
  if (runtime.provider === "ollama") return t("panel.llm.backend.ollama", { endpoint: runtime.endpoint || t("panel.llm.backend.localEndpoint") });
  const device = runtime.device === "webgpu"
    ? "WebGPU"
    : (runtime.device === "wasm" ? "WASM" : runtime.device || "auto");
  const dtype = runtime.dtype ? ` · ${runtime.dtype}` : "";
  const fallback = runtime.fallback ? t("panel.llm.backend.fallbackSuffix") : "";
  return `Transformers.js · ${device}${dtype}${fallback}`;
}

function createTextElement(tagName: keyof HTMLElementTagNameMap, className: string, text = ""): HTMLElement {
  const el = document.createElement(tagName);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function artifactLineText(artifact: LlmArtifactSummary): string {
  const pathValue = textValue(artifact.args?.path);
  const path = pathValue ? ` · ${pathValue}` : "";
  const stateText = artifact.ok ? t("common.okLower") : t("panel.llm.resources.stateError");
  const size = artifact.sizeBytes ? ` · ${Math.ceil(artifact.sizeBytes / 1024)} KB` : "";
  const truncated = artifact.truncated ? t("panel.llm.resources.truncated") : "";
  return t("panel.llm.resources.artifactLine", {
    id: artifact.id,
    tool: artifact.tool || t("panel.llm.resources.toolFallback"),
    state: stateText,
    size,
    truncated,
    path,
  });
}

function artifactContextLimit(): number {
  const selected = getSelectedModel();
  const policy = llmContextBudget.getPolicy(selected);
  const limit = Number(policy.maxToolResultCharsForSynthesis ?? policy.maxToolResultChars);
  return Number.isFinite(limit) ? Math.max(0, limit) : 0;
}

function createArtifactResourceRow(summary: LlmArtifactSummary): HTMLDivElement {
  const artifact = llmArtifacts.findById(summary.id);
  const attached = Boolean(summary.contextAttached);
  const canAttach = artifactContextLimit() > 0;
  const row = document.createElement("div");
  row.className = `ba-llm-artifact-row${attached ? " is-attached" : ""}`;
  row.dataset.artifactId = summary.id;

  const label = document.createElement("button");
  label.type = "button";
  label.className = "ba-llm-artifact-summary";
  label.textContent = artifactLineText(summary) + (attached ? t("panel.llm.resources.artifactAttachedSuffix") : "");
  label.setAttribute("aria-label", t("panel.llm.resources.artifactPreviewTitle", { id: summary.id }));
  label.setAttribute("aria-expanded", "false");

  const actions = document.createElement("div");
  actions.className = "ba-llm-artifact-actions";

  const attach = document.createElement("button");
  attach.type = "button";
  attach.className = `ba-llm-artifact-action${attached ? " is-attached-action" : ""}`;
  attach.textContent = attached
    ? t("panel.llm.resources.artifactDetach")
    : (canAttach ? t("panel.llm.resources.artifactAttach") : t("panel.llm.resources.artifactAttachUnavailable"));
  attach.title = attached
    ? t("panel.llm.resources.artifactDetachTitle", { id: summary.id })
    : (canAttach
      ? t("panel.llm.resources.artifactAttachTitle", { id: summary.id })
      : t("panel.llm.resources.artifactAttachUnavailableTitle", { id: summary.id }));
  attach.disabled = !attached && !canAttach;
  attach.addEventListener("click", () => {
    if (attached) llmArtifacts.clearContextArtifact();
    else llmArtifacts.attachToContext(summary.id);
    updateResourceLines();
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ba-llm-artifact-action ba-llm-artifact-delete ba-icon-only";
  remove.setAttribute("aria-label", t("panel.llm.resources.artifactDeleteTitle", { id: summary.id }));
  remove.title = t("panel.llm.resources.artifactDeleteTitle", { id: summary.id });
  remove.addEventListener("click", () => {
    llmArtifacts.remove(summary.id);
    updateResourceLines();
  });

  actions.append(attach, remove);

  const preview = document.createElement("pre");
  preview.className = "ba-llm-artifact-preview";
  preview.hidden = true;

  function renderPreview(): void {
    preview.textContent = artifact
      ? llmArtifacts.formatArtifactForDisplay(artifact, { maxChars: 5000 })
      : t("common.noOutputParen");
  }

  label.addEventListener("click", () => {
    const willOpen = preview.hidden;
    if (willOpen) renderPreview();
    else preview.textContent = "";
    preview.hidden = !willOpen;
    label.setAttribute("aria-expanded", String(willOpen));
  });

  row.append(label, actions, preview);
  return row;
}

function createMetaItem(key: string, value: unknown): HTMLSpanElement {
  const item = document.createElement("span");
  const label = document.createElement("b");
  label.textContent = `${key}:`;
  item.append(label, document.createTextNode(` ${textValue(value, "—")}`));
  return item;
}

function updateSelectedModelCard(): void {
  const selected = getSelectedModel();
  const active = getLlmState()?.activeModel || null;
  const model = shouldShowActiveModel(selected, active) ? active || selected : selected;
  const title = document.getElementById("ba-llm-selected-title");
  const desc = document.getElementById("ba-llm-selected-desc");
  const meta = document.getElementById("ba-llm-selected-meta");
  const repo = document.getElementById("ba-llm-repo-path");

  if (title) title.textContent = llmModelShortLabel(model);
  if (desc) desc.textContent = model.description || t("panel.llm.model.descFallback");
  if (repo) repo.textContent = model.custom ? t("panel.llm.model.repoCustomHint") : model.model || "";
  if (meta) {
    const entries: Array<[string, unknown] | null> = [
      getLlmState()?.loaded ? [t("panel.llm.meta.backendLoaded"), activeBackendLabel(model) || "—"] : null,
      [t("panel.llm.meta.engine"), llmEngineLabel(model.engine)],
      [t("panel.llm.meta.download"), model.sizeLabel || "—"],
      [t("panel.llm.meta.quantization"), model.dtype || "—"],
      [t("panel.llm.meta.memory"), model.minMemoryLabel || "—"],
      [t("panel.llm.meta.compatibility"), model.compatibilityLabel || "—"],
      [t("panel.llm.meta.languages"), model.languageLabel || "—"],
      [t("panel.llm.meta.tools"), model.agent?.toolCalling || "—"],
      [t("panel.llm.meta.reasoning"), model.thinking?.enabled ? t("common.yes") : t("common.no")],
    ];
    const items = entries.filter((entry): entry is [string, unknown] => Boolean(entry)).map(([key, value]) => createMetaItem(key, value));
    meta.replaceChildren(...items);
  }
  syncThinkingToggleUi();
  syncWorkerUnloadButton();
}

async function checkCapabilities(options: { force?: boolean } = {}): Promise<LlmCapabilities> {
  const { force = false } = options;
  setStatus(t("panel.llm.status.checkingGpu"), "warn");
  try {
    const result = await ensureLLMCapabilities({ force, source: force ? "manual" : "panel" });
    applyCapabilitiesToPanel(result);
    return result;
  } finally {
    llmAgent.updateChatAvailability();
  }
}

function syncCustomVisibility(): void {
  const select = selectedModelSelect();
  const customWrap = document.getElementById("ba-llm-custom-wrap");
  const ollamaEndpointWrap = document.getElementById("ba-llm-ollama-endpoint-wrap");
  const selected = getSelectedModel();
  if (customWrap) {
    customWrap.hidden = !selected.custom;
    const text = selected.engine === "ollama"
      ? t("panel.llm.custom.ollamaLabel")
      : t("panel.llm.field.customModel");
    if (customWrap.firstChild?.nodeType === Node.TEXT_NODE) customWrap.firstChild.nodeValue = text;
  }
  const customInput = inputById("ba-llm-custom-model");
  if (customInput) {
    customInput.placeholder = selected.engine === "ollama"
      ? "qwen3.5:4b"
      : "onnx-community/Llama-3.2-1B-Instruct-ONNX";
  }
  if (ollamaEndpointWrap) {
    const isOllama = selected.engine === "ollama";
    ollamaEndpointWrap.hidden = !isOllama;
    const input = inputById("ba-llm-ollama-endpoint");
    if (input && !input.value) {
      input.value = localStorage.getItem("ba.llm.ollama.endpoint") || "http://127.0.0.1:11434";
    }
  }
  const ollamaOriginNotice = document.getElementById("ba-llm-ollama-origin-notice");
  if (ollamaOriginNotice) {
    const show = Boolean(selected.engine === "ollama" && originApi.isPublishedOrigin());
    ollamaOriginNotice.hidden = !show;
    if (show) ollamaOriginNotice.textContent = originApi.localServiceWarningText("ollama");
  }
  if (select) ensureLlmState().selectedModelId = select.value;
  updateSelectedModelCard();
  updateResourceLines();
  setProgress(null, true);
  const llm = ensureLlmState();
  const caps = isLlmCapabilities(llm.capabilities) ? llm.capabilities : null;
  const needsWebGPU = llmModelRequiresWebGPU(selected);
  if (needsWebGPU && caps && !caps.webgpu) {
    setStatus(t("panel.llm.status.requiresWebgpu"), "warn");
  } else if (selected.requiresShaderF16 && caps?.webgpu && !caps.shaderF16) {
    setStatus(t("common.requiresShaderF16"), "warn");
  } else if (selected.engine === "ollama") {
    setStatus(t("panel.llm.status.requiresOllama"), "warn");
  } else if (selected.device === "wasm") {
    setStatus(t("panel.llm.status.wasmExperimental"), "warn");
  } else if (!llm.loaded) {
    setStatus(t("common.unloadedLower"), "warn");
  }
}

function syncToolPolicyUi(): void {
  const select = document.getElementById("ba-llm-tool-autonomy");
  const detail = document.getElementById("ba-llm-tool-autonomy-detail");
  if (!(select instanceof HTMLSelectElement)) return;
  const value = String(llmToolExecutor.getAutonomyMaxLevel() ?? ensureLlmState().settings.toolAutonomyMaxLevel ?? 1);
  if (select.value !== value) select.value = value;
  const level = llmToolRegistry.SECURITY_LEVELS.find((item) => String(item.level) === value);
  if (detail) detail.textContent = level?.description || t("panel.llm.toolPolicy.defaultDetail");
}

function getActiveToolProfileId(): string {
  if (isRecord(state.activeRuntime) && isRecord(state.activeRuntime.profile)) {
    const id = textValue(state.activeRuntime.profile.id);
    if (id) return id;
  }
  return getSelectedProfile()?.id
    || selectedProfileIdFromDom()
    || "manual";
}

function selectedProfileIdFromDom(): string {
  const profile = document.getElementById("vm-profile");
  return profile instanceof HTMLSelectElement ? profile.value : "";
}

function getActiveToolProfileLabel(profileId: string): string {
  if (profileId === "manual") return t("panel.llm.profile.manual");
  const profile = state.profiles.filter(isVmProfile).find((item) => item.id === profileId);
  return profile?.name || profileId || t("panel.llm.profile.current");
}

function getSelectedModelForTools(): LlmModelConfig {
  const llm = getLlmState();
  if (llm?.loaded && llm.activeModel) return llm.activeModel;
  const select = selectedModelSelect();
  return llmModelOptions.find((item) => item.id === select?.value)
    || llm?.activeModel
    || llmModelOptions[0]
    || { id: "custom-transformersjs", engine: "transformersjs" };
}

function getNativeToolsPickerState(): NativeToolsPickerState {
  const policy = nativeToolsPolicy();
  const model = getSelectedModelForTools();
  const profileId = getActiveToolProfileId();
  if (!policy) return { model, profileId, max: 0, active: new Set(), available: [], policy: null };
  const max = policy.getMaxNativeTools(model);
  const available = toolRegistry()?.listTools({ profileId }) || [];
  const active = new Set(policy.resolveActiveToolNames(model, profileId));
  return { model, profileId, max, active, available, policy };
}

function nativeToolsHintText(model: LlmModelConfig, activeCount: number, max: number): string {
  const weak = model.agent?.toolCalling === "weak";
  if (!activeCount) return t("panel.llm.tools.noneSelected");
  const label = llmModelShortLabel(model);
  return weak
    ? tn("panel.llm.tools.hintWeak", activeCount, { label, max })
    : tn("panel.llm.tools.hintStrong", activeCount, { label, max });
}

function updateNativeToolsPickerUi(): void {
  const picker = document.getElementById("ba-chat-tools-picker");
  const hint = document.getElementById("ba-chat-tools-hint");
  if (!picker) {
    updateChatToolsButton();
    return;
  }
  const previousGrid = picker.querySelector<HTMLElement>(".ba-llm-native-tools-grid");
  const previousScrollTop = previousGrid?.scrollTop ?? 0;
  const focusedTool = document.activeElement instanceof Element ? document.activeElement.getAttribute("data-tool") || "" : "";

  const { model, max, active, available, policy } = getNativeToolsPickerState();
  if (!policy) {
    picker.replaceChildren(createTextElement("small", "", t("panel.llm.tools.policyNotLoaded")));
    updateChatToolsButton();
    return;
  }

  if (hint) hint.textContent = nativeToolsHintText(model, active.size, max);

  const head = document.createElement("div");
  head.className = "ba-llm-native-tools-head";
  const title = document.createElement("strong");
  title.textContent = t("panel.llm.tools.inLoop");
  const count = document.createElement("span");
  count.className = "ba-native-tools-count";
  count.dataset.nativeToolsCount = "";
  count.textContent = `${active.size}/${max}`;
  head.append(title, count);

  const grid = document.createElement("div");
  grid.className = "ba-llm-native-tools-grid ba-llm-native-tools-grid--modal";
  if (available.length) {
    for (const tool of available) {
      const isActive = active.has(tool.name);
      const atMax = active.size >= max && !isActive;
      const row = document.createElement("label");
      row.className = `ba-llm-native-tool-row${atMax ? " is-disabled" : ""}`;
      row.title = tool.label || tool.name;

      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.tool = tool.name;
      input.checked = isActive;
      input.disabled = atMax;

      const name = createTextElement("span", "ba-llm-native-tool-name", tool.name);
      const meta = createTextElement("span", "ba-llm-native-tool-meta", t("panel.llm.tools.levelShort", { level: tool.riskLevel }));
      row.append(input, name, meta);
      grid.appendChild(row);
    }
  } else {
    grid.appendChild(createTextElement("small", "", t("panel.llm.tools.noneForProfile")));
  }

  if (picker.dataset.nativeToolsPickerBound !== "1") {
    picker.dataset.nativeToolsPickerBound = "1";
    picker.addEventListener("change", (event) => {
      const input = eventTargetElement(event)?.closest<HTMLInputElement>("input[data-tool]");
      if (!input || !picker.contains(input)) return;
      const { model: nextModel, profileId: nextProfileId, policy: nextPolicy } = getNativeToolsPickerState();
      nextPolicy?.toggleToolName(nextModel, input.getAttribute("data-tool") || "", input.checked, nextProfileId);
      updateNativeToolsPickerUi();
    });
  }

  picker.replaceChildren(head, grid);
  const nextGrid = picker.querySelector<HTMLElement>(".ba-llm-native-tools-grid");
  if (nextGrid) {
    nextGrid.scrollTop = previousScrollTop;
    window.requestAnimationFrame(() => {
      nextGrid.scrollTop = previousScrollTop;
      if (focusedTool) {
        picker.querySelector<HTMLElement>(`input[data-tool="${CSS.escape(focusedTool)}"]`)?.focus({ preventScroll: true });
      }
    });
  }
  updateChatToolsButton();
}

function updateChatToolsButton(): void {
  const btn = document.getElementById("chat-tools-btn");
  const badge = document.getElementById("chat-tools-badge");
  if (!btn) return;

  const { model, max, active, policy } = getNativeToolsPickerState();
  const activeCount = active.size;
  const label = llmModelShortLabel(model);

  if (badge) {
    badge.textContent = activeCount ? String(activeCount) : "";
    badge.hidden = !activeCount;
    badge.setAttribute("aria-hidden", activeCount ? "false" : "true");
  }

  if (!policy) {
    btn.title = t("panel.llm.toolsBtn.policyNotLoaded");
    btn.setAttribute("aria-label", btn.title);
    return;
  }

  btn.title = activeCount
    ? tn("panel.llm.toolsBtn.active", activeCount, { max, label })
    : t("panel.llm.toolsBtn.none", { max, label });
  btn.setAttribute("aria-label", btn.title);
}

function openChatToolsModal(): void {
  void showBaModalPanel({
    title: t("panel.llm.toolsModal.title"),
    onMount(bodyEl) {
      const hint = document.createElement("small");
      hint.id = "ba-chat-tools-hint";
      hint.className = "ba-llm-note ba-chat-tools-hint";
      const picker = document.createElement("div");
      picker.id = "ba-chat-tools-picker";
      picker.className = "ba-llm-native-tools-picker ba-llm-native-tools-picker--modal";
      bodyEl.replaceChildren(hint, picker);
      updateNativeToolsPickerUi();
    },
    buttons: [{ id: "close", label: t("common.done"), variant: "primary" }],
  });
}

function updateAvailableToolsUi(): void {
  const box = document.getElementById("ba-llm-tool-list");
  if (!box) return;

  const registry = toolRegistry();
  const countBadge = document.getElementById("ba-llm-tool-count");
  if (!registry?.listTools) {
    if (countBadge) countBadge.textContent = "—";
    const title = document.createElement("b");
    title.textContent = t("panel.llm.tools.available");
    box.replaceChildren(title, createTextElement("span", "", t("panel.llm.tools.registryUnavailable")));
    return;
  }

  const profileId = getActiveToolProfileId();
  const profileLabel = getActiveToolProfileLabel(profileId);
  const tools = registry.listTools({ profileId });
  if (countBadge) {
    countBadge.textContent = tn("panel.llm.tools.count", tools.length);
    countBadge.title = t("panel.llm.tools.availableForTitle", { profile: profileLabel });
  }
  const title = document.createElement("b");
  title.textContent = t("panel.llm.tools.availableFor", { profile: profileLabel });
  const children: HTMLElement[] = [title];
  if (tools.length) {
    for (const tool of tools) {
      const chip = createTextElement("span", "", t("common.levelChip", { name: tool.name, level: tool.riskLevel }));
      chip.title = t("common.levelChip", { name: tool.label || tool.name, level: tool.riskLevel });
      children.push(chip);
    }
  } else {
    children.push(createTextElement("span", "", t("panel.llm.tools.noneAvailableForProfile")));
  }
  if (profileId === "manual") {
    children.push(createTextElement("small", "", t("panel.llm.tools.manualNote")));
  }
  box.replaceChildren(...children);
}

function snapshotWithFallback(): ResourceSnapshot {
  return llmResourceGovernor.getSnapshot();
}

function updateResourceLines(extra: ResourceUpdateExtra = {}): void {
  const box = document.getElementById("ba-llm-resource-lines");
  if (!box) return;
  const llm = ensureLlmState();
  const snap = snapshotWithFallback();
  const storedContext = resourceContext(llm.lastContextInspect);
  const ctx = extra.context || storedContext || null;
  if (extra.context) llm.lastContextInspect = extra.context;
  const selected = getSelectedModel();
  const policy = llmContextBudget.getPolicy(selected);
  const contextWindow = selected.contextWindowTokens ?? policy.contextWindowTokens;
  const safeInput = policy.safeInputTokens;
  const maxOutput = policy.maxNewTokensDefault;
  const planOutput = policy.maxNewTokensForPlan;
  const budgetLine = contextWindow && safeInput && maxOutput
    ? t("panel.llm.resources.budget", { context: contextWindow, input: safeInput, output: maxOutput })
      + (planOutput ? t("panel.llm.resources.budgetPlan", { plan: planOutput }) : "")
    : t("panel.llm.resources.budgetPending");
  const artifactCount = numberValue(snap.artifacts ?? llm.artifacts?.length ?? 0);
  const artifactBadge = document.getElementById("ba-llm-artifact-count");
  if (artifactBadge) {
    artifactBadge.textContent = tn("panel.llm.artifactCount", artifactCount);
    artifactBadge.title = snap.lastArtifactId ? t("panel.llm.resources.lastArtifact", { id: snap.lastArtifactId }) : t("panel.llm.resources.artifactsSaved");
  }
  const recentArtifacts = llmArtifacts.listSummaries({ limit: 3 }).filter((item): item is LlmArtifactSummary => Boolean(item));
  const attachedArtifact = llmArtifacts.getContextArtifact();
  const attachedSummary = attachedArtifact ? llmArtifacts.summarizeArtifact(attachedArtifact) : null;
  const artifactsById = new Map<string, LlmArtifactSummary>();
  for (const artifact of recentArtifacts.slice().reverse()) {
    artifactsById.set(artifact.id, artifact);
  }
  if (attachedSummary && !artifactsById.has(attachedSummary.id)) {
    artifactsById.set(attachedSummary.id, attachedSummary);
  }
  const artifactRows = Array.from(artifactsById.values()).map(createArtifactResourceRow);
  const attachedLine = attachedSummary
    ? (artifactContextLimit() > 0
      ? t("panel.llm.resources.artifactAttachedLine", { id: attachedSummary.id })
      : t("panel.llm.resources.artifactAttachedBlockedLine", { id: attachedSummary.id }))
    : "";
  const operationLine = (snap.lastOperation
    ? t("panel.llm.resources.operationLine", { op: snap.lastOperation })
    : t("panel.llm.resources.operation"))
    + (snap.llmBusy ? t("panel.llm.resources.llmBusy") : "")
    + (snap.toolBusy ? t("panel.llm.resources.toolBusy") : "");
  const lines: HTMLElement[] = [
    createTextElement(
      "span",
      "",
      t("panel.llm.resources.artifacts", { count: artifactCount })
        + (snap.lastArtifactId ? ` · ${snap.lastArtifactId}` : "")
        + (attachedLine ? ` · ${attachedLine}` : ""),
    ),
    ...artifactRows,
    createTextElement("span", "", budgetLine),
    createTextElement("span", "", ctx ? t("panel.llm.resources.contextActive", { tokens: ctx.estimatedTokens || 0, chars: ctx.chars || 0 }) : t("panel.llm.resources.context")),
    createTextElement("span", "", operationLine),
  ];
  if (artifactCount) {
    const button = document.createElement("button");
    button.id = "ba-llm-clear-artifacts";
    button.type = "button";
    button.textContent = t("panel.llm.resources.clearArtifacts");
    button.addEventListener("click", () => {
      llmArtifacts.clear();
      updateResourceLines();
    });
    lines.push(button);
  }
  box.replaceChildren(...lines);
}

async function handleLoadClick(): Promise<void> {
  const llm = ensureLlmState();
  try {
    setButtonBusy(true);
    setProgress({ status: "init", model: getSelectedModel().model || "" }, true);
    const selected = getSelectedModel();
    const caps = await checkCapabilities();
    if (llmModelRequiresWebGPU(selected) && !caps.webgpu) return;
    setStatus(selected.engine === "ollama"
      ? t("common.connectingOllama")
      : (selected.device === "wasm" ? t("panel.llm.status.loadingWasm") : t("panel.llm.status.loadingModel")), "warn");
    llm.loading = true;
    await llmAgent.loadSelectedModel();
    setProgress({ status: "done" }, true);
  } catch (error) {
    llm.lastError = errorMessage(error);
    setStatus(t("panel.llm.status.loadError"), "bad");
    setProgress({ status: "error", file: errorMessage(error) }, true);
  } finally {
    llm.loading = false;
    setButtonBusy(false);
    syncWorkerUnloadButton();
    llmAgent.updateChatAvailability();
  }
}

async function handleClearMemoryClick(): Promise<void> {
  const result = await showBaModal({
    title: t("common.clearChat"),
    message: t("panel.llm.clearChat.message"),
    detail: t("panel.llm.clearChat.detail"),
    buttons: [
      { id: "cancel", label: t("common.cancel"), variant: "secondary", cancel: true },
      { id: "clear", label: t("common.clearChat"), variant: "danger" },
    ],
  });
  if (result === "clear") llmAgent.clearHistory();
}

function mountPanel(): void {
  const body = findLLMPanelBody();
  if (!body || document.getElementById("ba-llm-panel")) return;
  const llm = ensureLlmState();

  const details = body.closest("details");
  const summary = details?.querySelector("summary.panel-title");
  if (details) details.classList.add("ba-llm-panel-host");
  if (summary && !summary.querySelector("#ba-llm-status")) {
    const statusBadge = document.createElement("span");
    statusBadge.id = "ba-llm-status";
    statusBadge.className = "badge ba-llm-header-status warn";
    statusBadge.textContent = llm.loading
      ? t("common.loadingLower")
      : (llm.loaded ? t("common.loadedLower") : t("common.unloadedLower"));
    summary.appendChild(statusBadge);
  }
  if (summary && !summary.querySelector("#ba-llm-summary-compat")) {
    const capabilityBadge = document.createElement("span");
    capabilityBadge.id = "ba-llm-summary-compat";
    capabilityBadge.className = "badge ba-llm-summary-compat warn";
    capabilityBadge.textContent = llm.capabilitiesChecked
      ? (syncLLMCapabilityBadges(isLlmCapabilities(llm.capabilities) ? llm.capabilities : null, "ready").text || "GPU")
      : t("caps.badge.pending");
    summary.appendChild(capabilityBadge);
  }

  Array.from(body.children).forEach((child) => child.remove());

  body.insertAdjacentHTML("beforeend", llmPanelTemplate.buildLLMPanelHtml());
  applyDomTranslations(body);
  originApi.syncWarnings();

  const select = selectedModelSelect();
  if (!select) return;
  select.value = llm.selectedModelId;
  select.addEventListener("change", () => {
    if (llm.loaded) llmAgent.unloadModel();
    syncCustomVisibility();
    updateNativeToolsPickerUi();
  });
  syncCustomVisibility();
  syncToolPolicyUi();
  updateAvailableToolsUi();
  updateChatToolsButton();
  updateResourceLines();
  if (llm.capabilitiesChecked) {
    applyCapabilitiesToPanel(isLlmCapabilities(llm.capabilities) ? llm.capabilities : null);
  } else {
    syncLLMCapabilityBadges(null, llm.capabilitiesChecking ? "checking" : "ready");
    llmPanelCapabilities.decorateCapabilityRecheckBadges();
  }
  llmPanelCapabilities.bindCapabilityRecheckBadges(() => {
    void llmPanelCapabilities.runCapabilityRecheckFromBadge({ checkCapabilities, setStatus });
  });

  if (details instanceof HTMLDetailsElement) {
    details.addEventListener("toggle", () => {
      void llmPanelCapabilities.ensureCapabilitiesWhenPanelOpens(details, { checkCapabilities, setStatus });
    });
    if (details.open) {
      void llmPanelCapabilities.ensureCapabilitiesWhenPanelOpens(details, { checkCapabilities, setStatus });
    }
  }
  document.getElementById("ba-llm-tool-autonomy")?.addEventListener("change", (event) => {
    const selectTarget = event.target instanceof HTMLSelectElement ? event.target : null;
    llmToolExecutor.setAutonomyMaxLevel(selectTarget?.value ?? 1);
    syncToolPolicyUi();
  });

  document.getElementById("chat-tools-btn")?.addEventListener("click", () => openChatToolsModal());

  document.getElementById("ba-llm-show-thinking")?.addEventListener("change", (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    if (input && llm.settings) llm.settings.showThinking = input.checked;
  });

  document.getElementById("ba-llm-ollama-endpoint")?.addEventListener("change", (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    const value = (input?.value || "").trim().replace(/\/+$/g, "");
    if (value) localStorage.setItem("ba.llm.ollama.endpoint", value);
    else localStorage.removeItem("ba.llm.ollama.endpoint");
    if (llm.loaded && getSelectedModel().engine === "ollama") {
      llmAgent.unloadModel();
    }
    syncCustomVisibility();
  });

  document.getElementById("vm-profile")?.addEventListener("change", () => {
    updateAvailableToolsUi();
    updateNativeToolsPickerUi();
  });
  llmEventsApi.on("native-tools", () => {
    updateNativeToolsPickerUi();
    updateChatToolsButton();
  });

  document.getElementById("ba-llm-load")?.addEventListener("click", () => {
    void handleLoadClick();
  });

  document.getElementById("chat-clear-memory")?.addEventListener("click", () => {
    void handleClearMemoryClick();
  });
  llmAgent.updateChatAvailability();
  syncWorkerUnloadButton();
  document.getElementById("ba-llm-abort")?.addEventListener("click", () => {
    if (!canUnloadActiveWorker()) return;
    llmAgent.unloadModel();
    setProgress(null, true);
    setStatus(t("panel.llm.status.workerUnloaded"), "warn");
    syncWorkerUnloadButton();
  });
}

function bindEvents(): void {
  llmEventsApi.on("status", (detail) => {
    setStatus(textValue(detail.text, "—"), textValue(detail.tone));
    updateSelectedModelCard();
  });

  llmEventsApi.on("capabilities", (detail) => {
    const currentCapabilities = getLlmState()?.capabilities;
    const capabilities = isLlmCapabilities(detail.capabilities)
      ? detail.capabilities
      : (isLlmCapabilities(currentCapabilities) ? currentCapabilities : null);
    applyCapabilitiesToPanel(capabilities);
  });

  llmEventsApi.on("tool-policy", () => {
    syncToolPolicyUi();
    updateAvailableToolsUi();
  });

  llmEventsApi.on("progress", (detail) => {
    setProgress(detail, true);
  });

  llmEventsApi.on("context", (detail) => {
    updateResourceLines({ context: resourceContext(detail) || {} });
  });

  llmEventsApi.on("artifact", () => updateResourceLines());
  llmEventsApi.on("artifact-context", () => updateResourceLines());
  llmEventsApi.on("artifact-remove", () => updateResourceLines());
  llmEventsApi.on("artifact-clear", () => updateResourceLines());

  llmEventsApi.on("resource", () => {
    updateResourceLines();
    updateAvailableToolsUi();
  });

  appEvents.on("app:language-changed", () => {
    updateSelectedModelCard();
    updateResourceLines();
    updateAvailableToolsUi();
    updateChatToolsButton();
    updateNativeToolsPickerUi();
    syncToolPolicyUi();
    const capabilities = getLlmState()?.capabilities;
    updateCapabilityDetails(isLlmCapabilities(capabilities) ? capabilities : null);
  });
}

export function initLlmPanel(): void {
  if (initialized) return;
  initialized = true;
  bindEvents();
  window.requestAnimationFrame(mountPanel);
  window.requestAnimationFrame(updateChatToolsButton);
}
