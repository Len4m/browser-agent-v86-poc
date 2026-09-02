import { t } from "../../app/i18n";
import { setLoading } from "../../vm/runtime-assets";
import { ensureLLMCapabilities, syncLLMCapabilityBadges, type LlmCapabilities } from "../state/capabilities";
import { resolveTurnModelConfig } from "../models/model-config";
import {
  getLlmState,
  llmEngineMetaLabel,
  llmModelShortLabel,
  type LlmModelConfig,
} from "../state/chat-state";
import { llmAgent } from "../runtime/agent-loop";
import { bytesLabel, inputById, setDisabled, textValue } from "./dom-utils";
import { llmPanelCapabilities } from "./capabilities-view";
import { ensureLlmState, getSelectedModel } from "./state-utils";

export interface ProgressDetail {
  status?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  file?: string;
  name?: string;
  path?: string;
  data?: string;
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

interface RuntimeViewHooks {
  getSelectedSource: () => "transformersjs" | "ollama";
}

export interface RuntimeView {
  setStatus: (text: string, tone?: string) => void;
  setProgress: (detail: ProgressDetail | null) => void;
  updateCapabilityDetails: (result: LlmCapabilities | null) => void;
  applyCapabilities: (result: LlmCapabilities | null) => void;
  checkCapabilities: (options?: { force?: boolean }) => Promise<LlmCapabilities>;
  updateSelectedModelCard: () => void;
  canUnloadActiveWorker: () => boolean;
  syncWorkerUnloadButton: () => void;
}

function normalizePercent(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric <= 1 && numeric >= 0) return Math.round(numeric * 100);
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function modelFileKind(file: string): string {
  const normalized = file.toLowerCase();
  if (/\.onnx(?:_data)?$|\.safetensors$|\.(?:bin|gguf)$|model.*\.data$/.test(normalized)) {
    return t("panel.llm.progress.component.weights");
  }
  if (/tokenizer|vocab|merges|added_tokens|special_tokens/.test(normalized)) {
    return t("panel.llm.progress.component.tokenizer");
  }
  if (/config|preprocessor|processor|chat_template/.test(normalized)) {
    return t("panel.llm.progress.component.configuration");
  }
  return t("panel.llm.progress.component.files");
}

function getProgressInfo(detail: ProgressDetail | null | undefined): ProgressInfo {
  if (!detail) return { mode: "idle", percent: null, title: "", detail: "" };
  const rawPercent = Number.isFinite(detail.progress)
    ? normalizePercent(detail.progress)
    : (Number.isFinite(detail.loaded) && Number.isFinite(detail.total) && Number(detail.total) > 0
      ? normalizePercent(Number(detail.loaded) / Number(detail.total))
      : null);
  const file = detail.file || detail.name || detail.path || "";
  const component = modelFileKind(file);
  const loaded = bytesLabel(detail.loaded);
  const total = bytesLabel(detail.total);
  const size = loaded && total ? `${loaded} / ${total}` : (loaded || total || "");

  switch (detail.status) {
    case "init":
      return { mode: "indeterminate", percent: null, title: t("panel.llm.progress.preparingModel"), detail: detail.model || "" };
    case "initiate":
      return { mode: "indeterminate", percent: null, title: t("panel.llm.progress.preparingComponent", { component }), detail: file || t("panel.llm.progress.initializing") };
    case "download":
      return { mode: "indeterminate", percent: null, title: t("panel.llm.progress.downloadingComponent", { component }), detail: file || t("panel.llm.progress.waiting") };
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
        title: rawPercent == null
          ? t("panel.llm.progress.downloadingComponent", { component })
          : t("panel.llm.progress.downloadingComponentPercent", { component, percent: rawPercent }),
        detail: file ? `${file}${size ? ` · ${size}` : ""}` : (size || t("panel.llm.progress.fileProgress")),
      };
    case "loading":
      return {
        mode: "indeterminate",
        percent: null,
        title: /compil|warm/i.test(detail.data || "")
          ? t("panel.llm.progress.warmingModel")
          : t("panel.llm.progress.preparingModel"),
        detail: file,
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
      return { mode: "determinate", percent: 100, title: t("panel.llm.progress.componentComplete", { component }), detail: file || t("panel.llm.progress.loadComplete") };
    default:
      return { mode: rawPercent == null ? "indeterminate" : "determinate", percent: rawPercent, title: detail.status || t("common.loading"), detail: file || size || "" };
  }
}

function shouldShowActiveModel(selected: LlmModelConfig, active: LlmModelConfig | null): boolean {
  const llm = getLlmState();
  return Boolean(llm?.loaded && active && (active.id === selected.id || active.fallbackFrom === selected.id));
}

function activeBackendLabel(model: LlmModelConfig): string {
  const runtime = model.runtime;
  if (!runtime) return "";
  if (runtime.provider === "ollama") {
    return t("panel.llm.backend.ollama", { endpoint: runtime.endpoint || t("panel.llm.backend.localEndpoint") });
  }
  const device = runtime.device === "webgpu" ? "WebGPU" : (runtime.device === "wasm" ? "WASM" : runtime.device || "auto");
  const dtype = runtime.dtype ? ` · ${runtime.dtype}` : "";
  const fallback = runtime.fallback ? t("panel.llm.backend.fallbackSuffix") : "";
  return `Transformers.js v4 · ${device}${dtype}${fallback}`;
}

function createMetaItem(key: string, value: unknown): HTMLSpanElement {
  const item = document.createElement("span");
  const label = document.createElement("b");
  label.textContent = `${key}:`;
  item.append(label, document.createTextNode(` ${textValue(value, "—")}`));
  return item;
}

export function createRuntimeView(hooks: RuntimeViewHooks): RuntimeView {
  function setStatus(text: string, tone = ""): void {
    const status = document.getElementById("ba-llm-status");
    if (!status) return;
    status.textContent = text;
    status.className = `badge ba-llm-header-status ${tone}`.trim();
  }

  function setProgress(detail: ProgressDetail | null): void {
    if (!detail) {
      setLoading(false);
      return;
    }
    const info = getProgressInfo(detail);
    setLoading(true, {
      title: info.title || t("common.loading"),
      detail: info.detail,
      percent: info.percent,
      indeterminate: info.mode === "indeterminate",
      cancelable: llmAgent.isModelLoadActive(),
      cancelLabel: t("panel.llm.action.cancelDownload"),
      onCancel: llmAgent.cancelModelLoad,
    });
  }

  function canUnloadActiveWorker(): boolean {
    const llm = getLlmState();
    return Boolean(llm?.loaded
      && !llm.loading
      && !llmAgent.isChatOperationActive()
      && llm.activeModel?.runtime?.worker);
  }

  function syncWorkerUnloadButton(): void {
    setDisabled(document.getElementById("ba-llm-abort"), !canUnloadActiveWorker());
  }

  function updateSelectedModelCard(): void {
    const selected = getSelectedModel();
    const active = getLlmState()?.activeModel || null;
    const model = shouldShowActiveModel(selected, active)
      ? resolveTurnModelConfig(active || selected, selected)
      : selected;
    const title = document.getElementById("ba-llm-selected-title");
    const desc = document.getElementById("ba-llm-selected-desc");
    const meta = document.getElementById("ba-llm-selected-meta");
    const repo = document.getElementById("ba-llm-repo-path");
    const card = document.getElementById("ba-llm-selected-card");
    const manualModelId = hooks.getSelectedSource() === "transformersjs"
      ? inputById("ba-llm-custom-model")?.value.trim()
      : "";
    const visible = Boolean(model.model
      && model.engine === hooks.getSelectedSource()
      && (!manualModelId || manualModelId === model.model));
    if (card instanceof HTMLElement) card.hidden = !visible;
    if (title) title.textContent = llmModelShortLabel(model);
    if (desc) {
      const capabilities = model.inspection?.capabilities;
      const tags = capabilities
        ? (["chat", "tools", "thinking", "vision"] as const).map((name) => {
            const tag = document.createElement("span");
            const value = capabilities[name];
            tag.className = `ba-llm-tag ba-llm-tag--${value === true ? "positive" : value === false ? "muted" : "unknown"}`;
            tag.textContent = `${name}: ${value === null ? t("panel.llm.capability.unknown") : value ? t("common.yes") : t("common.no")}`;
            return tag;
          })
        : [];
      desc.replaceChildren(...tags);
      desc.hidden = !tags.length;
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
      meta.replaceChildren(...entries
        .filter((entry): entry is [string, unknown] => Boolean(entry))
        .map(([key, value]) => createMetaItem(key, value)));
    }
    const warnings = document.getElementById("ba-llm-model-warnings");
    if (warnings) {
      const warningLabel = (message: string): string => {
        if (/tool/i.test(message)) return t("panel.llm.warning.toolsUnknown");
        if (/chat.?template/i.test(message)) return t("panel.llm.warning.chatTemplate");
        if (/onnx/i.test(message)) return t("panel.llm.warning.onnx");
        if (/inspect|validat/i.test(message)) return t("panel.llm.warning.unvalidated");
        return message;
      };
      const tags = (model.inspection?.warnings || []).map((message) => {
        const tag = document.createElement("span");
        tag.className = "ba-llm-tag ba-llm-tag--warning";
        tag.textContent = warningLabel(message);
        tag.title = message;
        return tag;
      });
      if (model.inspection?.error) {
        const error = document.createElement("span");
        error.className = "ba-llm-tag ba-llm-tag--error";
        error.textContent = t("panel.llm.warning.inspectionError");
        error.title = model.inspection.error;
        tags.push(error);
      }
      warnings.replaceChildren(...tags);
      warnings.hidden = !visible || !tags.length;
    }
    syncWorkerUnloadButton();
  }

  function updateModelOptionCompatibility(capabilities: LlmCapabilities | null): void {
    const selected = getSelectedModel();
    const dtype = document.getElementById("ba-llm-dtype");
    if (dtype instanceof HTMLSelectElement) {
      for (const option of Array.from(dtype.options)) {
        option.disabled = Boolean(capabilities && !capabilities.shaderF16 && /f16/i.test(option.value));
      }
    }
    if (capabilities && !capabilities.webgpu && selected.engine === "transformersjs" && selected.device === "webgpu") {
      setStatus(t("panel.llm.status.wasmExperimental"), "warn");
    }
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

  function applyCapabilities(result: LlmCapabilities | null): void {
    if (!result) return;
    updateCapabilityDetails(result);
    updateModelOptionCompatibility(result);
    syncLLMCapabilityBadges(result, "ready");
    const llm = ensureLlmState();
    if (llm.loaded) setStatus(t("common.loadedLower"), "good");
    else if (llm.loading) setStatus(t("common.loadingLower"), "warn");
    else if (!result.webgpu) setStatus(t("common.wasm"), "warn");
    else setStatus(t("common.unloadedLower"), "warn");
    llmPanelCapabilities.decorateCapabilityRecheckBadges();
  }

  async function checkCapabilities(options: { force?: boolean } = {}): Promise<LlmCapabilities> {
    const { force = false } = options;
    setStatus(t("panel.llm.status.checkingGpu"), "warn");
    try {
      const result = await ensureLLMCapabilities({ force, source: force ? "manual" : "panel" });
      applyCapabilities(result);
      return result;
    } finally {
      llmAgent.updateChatAvailability();
    }
  }

  return {
    setStatus,
    setProgress,
    updateCapabilityDetails,
    applyCapabilities,
    checkCapabilities,
    updateSelectedModelCard,
    canUnloadActiveWorker,
    syncWorkerUnloadButton,
  };
}
