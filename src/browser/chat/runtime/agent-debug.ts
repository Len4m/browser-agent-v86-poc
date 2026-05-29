// @ts-nocheck
// Browser Agent v86 - 22 Agent loop debug (visible trace for stream / tools / routing)
// Toggle from chat panel. Persists enabled flag in localStorage.

(function initLLMAgentDebug() {
  const STORAGE_KEY = "ba.llm.agentDebug.enabled";
  const MAX_LINES = 250;
  const MAX_MESSAGE_CHARS = 500;
  const MAX_DATA_CHARS = 1200;
  const entries = [];

  let logEl = null;
  let panelEl = null;
  let renderDirty = false;

  function isPanelVisible() {
    return Boolean(panelEl && !panelEl.hidden && panelEl.open);
  }

  function isEnabled() {
    return window.BA_LLM_AGENT_DEBUG?.enabled !== false
      && localStorage.getItem(STORAGE_KEY) !== "0";
  }

  function formatTime(date = new Date()) {
    return date.toLocaleTimeString("es-ES", { hour12: false, fractionalSecondDigits: 3 });
  }

  function preview(value, max = 320) {
    if (value == null) return "";
    let text = "";
    if (typeof value === "string") text = value;
    else {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  }

  function boundedText(value, max) {
    const text = String(value ?? "");
    return text.length > max ? `${text.slice(0, max)}${t("debug.charsOmitted", "… [{n} caracteres omitidos]", { n: text.length - max })}` : text;
  }

  function boundedData(value) {
    if (value == null) return null;
    return preview(value, MAX_DATA_CHARS);
  }

  function render() {
    if (!logEl) {
      renderDirty = true;
      return;
    }
    if (!isPanelVisible()) {
      renderDirty = true;
      return;
    }
    renderDirty = false;
    logEl.textContent = entries.map((e) => {
      const extra = e.data != null && e.data !== "" ? ` ${e.data}` : "";
      return `${e.time} [${e.category}] ${e.message}${extra}`;
    }).join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }

  function log(category, message, data = null) {
    if (!isEnabled()) return;
    const entry = {
      time: formatTime(),
      category: String(category || "info"),
      message: boundedText(message || "", MAX_MESSAGE_CHARS),
      data: boundedData(data),
    };
    entries.push(entry);
    while (entries.length > MAX_LINES) entries.shift();
    render();
    try {
      window.BA_LLM_EVENTS?.emit("agent-debug", entry);
    } catch { /* ignore */ }
  }

  function clear() {
    entries.length = 0;
    render();
    log("ui", t("debug.log.cleared", "Log limpiado"));
  }

  function setEnabled(value) {
    window.BA_LLM_AGENT_DEBUG.enabled = Boolean(value);
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
    const toggle = document.getElementById("ba-agent-debug-enabled");
    if (toggle) toggle.checked = Boolean(value);
    log("ui", value ? t("debug.log.enabled", "Registro activado") : t("debug.log.paused", "Registro pausado (no se añaden líneas nuevas)"));
  }

  function copyLog() {
    const text = entries.map((e) => {
      const extra = e.data != null ? ` ${e.data}` : "";
      return `${e.time} [${e.category}] ${e.message}${extra}`;
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

  function summarizeStreamPart(part) {
    if (!part || !part.type) return part;
    const type = part.type;
    if (type === "text-delta" || type === "reasoning-delta") {
      const chunk = part.text ?? part.textDelta ?? part.delta ?? "";
      return { type, len: chunk.length, sample: chunk.slice(0, 100) };
    }
    if (type === "tool-call" || type === "tool-input-available") {
      return {
        type,
        toolName: part.toolName ?? part.toolCallId ?? part.name,
        input: preview(part.input ?? part.args ?? part.arguments, 160),
      };
    }
    if (type === "tool-result" || type === "tool-output-available") {
      return { type, toolCallId: part.toolCallId, output: preview(part.output ?? part.result, 120) };
    }
    if (type === "tool-error" || type === "tool-output-error") {
      return { type, error: preview(part.error ?? part.message, 160) };
    }
    return { type, keys: Object.keys(part).slice(0, 8) };
  }

  function mountPanel() {
    const chatPanel = document.querySelector(".workspace-grid > .panel:first-child");
    const chatForm = document.getElementById("chat-form");
    const chatLog = document.getElementById("chat-log");
    if (!chatPanel || !chatForm || document.getElementById("ba-agent-debug-panel")) return;

    let skipNextDetailsLock = false;
    let chatLogObserver = null;

    function stopChatLogObserver() {
      chatLogObserver?.disconnect();
      chatLogObserver = null;
    }

    function startChatLogObserver() {
      if (!chatLog || chatLogObserver) return;
      chatLogObserver = new MutationObserver(() => syncChatPanelLayout());
      chatLogObserver.observe(chatLog, { childList: true });
    }

    function clearChatPanelDebugLayout() {
      chatPanel.style.minHeight = "";
      chatPanel.style.height = "";
      chatPanel.style.maxHeight = "";
      chatPanel.classList.remove("ba-chat-panel-debug-open");
      delete chatPanel.dataset.debugLockHeight;
    }

    function applyChatPanelDebugLock() {
      const lock = Number(chatPanel.dataset.debugLockHeight);
      if (!Number.isFinite(lock) || lock <= 0) return;
      chatPanel.style.height = `${lock}px`;
      chatPanel.style.minHeight = `${lock}px`;
      chatPanel.style.maxHeight = `${lock}px`;
    }

    function syncChatPanelLayout() {
      if (panelEl.hidden || !panelEl.open) {
        stopChatLogObserver();
        clearChatPanelDebugLayout();
        return;
      }

      startChatLogObserver();
      chatPanel.classList.add("ba-chat-panel-debug-open");
      requestAnimationFrame(() => {
        if (panelEl.hidden || !panelEl.open) return;
        applyChatPanelDebugLock();
      });
    }

    const actions = document.querySelector(".chat-title-actions");
    if (actions && !document.getElementById("ba-agent-debug-toggle")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.id = "ba-agent-debug-toggle";
      btn.className = "chat-clear-btn ba-agent-debug-toggle";
      btn.textContent = t("debug.toggle.label", "Debug");
      btn.title = t("debug.toggle.title", "Mostrar/ocultar trazas del agente (stream, tools, routing)");
      btn.setAttribute("aria-pressed", "false");
      actions.insertBefore(btn, actions.firstChild);
      btn.addEventListener("click", () => {
        const panel = document.getElementById("ba-agent-debug-panel");
        if (!panel) return;
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

    panelEl = document.createElement("details");
    panelEl.id = "ba-agent-debug-panel";
    panelEl.className = "ba-agent-debug-panel";
    panelEl.hidden = true;
    panelEl.innerHTML = `
      <summary class="ba-agent-debug-summary">${t("debug.panel.summary", "Debug agente · stream / tools / routing")}</summary>
      <div class="ba-agent-debug-body">
        <div class="ba-agent-debug-toolbar">
          <label class="ba-agent-debug-enable">
            <input type="checkbox" id="ba-agent-debug-enabled" checked />
            ${t("debug.toolbar.enable", "Registrar")}
          </label>
          <button type="button" id="ba-agent-debug-clear" class="secondary">${t("common.clear", "Limpiar")}</button>
          <button type="button" id="ba-agent-debug-copy" class="secondary">${t("debug.toolbar.copyLog", "Copiar log")}</button>
        </div>
        <pre id="ba-agent-debug-log" class="ba-agent-debug-log" aria-live="polite"></pre>
      </div>
    `;
    chatPanel.insertBefore(panelEl, chatForm);

    panelEl.addEventListener("beforetoggle", (event) => {
      if (event.newState === "open" && !skipNextDetailsLock && !panelEl.hidden) {
        chatPanel.dataset.debugLockHeight = String(chatPanel.offsetHeight);
      }
    });
    panelEl.addEventListener("toggle", syncChatPanelLayout);
    panelEl.addEventListener("toggle", () => {
      if (isPanelVisible() && renderDirty) render();
    });

    syncChatPanelLayout();

    logEl = document.getElementById("ba-agent-debug-log");
    const enabledToggle = document.getElementById("ba-agent-debug-enabled");
    enabledToggle.checked = localStorage.getItem(STORAGE_KEY) !== "0";
    enabledToggle.addEventListener("change", () => setEnabled(enabledToggle.checked));
    document.getElementById("ba-agent-debug-clear")?.addEventListener("click", () => {
      entries.length = 0;
      renderDirty = true;
      render();
    });
    document.getElementById("ba-agent-debug-copy")?.addEventListener("click", () => {
      copyLog().then(() => log("ui", t("debug.log.copied", "Log copiado al portapapeles"))).catch(() => log("ui", t("debug.log.copyFailed", "No se pudo copiar el log")));
    });

    ["tool-start", "tool-done", "tool-error"].forEach((type) => {
      window.addEventListener(`ba-llm:${type}`, (event) => {
        log("tool-exec", type, event.detail || {});
      });
    });
    window.addEventListener("ba-llm:resource", (event) => {
      log("governor", "resource", event.detail || {});
    });

    log("ui", t("debug.log.ready", "Panel debug listo. Activa tools, envía mensajes y observa [stream], [route], [tool]."));
  }

  window.BA_LLM_AGENT_DEBUG = {
    enabled: localStorage.getItem(STORAGE_KEY) !== "0",
    log,
    clear,
    setEnabled,
    copyLog,
    summarizeStreamPart,
    getEntries: () => entries.slice(),
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel, { once: true });
  } else {
    mountPanel();
  }
})();
