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
import {
  defaultModelConfig,
  findLlmModel,
  getLlmState,
  getSelectedLlmModel,
  llmEngineMetaLabel,
  llmEventsApi,
  llmModelRequiresWebGPU,
  llmModelShortLabel,
  registerDiscoveredModel,
  registerModelProfile,
  selectLlmModel,
  type LlmModelConfig,
} from "../state/chat-state";
import { discoverOllamaModels, HfModelSearchService, inspectOllamaModel } from "../models/model-discovery";
import type { DiscoveredModel, LlmEngine, LlmUserProfile, ModelInspection, OllamaThinkMode, ToolCallingQuality, ToolStrategy } from "../models/model-types";
import { modelKey } from "../models/model-types";
import {
  defaultProfile,
  exportProfiles,
  importProfiles,
  loadHfRecents,
  loadProfiles,
  PROFILES_STORAGE_KEY,
  recordHfRecent,
  saveProfile,
  validateProfile,
} from "../models/model-profiles";
import { chooseTransformersRuntime } from "../models/transformers-inspection";
import { getAiSdkReady } from "../provider/ai-sdk-runtime";
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
const hfSearch = new HfModelSearchService();
let hfNextUrl: string | null = null;
let hfResults: DiscoveredModel[] = [];
let ollamaResults: DiscoveredModel[] = [];

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
  return findLlmModel(select?.value) || getSelectedLlmModel() || defaultModelConfig("transformersjs", "");
}

function updateModelOptionCompatibility(caps: LlmCapabilities | null): void {
  const selected = getSelectedModel();
  const dtype = document.getElementById("ba-llm-dtype");
  if (dtype instanceof HTMLSelectElement) {
    for (const option of Array.from(dtype.options)) {
      option.disabled = Boolean(caps && !caps.shaderF16 && /f16/i.test(option.value));
    }
  }
  if (caps && !caps.webgpu && selected.engine === "transformersjs" && selected.device === "webgpu") {
    setStatus(t("panel.llm.status.requiresWebgpu"), "warn");
  }
}

function selectElement(id: string): HTMLSelectElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLSelectElement ? element : null;
}

function setDiscoveryError(id: string, message = ""): void {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = message;
  element.hidden = !message;
}

function formatDiscoveredModel(model: DiscoveredModel): string {
  const details = isRecord(model.metadata.details) ? model.metadata.details : {};
  const suffix = [
    textValue(details.parameter_size),
    textValue(details.quantization_level),
    bytesLabel(model.sizeBytes),
    model.downloads === undefined ? "" : `${model.downloads.toLocaleString()} ↓`,
  ].filter(Boolean).join(" · ");
  return suffix ? `${model.label} · ${suffix}` : model.label;
}

function renderDiscoveryOptions(select: HTMLSelectElement | null, models: DiscoveredModel[]): void {
  if (!select) return;
  const previous = select.value;
  select.replaceChildren(...models.map((model) => {
    const option = document.createElement("option");
    option.value = model.key;
    option.textContent = formatDiscoveredModel(model);
    return option;
  }));
  if (models.some((model) => model.key === previous)) select.value = previous;
}

function renderRecents(): void {
  const element = document.getElementById("ba-llm-hf-recents");
  if (!element) return;
  const recents = loadHfRecents(localStorage);
  element.textContent = recents.length ? `Recent: ${recents.join(" · ")}` : "";
}

function recentDiscoveredModels(): DiscoveredModel[] {
  return loadHfRecents(localStorage).map((modelId) => ({
    key: modelKey("transformersjs", modelId),
    engine: "transformersjs",
    modelId,
    label: `Recent · ${modelId}`,
    private: false,
    gated: false,
    metadata: { recent: true },
  }));
}

