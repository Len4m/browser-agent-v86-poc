// Browser Agent v86 - LLM panel HTML template.
// Static labels use data-i18n so applyDomTranslations() handles initial render
// and live language switching. Dynamic values are translated by panel.ts.

import { llmToolRegistry } from "../tools/tool-registry";

interface LlmPanelTemplateApi {
  escapeHtml: (value: unknown) => string;
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

function toolPolicyOptionsHtml(): string {
  return llmToolRegistry.SECURITY_LEVELS
    .map((item) => `<option value="${escapeHtml(item.level)}">${escapeHtml(item.label)}</option>`)
    .join("");
}

function buildLLMPanelHtml(): string {
  return `
      <div id="ba-llm-panel" class="ba-llm-panel">
        <p class="ba-llm-intro" data-i18n="panel.llm.intro">panel.llm.intro</p>

        <fieldset class="ba-llm-source-picker">
          <legend data-i18n="panel.llm.discovery.source">Source</legend>
          <div class="ba-llm-source-options">
            <label class="ba-llm-source-option">
              <input type="radio" name="ba-llm-source" value="transformersjs" checked />
              <span class="ba-llm-source-card">
                <span class="ba-llm-source-logo ba-llm-source-logo--hf" aria-hidden="true">
                  <img src="./assets/icons/huggingface.svg" alt="" />
                </span>
                <span class="ba-llm-source-copy"><strong>Transformers.js</strong><small>Hugging Face Hub</small></span>
                <span class="ba-llm-source-check" aria-hidden="true">✓</span>
              </span>
            </label>
            <label class="ba-llm-source-option">
              <input type="radio" name="ba-llm-source" value="ollama" />
              <span class="ba-llm-source-card">
                <span class="ba-llm-source-logo ba-llm-source-logo--ollama" aria-hidden="true">
                  <img src="./assets/icons/ollama.svg" alt="" />
                </span>
                <span class="ba-llm-source-copy"><strong>Ollama</strong><small data-i18n="panel.llm.discovery.localModels">Local models</small></span>
                <span class="ba-llm-source-check" aria-hidden="true">✓</span>
              </span>
            </label>
          </div>
        </fieldset>

        <section id="ba-llm-hf-discovery" class="ba-llm-discovery">
          <label class="ba-llm-field"><span data-i18n="panel.llm.discovery.search">Search Hugging Face</span>
            <input id="ba-llm-hf-search" type="search" autocomplete="off" placeholder="Qwen, Llama, Phi…" />
          </label>
          <div id="ba-llm-hf-error" class="ba-llm-note" hidden></div>
          <div class="ba-llm-field">
            <div class="ba-llm-model-list-heading">
              <span data-i18n="panel.llm.discovery.results">Hub results</span>
              <button id="ba-llm-hf-refresh" type="button" class="secondary ba-llm-refresh-icon" aria-label="Refresh" title="Refresh" data-i18n-attr="aria-label:common.refresh,title:common.refresh"></button>
            </div>
            <div class="ba-llm-model-list-frame">
              <div id="ba-llm-hf-results" class="ba-llm-model-list" role="listbox" aria-label="Hugging Face models" tabindex="0"></div>
              <span class="ba-llm-model-list-loading" aria-hidden="true"><span class="ba-llm-spinner"></span></span>
            </div>
          </div>
          <small class="ba-llm-note" data-i18n="panel.llm.discovery.toolsOnlyHub">Only models with detected tool support are listed. Manual repository IDs remain unrestricted.</small>
          <div id="ba-llm-custom-wrap" class="ba-llm-field">
            <label for="ba-llm-custom-model" data-i18n="panel.llm.discovery.manual">Repository ID</label>
            <div class="ba-llm-manual-input">
              <input id="ba-llm-custom-model" placeholder="organization/model" aria-describedby="ba-llm-custom-error" />
              <button id="ba-llm-custom-inspect" type="button" class="secondary ba-llm-manual-inspect" aria-label="Inspect repository information" title="Inspect repository information" data-i18n-attr="aria-label:panel.llm.discovery.inspectManual,title:panel.llm.discovery.inspectManual"></button>
            </div>
            <small id="ba-llm-custom-error" class="ba-llm-field-error" role="alert" hidden></small>
          </div>
          <small id="ba-llm-hf-recents" class="ba-llm-note"></small>
        </section>

        <section id="ba-llm-ollama-discovery" class="ba-llm-discovery" hidden>
          <label id="ba-llm-ollama-endpoint-wrap" class="ba-llm-field"><span data-i18n="panel.llm.field.ollamaEndpoint">panel.llm.field.ollamaEndpoint</span>
            <input id="ba-llm-ollama-endpoint" placeholder="http://127.0.0.1:11434" />
          </label>
          <div class="ba-llm-field">
            <div class="ba-llm-model-list-heading">
              <span data-i18n="panel.llm.discovery.installed">Installed models</span>
              <button id="ba-llm-ollama-refresh" type="button" class="secondary ba-llm-refresh-icon" aria-label="Refresh" title="Refresh" data-i18n-attr="aria-label:common.refresh,title:common.refresh"></button>
            </div>
            <div class="ba-llm-model-list-frame">
              <div id="ba-llm-ollama-models" class="ba-llm-model-list" role="listbox" aria-label="Ollama models" tabindex="0"></div>
              <span class="ba-llm-model-list-loading" aria-hidden="true"><span class="ba-llm-spinner"></span></span>
            </div>
          </div>
          <small class="ba-llm-note" data-i18n="panel.llm.discovery.toolsOnlyOllama">Only installed models that announce tool support are listed.</small>
          <div id="ba-llm-ollama-error" class="ba-llm-note" hidden></div>
        </section>
        <div id="ba-llm-ollama-origin-notice" class="local-service-origin-warning ba-llm-origin-warning" hidden></div>

        <div id="ba-llm-model-inspection" class="ba-llm-inspection-loading" role="status" aria-live="polite" hidden>
          <span class="ba-llm-spinner" aria-hidden="true"></span>
          <span id="ba-llm-model-inspection-text"></span>
        </div>

        <section id="ba-llm-selected-card" class="ba-llm-model-card" aria-live="polite">
          <div class="ba-llm-model-main">
            <strong id="ba-llm-selected-title" data-i18n="panel.llm.selected.defaultTitle">panel.llm.selected.defaultTitle</strong>
            <span id="ba-llm-repo-path" class="ba-llm-repo-path"></span>
            <p id="ba-llm-selected-desc"></p>
          </div>
          <div id="ba-llm-selected-meta" class="ba-llm-model-meta"></div>
        </section>

        <div id="ba-llm-model-warnings" class="ba-llm-note"></div>

        <details class="ba-llm-tool-policy ba-llm-collapsible-card">
          <summary class="ba-llm-tool-policy-head ba-llm-collapsible-summary"><strong data-i18n="panel.llm.profile.basic">Agent configuration</strong></summary>
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
          <summary class="ba-llm-tool-policy-head ba-llm-collapsible-summary"><strong data-i18n="panel.llm.profile.advanced">Advanced configuration</strong></summary>
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
            <div class="ba-llm-row ba-llm-profile-actions">
              <button id="ba-llm-profile-reset" type="button" class="secondary" data-i18n="panel.llm.profile.reset">Restore defaults</button>
            </div>
          </div>
        </details>

        <div class="ba-llm-actions-primary">
          <button id="ba-llm-load" type="button" data-i18n="panel.llm.action.load">panel.llm.action.load</button>
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
  toolPolicyOptionsHtml,
  buildLLMPanelHtml,
};
