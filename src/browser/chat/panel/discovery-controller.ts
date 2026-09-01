import { t } from "../../app/i18n";
import { ensureLLMCapabilities } from "../state/capabilities";
import {
  getLlmModels,
  getSelectedLlmModel,
  registerDiscoveredModel,
  selectLlmModel,
  type LlmModelConfig,
} from "../state/chat-state";
import {
  discoverOllamaToolModels,
  HfModelSearchService,
  inspectOllamaModel,
} from "../models/model-discovery";
import type { DiscoveredModel, LlmEngine, LlmUserProfile, ModelInspection } from "../models/model-types";
import { modelKey } from "../models/model-types";
import { loadHfRecents, recordHfRecent } from "../models/model-profiles";
import { chooseTransformersRuntime } from "../models/transformers-inspection";
import { getAiSdkReady } from "../provider/ai-sdk-runtime";
import { llmAgent } from "../runtime/agent-loop";
import {
  bytesLabel,
  elementById,
  errorMessage,
  eventTargetElement,
  inputById,
  isRecord,
  setDisabled,
  textValue,
} from "./dom-utils";
import { ensureLlmState, getSelectedModel } from "./state-utils";

interface DiscoveryControllerHooks {
  onModelSelected: (config: LlmModelConfig) => void;
  onSourceChanged: () => void;
}

const ACTION_CONTROL_SELECTOR = [
  'input[name="ba-llm-source"]',
  "#ba-llm-hf-search",
  "#ba-llm-custom-model",
  "#ba-llm-ollama-endpoint",
  "#ba-llm-tool-strategy",
  "#ba-llm-tool-calling",
  "#ba-llm-max-steps",
  "#ba-llm-max-tools",
  "#ba-llm-think-mode",
  "#ba-llm-show-thinking",
  "#ba-llm-temperature",
  "#ba-llm-top-p",
  "#ba-llm-context-window",
  "#ba-llm-safe-input",
  "#ba-llm-max-output",
  "#ba-llm-max-plan",
  "#ba-llm-device",
  "#ba-llm-dtype",
  "#ba-llm-reuse-cache",
  "#ba-llm-thinking-tag",
  "#ba-llm-start-reasoning",
  "#ba-llm-profile-reset",
].join(",");

export interface DiscoveryController {
  source: () => LlmEngine;
  bind: () => void;
  initialize: () => void;
  ensureSelection: () => Promise<LlmModelConfig>;
  setActionBusy: (busy: boolean) => void;
  render: () => void;
  recordRecent: (model: LlmModelConfig) => void;
}

