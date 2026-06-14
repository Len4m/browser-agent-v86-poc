// Browser Agent v86 - agent loop debug.
// Visible trace for stream, tools and routing. The enabled flag persists in
// localStorage so the panel can be toggled without losing preference.

import { t } from "../../app/i18n";
import { llmEventsApi } from "../state/chat-state";

const STORAGE_KEY = "ba.llm.agentDebug.enabled";
const MAX_LINES = 250;
const MAX_MESSAGE_CHARS = 500;
const MAX_DATA_CHARS = 1200;

export interface AgentDebugEntry extends Record<string, unknown> {
  time: string;
  category: string;
  message: string;
  data: string | null;
}

export interface LlmAgentDebugApi {
  enabled: boolean;
  log: (category: unknown, message: unknown, data?: unknown) => void;
  clear: () => void;
  setEnabled: (value: unknown) => void;
  copyLog: () => Promise<void>;
  summarizeStreamPart: (part: unknown) => unknown;
  getEntries: () => AgentDebugEntry[];
}

type DetailsBeforeToggleEvent = Event & {
  newState?: string;
};

const entries: AgentDebugEntry[] = [];

let logEl: HTMLPreElement | null = null;
let panelEl: HTMLDetailsElement | null = null;
let renderDirty = false;
let initialized = false;

function isPanelVisible(): boolean {
  return Boolean(panelEl && !panelEl.hidden && panelEl.open);
}

function isEnabled(): boolean {
  return llmAgentDebug.enabled !== false
    && localStorage.getItem(STORAGE_KEY) !== "0";
}

function formatTime(date = new Date()): string {
  return date.toLocaleTimeString("es-ES", { hour12: false, fractionalSecondDigits: 3 });
}

function preview(value: unknown, max = 320): string {
  if (value == null) return "";
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      const json = JSON.stringify(value);
      text = typeof json === "string" ? json : plainText(value);
    } catch {
      text = plainText(value);
    }
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function plainText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol") {
    return String(value);
  }
  if (typeof value === "function") return value.name ? `[function ${value.name}]` : "[function]";
  return Object.prototype.toString.call(value);
}

function boundedText(value: unknown, max: number): string {
  const text = plainText(value);
  return text.length > max ? `${text.slice(0, max)}${t("debug.charsOmitted", { n: text.length - max })}` : text;
}

function boundedData(value: unknown): string | null {
  if (value == null) return null;
  return preview(value, MAX_DATA_CHARS);
}