async function refreshHfModels({ append = false, force = false }: { append?: boolean; force?: boolean } = {}): Promise<void> {
  const search = inputById("ba-llm-hf-search")?.value || "";
  const results = selectElement("ba-llm-hf-results");
  const more = document.getElementById("ba-llm-hf-more");
  setDisabled(results, true);
  setDiscoveryError("ba-llm-hf-error");
  if (force) hfSearch.clearCache();
  try {
    const page = await hfSearch.search(search, append ? hfNextUrl : null);
    const pageModels = append ? page.models : [...recentDiscoveredModels(), ...page.models];
    hfResults = append
      ? [...hfResults, ...pageModels.filter((model) => !hfResults.some((item) => item.key === model.key))]
      : pageModels.filter((model, index, list) => list.findIndex((item) => item.key === model.key) === index);
    hfNextUrl = page.nextUrl;
    renderDiscoveryOptions(results, hfResults);
    if (more instanceof HTMLButtonElement) more.hidden = !hfNextUrl;
  } catch (error) {
    if ((error as { name?: string })?.name !== "AbortError") setDiscoveryError("ba-llm-hf-error", errorMessage(error));
  } finally {
    setDisabled(results, false);
  }
}

function ollamaEndpoint(): string {
  return (inputById("ba-llm-ollama-endpoint")?.value
    || localStorage.getItem("ba.llm.ollama.endpoint")
    || "http://127.0.0.1:11434").trim().replace(/\/+$/g, "");
}

async function refreshOllamaModels(): Promise<void> {
  const select = selectElement("ba-llm-ollama-models");
  setDisabled(select, true);
  setDiscoveryError("ba-llm-ollama-error");
  try {
    ollamaResults = await discoverOllamaModels(fetch, ollamaEndpoint());
    renderDiscoveryOptions(select, ollamaResults);
  } catch (error) {
    ollamaResults = [];
    renderDiscoveryOptions(select, []);
    setDiscoveryError("ba-llm-ollama-error", errorMessage(error));
  } finally {
    setDisabled(select, false);
  }
}

function refreshRegisteredModelSelect(config?: LlmModelConfig): void {
  const select = selectedModelSelect();
  if (!select) return;
  select.innerHTML = llmPanelTemplate.modelOptionsHtml();
  select.value = config?.id || ensureLlmState().selectedModelId;
}

function failedInspection(modelId: string, error: unknown): ModelInspection {
  return {
    modelId,
    availableDtypes: [],
    files: [],
    capabilities: { chat: null, tools: null, thinking: null, vision: null },
    warnings: ["Inspection failed. Loading with dtype:auto has not been validated."],
    inspected: false,
    error: errorMessage(error),
  };
}

async function selectTransformersModel(modelId: string, discovered?: DiscoveredModel): Promise<LlmModelConfig> {
  const normalized = modelId.trim();
  if (!normalized.includes("/")) throw new Error("Use a Hugging Face repository ID such as organization/model");
  const item = discovered || {
    key: modelKey("transformersjs", normalized),
    engine: "transformersjs" as const,
    modelId: normalized,
    label: normalized,
    private: false,
    gated: false,
    metadata: { manual: true },
  };
  const savedProfile = loadProfiles(localStorage)[item.key];
  let inspection: ModelInspection;
  let selection: Partial<LlmUserProfile> = {};
  try {
    const sdk = await getAiSdkReady();
    if (!sdk) throw new Error("AI SDK bridge is unavailable");
    inspection = await sdk.inspectModel(normalized);
    const caps = await ensureLLMCapabilities({ source: "model-inspection" });
    const runtime = chooseTransformersRuntime(inspection.availableDtypes, { webgpu: caps.webgpu, shaderF16: caps.shaderF16 });
    selection = { device: runtime.device, dtype: runtime.dtype };
    if (runtime.dtype !== inspection.selectedDtype && runtime.dtype !== "auto") {
      inspection = await sdk.inspectModel(normalized, { dtype: runtime.dtype });
    }
  } catch (error) {
    inspection = failedInspection(normalized, error);
    selection = { device: "auto", dtype: "auto" };
  }
  const config = registerDiscoveredModel(item, inspection, savedProfile ? null : selection);
  selectLlmModel(config);
  refreshRegisteredModelSelect(config);
  syncProfileUi(config);
  updateSelectedModelCard();
  return config;
}

