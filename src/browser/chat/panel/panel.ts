// @ts-nocheck
// Browser Agent v86 - 15 LLM UI panel
// v9.37.20: LLM panel consumes the shared capability service used by the page header.
//
// This panel is intentionally isolated inside the existing "LLM objetivo" card.
// It does not replace the chat, VM, consoles, tools or global layout. All selectors
// are namespaced with ba-llm-* to keep future maintenance predictable.

(function initLLMUIPanel() {
  const fmt = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });

  const {
    escapeHtml,
    buildLLMPanelHtml,
  } = window.BA_LLM_PANEL_TEMPLATE;

  const panelCaps = window.BA_LLM_PANEL_CAPS;

  function findLLMPanelBody() {
    const details = Array.from(document.querySelectorAll("details.panel.small.collapsible-panel"))
      .find((item) => {
        const title = item.querySelector("summary.panel-title h2")?.textContent?.trim() || "";
        const summaryText = item.querySelector("summary.panel-title")?.textContent || "";
        return title === "LLM"
          || title === "LLM objetivo"
          || (summaryText.includes("LLM") && summaryText.includes("Transformers.js"));
      });
    return details?.querySelector(".collapsible-panel-body") || null;
  }

  function getSelectedModel() {
    const select = document.getElementById("ba-llm-model");
    return window.BA_LLM_MODELS.find((item) => item.id === select?.value)
      || window.BA_LLM_MODELS[0];
  }

  function compatibleFallbackFor(model, { noWebGPU = false, noF16 = false } = {}) {
    if (noWebGPU) {
      return window.BA_LLM_MODELS.find((item) => item.engine === "transformersjs" && item.device === "wasm")
        || window.BA_LLM_MODELS.find((item) => item.device === "wasm")
        || model;
    }
    if (!noF16 || !model?.requiresShaderF16) return model;
    const baseId = model.id.replace(/-q4f16$/, "-q4");
    return window.BA_LLM_MODELS.find((item) => item.id === baseId)
      || window.BA_LLM_MODELS.find((item) => item.engine === model.engine && item.model === model.model && item.device === "webgpu" && !item.requiresShaderF16)
      || window.BA_LLM_MODELS.find((item) => item.engine === "transformersjs" && item.device === "webgpu" && !item.requiresShaderF16)
      || window.BA_LLM_MODELS.find((item) => item.engine === "transformersjs" && item.device === "wasm")
      || window.BA_LLM_MODELS[0];
  }

  function updateModelOptionCompatibility(caps) {
    const select = document.getElementById("ba-llm-model");
    if (!select) return;

    const noWebGPU = caps && !caps.webgpu;
    const noF16 = caps && caps.webgpu && !caps.shaderF16;
    for (const option of Array.from(select.options)) {
      const model = window.BA_LLM_MODELS.find((item) => item.id === option.value);
      const needsWebGPU = (model?.engine || "transformersjs") === "transformersjs" && (model?.device || "webgpu") === "webgpu";
      const disabled = Boolean((noWebGPU && needsWebGPU) || (noF16 && model?.requiresShaderF16));
      option.disabled = disabled;
      if (disabled && !option.dataset.originalText) option.dataset.originalText = option.textContent;
      if (!disabled && option.dataset.originalText) option.textContent = option.dataset.originalText;
      const unavailable = t("common.unavailable", "no disponible");
      if (disabled && !option.textContent.includes(unavailable)) {
        option.textContent = `${option.dataset.originalText || option.textContent} · ${unavailable}`;
      }
    }

    const selected = getSelectedModel();
    const selectedNeedsWebGPU = (selected?.engine || "transformersjs") === "transformersjs" && (selected?.device || "webgpu") === "webgpu";
    if ((noWebGPU && selectedNeedsWebGPU) || (noF16 && selected?.requiresShaderF16)) {
      const fallback = compatibleFallbackFor(selected, { noWebGPU, noF16 });
      select.value = fallback.id;
      window.BA_LLM.selectedModelId = fallback.id;
      updateSelectedModelCard();
      setStatus(noWebGPU ? t("panel.llm.status.switchedWasm", "cambiado a WASM experimental") : t("panel.llm.status.switchedQ4", "cambiado a q4"), "warn");
    }
  }

  function setStatus(text, tone = "") {
    const status = document.getElementById("ba-llm-status");
    if (!status) return;
    status.textContent = text;
    status.className = `badge ba-llm-header-status ${tone}`.trim();
  }

  function setSummaryCapability(text, tone = "") {
    const badge = document.getElementById("ba-llm-summary-compat");
    if (!badge) return;
    badge.textContent = text;
    badge.className = `badge ba-llm-summary-compat ${tone}`.trim();
  }

  function updateCapabilityDetails(result) {
    const detail = document.getElementById("ba-llm-capabilities");
    if (!detail) return;
    if (!result) {
      detail.textContent = t("common.inferencePending", "Pendiente de comprobar capacidades de inferencia local.");
      return;
    }
    const limits = result.limits || {};
    detail.textContent = result.webgpu
      ? t("panel.llm.capabilities.webgpu", "WebGPU disponible · shader-f16: {shaderF16} · dtype recomendado: {dtype} · maxBuffer: {maxBuffer}", {
          shaderF16: result.shaderF16 ? t("common.yes", "sí") : t("common.no", "no"),
          dtype: result.recommendedDtype || "q4",
          maxBuffer: limits.maxBufferSize || "—",
        })
      : t("panel.llm.capabilities.noWebgpu", "{reason} · WASM experimental disponible solo para modelos compatibles.", {
          reason: result.reason || t("panel.llm.capabilities.noWebgpuReason", "WebGPU no disponible."),
        });
  }

  function applyCapabilitiesToPanel(result) {
    if (!result) return;
    updateCapabilityDetails(result);
    updateModelOptionCompatibility(result);
    window.BA_syncLLMCapabilityBadges?.(result, "ready");
    syncLifecycleStatusAfterCapabilityCheck(result);
    panelCaps.decorateCapabilityRecheckBadges();
  }

  function syncLifecycleStatusAfterCapabilityCheck(result) {
    // Keep the small status badge in the card focused on lifecycle state
    // (loaded/loading/unloaded). Capability information is shown in the
    // details header and in the technical note below the actions.
    if (window.BA_LLM.loaded) {
      setStatus(t("common.loadedLower", "cargado"), "good");
    } else if (window.BA_LLM.loading) {
      setStatus(t("common.loadingLower", "cargando"), "warn");
    } else if (result && !result.webgpu && getSelectedModel()?.device === "wasm") {
      setStatus(t("common.wasm", "WASM"), "warn");
    } else {
      setStatus(t("common.unloadedLower", "sin cargar"), "warn");
    }
  }

  function setButtonBusy(isBusy) {
    const load = document.getElementById("ba-llm-load");
    const check = document.getElementById("ba-llm-check");
    const select = document.getElementById("ba-llm-model");
    const custom = document.getElementById("ba-llm-custom-model");
    if (load) load.disabled = isBusy;
    if (check) check.disabled = isBusy;
    if (select) select.disabled = isBusy;
    if (custom) custom.disabled = isBusy;
  }

  function bytesLabel(value) {
    if (!Number.isFinite(value) || value <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${fmt.format(size)} ${units[unit]}`;
  }

  function normalizePercent(value) {
    if (!Number.isFinite(value)) return null;
    if (value <= 1 && value >= 0) return Math.round(value * 100);
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function getProgressInfo(detail) {
    if (!detail) return { mode: "idle", percent: null, title: "", detail: "" };

    const rawPercent = Number.isFinite(detail.progress)
      ? normalizePercent(detail.progress)
      : (Number.isFinite(detail.loaded) && Number.isFinite(detail.total) && detail.total > 0
        ? normalizePercent(detail.loaded / detail.total)
        : null);

    const file = detail.file || detail.name || detail.path || "";
    const loaded = bytesLabel(detail.loaded);
    const total = bytesLabel(detail.total);
    const size = loaded && total ? `${loaded} / ${total}` : (loaded || total || "");

    switch (detail.status) {
      case "init":
        return { mode: "indeterminate", percent: null, title: t("panel.llm.progress.preparingModel", "Preparando carga del modelo"), detail: detail.model || "" };
      case "initiate":
        return { mode: "indeterminate", percent: null, title: t("panel.llm.progress.preparingFile", "Preparando archivo"), detail: file || t("panel.llm.progress.initializing", "Inicializando descarga") };
      case "download":
        return { mode: "indeterminate", percent: null, title: t("common.downloading", "Descargando"), detail: file || t("panel.llm.progress.waiting", "Esperando progreso") };
      case "progress_total":
        return {
          mode: "determinate",
          percent: rawPercent,
          title: rawPercent == null ? t("panel.llm.progress.downloadingModel", "Descargando modelo") : t("panel.llm.progress.downloadingModelPercent", "Descargando modelo · {percent}%", { percent: rawPercent }),
          detail: file ? `${file}${size ? ` · ${size}` : ""}` : (size || t("panel.llm.progress.globalProgress", "Progreso global")),
        };
      case "progress":
        return {
          mode: rawPercent == null ? "indeterminate" : "determinate-file",
          percent: rawPercent,
          title: rawPercent == null ? t("panel.llm.progress.downloadingFile", "Descargando archivo") : t("panel.llm.progress.currentFilePercent", "Archivo actual · {percent}%", { percent: rawPercent }),
          detail: file ? `${file}${size ? ` · ${size}` : ""}` : (size || t("panel.llm.progress.fileProgress", "Progreso de archivo")),
        };
      case "fallback":
        return {
          mode: "indeterminate",
          percent: null,
          title: t("panel.llm.progress.webgpuFailed", "WebGPU falló; probando alternativa WASM"),
          detail: file || detail.reason || t("panel.llm.progress.restartingWorker", "Reiniciando worker sin WebGPU"),
        };
      case "ready":
        return { mode: "determinate", percent: 100, title: t("panel.llm.progress.filesReady", "Archivos listos"), detail: file || t("panel.llm.progress.preparingExecution", "Preparando ejecución") };
      case "done":
        return { mode: "determinate", percent: 100, title: t("panel.llm.progress.modelDownloaded", "Modelo descargado"), detail: t("panel.llm.progress.loadComplete", "Carga completada") };
      default:
        return { mode: rawPercent == null ? "indeterminate" : "determinate", percent: rawPercent, title: detail.status || t("common.loading", "Cargando"), detail: file || size || "" };
    }
  }

  function setProgress(detail, force = false) {
    const wrap = document.getElementById("ba-llm-progress-wrap");
    const bar = document.getElementById("ba-llm-progress-bar");
    const percent = document.getElementById("ba-llm-progress-percent");
    const title = document.getElementById("ba-llm-progress-title");
    const sub = document.getElementById("ba-llm-progress-detail");
    if (!wrap || !bar || !percent || !title || !sub) return;

    if (!detail && !force) return;

    const info = detail ? getProgressInfo(detail) : { mode: "idle", percent: 0, title: t("panel.llm.progress.idle", "Sin descarga activa"), detail: "" };
    wrap.classList.toggle("is-active", info.mode !== "idle");
    bar.classList.toggle("is-indeterminate", info.mode === "indeterminate");

    const pct = info.percent == null ? 0 : info.percent;
    bar.style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", String(pct));
    percent.textContent = info.percent == null ? "—" : `${pct}%`;
    title.textContent = info.title || t("common.loading", "Cargando");
    sub.textContent = info.detail || "";
  }

  function syncThinkingToggleUi() {
    const model = getSelectedModel();
    const wrap = document.getElementById("ba-llm-thinking-wrap");
    const input = document.getElementById("ba-llm-show-thinking");
    if (!wrap || !input) return;
    const enabled = Boolean(model?.thinking?.enabled);
    wrap.hidden = !enabled;
    if (!enabled) {
      input.checked = false;
      if (window.BA_LLM?.settings) window.BA_LLM.settings.showThinking = false;
    }
  }

  function shouldShowActiveModel(selected, active) {
    if (!window.BA_LLM?.loaded || !active) return false;
    return active.id === selected?.id || active.fallbackFrom === selected?.id;
  }

  function activeBackendLabel(model) {
    const runtime = model?.runtime;
    if (!runtime) return "";
    if (runtime.provider === "ollama") return t("panel.llm.backend.ollama", "Ollama · {endpoint}", { endpoint: runtime.endpoint || t("panel.llm.backend.localEndpoint", "endpoint local") });
    const device = runtime.device === "webgpu"
      ? "WebGPU"
      : (runtime.device === "wasm" ? "WASM" : runtime.device || "auto");
    const dtype = runtime.dtype ? ` · ${runtime.dtype}` : "";
    const fallback = runtime.fallback ? t("panel.llm.backend.fallbackSuffix", " · alternativa") : "";
    return `Transformers.js · ${device}${dtype}${fallback}`;
  }

  function createTextElement(tagName, className, text = "") {
    const el = document.createElement(tagName);
    if (className) el.className = className;
    el.textContent = text;
    return el;
  }

  function createMetaItem(key, value) {
    const item = document.createElement("span");
    const label = document.createElement("b");
    label.textContent = `${key}:`;
    item.append(label, document.createTextNode(` ${value}`));
    return item;
  }

  function updateSelectedModelCard() {
    const selected = getSelectedModel();
    const active = window.BA_LLM?.activeModel || null;
    const model = shouldShowActiveModel(selected, active) ? active : selected;
    const title = document.getElementById("ba-llm-selected-title");
    const desc = document.getElementById("ba-llm-selected-desc");
    const meta = document.getElementById("ba-llm-selected-meta");
    const repo = document.getElementById("ba-llm-repo-path");

    if (title) title.textContent = model.shortLabel || model.label;
    if (desc) desc.textContent = model.description || t("panel.llm.model.descFallback", "Modelo compatible con AI SDK.");
    if (repo) repo.textContent = model.custom ? t("panel.llm.model.repoCustomHint", "Introduce un modelo compatible antes de cargar.") : model.model;
    if (meta) {
      const items = [
        window.BA_LLM?.loaded ? [t("panel.llm.meta.backendLoaded", "Backend cargado"), activeBackendLabel(model) || "—"] : null,
        [t("panel.llm.meta.engine", "Motor"), model.engineLabel || "Transformers.js"],
        [t("panel.llm.meta.download", "Descarga"), model.sizeLabel || "—"],
        [t("panel.llm.meta.quantization", "Cuantización"), model.dtype || "—"],
        [t("panel.llm.meta.memory", "Memoria"), model.minMemoryLabel || "—"],
        [t("panel.llm.meta.compatibility", "Compatibilidad"), model.compatibilityLabel || "—"],
        [t("panel.llm.meta.languages", "Idiomas"), model.languageLabel || "—"],
        [t("panel.llm.meta.tools", "Herramientas"), model.agent?.toolCalling || "—"],
        [t("panel.llm.meta.reasoning", "Razonamiento"), model.thinking?.enabled ? t("common.yes", "sí") : t("common.no", "no")],
      ].filter(Boolean).map(([key, value]) => createMetaItem(key, value));
      meta.replaceChildren(...items);
    }
    syncThinkingToggleUi();
  }

  async function checkCapabilities(options = {}) {
    const { force = false } = options;
    setStatus(t("panel.llm.status.checkingGpu", "Comprobando GPU…"), "warn");
    try {
      const result = await window.BA_ensureLLMCapabilities({ force, source: force ? "manual" : "panel" });
      applyCapabilitiesToPanel(result);
      return result;
    } finally {
      window.BA_LLM_AGENT?.updateChatAvailability?.();
    }
  }

  function syncCustomVisibility() {
    const select = document.getElementById("ba-llm-model");
    const customWrap = document.getElementById("ba-llm-custom-wrap");
    const ollamaEndpointWrap = document.getElementById("ba-llm-ollama-endpoint-wrap");
    const selected = getSelectedModel();
    if (customWrap) {
      customWrap.hidden = !selected?.custom;
      const text = selected?.engine === "ollama"
        ? t("panel.llm.custom.ollamaLabel", "Modelo de Ollama")
        : t("panel.llm.field.customModel", "Modelo custom compatible con Transformers.js");
      if (customWrap.firstChild?.nodeType === Node.TEXT_NODE) customWrap.firstChild.nodeValue = text;
    }
    const customInput = document.getElementById("ba-llm-custom-model");
    if (customInput) {
      customInput.placeholder = selected?.engine === "ollama"
        ? "qwen3.5:4b"
        : "onnx-community/Llama-3.2-1B-Instruct-ONNX";
    }
    if (ollamaEndpointWrap) {
      const isOllama = selected?.engine === "ollama";
      ollamaEndpointWrap.hidden = !isOllama;
      const input = document.getElementById("ba-llm-ollama-endpoint");
      if (input && !input.value) {
        input.value = localStorage.getItem("ba.llm.ollama.endpoint") || "http://127.0.0.1:11434";
      }
    }
    const ollamaOriginNotice = document.getElementById("ba-llm-ollama-origin-notice");
    if (ollamaOriginNotice) {
      const show = Boolean(selected?.engine === "ollama" && window.BA_ORIGIN?.isPublishedOrigin?.());
      ollamaOriginNotice.hidden = !show;
      if (show) ollamaOriginNotice.textContent = window.BA_ORIGIN.localServiceWarningText("ollama");
    }
    if (select) window.BA_LLM.selectedModelId = select.value;
    updateSelectedModelCard();
    updateResourceLines();
    setProgress(null, true);
    const caps = window.BA_LLM.capabilities;
    const needsWebGPU = (selected?.engine || "transformersjs") === "transformersjs" && (selected?.device || "webgpu") === "webgpu";
    if (needsWebGPU && caps && !caps.webgpu) {
      setStatus(t("panel.llm.status.requiresWebgpu", "requiere WebGPU"), "warn");
    } else if (selected?.requiresShaderF16 && caps?.webgpu && !caps.shaderF16) {
      setStatus(t("common.requiresShaderF16", "requiere shader-f16"), "warn");
    } else if (selected?.engine === "ollama") {
      setStatus(t("panel.llm.status.requiresOllama", "requiere Ollama"), "warn");
    } else if (selected?.device === "wasm") {
      setStatus(t("panel.llm.status.wasmExperimental", "WASM experimental"), "warn");
    } else if (!window.BA_LLM.loaded) {
      setStatus(t("common.unloadedLower", "sin cargar"), "warn");
    }
  }

  function syncToolPolicyUi() {
    const select = document.getElementById("ba-llm-tool-autonomy");
    const detail = document.getElementById("ba-llm-tool-autonomy-detail");
    if (!select) return;
    const value = String(window.BA_LLM_TOOL_EXECUTOR?.getAutonomyMaxLevel?.() ?? window.BA_LLM.settings.toolAutonomyMaxLevel ?? 1);
    if (select.value !== value) select.value = value;
    const level = (window.BA_LLM_TOOL_REGISTRY?.SECURITY_LEVELS || []).find((item) => String(item.level) === value);
    if (detail) detail.textContent = level?.description || t("panel.llm.toolPolicy.defaultDetail", "Configura cuándo el agente debe pedir permiso antes de ejecutar una tool.");
  }


  function getActiveToolProfileId() {
    return state.activeRuntime?.profile?.id
      || getSelectedProfile?.()?.id
      || document.getElementById("vm-profile")?.value
      || "manual";
  }

  function getActiveToolProfileLabel(profileId) {
    if (profileId === "manual") return t("panel.llm.profile.manual", "manual");
    const profile = state.profiles?.find?.((item) => item.id === profileId);
    return profile?.name || profileId || t("panel.llm.profile.current", "perfil actual");
  }

  function formatCountLabel(count, singular, plural) {
    const n = Number(count) || 0;
    return `${n} ${n === 1 ? singular : plural}`;
  }

  function getSelectedModelForTools() {
    return window.BA_LLM_MODELS.find((item) => item.id === document.getElementById("ba-llm-model")?.value)
      || window.BA_LLM.activeModel
      || window.BA_LLM_MODELS[0];
  }

  function getNativeToolsPickerState() {
    const policy = window.BA_LLM_NATIVE_TOOLS;
    const model = getSelectedModelForTools();
    const profileId = getActiveToolProfileId();
    if (!policy) {
      return { model, profileId, max: 0, active: new Set(), available: [], policy: null };
    }
    const max = policy.getMaxNativeTools(model);
    const available = window.BA_LLM_TOOL_REGISTRY?.listTools?.({ profileId }) || [];
    const active = new Set(policy.resolveActiveToolNames(model, profileId));
    return { model, profileId, max, active, available, policy };
  }

  function nativeToolsHintText(model, activeCount, max) {
    const weak = model?.agent?.toolCalling === "weak";
    if (!activeCount) {
      return t("panel.llm.tools.noneSelected", "Ninguna herramienta seleccionada: el chat no ejecutará herramientas (solo texto del modelo).");
    }
    const label = model?.shortLabel || model?.label || t("panel.llm.modelFallback", "modelo");
    return weak
      ? tn("panel.llm.tools.hintWeak", activeCount,
          "{count} herramienta activa · {label}: el modelo propondrá una acción y la app la ejecutará (máx. {max} en el listado).",
          "{count} herramientas activas · {label}: el modelo propondrá una acción y la app la ejecutará (máx. {max} en el listado).",
          { label, max })
      : tn("panel.llm.tools.hintStrong", activeCount,
          "{count} herramienta activa · bucle AI (máx. {max}, {label}). Menos herramientas = menos VRAM.",
          "{count} herramientas activas · bucle AI (máx. {max}, {label}). Menos herramientas = menos VRAM.",
          { label, max });
  }

  function updateNativeToolsPickerUi() {
    const picker = document.getElementById("ba-chat-tools-picker");
    const hint = document.getElementById("ba-chat-tools-hint");
    if (!picker) {
      updateChatToolsButton();
      return;
    }
    const previousGrid = picker.querySelector(".ba-llm-native-tools-grid");
    const previousScrollTop = previousGrid?.scrollTop ?? 0;
    const focusedTool = document.activeElement?.getAttribute?.("data-tool") || "";

    const { model, profileId, max, active, available, policy } = getNativeToolsPickerState();
    if (!policy) {
      picker.replaceChildren(createTextElement("small", "", t("panel.llm.tools.policyNotLoaded", "Política de tools nativas no cargada.")));
      updateChatToolsButton();
      return;
    }

    if (hint) hint.textContent = nativeToolsHintText(model, active.size, max);

    const head = document.createElement("div");
    head.className = "ba-llm-native-tools-head";
    const title = document.createElement("strong");
    title.textContent = t("panel.llm.tools.inLoop", "Herramientas en el bucle");
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
        const meta = createTextElement("span", "ba-llm-native-tool-meta", t("panel.llm.tools.levelShort", "niv. {level}", { level: tool.riskLevel }));
        row.append(input, name, meta);
        grid.appendChild(row);
      }
    } else {
      grid.appendChild(createTextElement("small", "", t("panel.llm.tools.noneForProfile", "Sin tools para este perfil.")));
    }

    if (picker.dataset.nativeToolsPickerBound !== "1") {
      picker.dataset.nativeToolsPickerBound = "1";
      picker.addEventListener("change", (event) => {
        const input = event.target?.closest?.("input[data-tool]");
        if (!input || !picker.contains(input)) return;
        const { model: nextModel, profileId: nextProfileId, policy: nextPolicy } = getNativeToolsPickerState();
        nextPolicy?.toggleToolName(nextModel, input.getAttribute("data-tool"), input.checked, nextProfileId);
        updateNativeToolsPickerUi();
      });
    }

    picker.replaceChildren(head, grid);
    const nextGrid = picker.querySelector(".ba-llm-native-tools-grid");
    if (nextGrid) {
      nextGrid.scrollTop = previousScrollTop;
      window.requestAnimationFrame(() => {
        nextGrid.scrollTop = previousScrollTop;
        if (focusedTool) {
          picker.querySelector(`input[data-tool="${CSS.escape(focusedTool)}"]`)?.focus?.({ preventScroll: true });
        }
      });
    }
    updateChatToolsButton();
  }

  function updateChatToolsButton() {
    const btn = document.getElementById("chat-tools-btn");
    const badge = document.getElementById("chat-tools-badge");
    if (!btn) return;

    const { model, max, active, policy } = getNativeToolsPickerState();
    const activeCount = active.size;
    const label = model?.shortLabel || model?.label || t("panel.llm.modelFallback", "modelo");

    if (badge) {
      badge.textContent = activeCount ? String(activeCount) : "";
      badge.hidden = !activeCount;
      badge.setAttribute("aria-hidden", activeCount ? "false" : "true");
    }

    if (!policy) {
      btn.title = t("panel.llm.toolsBtn.policyNotLoaded", "Herramientas del agente (política no cargada)");
      btn.setAttribute("aria-label", btn.title);
      return;
    }

    btn.title = activeCount
      ? tn("panel.llm.toolsBtn.active", activeCount,
          "{count} herramienta activa de {max} máx. ({label}). Clic para cambiar.",
          "{count} herramientas activas de {max} máx. ({label}). Clic para cambiar.",
          { max, label })
      : t("panel.llm.toolsBtn.none", "Sin herramientas activas (máx. {max} con {label}). Clic para elegir.", { max, label });
    btn.setAttribute("aria-label", btn.title);
  }

  function openChatToolsModal() {
    if (typeof showBaModalPanel !== "function") return;
    showBaModalPanel({
      title: t("panel.llm.toolsModal.title", "Herramientas del agente"),
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
      buttons: [{ id: "close", label: t("common.done", "Listo"), variant: "primary" }],
    });
  }

  function updateAvailableToolsUi() {
    const box = document.getElementById("ba-llm-tool-list");
    if (!box) return;

    const registry = window.BA_LLM_TOOL_REGISTRY;
    const countBadge = document.getElementById("ba-llm-tool-count");
    if (!registry?.listTools) {
      if (countBadge) countBadge.textContent = "—";
      const title = document.createElement("b");
      title.textContent = t("panel.llm.tools.available", "Herramientas disponibles:");
      box.replaceChildren(title, createTextElement("span", "", t("panel.llm.tools.registryUnavailable", "Registro no disponible")));
      return;
    }

    const profileId = getActiveToolProfileId();
    const profileLabel = getActiveToolProfileLabel(profileId);
    const tools = registry.listTools({ profileId });
    if (countBadge) {
      countBadge.textContent = tn("panel.llm.tools.count", tools.length, "{count} herramienta", "{count} herramientas");
      countBadge.title = t("panel.llm.tools.availableForTitle", "Herramientas disponibles para {profile}", { profile: profileLabel });
    }
    const title = document.createElement("b");
    title.textContent = t("panel.llm.tools.availableFor", "Herramientas disponibles para {profile}:", { profile: profileLabel });
    const children = [title];
    if (tools.length) {
      for (const tool of tools) {
        const chip = createTextElement("span", "", t("common.levelChip", "{name} · nivel {level}", { name: tool.name, level: tool.riskLevel }));
        chip.title = t("common.levelChip", "{name} · nivel {level}", { name: tool.label || tool.name, level: tool.riskLevel });
        children.push(chip);
      }
    } else {
      children.push(createTextElement("span", "", t("panel.llm.tools.noneAvailableForProfile", "Sin herramientas disponibles para este perfil")));
    }
    if (profileId === "manual") {
      children.push(createTextElement("small", "", t("panel.llm.tools.manualNote", "Perfil manual: se muestran todas las tools registradas. Algunas pueden fallar si el binario no está instalado.")));
    }
    box.replaceChildren(...children);
  }

  function updateResourceLines(extra = {}) {
    const box = document.getElementById("ba-llm-resource-lines");
    if (!box) return;
    const snap = window.BA_LLM_RESOURCE_GOVERNOR?.getSnapshot?.() || {};
    const ctx = extra.context || window.BA_LLM.lastContextInspect || null;
    if (extra.context) window.BA_LLM.lastContextInspect = extra.context;
    const selected = getSelectedModel();
    const policy = window.BA_LLM_CONTEXT?.getPolicy?.(selected) || {};
    const contextWindow = selected?.contextWindowTokens ?? policy.contextWindowTokens;
    const safeInput = policy.safeInputTokens;
    const maxOutput = policy.maxNewTokensDefault;
    const planOutput = policy.maxNewTokensForPlan;
    const budgetLine = contextWindow && safeInput && maxOutput
      ? t("panel.llm.resources.budget", "Presupuesto: contexto {context} · entrada {input} · salida {output}", { context: contextWindow, input: safeInput, output: maxOutput })
        + (planOutput ? t("panel.llm.resources.budgetPlan", " · plan {plan}", { plan: planOutput }) : "")
      : t("panel.llm.resources.budgetPending", "Presupuesto: pendiente");
    const artifactCount = snap.artifacts ?? window.BA_LLM?.artifacts?.length ?? 0;
    const artifactBadge = document.getElementById("ba-llm-artifact-count");
    if (artifactBadge) {
      artifactBadge.textContent = tn("panel.llm.artifactCount", artifactCount, "{count} artefacto", "{count} artefactos");
      artifactBadge.title = snap.lastArtifactId ? t("panel.llm.resources.lastArtifact", "Último artefacto: {id}", { id: snap.lastArtifactId }) : t("panel.llm.resources.artifactsSaved", "Artefactos guardados");
    }
    const artifacts = window.BA_LLM_ARTIFACTS?.listSummaries?.({ limit: 3 }) || [];
    const artifactLines = artifacts.slice().reverse().map((artifact) => {
      const path = artifact.args?.path ? ` · ${artifact.args.path}` : "";
      const state = artifact.ok ? t("common.okLower", "ok") : t("panel.llm.resources.stateError", "error");
      const size = artifact.sizeBytes ? ` · ${Math.ceil(artifact.sizeBytes / 1024)} KB` : "";
      const truncated = artifact.truncated ? t("panel.llm.resources.truncated", " · truncado") : "";
      return t("panel.llm.resources.artifactLine", "Artefacto: {id} · {tool} · {state}{size}{truncated}{path}", {
        id: artifact.id,
        tool: artifact.tool || t("panel.llm.resources.toolFallback", "tool"),
        state, size, truncated, path,
      });
    });
    const operationLine = (snap.lastOperation
      ? t("panel.llm.resources.operationLine", "Operación: {op}", { op: snap.lastOperation })
      : t("panel.llm.resources.operation", "Operación: inactiva"))
      + (snap.llmBusy ? t("panel.llm.resources.llmBusy", " · LLM ocupado") : "")
      + (snap.toolBusy ? t("panel.llm.resources.toolBusy", " · herramienta activa") : "");
    const lines = [
      t("panel.llm.resources.artifacts", "Artefactos: {count}", { count: artifactCount }) + (snap.lastArtifactId ? ` · ${snap.lastArtifactId}` : ""),
      ...artifactLines,
      budgetLine,
      ctx ? t("panel.llm.resources.contextActive", "Contexto: {tokens} tokens aprox. · {chars} caracteres", { tokens: ctx.estimatedTokens || 0, chars: ctx.chars || 0 }) : t("panel.llm.resources.context", "Contexto: pendiente"),
      operationLine,
    ].filter(Boolean).map((line) => createTextElement("span", "", line));
    if (artifactCount) {
      const button = document.createElement("button");
      button.id = "ba-llm-clear-artifacts";
      button.type = "button";
      button.textContent = t("panel.llm.resources.clearArtifacts", "Limpiar artefactos");
      button.addEventListener("click", () => {
        window.BA_LLM_ARTIFACTS?.clear?.();
        updateResourceLines();
      });
      lines.push(button);
    }
    box.replaceChildren(...lines);
  }

  function mountPanel() {
    const body = findLLMPanelBody();
    if (!body || document.getElementById("ba-llm-panel")) return;

    const details = body.closest("details");
    const summary = details?.querySelector("summary.panel-title");
    if (details) details.classList.add("ba-llm-panel-host");
    if (summary && !summary.querySelector("#ba-llm-status")) {
      const statusBadge = document.createElement("span");
      statusBadge.id = "ba-llm-status";
      statusBadge.className = "badge ba-llm-header-status warn";
      statusBadge.textContent = window.BA_LLM.loading
        ? t("common.loadingLower", "cargando")
        : (window.BA_LLM.loaded ? t("common.loadedLower", "cargado") : t("common.unloadedLower", "sin cargar"));
      summary.appendChild(statusBadge);
    }
    if (summary && !summary.querySelector("#ba-llm-summary-compat")) {
      const capabilityBadge = document.createElement("span");
      capabilityBadge.id = "ba-llm-summary-compat";
      capabilityBadge.className = "badge ba-llm-summary-compat warn";
      capabilityBadge.textContent = window.BA_LLM.capabilitiesChecked
        ? (window.BA_syncLLMCapabilityBadges?.(window.BA_LLM.capabilities, "ready")?.text || "GPU")
        : t("caps.badge.pending", "GPU pendiente");
      summary.appendChild(capabilityBadge);
    }

    // Remove the old static mock text inside the LLM card while preserving the
    // original details/summary wrapper. This avoids showing "Engine: WebLLM"
    // next to the real Transformers.js provider.
    Array.from(body.children).forEach((child) => child.remove());

    body.insertAdjacentHTML("beforeend", buildLLMPanelHtml());
    applyDomTranslations?.(body);
    window.BA_ORIGIN?.syncWarnings?.();

    const select = document.getElementById("ba-llm-model");
    select.value = window.BA_LLM.selectedModelId;
    // Do not intercept the native model <select>. Compatibility is checked when
    // the parent "LLM objetivo" panel opens for the first time.
    select.addEventListener("change", () => {
      if (window.BA_LLM.loaded) {
        window.BA_LLM_AGENT.unloadModel();
      }
      syncCustomVisibility();
      updateNativeToolsPickerUi();
    });
    syncCustomVisibility();
    syncToolPolicyUi();
    updateAvailableToolsUi();
    updateChatToolsButton();
    updateResourceLines();
    if (window.BA_LLM.capabilitiesChecked) {
      applyCapabilitiesToPanel(window.BA_LLM.capabilities);
    } else {
      window.BA_syncLLMCapabilityBadges?.(null, window.BA_LLM.capabilitiesChecking ? "checking" : "ready");
      panelCaps.decorateCapabilityRecheckBadges();
    }
    panelCaps.bindCapabilityRecheckBadges(() => {
      panelCaps.runCapabilityRecheckFromBadge({ checkCapabilities, setStatus });
    });

    if (details) {
      details.addEventListener("toggle", () => {
        panelCaps.ensureCapabilitiesWhenPanelOpens(details, { checkCapabilities, setStatus });
      });
      if (details.open) {
        panelCaps.ensureCapabilitiesWhenPanelOpens(details, { checkCapabilities, setStatus });
      }
    }
    document.getElementById("ba-llm-tool-autonomy")?.addEventListener("change", (event) => {
      window.BA_LLM_TOOL_EXECUTOR?.setAutonomyMaxLevel?.(event.target.value);
      syncToolPolicyUi();
    });

    document.getElementById("chat-tools-btn")?.addEventListener("click", () => openChatToolsModal());

    document.getElementById("ba-llm-show-thinking")?.addEventListener("change", (event) => {
      if (window.BA_LLM?.settings) {
        window.BA_LLM.settings.showThinking = Boolean(event.target.checked);
      }
    });

    document.getElementById("ba-llm-ollama-endpoint")?.addEventListener("change", (event) => {
      const value = String(event.target.value || "").trim().replace(/\/+$/g, "");
      if (value) localStorage.setItem("ba.llm.ollama.endpoint", value);
      else localStorage.removeItem("ba.llm.ollama.endpoint");
      if (window.BA_LLM.loaded && getSelectedModel()?.engine === "ollama") {
        window.BA_LLM_AGENT.unloadModel();
      }
      syncCustomVisibility();
    });

    document.getElementById("vm-profile")?.addEventListener("change", () => {
      updateAvailableToolsUi();
      updateNativeToolsPickerUi();
    });
    window.addEventListener("ba-llm:native-tools", () => {
      updateNativeToolsPickerUi();
      updateChatToolsButton();
    });

    document.getElementById("ba-llm-load")?.addEventListener("click", async () => {
      try {
        setButtonBusy(true);
        setProgress({ status: "init", model: getSelectedModel()?.model || "" }, true);
        const selected = getSelectedModel();
        const caps = await checkCapabilities();
        if ((selected.engine || "transformersjs") === "transformersjs" && (selected.device || "webgpu") === "webgpu" && !caps?.webgpu) return;
        setStatus(selected.engine === "ollama"
          ? t("common.connectingOllama", "Conectando con Ollama…")
          : (selected.device === "wasm" ? t("panel.llm.status.loadingWasm", "Cargando modelo WASM experimental…") : t("panel.llm.status.loadingModel", "Cargando modelo…")), "warn");
        window.BA_LLM.loading = true;
        await window.BA_LLM_AGENT.loadSelectedModel();
        setProgress({ status: "done" }, true);
      } catch (error) {
        window.BA_LLM.lastError = error.message;
        setStatus(t("panel.llm.status.loadError", "Error al cargar"), "bad");
        setProgress({ status: "error", file: error.message }, true);
      } finally {
        window.BA_LLM.loading = false;
        setButtonBusy(false);
        window.BA_LLM_AGENT?.updateChatAvailability?.();
      }
    });

    document.getElementById("chat-clear-memory")?.addEventListener("click", async () => {
      let confirmed = false;
      if (typeof showBaModal === "function") {
        const result = await showBaModal({
          title: t("common.clearChat", "Limpiar chat"),
          message: t("panel.llm.clearChat.message", "Se borrará el chat visible, el historial interno del LLM y los artefactos de herramientas."),
          detail: t("panel.llm.clearChat.detail", "Esta acción no afecta a la VM, la red WS, los discos ni los snapshots."),
          buttons: [
            { id: "cancel", label: t("common.cancel", "Cancelar"), variant: "secondary", cancel: true },
            { id: "clear", label: t("common.clearChat", "Limpiar chat"), variant: "danger" },
          ],
        });
        confirmed = result === "clear";
      } else {
        confirmed = window.confirm(t("panel.llm.clearChat.confirmFallback", "¿Limpiar chat visible, historial interno y artefactos?\n\nEsta acción no afecta a la VM."));
      }
      if (confirmed) window.BA_LLM_AGENT.clearHistory();
    });
    window.BA_LLM_AGENT.updateChatAvailability?.();
    document.getElementById("ba-llm-abort")?.addEventListener("click", () => {
      window.BA_LLM_AGENT.unloadModel();
      setProgress(null, true);
      setStatus(t("panel.llm.status.workerUnloaded", "worker descargado"), "warn");
    });
  }

  window.addEventListener("ba-llm:status", (event) => {
    setStatus(event.detail?.text || "—", event.detail?.tone || "");
    updateSelectedModelCard();
  });

  window.addEventListener("ba-llm:capabilities", (event) => {
    applyCapabilitiesToPanel(event.detail?.capabilities || window.BA_LLM.capabilities);
  });

  window.addEventListener("ba-llm:tool-policy", () => {
    syncToolPolicyUi();
    updateAvailableToolsUi();
  });

  window.addEventListener("ba-llm:progress", (event) => {
    setProgress(event.detail, true);
  });

  window.addEventListener("ba-llm:context", (event) => {
    updateResourceLines({ context: event.detail || {} });
  });

  window.addEventListener("ba-llm:artifact", () => {
    updateResourceLines();
  });

  window.addEventListener("ba-llm:resource", () => {
    updateResourceLines();
    updateAvailableToolsUi();
  });

  window.addEventListener("ba:langchange", () => {
    updateSelectedModelCard();
    updateResourceLines();
    updateAvailableToolsUi();
    updateChatToolsButton();
    updateNativeToolsPickerUi();
    syncToolPolicyUi();
    updateCapabilityDetails(window.BA_LLM?.capabilities || null);
  });

  window.BA_LLM_UI = {
    updateNativeToolsPickerUi,
    updateChatToolsButton,
    openChatToolsModal,
  };

  // index.html loads this file after 09-bootstrap-layout.js, so the existing UI
  // already exists. requestAnimationFrame avoids racing with layout enhancements.
  window.requestAnimationFrame(mountPanel);
  window.requestAnimationFrame(updateChatToolsButton);
})();