function eventDetail(event: Event): unknown {
  return event instanceof CustomEvent ? event.detail : {};
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function render(): void {
  if (!logEl) {
    renderDirty = true;
    return;
  }
  if (!isPanelVisible()) {
    renderDirty = true;
    return;
  }
  renderDirty = false;
  logEl.textContent = entries.map((entry) => {
    const extra = entry.data != null && entry.data !== "" ? ` ${entry.data}` : "";
    return `${entry.time} [${entry.category}] ${entry.message}${extra}`;
  }).join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}

function log(category: unknown, message: unknown, data: unknown = null): void {
  if (!isEnabled()) return;
  const categoryText = plainText(category);
  const entry: AgentDebugEntry = {
    time: formatTime(),
    category: categoryText || "info",
    message: boundedText(message || "", MAX_MESSAGE_CHARS),
    data: boundedData(data),
  };
  entries.push(entry);
  while (entries.length > MAX_LINES) entries.shift();
  render();
  try {
    llmEventsApi.emit("agent-debug", entry);
  } catch {
    // Debug logging must never affect the main agent loop.
  }
}

function clear(): void {
  entries.length = 0;
  render();
  log("ui", t("debug.log.cleared"));
}

function setEnabled(value: unknown): void {
  llmAgentDebug.enabled = Boolean(value);
  localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  const toggle = document.getElementById("ba-agent-debug-enabled");
  if (toggle instanceof HTMLInputElement) toggle.checked = Boolean(value);
  log("ui", value ? t("debug.log.enabled") : t("debug.log.paused"));
}

function copyLog(): Promise<void> {
  const text = entries.map((entry) => {
    const extra = entry.data != null ? ` ${entry.data}` : "";
    return `${entry.time} [${entry.category}] ${entry.message}${extra}`;
  }).join("\n");
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.className = "clipboard-fallback";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  return Promise.resolve();
}

function summarizeStreamPart(part: unknown): unknown {
  const record = recordValue(part);
  if (!record) return part;
  const type = textValue(record.type);
  if (!type) return part;

  if (type === "text-delta" || type === "reasoning-delta") {
    const chunk = textValue(record.text) || textValue(record.textDelta) || textValue(record.delta);
    return { type, len: chunk.length, sample: chunk.slice(0, 100) };
  }
  if (type === "tool-call" || type === "tool-input-available") {
    return {
      type,
      toolName: record.toolName ?? record.toolCallId ?? record.name,
      input: preview(record.input ?? record.args ?? record.arguments, 160),
    };
  }
  if (type === "tool-result" || type === "tool-output-available") {
    return { type, toolCallId: record.toolCallId, output: preview(record.output ?? record.result, 120) };
  }
  if (type === "tool-error" || type === "tool-output-error") {
    return { type, error: preview(record.error ?? record.message, 160) };
  }
  return { type, keys: Object.keys(record).slice(0, 8) };
}

function mountPanel(): void {
  const chatPanel = document.querySelector<HTMLElement>(".workspace-grid > .panel:first-child");
  const chatForm = document.getElementById("chat-form");
  const chatLog = document.getElementById("chat-log");
  if (!chatPanel || !chatForm || document.getElementById("ba-agent-debug-panel")) return;
  const panelRoot = chatPanel;
  const formNode = chatForm;

  let skipNextDetailsLock = false;
  let chatLogObserver: MutationObserver | null = null;

  function stopChatLogObserver(): void {
    chatLogObserver?.disconnect();
    chatLogObserver = null;
  }

  function startChatLogObserver(): void {
    if (!chatLog || chatLogObserver) return;
    chatLogObserver = new MutationObserver(() => syncChatPanelLayout());
    chatLogObserver.observe(chatLog, { childList: true });
  }

  function clearChatPanelDebugLayout(): void {
    panelRoot.style.minHeight = "";
    panelRoot.style.height = "";
    panelRoot.style.maxHeight = "";
    panelRoot.classList.remove("ba-chat-panel-debug-open");
    delete panelRoot.dataset.debugLockHeight;
  }

  function applyChatPanelDebugLock(): void {
    const lock = Number(panelRoot.dataset.debugLockHeight);
    if (!Number.isFinite(lock) || lock <= 0) return;
    panelRoot.style.height = `${lock}px`;
    panelRoot.style.minHeight = `${lock}px`;
    panelRoot.style.maxHeight = `${lock}px`;
  }

  function syncChatPanelLayout(): void {
    if (!panelEl || panelEl.hidden || !panelEl.open) {
      stopChatLogObserver();
      clearChatPanelDebugLayout();
      return;
    }

    startChatLogObserver();
    panelRoot.classList.add("ba-chat-panel-debug-open");
    requestAnimationFrame(() => {
      if (!panelEl || panelEl.hidden || !panelEl.open) return;
      applyChatPanelDebugLock();
    });
  }

  const actions = document.querySelector(".chat-title-actions");
  if (actions && !document.getElementById("ba-agent-debug-toggle")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "ba-agent-debug-toggle";
    btn.className = "chat-clear-btn ba-agent-debug-toggle";
    btn.textContent = t("debug.toggle.label");
    btn.title = t("debug.toggle.title");
    btn.setAttribute("aria-pressed", "false");
    actions.insertBefore(btn, actions.firstChild);
    btn.addEventListener("click", () => {
      const panel = document.getElementById("ba-agent-debug-panel");
      if (!(panel instanceof HTMLDetailsElement)) return;
      const show = panel.hidden;
      panel.hidden = !show;
      btn.setAttribute("aria-pressed", show ? "true" : "false");
      if (show) {
        skipNextDetailsLock = true;
        panel.open = true;
        requestAnimationFrame(() => {
          skipNextDetailsLock = false;
        });
      } else {
        clearChatPanelDebugLayout();
      }
      syncChatPanelLayout();
      if (show && renderDirty) render();
    });
  }

  const debugPanel = document.createElement("details");
  panelEl = debugPanel;
  debugPanel.id = "ba-agent-debug-panel";
  debugPanel.className = "ba-agent-debug-panel";
  debugPanel.hidden = true;
  debugPanel.innerHTML = `
    <summary class="ba-agent-debug-summary">${t("debug.panel.summary")}</summary>
    <div class="ba-agent-debug-body">
      <div class="ba-agent-debug-toolbar">
        <label class="ba-agent-debug-enable">
          <input type="checkbox" id="ba-agent-debug-enabled" checked />
          ${t("debug.toolbar.enable")}
        </label>
        <button type="button" id="ba-agent-debug-clear" class="secondary">${t("common.clear")}</button>
        <button type="button" id="ba-agent-debug-copy" class="secondary">${t("debug.toolbar.copyLog")}</button>
      </div>
      <pre id="ba-agent-debug-log" class="ba-agent-debug-log" aria-live="polite"></pre>
    </div>
  `;
  panelRoot.insertBefore(debugPanel, formNode);

  debugPanel.addEventListener("beforetoggle", (event) => {
    const toggleEvent = event as DetailsBeforeToggleEvent;
    if (toggleEvent.newState === "open" && !skipNextDetailsLock && !debugPanel.hidden) {
      panelRoot.dataset.debugLockHeight = String(panelRoot.offsetHeight);
    }
  });
  debugPanel.addEventListener("toggle", syncChatPanelLayout);
  debugPanel.addEventListener("toggle", () => {
    if (isPanelVisible() && renderDirty) render();
  });

  syncChatPanelLayout();

  const logNode = document.getElementById("ba-agent-debug-log");
  logEl = logNode instanceof HTMLPreElement ? logNode : null;
  const enabledToggle = document.getElementById("ba-agent-debug-enabled");
  if (enabledToggle instanceof HTMLInputElement) {
    enabledToggle.checked = localStorage.getItem(STORAGE_KEY) !== "0";
    enabledToggle.addEventListener("change", () => setEnabled(enabledToggle.checked));
  }
  document.getElementById("ba-agent-debug-clear")?.addEventListener("click", () => {
    entries.length = 0;
    renderDirty = true;
    render();
  });
  document.getElementById("ba-agent-debug-copy")?.addEventListener("click", () => {
    copyLog()
      .then(() => log("ui", t("debug.log.copied")))
      .catch(() => log("ui", t("debug.log.copyFailed")));
  });

  ["tool-start", "tool-done", "tool-error"].forEach((type) => {
    window.addEventListener(`ba-llm:${type}`, (event) => {
      log("tool-exec", type, eventDetail(event) || {});
    });
  });
  window.addEventListener("ba-llm:resource", (event) => {
    log("governor", "resource", eventDetail(event) || {});
  });

  log("ui", t("debug.log.ready"));
}

export function initLlmAgentDebug(): void {
  if (initialized) return;
  initialized = true;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel, { once: true });
  } else {
    mountPanel();
  }
}

export const llmAgentDebug: LlmAgentDebugApi = {
  enabled: localStorage.getItem(STORAGE_KEY) !== "0",
  log,
  clear,
  setEnabled,
  copyLog,
  summarizeStreamPart,
  getEntries: () => entries.slice(),
};