async function selectOllamaDiscovered(model: DiscoveredModel): Promise<LlmModelConfig> {
  const details = await inspectOllamaModel(fetch, ollamaEndpoint(), model);
  const inspection: ModelInspection = {
    modelId: model.modelId,
    availableDtypes: [],
    files: [],
    contextWindowTokens: details.contextWindowTokens,
    chatTemplate: details.template,
    capabilities: details.capabilities,
    warnings: [
      ...(details.capabilities.tools ? [] : ["Ollama does not announce tool support; the user profile remains authoritative."]),
      ...(details.capabilities.thinking ? [] : ["Ollama does not announce thinking support."]),
    ],
    inspected: true,
  };
  const config = registerDiscoveredModel(model, inspection);
  selectLlmModel(config);
  refreshRegisteredModelSelect(config);
  syncProfileUi(config);
  updateSelectedModelCard();
  return config;
}

function selectedDiscoverySource(): LlmEngine {
  return selectElement("ba-llm-source")?.value === "ollama" ? "ollama" : "transformersjs";
}

async function ensureDiscoverySelection(): Promise<LlmModelConfig> {
  const source = selectedDiscoverySource();
  if (source === "ollama") {
    const key = selectElement("ba-llm-ollama-models")?.value;
    const model = ollamaResults.find((item) => item.key === key);
    if (!model) throw new Error("Select an installed Ollama model");
    if (getSelectedLlmModel()?.id === model.key) return getSelectedLlmModel() as LlmModelConfig;
    return await selectOllamaDiscovered(model);
  }
  const manual = inputById("ba-llm-custom-model")?.value.trim();
  const key = selectElement("ba-llm-hf-results")?.value;
  const model = hfResults.find((item) => item.key === key);
  const modelId = manual || model?.modelId || "";
  if (!modelId) throw new Error("Select a Hub result or enter a repository ID");
  if (getSelectedLlmModel()?.model === modelId) return getSelectedLlmModel() as LlmModelConfig;
  return await selectTransformersModel(modelId, manual ? undefined : model);
}

