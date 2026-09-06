// Browser Agent v86 - LLM panel coordinator.
// Rendering and domain-specific controls live in focused sibling modules; this
// file only mounts the panel and connects application events to those views.

import { applyDomTranslations, t } from "../../app/i18n";
import { originApi } from "../../app/origin-awareness";
import { appEvents } from "../../core/events";
import { showBaModal } from "../../ui/modal";
import { isAbortError } from "../../vm/runtime-assets";
import { syncLLMCapabilityBadges } from "../state/capabilities";
import { getLlmState, getSelectedLlmModel, llmEventsApi, type LlmModelConfig } from "../state/chat-state";
import { llmAgent } from "../runtime/agent-loop";
import { llmPanelCapabilities } from "./capabilities-view";
import { createDiscoveryController, type DiscoveryController } from "./discovery-controller";
import { errorMessage, inputById, setDisabled, textValue } from "./dom-utils";
import { createProfileControls, type ProfileControls } from "./profile-controls";
import { openChatResourcesModal, resourceContext, updateResourceLines } from "./resources-view";
import { createRuntimeView } from "./runtime-view";
import { ensureLlmState, getSelectedModel, isLlmCapabilities } from "./state-utils";
import { llmPanelTemplate } from "./template";
import {
  openChatToolsModal,
  syncToolPolicyUi,
  updateChatToolsButton,
  updateNativeToolsPickerUi,
} from "./tools-view";

let initialized = false;

const runtimeView = createRuntimeView({
  getSelectedSource: () => discovery.source(),
});

function onModelChanged(config: LlmModelConfig): void {
  setLoadError();
  runtimeView.updateSelectedModelCard();
  updateNativeToolsPickerUi();
  updateResourceLines();
  if (config.engine === "transformersjs") runtimeView.syncWorkerUnloadButton();
}

const profiles: ProfileControls = createProfileControls({
  setStatus: runtimeView.setStatus,
  onModelChanged,
});

const discovery: DiscoveryController = createDiscoveryController({
  onModelSelected(config) {
    profiles.sync(config);
    onModelChanged(config);
  },
  onCandidateChanged() {
    setLoadError();
    runtimeView.updateSelectedModelCard();
  },
  onSourceChanged: syncSourceVisibility,
});

