// Browser Agent v86 - LLM panel HTML template.
// Static labels use data-i18n so applyDomTranslations() handles initial render
// and live language switching. Dynamic values are translated by panel.ts.

import { t } from "../../app/i18n";
import { getLlmModels, llmModelLabel, type LlmModelConfig } from "../state/chat-state";
import { llmToolRegistry } from "../tools/tool-registry";

interface LlmPanelTemplateApi {
  escapeHtml: (value: unknown) => string;
  modelOptionsHtml: () => string;
  toolPolicyOptionsHtml: () => string;
  buildLLMPanelHtml: () => string;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function escapeHtml(value: unknown): string {
  return textValue(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function modelOptionsHtml(): string {
  const models = getLlmModels();
  const groups = [
    {
      label: t("panel.llm.optgroup.ollama"),
      matches: (model: LlmModelConfig) => model.engine === "ollama",
    },
    {
      label: t("panel.llm.optgroup.transformers"),
      matches: (model: LlmModelConfig) => (model.engine || "transformersjs") === "transformersjs",
    },
  ];

  const optionHtml = (model: LlmModelConfig): string => {
    const sizeLabel = textValue(model.sizeLabel);
    const size = sizeLabel ? ` · ${sizeLabel}` : "";
    const dtype = model.dtype ? ` · ${model.dtype}` : "";
    return `<option value="${escapeHtml(model.id)}">${escapeHtml(llmModelLabel(model))}${escapeHtml(size)}${escapeHtml(dtype)}</option>`;
  };

  const used = new Set<string>();
  const grouped = groups.map((group) => {
    const options = models.filter((model) => group.matches(model));
    options.forEach((model) => used.add(model.id));
    if (!options.length) return "";
    return `<optgroup label="${escapeHtml(group.label)}">${options.map(optionHtml).join("")}</optgroup>`;
  });

  const remaining = models.filter((model) => !used.has(model.id));
  if (remaining.length) {
    grouped.push(`<optgroup label="${escapeHtml(t("panel.llm.optgroup.others"))}">${remaining.map(optionHtml).join("")}</optgroup>`);
  }

  return grouped.join("");
}

function toolPolicyOptionsHtml(): string {
  return llmToolRegistry.SECURITY_LEVELS
    .map((item) => `<option value="${escapeHtml(item.level)}">${escapeHtml(item.label)}</option>`)
    .join("");
}

function buildLLMPanelHtml(): string {
  return `
      <div id="ba-llm-panel" class="ba-llm-panel">
        <div class="ba-llm-hero">
          <div class="ba-llm-mark" aria-hidden="true">LLM</div>
          <div class="ba-llm-hero-copy">
            <div class="ba-llm-kicker" data-i18n="panel.llm.kicker">panel.llm.kicker</div>
            <div class="ba-llm-title-row">
              <strong>Transformers.js/Ollama</strong>
            </div>
            <p data-i18n="panel.llm.intro">panel.llm.intro</p>
          </div>
        </div>

        <label class="ba-llm-field"><span data-i18n="panel.llm.discovery.source">Source</span>
          <select id="ba-llm-source">
            <option value="transformersjs">Transformers.js · Hugging Face</option>
            <option value="ollama">Ollama</option>
          </select>
        </label>

        <section id="ba-llm-hf-discovery" class="ba-llm-discovery">
          <label class="ba-llm-field"><span data-i18n="panel.llm.discovery.search">Search Hugging Face</span>
            <input id="ba-llm-hf-search" type="search" autocomplete="off" placeholder="Qwen, Llama, Phi…" />
          </label>
          <div class="ba-llm-row">
            <button id="ba-llm-hf-refresh" type="button" class="secondary" data-i18n="common.refresh">Refresh</button>
            <button id="ba-llm-hf-more" type="button" class="secondary" data-i18n="panel.llm.discovery.more" hidden>Load more</button>
          </div>
          <div id="ba-llm-hf-error" class="ba-llm-note" hidden></div>
          <label class="ba-llm-field"><span data-i18n="panel.llm.discovery.results">Hub results</span>
            <select id="ba-llm-hf-results" size="6"></select>
          </label>
          <label id="ba-llm-custom-wrap" class="ba-llm-field"><span data-i18n="panel.llm.discovery.manual">Repository ID</span>
            <input id="ba-llm-custom-model" placeholder="onnx-community/Llama-3.2-1B-Instruct-ONNX" />
          </label>
          <small id="ba-llm-hf-recents" class="ba-llm-note"></small>
        </section>

        <section id="ba-llm-ollama-discovery" class="ba-llm-discovery" hidden>
          <label id="ba-llm-ollama-endpoint-wrap" class="ba-llm-field"><span data-i18n="panel.llm.field.ollamaEndpoint">panel.llm.field.ollamaEndpoint</span>
            <input id="ba-llm-ollama-endpoint" placeholder="http://127.0.0.1:11434" />
          </label>
          <button id="ba-llm-ollama-refresh" type="button" class="secondary" data-i18n="common.refresh">Refresh</button>
          <label class="ba-llm-field"><span data-i18n="panel.llm.discovery.installed">Installed models</span>
            <select id="ba-llm-ollama-models" size="6"></select>
          </label>
          <div id="ba-llm-ollama-error" class="ba-llm-note" hidden></div>
        </section>
        <div id="ba-llm-ollama-origin-notice" class="local-service-origin-warning ba-llm-origin-warning" hidden></div>

        <label class="ba-llm-field"><span data-i18n="panel.llm.field.model">panel.llm.field.model</span>
          <select id="ba-llm-model">${modelOptionsHtml()}</select>
        </label>

        <section class="ba-llm-model-card" aria-live="polite">
          <div class="ba-llm-model-main">
            <strong id="ba-llm-selected-title" data-i18n="panel.llm.selected.defaultTitle">panel.llm.selected.defaultTitle</strong>
            <span id="ba-llm-repo-path" class="ba-llm-repo-path"></span>
            <p id="ba-llm-selected-desc"></p>
          </div>
          <div id="ba-llm-selected-meta" class="ba-llm-model-meta"></div>
        </section>

        <div id="ba-llm-model-warnings" class="ba-llm-note"></div>

        <details class="ba-llm-tool-policy ba-llm-collapsible-card" open>
          <summary class="ba-llm-collapsible-summary"><strong data-i18n="panel.llm.profile.basic">Agent configuration</strong></summary>
          <div class="ba-llm-collapsible-body">
            <label class="ba-llm-field"><span data-i18n="panel.llm.profile.strategy">Tool strategy</span>
              <select id="ba-llm-tool-strategy"><option value="off">off</option><option value="heuristic">heuristic</option><option value="model-first">model-first</option></select>
            </label>
            <label class="ba-llm-field"><span data-i18n="panel.llm.profile.quality">Tool calling</span>
              <select id="ba-llm-tool-calling"><option value="weak">weak</option><option value="fair">fair</option><option value="good">good</option></select>
            </label>
            <label class="ba-llm-field"><span>maxSteps</span><input id="ba-llm-max-steps" type="number" min="1" max="8" /></label>
            <label class="ba-llm-field"><span>maxNativeTools</span><input id="ba-llm-max-tools" type="number" min="1" max="12" /></label>
            <label class="ba-llm-field"><span data-i18n="panel.llm.profile.think">Thinking</span><select id="ba-llm-think-mode"></select></label>
            <label class="ba-llm-field ba-llm-thinking-toggle"><input id="ba-llm-show-thinking" type="checkbox" /><span data-i18n="panel.llm.thinkingToggle">panel.llm.thinkingToggle</span></label>
          </div>
        </details>

        <details class="ba-llm-tool-policy ba-llm-collapsible-card">
          <summary class="ba-llm-collapsible-summary"><strong data-i18n="panel.llm.profile.advanced">Advanced configuration</strong></summary>
          <div class="ba-llm-collapsible-body">
            <label class="ba-llm-field"><span>temperature</span><input id="ba-llm-temperature" type="number" min="0" max="2" step="0.05" /></label>
            <label class="ba-llm-field"><span>topP</span><input id="ba-llm-top-p" type="number" min="0" max="1" step="0.05" /></label>
            <label class="ba-llm-field"><span>contextWindowTokens</span><input id="ba-llm-context-window" type="number" min="256" /></label>
            <label class="ba-llm-field"><span>safeInputTokens</span><input id="ba-llm-safe-input" type="number" min="128" /></label>
            <label class="ba-llm-field"><span>maxOutputTokens</span><input id="ba-llm-max-output" type="number" min="1" /></label>
            <label class="ba-llm-field"><span>maxNewTokensForPlan</span><input id="ba-llm-max-plan" type="number" min="1" /></label>
            <label id="ba-llm-device-wrap" class="ba-llm-field"><span>device</span><select id="ba-llm-device"><option value="auto">auto</option><option value="webgpu">webgpu</option><option value="wasm">wasm</option></select></label>
            <label id="ba-llm-dtype-wrap" class="ba-llm-field"><span>dtype</span><select id="ba-llm-dtype"><option value="auto">auto</option></select></label>
            <label id="ba-llm-cache-wrap" class="ba-llm-field ba-llm-thinking-toggle"><input id="ba-llm-reuse-cache" type="checkbox" /><span>generation cache</span></label>
            <label id="ba-llm-tag-wrap" class="ba-llm-field"><span>thinking tag</span><input id="ba-llm-thinking-tag" value="think" /></label>
            <label id="ba-llm-reasoning-start-wrap" class="ba-llm-field ba-llm-thinking-toggle"><input id="ba-llm-start-reasoning" type="checkbox" /><span>startWithReasoning</span></label>
            <div class="ba-llm-row">
              <button id="ba-llm-profile-reset" type="button" class="secondary" data-i18n="panel.llm.profile.reset">Restore engine defaults</button>
              <button id="ba-llm-profile-export" type="button" class="secondary" data-i18n="panel.llm.profile.export">Export profiles</button>
              <button id="ba-llm-profile-import" type="button" class="secondary" data-i18n="panel.llm.profile.import">Import profiles</button>
              <input id="ba-llm-profile-file" type="file" accept="application/json,.json" hidden />
            </div>
          </div>
        </details>

        <div class="ba-llm-actions-primary">
          <button id="ba-llm-load" type="button" data-i18n="panel.llm.action.load">panel.llm.action.load</button>
        </div>

        <small class="ba-llm-note" data-i18n="panel.llm.note.tools">panel.llm.note.tools</small>

        <div id="ba-llm-progress-wrap" class="ba-llm-progress-wrap" aria-live="polite">
          <div class="ba-llm-progress-head">
            <span id="ba-llm-progress-title" data-i18n="panel.llm.progress.idle">panel.llm.progress.idle</span>
            <b id="ba-llm-progress-percent">—</b>
          </div>
          <div class="ba-llm-progress-track">
            <div id="ba-llm-progress-bar" class="ba-llm-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></div>
          </div>
          <div id="ba-llm-progress-detail" class="ba-llm-progress-detail"></div>
        </div>

        <details class="ba-llm-resource-card ba-llm-collapsible-card">
          <summary class="ba-llm-tool-policy-head ba-llm-collapsible-summary">
            <strong data-i18n="panel.llm.resources.title">panel.llm.resources.title</strong>
            <span id="ba-llm-artifact-count" class="ba-llm-card-count">—</span>
          </summary>
          <div id="ba-llm-resource-lines" class="ba-llm-resource-lines">
            <span data-i18n="panel.llm.resources.context">panel.llm.resources.context</span>
            <span data-i18n="panel.llm.resources.operation">panel.llm.resources.operation</span>
          </div>
        </details>

        <details class="ba-llm-tool-policy ba-llm-collapsible-card">
          <summary class="ba-llm-tool-policy-head ba-llm-collapsible-summary">
            <strong data-i18n="panel.llm.autonomy.title">panel.llm.autonomy.title</strong>
            <span id="ba-llm-tool-count" class="ba-llm-card-count">—</span>
          </summary>
          <div class="ba-llm-collapsible-body">
            <label class="ba-llm-field"><span data-i18n="panel.llm.autonomy.runUntil">panel.llm.autonomy.runUntil</span>
              <select id="ba-llm-tool-autonomy">${toolPolicyOptionsHtml()}</select>
            </label>
            <small id="ba-llm-tool-autonomy-detail"></small>
            <div id="ba-llm-tool-list" class="ba-llm-tool-list" aria-live="polite">
              <b data-i18n="panel.llm.tools.available">panel.llm.tools.available</b>
              <span data-i18n="common.checkingEllipsis">common.checkingEllipsis</span>
            </div>
          </div>
        </details>

        <div class="ba-llm-row ba-llm-actions-secondary">
          <button id="ba-llm-abort" type="button" class="secondary danger-light" data-i18n="panel.llm.action.unloadWorker">panel.llm.action.unloadWorker</button>
        </div>
        <div id="ba-llm-capabilities" class="ba-llm-note" data-i18n="common.inferencePending">common.inferencePending</div>
      </div>
    `;
}

export const llmPanelTemplate: LlmPanelTemplateApi = {
  escapeHtml,
  modelOptionsHtml,
  toolPolicyOptionsHtml,
  buildLLMPanelHtml,
};