function numericInput(id: string, fallback: number): number {
  const value = Number(inputById(id)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function syncProfileUi(config = getSelectedModel()): void {
  const profile = config.profile;
  if (!profile) return;
  const setValue = (id: string, value: unknown): void => {
    const element = document.getElementById(id);
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) element.value = textValue(value);
  };
  setValue("ba-llm-tool-strategy", profile.toolStrategy);
  setValue("ba-llm-tool-calling", profile.toolCalling);
  setValue("ba-llm-max-steps", profile.maxSteps);
  setValue("ba-llm-max-tools", profile.maxNativeTools);
  setValue("ba-llm-temperature", profile.temperature);
  setValue("ba-llm-top-p", profile.topP);
  setValue("ba-llm-context-window", profile.contextWindowTokens);
  setValue("ba-llm-safe-input", profile.safeInputTokens);
  setValue("ba-llm-max-output", profile.maxOutputTokens);
  setValue("ba-llm-max-plan", profile.maxNewTokensForPlan);
  setValue("ba-llm-device", profile.device || "auto");
  const dtype = selectElement("ba-llm-dtype");
  if (dtype) {
    const dtypes = ["auto", ...(config.inspection?.availableDtypes || [])];
    dtype.replaceChildren(...[...new Set(dtypes)].map((value) => new Option(value, value)));
    dtype.value = profile.dtype || "auto";
  }
  const think = selectElement("ba-llm-think-mode");
  if (think) {
    const options = profile.engine === "ollama" ? ["auto", "off", "on", "low", "medium", "high", "max"] : ["off", "on"];
    think.replaceChildren(...options.map((value) => new Option(value, value)));
    think.value = profile.engine === "ollama" ? profile.ollamaThink || "auto" : (profile.transformersThinking?.enabled ? "on" : "off");
  }
  const checked = (id: string, value: boolean): void => { const input = inputById(id); if (input) input.checked = value; };
  checked("ba-llm-show-thinking", profile.showThinking);
  checked("ba-llm-reuse-cache", Boolean(profile.reuseGenerationCache));
  checked("ba-llm-start-reasoning", Boolean(profile.transformersThinking?.startWithReasoning));
  setValue("ba-llm-thinking-tag", profile.transformersThinking?.tagName || "think");
  for (const id of ["ba-llm-device-wrap", "ba-llm-dtype-wrap", "ba-llm-cache-wrap", "ba-llm-tag-wrap", "ba-llm-reasoning-start-wrap"]) {
    const element = document.getElementById(id);
    if (element instanceof HTMLElement) element.hidden = profile.engine !== "transformersjs";
  }
}

function profileFromUi(config: LlmModelConfig): LlmUserProfile | null {
  const current = config.profile || defaultProfile(config.engine, config.model || "");
  const thinkMode = selectElement("ba-llm-think-mode")?.value || "off";
  return validateProfile({
    ...current,
    toolStrategy: selectElement("ba-llm-tool-strategy")?.value as ToolStrategy,
    toolCalling: selectElement("ba-llm-tool-calling")?.value as ToolCallingQuality,
    maxSteps: numericInput("ba-llm-max-steps", current.maxSteps),
    maxNativeTools: numericInput("ba-llm-max-tools", current.maxNativeTools),
    temperature: numericInput("ba-llm-temperature", current.temperature),
    topP: numericInput("ba-llm-top-p", current.topP),
    contextWindowTokens: numericInput("ba-llm-context-window", current.contextWindowTokens),
    safeInputTokens: numericInput("ba-llm-safe-input", current.safeInputTokens),
    maxOutputTokens: numericInput("ba-llm-max-output", current.maxOutputTokens),
    maxNewTokensForPlan: numericInput("ba-llm-max-plan", current.maxNewTokensForPlan),
    showThinking: Boolean(inputById("ba-llm-show-thinking")?.checked),
    device: selectElement("ba-llm-device")?.value || "auto",
    dtype: selectElement("ba-llm-dtype")?.value || "auto",
    reuseGenerationCache: Boolean(inputById("ba-llm-reuse-cache")?.checked),
    transformersThinking: current.engine === "transformersjs" ? {
      enabled: thinkMode === "on",
      tagName: inputById("ba-llm-thinking-tag")?.value.trim() || "think",
      startWithReasoning: Boolean(inputById("ba-llm-start-reasoning")?.checked),
    } : undefined,
    ollamaThink: current.engine === "ollama" ? thinkMode as OllamaThinkMode : undefined,
  });
}

function saveProfileFromUi(): void {
  const current = getSelectedModel();
  const profile = profileFromUi(current);
  if (!profile) {
    setStatus("Invalid model profile", "bad");
    return;
  }
  if (ensureLlmState().loaded) llmAgent.unloadModel();
  saveProfile(localStorage, profile);
  const config = registerModelProfile(profile, current.inspection || null);
  selectLlmModel(config);
  refreshRegisteredModelSelect(config);
  updateSelectedModelCard();
  updateNativeToolsPickerUi();
}

function resetCurrentProfile(): void {
  const current = getSelectedModel();
  const profile = defaultProfile(current.engine, current.model || "");
  const config = registerModelProfile(profile, current.inspection || null);
  saveProfile(localStorage, profile);
  selectLlmModel(config);
  refreshRegisteredModelSelect(config);
  syncProfileUi(config);
  updateSelectedModelCard();
}

function exportStoredProfiles(): void {
  const content = JSON.stringify(exportProfiles(loadProfiles(localStorage)), null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "browser-agent-llm-profiles.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

async function importStoredProfiles(file: File): Promise<void> {
  const value: unknown = JSON.parse(await file.text());
  const existing = loadProfiles(localStorage);
  let result = importProfiles(value, existing, false);
  if (result.conflicts.length && window.confirm(`Overwrite ${result.conflicts.length} existing profiles?`)) {
    result = importProfiles(value, existing, true);
  }
  localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(result.profiles));
  setStatus(`Imported ${result.imported}; invalid ${result.invalid}; skipped ${result.conflicts.length}`, result.invalid ? "warn" : "good");
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
  const input = document.getElementById("ba-llm-show-thinking");
  if (!(input instanceof HTMLInputElement)) return;
  const enabled = Boolean(model.thinking?.enabled);
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
  return `Transformers.js v4 · ${device}${dtype}${fallback}`;
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
  if (desc) {
    const capabilities = model.inspection?.capabilities;
    const descText = capabilities
      ? `chat: ${capabilities.chat ?? "unknown"} · tools: ${capabilities.tools ?? "unknown"} · thinking: ${capabilities.thinking ?? "unknown"} · vision: ${capabilities.vision ?? "unknown"}`
      : "";
    desc.textContent = descText;
    desc.hidden = !descText;
  }
  if (repo) repo.textContent = model.model || "";
  if (meta) {
    const loaded = Boolean(getLlmState()?.loaded);
    const entries: Array<[string, unknown] | null> = [
      loaded ? [t("panel.llm.meta.backendLoaded"), activeBackendLabel(model) || "—"] : null,
      loaded ? null : [t("panel.llm.meta.engine"), llmEngineMetaLabel(model)],
      [t("panel.llm.meta.download"), bytesLabel(model.sizeBytes) || "—"],
      loaded ? null : [t("panel.llm.meta.quantization"), model.dtype || "—"],
      ["context", model.contextWindowTokens || "—"],
      [t("panel.llm.meta.tools"), model.agent?.toolCalling || "—"],
      [t("panel.llm.meta.reasoning"), model.thinking?.enabled ? t("common.yes") : t("common.no")],
    ];
    const items = entries.filter((entry): entry is [string, unknown] => Boolean(entry)).map(([key, value]) => createMetaItem(key, value));
    meta.replaceChildren(...items);
  }
  const warnings = document.getElementById("ba-llm-model-warnings");
  if (warnings) warnings.textContent = [...(model.inspection?.warnings || []), ...(model.inspection?.error ? [model.inspection.error] : [])].join(" · ");
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
  const source = selectedDiscoverySource();
  const hf = document.getElementById("ba-llm-hf-discovery");
  const ollama = document.getElementById("ba-llm-ollama-discovery");
  if (hf instanceof HTMLElement) hf.hidden = source !== "transformersjs";
  if (ollama instanceof HTMLElement) ollama.hidden = source !== "ollama";
  const selected = getSelectedModel();
  const endpoint = inputById("ba-llm-ollama-endpoint");
  if (endpoint && !endpoint.value) {
    endpoint.value = localStorage.getItem("ba.llm.ollama.endpoint") || "http://127.0.0.1:11434";
  }
  const ollamaOriginNotice = document.getElementById("ba-llm-ollama-origin-notice");
  if (ollamaOriginNotice) {
    const show = Boolean(source === "ollama" && originApi.isPublishedOrigin());
    ollamaOriginNotice.hidden = !show;
    if (show) ollamaOriginNotice.textContent = originApi.localServiceWarningText("ollama");
  }
  updateSelectedModelCard();
  updateResourceLines();
  setProgress(null, true);
  const llm = ensureLlmState();
  const caps = isLlmCapabilities(llm.capabilities) ? llm.capabilities : null;
  const needsWebGPU = llmModelRequiresWebGPU(selected);
  if (needsWebGPU && caps && !caps.webgpu) {
    setStatus(t("panel.llm.status.requiresWebgpu"), "warn");
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
  return findLlmModel(select?.value)
    || llm?.activeModel
    || getSelectedLlmModel()
    || defaultModelConfig("transformersjs", "");
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
    setProgress({ status: "init", model: "" }, true);
    const selected = await ensureDiscoverySelection();
    setProgress({ status: "init", model: selected.model || "" }, true);
    const caps = await checkCapabilities();
    if (llmModelRequiresWebGPU(selected) && !caps.webgpu) return;
    setStatus(selected.engine === "ollama"
      ? t("common.connectingOllama")
      : (selected.device === "wasm" ? t("panel.llm.status.loadingWasm") : t("panel.llm.status.loadingModel")), "warn");
    llm.loading = true;
    await llmAgent.loadSelectedModel();
    if (selected.engine === "transformersjs" && selected.model) {
      recordHfRecent(localStorage, selected.model);
      renderRecents();
    }
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
    const config = findLlmModel(select.value);
    if (config) selectLlmModel(config);
    syncProfileUi(config || getSelectedModel());
    syncCustomVisibility();
    updateNativeToolsPickerUi();
  });
  const source = selectElement("ba-llm-source");
  source?.addEventListener("change", () => {
    if (llm.loaded) llmAgent.unloadModel();
    syncCustomVisibility();
    if (source.value === "ollama") void refreshOllamaModels();
  });
  inputById("ba-llm-hf-search")?.addEventListener("input", () => { void refreshHfModels(); });
  document.getElementById("ba-llm-hf-refresh")?.addEventListener("click", () => { void refreshHfModels({ force: true }); });
  document.getElementById("ba-llm-hf-more")?.addEventListener("click", () => { if (hfNextUrl) void refreshHfModels({ append: true }); });
  selectElement("ba-llm-hf-results")?.addEventListener("change", () => {
    const key = selectElement("ba-llm-hf-results")?.value;
    const model = hfResults.find((item) => item.key === key);
    const manual = inputById("ba-llm-custom-model");
    if (manual) manual.value = "";
    if (model) void selectTransformersModel(model.modelId, model).catch((error) => setDiscoveryError("ba-llm-hf-error", errorMessage(error)));
  });
  document.getElementById("ba-llm-ollama-refresh")?.addEventListener("click", () => { void refreshOllamaModels(); });
  selectElement("ba-llm-ollama-models")?.addEventListener("change", () => {
    const key = selectElement("ba-llm-ollama-models")?.value;
    const model = ollamaResults.find((item) => item.key === key);
    if (model) void selectOllamaDiscovered(model).catch((error) => setDiscoveryError("ba-llm-ollama-error", errorMessage(error)));
  });
  const profileControlIds = [
    "ba-llm-tool-strategy", "ba-llm-tool-calling", "ba-llm-max-steps", "ba-llm-max-tools",
    "ba-llm-think-mode", "ba-llm-show-thinking", "ba-llm-temperature", "ba-llm-top-p",
    "ba-llm-context-window", "ba-llm-safe-input", "ba-llm-max-output", "ba-llm-max-plan",
    "ba-llm-device", "ba-llm-dtype", "ba-llm-reuse-cache", "ba-llm-thinking-tag", "ba-llm-start-reasoning",
  ];
  for (const id of profileControlIds) document.getElementById(id)?.addEventListener("change", saveProfileFromUi);
  document.getElementById("ba-llm-profile-reset")?.addEventListener("click", resetCurrentProfile);
  document.getElementById("ba-llm-profile-export")?.addEventListener("click", exportStoredProfiles);
  document.getElementById("ba-llm-profile-import")?.addEventListener("click", () => inputById("ba-llm-profile-file")?.click());
  inputById("ba-llm-profile-file")?.addEventListener("change", (event) => {
    const file = event.target instanceof HTMLInputElement ? event.target.files?.[0] : null;
    if (file) void importStoredProfiles(file).catch((error) => setStatus(errorMessage(error), "bad"));
  });
  hfResults = recentDiscoveredModels();
  renderDiscoveryOptions(selectElement("ba-llm-hf-results"), hfResults);
  renderRecents();
  void refreshHfModels();
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
    if (llm.loaded) {
      llmAgent.unloadModel();
    }
    void refreshOllamaModels();
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
    const select = selectedModelSelect();
    if (select) {
      select.innerHTML = llmPanelTemplate.modelOptionsHtml();
      select.value = ensureLlmState().selectedModelId;
    }
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
