// @ts-nocheck
// Browser Agent v86 - 15a LLM panel HTML template
// Template builders extracted from 15-llm-ui-panel.js.
// Static labels use data-i18n so applyDomTranslations() handles initial render
// and live language switching. Dynamic values are translated by panel.ts via t().

(function initLLMPanelTemplate() {
  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function modelOptionsHtml() {
    const groups = [
      {
        label: t("panel.llm.optgroup.ollama", "Ollama"),
        matches: (model) => model.engine === "ollama",
      },
      {
        label: t("panel.llm.optgroup.transformers", "Transformers.js / navegador"),
        matches: (model) => (model.engine || "transformersjs") === "transformersjs",
      },
    ];

    const optionHtml = (model) => {
      const size = model.sizeLabel ? ` · ${model.sizeLabel}` : "";
      const dtype = model.dtype ? ` · ${model.dtype}` : "";
      const compat = model.requiresShaderF16
        ? ` · ${t("panel.llm.model.requiresShaderF16", "requiere shader-f16")}`
        : "";
      return `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}${escapeHtml(size)}${escapeHtml(dtype)}${escapeHtml(compat)}</option>`;
    };

    const used = new Set();
    const grouped = groups.map((group) => {
      const options = window.BA_LLM_MODELS.filter((model) => group.matches(model));
      options.forEach((model) => used.add(model.id));
      if (!options.length) return "";
      return `<optgroup label="${escapeHtml(group.label)}">${options.map(optionHtml).join("")}</optgroup>`;
    });

    const remaining = window.BA_LLM_MODELS.filter((model) => !used.has(model.id));
    if (remaining.length) {
      grouped.push(`<optgroup label="${escapeHtml(t("panel.llm.optgroup.others", "Otros"))}">${remaining.map(optionHtml).join("")}</optgroup>`);
    }

    return grouped.join("");
  }

  function toolPolicyOptionsHtml() {
    const levels = window.BA_LLM_TOOL_REGISTRY?.SECURITY_LEVELS || [];
    return levels.map((item) => `<option value="${escapeHtml(item.level)}">${escapeHtml(item.label)}</option>`).join("");
  }

  function buildLLMPanelHtml() {
    return `
      <div id="ba-llm-panel" class="ba-llm-panel">
        <div class="ba-llm-hero">
          <div class="ba-llm-mark" aria-hidden="true">LLM</div>
          <div class="ba-llm-hero-copy">
            <div class="ba-llm-kicker" data-i18n="panel.llm.kicker">Inferencia · AI SDK v6</div>
            <div class="ba-llm-title-row">
              <strong>Transformers.js/Ollama</strong>
            </div>
            <p data-i18n="panel.llm.intro">Modelos ONNX en el navegador u Ollama local por HTTP. WebGPU recomendado para Transformers.js.</p>
          </div>
        </div>

        <label class="ba-llm-field"><span data-i18n="panel.llm.field.model">Modelo</span>
          <select id="ba-llm-model">${modelOptionsHtml()}</select>
        </label>

        <section class="ba-llm-model-card" aria-live="polite">
          <div class="ba-llm-model-main">
            <strong id="ba-llm-selected-title">Modelo local</strong>
            <span id="ba-llm-repo-path" class="ba-llm-repo-path"></span>
            <p id="ba-llm-selected-desc"></p>
          </div>
          <div id="ba-llm-selected-meta" class="ba-llm-model-meta"></div>
        </section>

        <label id="ba-llm-custom-wrap" class="ba-llm-field" hidden><span data-i18n="panel.llm.field.customModel">Modelo custom compatible con Transformers.js</span>
          <input id="ba-llm-custom-model" placeholder="onnx-community/Llama-3.2-1B-Instruct-ONNX o qwen3:1.7b" />
        </label>

        <label id="ba-llm-ollama-endpoint-wrap" class="ba-llm-field" hidden><span data-i18n="panel.llm.field.ollamaEndpoint">Endpoint Ollama</span>
          <input id="ba-llm-ollama-endpoint" placeholder="http://127.0.0.1:11434" />
        </label>
        <div id="ba-llm-ollama-origin-notice" class="local-service-origin-warning ba-llm-origin-warning" hidden></div>

        <div class="ba-llm-actions-primary">
          <button id="ba-llm-load" type="button" data-i18n="panel.llm.action.load">Cargar modelo</button>
        </div>

        <small class="ba-llm-note" data-i18n="panel.llm.note.tools">Activa herramientas con el botón de llave inglesa junto al campo de chat. Ollama requiere CORS permitido en el host.</small>

        <label id="ba-llm-thinking-wrap" class="ba-llm-field ba-llm-thinking-toggle" hidden>
          <input id="ba-llm-show-thinking" type="checkbox" />
          <span data-i18n="panel.llm.thinkingToggle">Mostrar razonamiento del modelo (thinking)</span>
        </label>

        <div id="ba-llm-progress-wrap" class="ba-llm-progress-wrap" aria-live="polite">
          <div class="ba-llm-progress-head">
            <span id="ba-llm-progress-title">Sin descarga activa</span>
            <b id="ba-llm-progress-percent">—</b>
          </div>
          <div class="ba-llm-progress-track">
            <div id="ba-llm-progress-bar" class="ba-llm-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></div>
          </div>
          <div id="ba-llm-progress-detail" class="ba-llm-progress-detail"></div>
        </div>

        <details class="ba-llm-resource-card ba-llm-collapsible-card">
          <summary class="ba-llm-tool-policy-head ba-llm-collapsible-summary">
            <strong data-i18n="panel.llm.resources.title">Recursos y contexto</strong>
            <span id="ba-llm-artifact-count" class="ba-llm-card-count">0 artefactos</span>
          </summary>
          <div id="ba-llm-resource-lines" class="ba-llm-resource-lines">
            <span>Artefactos: 0</span>
            <span>Contexto: pendiente</span>
            <span>Operación: inactiva</span>
          </div>
        </details>

        <details class="ba-llm-tool-policy ba-llm-collapsible-card">
          <summary class="ba-llm-tool-policy-head ba-llm-collapsible-summary">
            <strong data-i18n="panel.llm.autonomy.title">Autonomía de herramientas</strong>
            <span id="ba-llm-tool-count" class="ba-llm-card-count">—</span>
          </summary>
          <div class="ba-llm-collapsible-body">
            <label class="ba-llm-field"><span data-i18n="panel.llm.autonomy.runUntil">Ejecutar sin pedir permiso hasta</span>
              <select id="ba-llm-tool-autonomy">${toolPolicyOptionsHtml()}</select>
            </label>
            <small id="ba-llm-tool-autonomy-detail"></small>
            <div id="ba-llm-tool-list" class="ba-llm-tool-list" aria-live="polite">
              <b>Herramientas disponibles:</b>
              <span>Calculando…</span>
            </div>
          </div>
        </details>

        <div class="ba-llm-row ba-llm-actions-secondary">
          <button id="ba-llm-abort" type="button" class="secondary danger-light" data-i18n="panel.llm.action.unloadWorker">Descargar worker</button>
        </div>
        <div id="ba-llm-capabilities" class="ba-llm-note">Pendiente de comprobar capacidades de inferencia local.</div>
      </div>
    `;
  }

  window.BA_LLM_PANEL_TEMPLATE = {
    escapeHtml,
    modelOptionsHtml,
    toolPolicyOptionsHtml,
    buildLLMPanelHtml,
  };
})();
