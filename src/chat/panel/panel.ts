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
      if (disabled && !option.textContent.includes("no disponible")) {
        option.textContent = `${option.dataset.originalText || option.textContent} · no disponible`;
      }
    }

    const selected = getSelectedModel();
    const selectedNeedsWebGPU = (selected?.engine || "transformersjs") === "transformersjs" && (selected?.device || "webgpu") === "webgpu";
    if ((noWebGPU && selectedNeedsWebGPU) || (noF16 && selected?.requiresShaderF16)) {
      const fallback = compatibleFallbackFor(selected, { noWebGPU, noF16 });
      select.value = fallback.id;
      window.BA_LLM.selectedModelId = fallback.id;
      updateSelectedModelCard();
      setStatus(noWebGPU ? "cambiado a WASM experimental" : "cambiado a q4", "warn");
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
      detail.textContent = "Pendiente de comprobar capacidades de inferencia local.";
      return;
    }
    const limits = result.limits || {};
    detail.textContent = result.webgpu
      ? `WebGPU disponible · shader-f16: ${result.shaderF16 ? "sí" : "no"} · dtype recomendado: ${result.recommendedDtype || "q4"} · maxBuffer: ${limits.maxBufferSize || "—"}`
      : `${result.reason || "WebGPU no disponible."} · WASM experimental disponible solo para modelos compatibles.`;
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
      setStatus("cargado", "good");
    } else if (window.BA_LLM.loading) {
      setStatus("cargando", "warn");
    } else if (result && !result.webgpu && getSelectedModel()?.device === "wasm") {
      setStatus("WASM", "warn");
    } else {
      setStatus("sin cargar", "warn");
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
        return { mode: "indeterminate", percent: null, title: "Preparando carga del modelo", detail: detail.model || "" };
      case "initiate":
        return { mode: "indeterminate", percent: null, title: "Preparando archivo", detail: file || "Inicializando descarga" };
      case "download":
        return { mode: "indeterminate", percent: null, title: "Descargando", detail: file || "Esperando progreso" };
      case "progress_total":
        return {
          mode: "determinate",
          percent: rawPercent,
          title: rawPercent == null ? "Descargando modelo" : `Descargando modelo · ${rawPercent}%`,
          detail: file ? `${file}${size ? ` · ${size}` : ""}` : (size || "Progreso global"),
        };
      case "progress":
        return {
          mode: rawPercent == null ? "indeterminate" : "determinate-file",
          percent: rawPercent,
          title: rawPercent == null ? "Descargando archivo" : `Archivo actual · ${rawPercent}%`,
          detail: file ? `${file}${size ? ` · ${size}` : ""}` : (size || "Progreso de archivo"),
        };
      case "fallback":
        return {
          mode: "indeterminate",
          percent: null,
          title: "WebGPU falló; probando alternativa WASM",
          detail: file || detail.reason || "Reiniciando worker sin WebGPU",
        };
      case "ready":
        return { mode: "determinate", percent: 100, title: "Archivos listos", detail: file || "Preparando ejecución" };
      case "done":
        return { mode: "determinate", percent: 100, title: "Modelo descargado", detail: "Carga completada" };
      default:
        return { mode: rawPercent == null ? "indeterminate" : "determinate", percent: rawPercent, title: detail.status || "Cargando", detail: file || size || "" };
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

    const info = detail ? getProgressInfo(detail) : { mode: "idle", percent: 0, title: "Sin descarga activa", detail: "" };
    wrap.classList.toggle("is-active", info.mode !== "idle");
    bar.classList.toggle("is-indeterminate", info.mode === "indeterminate");

    const pct = info.percent == null ? 0 : info.percent;
    bar.style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", String(pct));
    percent.textContent = info.percent == null ? "—" : `${pct}%`;
    title.textContent = info.title || "Cargando";
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
    if (runtime.provider === "ollama") return `Ollama · ${runtime.endpoint || "endpoint local"}`;
    const device = runtime.device === "webgpu"
      ? "WebGPU"
      : (runtime.device === "wasm" ? "WASM" : runtime.device || "auto");
    const dtype = runtime.dtype ? ` · ${runtime.dtype}` : "";
    const fallback = runtime.fallback ? " · alternativa" : "";
    return `Transformers.js · ${device}${dtype}${fallback}`;
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
    if (desc) desc.textContent = model.description || "Modelo compatible con AI SDK.";
    if (repo) repo.textContent = model.custom ? "Introduce un modelo compatible antes de cargar." : model.model;
    if (meta) {
      meta.innerHTML = [
        window.BA_LLM?.loaded ? ["Backend cargado", activeBackendLabel(model) || "—"] : null,
        ["Motor", model.engineLabel || "Transformers.js"],
        ["Descarga", model.sizeLabel || "—"],
        ["Cuantización", model.dtype || "—"],
        ["Memoria", model.minMemoryLabel || "—"],
        ["Compatibilidad", model.compatibilityLabel || "—"],
        ["Idiomas", model.languageLabel || "—"],
        ["Herramientas", model.agent?.toolCalling || "—"],
        ["Razonamiento", model.thinking?.enabled ? "sí" : "no"],
      ].filter(Boolean).map(([key, value]) => `<span><b>${escapeHtml(key)}:</b> ${escapeHtml(value)}</span>`).join("");
    }
    syncThinkingToggleUi();
  }

  async function checkCapabilities(options = {}) {
    const { force = false } = options;
    setStatus("Comprobando GPU…", "warn");
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
      customWrap.style.display = selected?.custom ? "grid" : "none";
      const text = selected?.engine === "ollama"
        ? "Modelo de Ollama"
        : "Modelo custom compatible con Transformers.js";
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
      ollamaEndpointWrap.style.display = isOllama ? "grid" : "none";
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
      setStatus("requiere WebGPU", "warn");
    } else if (selected?.requiresShaderF16 && caps?.webgpu && !caps.shaderF16) {
      setStatus("requiere shader-f16", "warn");
    } else if (selected?.engine === "ollama") {
      setStatus("requiere Ollama", "warn");
    } else if (selected?.device === "wasm") {
      setStatus("WASM experimental", "warn");
    } else if (!window.BA_LLM.loaded) {
      setStatus("sin cargar", "warn");
    }
  }

  function syncToolPolicyUi() {
    const select = document.getElementById("ba-llm-tool-autonomy");
    const detail = document.getElementById("ba-llm-tool-autonomy-detail");
    if (!select) return;
    const value = String(window.BA_LLM_TOOL_EXECUTOR?.getAutonomyMaxLevel?.() ?? window.BA_LLM.settings.toolAutonomyMaxLevel ?? 1);
    if (select.value !== value) select.value = value;
    const level = (window.BA_LLM_TOOL_REGISTRY?.SECURITY_LEVELS || []).find((item) => String(item.level) === value);
    if (detail) detail.textContent = level?.description || "Configura cuándo el agente debe pedir permiso antes de ejecutar una tool.";
  }


  function getActiveToolProfileId() {
    return state.activeRuntime?.profile?.id
      || getSelectedProfile?.()?.id
      || document.getElementById("vm-profile")?.value
      || "manual";
  }

  function getActiveToolProfileLabel(profileId) {
    if (profileId === "manual") return "manual";
    const profile = state.profiles?.find?.((item) => item.id === profileId);
    return profile?.name || profileId || "perfil actual";
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
      return "Ninguna herramienta seleccionada: el chat no ejecutará herramientas (solo texto del modelo).";
    }
    const label = model?.shortLabel || model?.label || "modelo";
    return weak
      ? `${activeCount} herramienta(s) activa(s) · ${label}: el modelo propondrá una acción y la app la ejecutará (máx. ${max} en el listado).`
      : `${activeCount} herramienta(s) activa(s) · bucle AI (máx. ${max}, ${label}). Menos herramientas = menos VRAM.`;
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
      picker.innerHTML = "<small>Política de tools nativas no cargada.</small>";
      updateChatToolsButton();
      return;
    }

    if (hint) hint.textContent = nativeToolsHintText(model, active.size, max);

    const rows = available.map((tool) => {
      const checked = active.has(tool.name) ? "checked" : "";
      const atMax = active.size >= max && !active.has(tool.name);
      const disabled = atMax ? "disabled" : "";
      return `<label class="ba-llm-native-tool-row${atMax ? " is-disabled" : ""}" title="${escapeHtml(tool.label || tool.name)}">
        <input type="checkbox" data-tool="${escapeHtml(tool.name)}" ${checked} ${disabled} />
        <span class="ba-llm-native-tool-name">${escapeHtml(tool.name)}</span>
        <span class="ba-llm-native-tool-meta">niv. ${escapeHtml(tool.riskLevel)}</span>
      </label>`;
    }).join("");

    picker.innerHTML = `
      <div class="ba-llm-native-tools-head">
        <strong>Herramientas en el bucle</strong>
        <span class="ba-native-tools-count" data-native-tools-count>${active.size}/${max}</span>
      </div>
      <div class="ba-llm-native-tools-grid ba-llm-native-tools-grid--modal">${rows || "<small>Sin tools para este perfil.</small>"}</div>
    `;

    picker.querySelectorAll("input[data-tool]").forEach((input) => {
      input.addEventListener("change", () => {
        const name = input.getAttribute("data-tool");
        policy.toggleToolName(model, name, input.checked, profileId);
        updateNativeToolsPickerUi();
      });
    });
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
    const label = model?.shortLabel || model?.label || "modelo";

    if (badge) {
      badge.textContent = activeCount ? String(activeCount) : "";
      badge.hidden = !activeCount;
      badge.setAttribute("aria-hidden", activeCount ? "false" : "true");
    }

    if (!policy) {
      btn.title = "Herramientas del agente (política no cargada)";
      btn.setAttribute("aria-label", btn.title);
      return;
    }

    btn.title = activeCount
      ? `${activeCount} herramienta(s) activa(s) de ${max} máx. (${label}). Clic para cambiar.`
      : `Sin herramientas activas (máx. ${max} con ${label}). Clic para elegir.`;
    btn.setAttribute("aria-label", btn.title);
  }

  function openChatToolsModal() {
    if (typeof showBaModalPanel !== "function") return;
    showBaModalPanel({
      title: "Herramientas del agente",
      onMount(bodyEl) {
        bodyEl.innerHTML = `
          <small id="ba-chat-tools-hint" class="ba-llm-note ba-chat-tools-hint"></small>
          <div id="ba-chat-tools-picker" class="ba-llm-native-tools-picker ba-llm-native-tools-picker--modal"></div>
        `;
        updateNativeToolsPickerUi();
      },
      buttons: [{ id: "close", label: "Listo", variant: "primary" }],
    });
  }

  function updateAvailableToolsUi() {
    const box = document.getElementById("ba-llm-tool-list");
    if (!box) return;

    const registry = window.BA_LLM_TOOL_REGISTRY;
    const countBadge = document.getElementById("ba-llm-tool-count");
    if (!registry?.listTools) {
      if (countBadge) countBadge.textContent = "—";
      box.innerHTML = `<b>Herramientas disponibles:</b><span>Registro no disponible</span>`;
      return;
    }

    const profileId = getActiveToolProfileId();
    const profileLabel = getActiveToolProfileLabel(profileId);
    const tools = registry.listTools({ profileId });
    if (countBadge) {
      countBadge.textContent = formatCountLabel(tools.length, "herramienta", "herramientas");
      countBadge.title = `Herramientas disponibles para ${profileLabel}`;
    }
    const chips = tools.length
      ? tools.map((tool) => {
          const title = `${tool.label || tool.name} · nivel ${tool.riskLevel}`;
          return `<span title="${escapeHtml(title)}">${escapeHtml(tool.name)} · nivel ${escapeHtml(tool.riskLevel)}</span>`;
        }).join("")
      : `<span>Sin herramientas disponibles para este perfil</span>`;

    const manualHint = profileId === "manual"
      ? `<small>Perfil manual: se muestran todas las tools registradas. Algunas pueden fallar si el binario no está instalado.</small>`
      : "";

    box.innerHTML = `<b>Herramientas disponibles para ${escapeHtml(profileLabel)}:</b>${chips}${manualHint}`;
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
      ? `Presupuesto: contexto ${escapeHtml(contextWindow)} · entrada ${escapeHtml(safeInput)} · salida ${escapeHtml(maxOutput)}${planOutput ? ` · plan ${escapeHtml(planOutput)}` : ""}`
      : "Presupuesto: pendiente";
    const artifactCount = snap.artifacts ?? window.BA_LLM?.artifacts?.length ?? 0;
    const artifactBadge = document.getElementById("ba-llm-artifact-count");
    if (artifactBadge) {
      artifactBadge.textContent = formatCountLabel(artifactCount, "artefacto", "artefactos");
      artifactBadge.title = snap.lastArtifactId ? `Último artefacto: ${snap.lastArtifactId}` : "Artefactos guardados";
    }
    const artifacts = window.BA_LLM_ARTIFACTS?.listSummaries?.({ limit: 3 }) || [];
    const artifactLines = artifacts.slice().reverse().map((artifact) => {
      const path = artifact.args?.path ? ` · ${artifact.args.path}` : "";
      const state = artifact.ok ? "ok" : "error";
      const size = artifact.sizeBytes ? ` · ${Math.ceil(artifact.sizeBytes / 1024)} KB` : "";
      const truncated = artifact.truncated ? " · truncado" : "";
      return `Artefacto: ${escapeHtml(artifact.id)} · ${escapeHtml(artifact.tool || "tool")} · ${escapeHtml(state)}${escapeHtml(size)}${escapeHtml(truncated)}${escapeHtml(path)}`;
    });
    const actions = artifactCount
      ? `<button id="ba-llm-clear-artifacts" type="button">Limpiar artefactos</button>`
      : "";
    box.innerHTML = [
      `Artefactos: ${escapeHtml(artifactCount)}${snap.lastArtifactId ? ` · ${escapeHtml(snap.lastArtifactId)}` : ""}`,
      ...artifactLines,
      budgetLine,
      ctx ? `Contexto: ${escapeHtml(ctx.estimatedTokens || 0)} tokens aprox. · ${escapeHtml(ctx.chars || 0)} caracteres` : "Contexto: pendiente",
      `Operación: ${escapeHtml(snap.lastOperation || "inactiva")}${snap.llmBusy ? " · LLM ocupado" : ""}${snap.toolBusy ? " · herramienta activa" : ""}`,
      actions,
    ].filter(Boolean).map((line) => `<span>${line}</span>`).join("");
    box.querySelector("#ba-llm-clear-artifacts")?.addEventListener("click", () => {
      window.BA_LLM_ARTIFACTS?.clear?.();
      updateResourceLines();
    });
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
        ? "cargando"
        : (window.BA_LLM.loaded ? "cargado" : "sin cargar");
      summary.appendChild(statusBadge);
    }
    if (summary && !summary.querySelector("#ba-llm-summary-compat")) {
      const capabilityBadge = document.createElement("span");
      capabilityBadge.id = "ba-llm-summary-compat";
      capabilityBadge.className = "badge ba-llm-summary-compat warn";
      capabilityBadge.textContent = window.BA_LLM.capabilitiesChecked
        ? (window.BA_syncLLMCapabilityBadges?.(window.BA_LLM.capabilities, "ready")?.text || "GPU")
        : "GPU pendiente";
      summary.appendChild(capabilityBadge);
    }

    // Remove the old static mock text inside the LLM card while preserving the
    // original details/summary wrapper. This avoids showing "Engine: WebLLM"
    // next to the real Transformers.js provider.
    Array.from(body.children).forEach((child) => child.remove());

    body.insertAdjacentHTML("beforeend", buildLLMPanelHtml());
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
          ? "Conectando con Ollama…"
          : (selected.device === "wasm" ? "Cargando modelo WASM experimental…" : "Cargando modelo…"), "warn");
        window.BA_LLM.loading = true;
        await window.BA_LLM_AGENT.loadSelectedModel();
        setProgress({ status: "done" }, true);
      } catch (error) {
        window.BA_LLM.lastError = error.message;
        setStatus("Error al cargar", "bad");
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
          title: "Limpiar chat",
          message: "Se borrará el chat visible, el historial interno del LLM y los artefactos de herramientas.",
          detail: "Esta acción no afecta a la VM, la red WS, los discos ni los snapshots.",
          buttons: [
            { id: "cancel", label: "Cancelar", variant: "secondary", cancel: true },
            { id: "clear", label: "Limpiar chat", variant: "danger" },
          ],
        });
        confirmed = result === "clear";
      } else {
        confirmed = window.confirm("¿Limpiar chat visible, historial interno y artefactos?\n\nEsta acción no afecta a la VM.");
      }
      if (confirmed) window.BA_LLM_AGENT.clearHistory();
    });
    window.BA_LLM_AGENT.updateChatAvailability?.();
    document.getElementById("ba-llm-abort")?.addEventListener("click", () => {
      window.BA_LLM_AGENT.unloadModel();
      setProgress(null, true);
      setStatus("worker descargado", "warn");
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