function findLlmPanelBody(): HTMLElement | null {
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

function syncSourceVisibility(): void {
  setLoadError();
  const source = discovery.source();
  const huggingFace = document.getElementById("ba-llm-hf-discovery");
  const ollama = document.getElementById("ba-llm-ollama-discovery");
  if (huggingFace instanceof HTMLElement) huggingFace.hidden = source !== "transformersjs";
  if (ollama instanceof HTMLElement) ollama.hidden = source !== "ollama";

  const endpoint = inputById("ba-llm-ollama-endpoint");
  if (endpoint && !endpoint.value) {
    endpoint.value = localStorage.getItem("ba.llm.ollama.endpoint") || "http://127.0.0.1:11434";
  }
  const originNotice = document.getElementById("ba-llm-ollama-origin-notice");
  if (originNotice) {
    const show = source === "ollama" && originApi.isPublishedOrigin();
    originNotice.hidden = !show;
    if (show) originNotice.textContent = originApi.localServiceWarningText("ollama");
  }

  runtimeView.updateSelectedModelCard();
  updateResourceLines();
  runtimeView.setProgress(null);

  const llm = ensureLlmState();
  const selected = getSelectedModel();
  const capabilities = isLlmCapabilities(llm.capabilities) ? llm.capabilities : null;
  if (selected.engine === "ollama") {
    runtimeView.setStatus(t("panel.llm.status.requiresOllama"), "warn");
  } else if (capabilities && !capabilities.webgpu) {
    runtimeView.setStatus(t("panel.llm.status.wasmExperimental"), "warn");
  } else if (selected.device === "wasm") {
    runtimeView.setStatus(t("panel.llm.status.wasmExperimental"), "warn");
  } else if (!llm.loaded) {
    runtimeView.setStatus(t("common.unloadedLower"), "warn");
  }
}

function setPanelBusy(busy: boolean): void {
  discovery.setActionBusy(busy);
  runtimeView.syncWorkerUnloadButton();
}

function syncTurnControls(busy = llmAgent.isChatOperationActive()): void {
  discovery.setTurnBusy(busy);
  runtimeView.syncWorkerUnloadButton();
}

function setLoadError(message = ""): void {
  const element = document.getElementById("ba-llm-load-error");
  if (!element) return;
  element.textContent = message;
  element.hidden = !message;
}

async function handleLoadClick(): Promise<void> {
  const llm = ensureLlmState();
  try {
    setLoadError();
    setPanelBusy(true);
    runtimeView.setProgress({ status: "init", model: "" });
    const selected = await discovery.ensureSelection();
    runtimeView.setProgress({ status: "init", model: selected.model || "" });
    await runtimeView.checkCapabilities();
    runtimeView.setStatus(selected.engine === "ollama"
      ? t("common.connectingOllama")
      : (selected.device === "wasm" ? t("panel.llm.status.loadingWasm") : t("panel.llm.status.loadingModel")), "warn");
    llm.loading = true;
    const loading = llmAgent.loadSelectedModel();
    runtimeView.setProgress({ status: "init", model: selected.model || "" });
    await loading;
  } catch (error) {
    if (isAbortError(error)) {
      llm.lastError = "";
      setLoadError();
      runtimeView.setStatus(t("common.operationCancelled"), "warn");
    } else {
      const message = errorMessage(error);
      llm.lastError = message;
      setLoadError(t("panel.llm.status.loadErrorDetail", { error: message }));
      runtimeView.setStatus(t("panel.llm.status.loadError"), "bad");
    }
  } finally {
    llm.loading = false;
    runtimeView.setProgress(null);
    setPanelBusy(false);
    runtimeView.syncWorkerUnloadButton();
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

function mountSummaryBadges(body: HTMLElement): void {
  const llm = ensureLlmState();
  const details = body.closest("details");
  const summary = details?.querySelector("summary.panel-title");
  if (details) details.classList.add("ba-llm-panel-host");
  if (summary && !summary.querySelector("#ba-llm-status")) {
    const status = document.createElement("span");
    status.id = "ba-llm-status";
    status.className = "badge ba-llm-header-status warn";
    status.textContent = llm.loading
      ? t("common.loadingLower")
      : (llm.loaded ? t("common.loadedLower") : t("common.unloadedLower"));
    summary.appendChild(status);
  }
  if (summary && !summary.querySelector("#ba-llm-summary-compat")) {
    const capability = document.createElement("span");
    capability.id = "ba-llm-summary-compat";
    capability.className = "badge ba-llm-summary-compat warn";
    capability.textContent = llm.capabilitiesChecked
      ? (syncLLMCapabilityBadges(isLlmCapabilities(llm.capabilities) ? llm.capabilities : null, "ready").text || "GPU")
      : t("caps.badge.pending");
    summary.appendChild(capability);
  }
}

function bindCapabilityControls(details: HTMLDetailsElement | null): void {
  llmPanelCapabilities.bindCapabilityRecheckBadges(() => {
    void llmPanelCapabilities.runCapabilityRecheckFromBadge({
      checkCapabilities: runtimeView.checkCapabilities,
      setStatus: runtimeView.setStatus,
    });
  });
  if (!details) return;
  details.addEventListener("toggle", () => {
    void llmPanelCapabilities.ensureCapabilitiesWhenPanelOpens(details, {
      checkCapabilities: runtimeView.checkCapabilities,
      setStatus: runtimeView.setStatus,
    });
  });
  if (details.open) {
    void llmPanelCapabilities.ensureCapabilitiesWhenPanelOpens(details, {
      checkCapabilities: runtimeView.checkCapabilities,
      setStatus: runtimeView.setStatus,
    });
  }
}

function bindPanelControls(): void {
  const llm = ensureLlmState();
  document.getElementById("chat-tools-btn")?.addEventListener("click", openChatToolsModal);
  document.getElementById("chat-resources-btn")?.addEventListener("click", openChatResourcesModal);
  document.getElementById("vm-profile")?.addEventListener("change", () => {
    updateNativeToolsPickerUi();
  });
  llmEventsApi.on("native-tools", () => {
    updateNativeToolsPickerUi();
    updateChatToolsButton();
  });
  document.getElementById("ba-llm-load")?.addEventListener("click", () => { void handleLoadClick(); });
  document.getElementById("chat-clear-memory")?.addEventListener("click", () => { void handleClearMemoryClick(); });
  document.getElementById("ba-llm-abort")?.addEventListener("click", () => {
    if (!runtimeView.canUnloadActiveWorker()) return;
    llmAgent.unloadModel();
    runtimeView.setProgress(null);
    runtimeView.setStatus(t("panel.llm.status.workerUnloaded"), "warn");
    runtimeView.syncWorkerUnloadButton();
  });
  setDisabled(document.getElementById("ba-llm-abort"), !llm.loaded);
}

function mountPanel(): void {
  const body = findLlmPanelBody();
  if (!body || document.getElementById("ba-llm-panel")) return;
  const llm = ensureLlmState();
  mountSummaryBadges(body);
  body.replaceChildren();
  body.insertAdjacentHTML("beforeend", llmPanelTemplate.buildLLMPanelHtml());
  applyDomTranslations(body);
  originApi.syncWarnings();

  const initialSource = getSelectedLlmModel()?.engine || "transformersjs";
  const sourceInput = document.querySelector<HTMLInputElement>(`input[name="ba-llm-source"][value="${initialSource}"]`);
  if (sourceInput) sourceInput.checked = true;

  discovery.bind();
  profiles.bind();
  discovery.initialize();
  profiles.sync();
  syncSourceVisibility();
  syncToolPolicyUi();
  updateChatToolsButton();
  updateResourceLines();

  if (llm.capabilitiesChecked) {
    runtimeView.applyCapabilities(isLlmCapabilities(llm.capabilities) ? llm.capabilities : null);
  } else {
    syncLLMCapabilityBadges(null, llm.capabilitiesChecking ? "checking" : "ready");
    llmPanelCapabilities.decorateCapabilityRecheckBadges();
  }
  const details = body.closest("details");
  bindCapabilityControls(details instanceof HTMLDetailsElement ? details : null);
  bindPanelControls();
  llmAgent.updateChatAvailability();
  runtimeView.syncWorkerUnloadButton();
}

function bindApplicationEvents(): void {
  llmEventsApi.on("status", (detail) => {
    const status = textValue(detail.text);
    if (status) runtimeView.setStatus(status, textValue(detail.tone));
    runtimeView.updateSelectedModelCard();
  });
  llmEventsApi.on("activity", (detail) => syncTurnControls(Boolean(detail.busy)));
  llmEventsApi.on("capabilities", (detail) => {
    const current = getLlmState()?.capabilities;
    const capabilities = isLlmCapabilities(detail.capabilities)
      ? detail.capabilities
      : (isLlmCapabilities(current) ? current : null);
    runtimeView.applyCapabilities(capabilities);
  });
  llmEventsApi.on("tool-policy", syncToolPolicyUi);
  llmEventsApi.on("progress", (detail) => runtimeView.setProgress(detail));
  llmEventsApi.on("context", (detail) => updateResourceLines({ context: resourceContext(detail) || {} }));
  for (const event of ["artifact", "artifact-context", "artifact-remove", "artifact-clear"] as const) {
    llmEventsApi.on(event, () => updateResourceLines());
  }
  llmEventsApi.on("resource", () => updateResourceLines());
  appEvents.on("app:language-changed", () => {
    discovery.render();
    runtimeView.updateSelectedModelCard();
    updateResourceLines();
    updateChatToolsButton();
    updateNativeToolsPickerUi();
    syncToolPolicyUi();
    const capabilities = getLlmState()?.capabilities;
    runtimeView.updateCapabilityDetails(isLlmCapabilities(capabilities) ? capabilities : null);
  });
}

export function initLlmPanel(): void {
  if (initialized) return;
  initialized = true;
  bindApplicationEvents();
  window.requestAnimationFrame(mountPanel);
  window.requestAnimationFrame(updateChatToolsButton);
}