export function createDiscoveryController(hooks: DiscoveryControllerHooks): DiscoveryController {
  const searchService = new HfModelSearchService();
  let hfNextUrl: string | null = null;
  let hfResults: DiscoveredModel[] = [];
  let ollamaResults: DiscoveredModel[] = [];
  let selectedHfKey = "";
  let selectedOllamaKey = "";
  let inspectionGeneration = 0;
  let inspectionModelId = "";
  let inspectionPending = false;
  let actionBusy = false;
  let hfRequestBusy = false;
  let hfRequestGeneration = 0;
  let ollamaRequestBusy = false;
  let hfLoadMoreButton: HTMLButtonElement | null = null;

  function source(): LlmEngine {
    const checked = document.querySelector<HTMLInputElement>('input[name="ba-llm-source"]:checked');
    return checked?.value === "ollama" ? "ollama" : "transformersjs";
  }

  function selectedKey(engine: LlmEngine): string {
    return engine === "ollama" ? selectedOllamaKey : selectedHfKey;
  }

  function setSelectedKey(engine: LlmEngine, key: string): void {
    if (engine === "ollama") selectedOllamaKey = key;
    else selectedHfKey = key;
    const list = elementById(engine === "ollama" ? "ba-llm-ollama-models" : "ba-llm-hf-results");
    for (const option of Array.from(list?.querySelectorAll<HTMLElement>("[data-model-key]") || [])) {
      const selected = option.dataset.modelKey === key;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-selected", String(selected));
    }
  }

  function formatDiscoveredModel(model: DiscoveredModel): string {
    const details = isRecord(model.metadata.details) ? model.metadata.details : {};
    return [
      textValue(details.parameter_size),
      textValue(details.quantization_level),
      bytesLabel(model.sizeBytes),
      model.downloads === undefined ? "" : `${model.downloads.toLocaleString()} ↓`,
    ].filter(Boolean).join(" · ");
  }

  function createOption(model: DiscoveredModel): HTMLButtonElement {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "ba-llm-model-option";
    option.dataset.modelKey = model.key;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    const main = document.createElement("span");
    main.className = "ba-llm-model-option-main";
    const title = document.createElement("strong");
    title.textContent = model.label;
    main.append(title);
    const details = formatDiscoveredModel(model);
    if (details) {
      const meta = document.createElement("small");
      meta.textContent = details;
      main.append(meta);
    }
    option.append(main);
    if (model.metadata.recent === true) {
      const recent = document.createElement("span");
      recent.className = "ba-llm-model-option-tag";
      recent.textContent = t("panel.llm.discovery.recent");
      option.append(recent);
    }
    return option;
  }

  function loadMoreButton(): HTMLButtonElement {
    if (!hfLoadMoreButton) {
      hfLoadMoreButton = document.createElement("button");
      hfLoadMoreButton.id = "ba-llm-hf-more";
      hfLoadMoreButton.type = "button";
      hfLoadMoreButton.className = "ba-llm-model-load-more";
      hfLoadMoreButton.setAttribute("role", "option");
      hfLoadMoreButton.setAttribute("aria-selected", "false");
      hfLoadMoreButton.addEventListener("click", () => {
        if (hfNextUrl && !actionBusy && !hfRequestBusy) void refreshHf({ append: true });
      });
    }
    hfLoadMoreButton.textContent = t("panel.llm.discovery.more");
    return hfLoadMoreButton;
  }

  function syncLoadMoreOption(container: HTMLElement, engine: LlmEngine): void {
    if (engine !== "transformersjs") return;
    if (hfNextUrl) container.append(loadMoreButton());
    else hfLoadMoreButton?.remove();
  }

  function renderList(container: HTMLElement | null, models: DiscoveredModel[], options: { append?: boolean } = {}): void {
    if (!container) return;
    const scrollTop = container.scrollTop;
    const activeElement = document.activeElement;
    const selectedModel = getSelectedLlmModel();
    const engine = container.id === "ba-llm-ollama-models" ? "ollama" : "transformersjs";
    const knownKeys = new Set(Array.from(container.querySelectorAll<HTMLElement>("[data-model-key]"))
      .map((item) => item.dataset.modelKey));
    const additions = options.append ? models.filter((model) => !knownKeys.has(model.key)) : models;
    if (!options.append) container.replaceChildren();
    container.append(...additions.map(createOption));
    syncLoadMoreOption(container, engine);
    const activeKey = selectedKey(engine) || (selectedModel?.engine === engine ? selectedModel.id : "");
    const hasActiveKey = Array.from(container.querySelectorAll<HTMLElement>("[data-model-key]"))
      .some((item) => item.dataset.modelKey === activeKey);
    if (activeKey && hasActiveKey) setSelectedKey(engine, activeKey);
    else if (!options.append) setSelectedKey(engine, "");
    if (options.append) {
      container.scrollTop = scrollTop;
      if (activeElement === hfLoadMoreButton && !document.contains(activeElement)) {
        container.focus({ preventScroll: true });
      } else if (activeElement instanceof HTMLElement && document.contains(activeElement)) {
        activeElement.focus({ preventScroll: true });
      }
    }
    syncBusyUi();
  }

  function renderListBusy(id: string, busy: boolean): void {
    const list = elementById(id);
    if (!list) return;
    list.classList.toggle("is-busy", busy);
    list.setAttribute("aria-busy", String(busy));
    for (const button of Array.from(list.querySelectorAll("button"))) setDisabled(button, busy);
  }

  function setActionControlsDisabled(disabled: boolean): void {
    for (const control of Array.from(document.querySelectorAll(ACTION_CONTROL_SELECTOR))) setDisabled(control, disabled);
  }

  function syncBusyUi(): void {
    renderListBusy("ba-llm-hf-results", actionBusy || hfRequestBusy);
    renderListBusy("ba-llm-ollama-models", actionBusy || ollamaRequestBusy);
    setDisabled(document.getElementById("ba-llm-hf-refresh"), actionBusy || hfRequestBusy);
    setDisabled(hfLoadMoreButton, actionBusy || hfRequestBusy);
    setDisabled(document.getElementById("ba-llm-ollama-refresh"), actionBusy || ollamaRequestBusy);
  }

  function setListBusy(id: string, busy: boolean): void {
    if (id === "ba-llm-hf-results") hfRequestBusy = busy;
    else if (id === "ba-llm-ollama-models") ollamaRequestBusy = busy;
    syncBusyUi();
  }

  function renderInspection(): void {
    const container = elementById("ba-llm-model-inspection");
    const text = document.getElementById("ba-llm-model-inspection-text");
    if (!container) return;
    container.hidden = !inspectionPending;
    if (text) text.textContent = inspectionPending
      ? t("panel.llm.discovery.inspecting", { model: inspectionModelId })
      : "";
    document.getElementById("ba-llm-panel")?.setAttribute("aria-busy", String(actionBusy || inspectionPending));
    if (inspectionPending) {
      const card = elementById("ba-llm-selected-card");
      const warnings = elementById("ba-llm-model-warnings");
      if (card) card.hidden = true;
      if (warnings) warnings.hidden = true;
    }
    setDisabled(document.getElementById("ba-llm-load"), actionBusy || inspectionPending);
  }

  function beginInspection(modelId: string): number {
    inspectionGeneration += 1;
    inspectionModelId = modelId;
    inspectionPending = true;
    renderInspection();
    return inspectionGeneration;
  }

  function finishInspection(generation: number): void {
    if (generation !== inspectionGeneration) return;
    inspectionModelId = "";
    inspectionPending = false;
    renderInspection();
  }

  function cancelInspection(): void {
    inspectionGeneration += 1;
    inspectionModelId = "";
    inspectionPending = false;
    renderInspection();
  }

  function recentModels(): DiscoveredModel[] {
    const verified = new Set(getLlmModels()
      .filter((model) => model.engine === "transformersjs" && model.inspection?.capabilities.tools === true)
      .map((model) => model.model));
    return loadHfRecents(localStorage)
      .filter((modelId) => verified.has(modelId))
      .map((modelId) => ({
        key: modelKey("transformersjs", modelId),
        engine: "transformersjs",
        modelId,
        label: modelId,
        private: false,
        gated: false,
        metadata: { recent: true, tools: true },
      }));
  }

  function renderRecents(): void {
    const element = document.getElementById("ba-llm-hf-recents");
    if (!element) return;
    const recents = recentModels();
    element.textContent = recents.length
      ? t("panel.llm.discovery.recentsAvailable", { count: recents.length })
      : "";
  }

  function setError(id: string, message = ""): void {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = message;
    element.hidden = !message;
  }

  async function refreshHf({ append = false, force = false }: { append?: boolean; force?: boolean } = {}): Promise<void> {
    if (actionBusy || (append && hfRequestBusy)) return;
    const requestGeneration = ++hfRequestGeneration;
    const search = inputById("ba-llm-hf-search")?.value || "";
    const results = elementById("ba-llm-hf-results");
    if (!append) {
      hfNextUrl = null;
      hfLoadMoreButton?.remove();
    }
    setListBusy("ba-llm-hf-results", true);
    setError("ba-llm-hf-error");
    if (force) searchService.clearCache();
    try {
      const page = await searchService.search(search, append ? hfNextUrl : null);
      const pageModels = append ? page.models : [...(search.trim() ? [] : recentModels()), ...page.models];
      hfResults = append
        ? [...hfResults, ...pageModels.filter((model) => !hfResults.some((item) => item.key === model.key))]
        : pageModels.filter((model, index, list) => list.findIndex((item) => item.key === model.key) === index);
      hfNextUrl = page.nextUrl;
      renderList(results, hfResults, { append });
    } catch (error) {
      if ((error as { name?: string })?.name !== "AbortError") setError("ba-llm-hf-error", errorMessage(error));
    } finally {
      if (requestGeneration === hfRequestGeneration) setListBusy("ba-llm-hf-results", false);
    }
  }

  function ollamaEndpoint(): string {
    return (inputById("ba-llm-ollama-endpoint")?.value
      || localStorage.getItem("ba.llm.ollama.endpoint")
      || "http://127.0.0.1:11434").trim().replace(/\/+$/g, "");
  }

  async function refreshOllama(): Promise<void> {
    if (actionBusy || ollamaRequestBusy) return;
    const list = elementById("ba-llm-ollama-models");
    setListBusy("ba-llm-ollama-models", true);
    setError("ba-llm-ollama-error");
    try {
      ollamaResults = await discoverOllamaToolModels(fetch, ollamaEndpoint());
      renderList(list, ollamaResults);
    } catch (error) {
      ollamaResults = [];
      renderList(list, []);
      setError("ba-llm-ollama-error", errorMessage(error));
    } finally {
      setListBusy("ba-llm-ollama-models", false);
    }
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

  async function selectTransformers(modelId: string, discovered?: DiscoveredModel): Promise<LlmModelConfig> {
    const normalized = modelId.trim();
    if (!normalized.includes("/")) throw new Error("Use a Hugging Face repository ID such as organization/model");
    const generation = beginInspection(normalized);
    try {
      const llm = ensureLlmState();
      if (llm.loaded && getSelectedLlmModel()?.model !== normalized) llmAgent.unloadModel();
      const item = discovered || {
        key: modelKey("transformersjs", normalized),
        engine: "transformersjs" as const,
        modelId: normalized,
        label: normalized,
        private: false,
        gated: false,
        metadata: { manual: true },
      };
      let inspection: ModelInspection;
      let selection: Partial<LlmUserProfile> = {};
      try {
        const sdk = await getAiSdkReady();
        if (!sdk) throw new Error("AI SDK bridge is unavailable");
        inspection = await sdk.inspectModel(normalized);
        if (generation !== inspectionGeneration) return getSelectedModel();
        const capabilities = await ensureLLMCapabilities({ source: "model-inspection" });
        if (generation !== inspectionGeneration) return getSelectedModel();
        const runtime = chooseTransformersRuntime(inspection.availableDtypes, capabilities);
        selection = { device: runtime.device, dtype: runtime.dtype };
        if (runtime.dtype !== inspection.selectedDtype && runtime.dtype !== "auto") {
          inspection = await sdk.inspectModel(normalized, { dtype: runtime.dtype });
        }
      } catch (error) {
        inspection = failedInspection(normalized, error);
        selection = { device: "auto", dtype: "auto" };
      }
      if (generation !== inspectionGeneration) return getSelectedModel();
      const config = registerDiscoveredModel(item, inspection, selection);
      selectLlmModel(config);
      setSelectedKey("transformersjs", item.key);
      hooks.onModelSelected(config);
      return config;
    } finally {
      finishInspection(generation);
    }
  }

  async function selectOllama(model: DiscoveredModel): Promise<LlmModelConfig> {
    const generation = beginInspection(model.modelId);
    try {
      const llm = ensureLlmState();
      if (llm.loaded && getSelectedLlmModel()?.model !== model.modelId) llmAgent.unloadModel();
      const details = await inspectOllamaModel(fetch, ollamaEndpoint(), model);
      if (generation !== inspectionGeneration) return getSelectedModel();
      const inspection: ModelInspection = {
        modelId: model.modelId,
        availableDtypes: [],
        files: [],
        contextWindowTokens: details.contextWindowTokens,
        chatTemplate: details.template,
        capabilities: details.capabilities,
        warnings: [
          ...(details.capabilities.tools ? [] : ["Ollama does not announce tool support; the user profile remains authoritative."]),
        ],
        inspected: true,
      };
      const config = registerDiscoveredModel(model, inspection);
      selectLlmModel(config);
      setSelectedKey("ollama", model.key);
      hooks.onModelSelected(config);
      return config;
    } finally {
      finishInspection(generation);
    }
  }

  async function ensureSelection(): Promise<LlmModelConfig> {
    if (source() === "ollama") {
      const model = ollamaResults.find((item) => item.key === selectedOllamaKey);
      if (!model) throw new Error("Select an installed Ollama model");
      if (getSelectedLlmModel()?.id === model.key) return getSelectedLlmModel() as LlmModelConfig;
      return await selectOllama(model);
    }
    const manual = inputById("ba-llm-custom-model")?.value.trim();
    const model = hfResults.find((item) => item.key === selectedHfKey);
    const modelId = manual || model?.modelId || "";
    if (!modelId) throw new Error("Select a Hub result or enter a repository ID");
    if (getSelectedLlmModel()?.model === modelId) return getSelectedLlmModel() as LlmModelConfig;
    return await selectTransformers(modelId, manual ? undefined : model);
  }

  function setActionBusy(busy: boolean): void {
    actionBusy = busy;
    setActionControlsDisabled(busy);
    setDisabled(document.getElementById("ba-llm-load"), busy || inspectionPending);
    document.getElementById("ba-llm-panel")?.setAttribute("aria-busy", String(busy || inspectionPending));
    syncBusyUi();
  }

  function bind(): void {
    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="ba-llm-source"]'))) {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        cancelInspection();
        if (ensureLlmState().loaded) llmAgent.unloadModel();
        hooks.onSourceChanged();
        if (input.value === "ollama") void refreshOllama();
      });
    }
    inputById("ba-llm-hf-search")?.addEventListener("input", () => { void refreshHf(); });
    document.getElementById("ba-llm-hf-refresh")?.addEventListener("click", () => { void refreshHf({ force: true }); });
    elementById("ba-llm-hf-results")?.addEventListener("click", (event) => {
      const option = eventTargetElement(event)?.closest<HTMLElement>("[data-model-key]");
      const model = hfResults.find((item) => item.key === option?.dataset.modelKey);
      const manual = inputById("ba-llm-custom-model");
      if (manual) manual.value = "";
      if (model) {
        setSelectedKey("transformersjs", model.key);
        void selectTransformers(model.modelId, model).catch((error) => setError("ba-llm-hf-error", errorMessage(error)));
      }
    });
    document.getElementById("ba-llm-ollama-refresh")?.addEventListener("click", () => { void refreshOllama(); });
    elementById("ba-llm-ollama-models")?.addEventListener("click", (event) => {
      const option = eventTargetElement(event)?.closest<HTMLElement>("[data-model-key]");
      const model = ollamaResults.find((item) => item.key === option?.dataset.modelKey);
      if (model) {
        setSelectedKey("ollama", model.key);
        void selectOllama(model).catch((error) => setError("ba-llm-ollama-error", errorMessage(error)));
      }
    });
    document.getElementById("ba-llm-ollama-endpoint")?.addEventListener("change", (event) => {
      const input = event.target instanceof HTMLInputElement ? event.target : null;
      const value = (input?.value || "").trim().replace(/\/+$/g, "");
      if (value) localStorage.setItem("ba.llm.ollama.endpoint", value);
      else localStorage.removeItem("ba.llm.ollama.endpoint");
      if (ensureLlmState().loaded) llmAgent.unloadModel();
      void refreshOllama();
      hooks.onSourceChanged();
    });
  }

  function initialize(): void {
    const selected = getSelectedLlmModel();
    if (selected?.engine === "transformersjs") {
      selectedHfKey = selected.id;
      const manual = inputById("ba-llm-custom-model");
      if (manual) manual.value = selected.model || "";
    } else if (selected?.engine === "ollama") {
      selectedOllamaKey = selected.id;
    }
    hfResults = recentModels();
    renderList(elementById("ba-llm-hf-results"), hfResults);
    renderRecents();
    if (selected?.engine === "ollama") void refreshOllama();
    else void refreshHf();
  }

  function render(): void {
    renderList(elementById("ba-llm-hf-results"), hfResults);
    renderList(elementById("ba-llm-ollama-models"), ollamaResults);
    renderRecents();
    renderInspection();
  }

  function recordRecent(model: LlmModelConfig): void {
    if (model.engine !== "transformersjs" || !model.model || model.inspection?.capabilities.tools !== true) return;
    recordHfRecent(localStorage, model.model);
    renderRecents();
  }

  return { source, bind, initialize, ensureSelection, setActionBusy, render, recordRecent };
}
