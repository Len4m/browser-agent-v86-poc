// @ts-nocheck
// Browser Agent v86 - 09 bootstrap layout
// Split from app.js in v9.35. Load order is defined in index.html.
// v9.37.20: header GPU badge delegates to the shared LLM capability service.

const CHAT_LAYOUT_STORAGE_KEY = "ba.chatExpanded";

function setChatExpanded(expanded, { persist = true } = {}) {
  const enabled = Boolean(expanded);
  document.body.classList.toggle("chat-expanded", enabled);
  const button = $("chat-layout-toggle");
  if (button) {
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.setAttribute("aria-label", enabled ? "Vista dividida" : "Ampliar chat");
    button.textContent = "";
    button.title = enabled
      ? "Vista dividida: volver a chat y VM en paralelo"
      : "Ampliar chat: usar todo el ancho y mover la VM debajo";
  }
  if (persist) {
    try { window.localStorage?.setItem(CHAT_LAYOUT_STORAGE_KEY, enabled ? "1" : "0"); } catch (_) {}
  }
}

function initChatLayoutToggle() {
  const button = $("chat-layout-toggle");
  if (!button) return;
  let initial = false;
  try { initial = window.localStorage?.getItem(CHAT_LAYOUT_STORAGE_KEY) === "1"; } catch (_) {}
  setChatExpanded(initial, { persist: false });
  button.addEventListener("click", () => {
    setChatExpanded(!document.body.classList.contains("chat-expanded"));
    scheduleSerialFit?.();
  });
}

function enhanceInterface() {
  document.body.classList.add("xterm-direct-console-mode-pending");

  if (!$('loading-overlay')) {
    const overlay = document.createElement("div");
    overlay.id = "loading-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="loading-card" role="status" aria-live="polite">
        <div class="loading-head">
          <div class="loading-spinner"></div>
          <div id="loading-title">Cargando</div>
        </div>
        <div id="loading-detail"></div>
        <div class="loading-progress"><div id="loading-bar"></div></div>
        <div id="loading-percent"></div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  if (!$("ba-modal-overlay")) {
    const modal = document.createElement("div");
    modal.id = "ba-modal-overlay";
    modal.className = "ba-modal-overlay";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="ba-modal-card" role="dialog" aria-modal="true" aria-labelledby="ba-modal-title">
        <div class="ba-modal-icon">!</div>
        <div class="ba-modal-content">
          <h3 id="ba-modal-title">Confirmar acción</h3>
          <p id="ba-modal-message"></p>
          <p id="ba-modal-detail" class="ba-modal-detail" hidden></p>
          <div id="ba-modal-body" class="ba-modal-body" hidden></div>
          <div id="ba-modal-actions" class="ba-modal-actions"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  const terminal = $("terminal");
  const screen = $("screen-container");
  const vmPanel = terminal?.closest(".panel");
  const toolbar = vmPanel?.querySelector(".toolbar");

  const serialConsole = $("serial-console");
  const serialTextarea = $("serial-textarea");
  if (screen) {
    screen.classList.add("hidden-vga");
  }
  if ((serialConsole || serialTextarea) && toolbar) {
    const tabs = document.createElement("div");
    tabs.id = "console-tabs";
    tabs.className = "console-tabs";
    tabs.innerHTML = `
      <div id="console-tabs-list" class="console-tabs-list"></div>
      <div class="console-tabs-actions">
        <button id="new-console" type="button" class="secondary console-action-btn new-console-btn" aria-label="Nueva consola" title="Crear una consola xterm nueva (máximo 4)"></button>
        <button id="redraw-console" type="button" class="secondary console-action-btn redraw-console-btn" aria-label="Refrescar consola" title="Limpiar la consola activa y enviar Ctrl+L"></button>
        <button id="close-console" type="button" class="secondary danger-light console-action-btn close-console-btn" aria-label="Cerrar consola" title="Cerrar la consola activa"></button>
        <button id="console-help" type="button" class="secondary console-action-btn console-help-btn" aria-label="Ayuda consola" title="Consolas xterm, PTYs y tools en background"></button>
        <button id="cancel-tool" type="button" class="secondary danger-light" disabled>Cancelar tool</button>
        <span id="console-tabs-status" class="badge">sin consola</span>
      </div>
    `;
    toolbar.after(tabs);

    const wrap = document.createElement("div");
    wrap.className = "vm-screen-wrap";
    tabs.after(wrap);

    const frame = document.createElement("div");
    frame.className = "vm-console-frame";
    const shell = document.createElement("div");
    shell.id = "vm-console-shell";
    shell.className = "vm-console-shell";
    frame.appendChild(shell);
    wrap.appendChild(frame);

    if (serialConsole) {
      serialConsole.classList.add("serial-screen");
      shell.appendChild(serialConsole);
    }
    if (serialTextarea) {
      serialTextarea.classList.add("serial-screen");
      // Only show the fallback textarea when xterm.js is not available.
      // With xterm.js enabled, showing it creates a second fake console.
      serialTextarea.hidden = Boolean(window.Terminal);
      shell.appendChild(serialTextarea);
    }

    const overlay = document.createElement("div");
    overlay.id = "vm-lock-overlay";
    shell.appendChild(overlay);
  }

  if (terminal && vmPanel) {
    terminal.className = "terminal tool-log";
    terminal.textContent = "Log de tools. Las consolas interactivas son las pestañas xterm superiores.\n";

    const details = document.createElement("details");
    details.className = "tool-log-details";
    const summary = document.createElement("summary");
    summary.textContent = "Log de tools y ejecución manual";
    terminal.parentNode.insertBefore(details, terminal);
    details.appendChild(summary);
    details.appendChild(terminal);

    // El formulario manual de ejecución pertenece al mismo bloque que el log.
    // Movemos el nodo existente para conservar IDs y listeners posteriores.
    const commandForm = document.getElementById("command-form");
    if (commandForm) {
      commandForm.classList.add("tool-log-command-form");
      details.appendChild(commandForm);
    }
  }

  const commandButton = document.querySelector("#command-form button");
  if (commandButton) {
    commandButton.textContent = "Tool";
    commandButton.classList.add("manual-tool-btn");
    commandButton.title = commandButton.title || "Ejecutar comando en la VM por serial1/ttyS1 sin bloquear la consola del usuario";
  }


  window.BA_BG_TOOLS?.mountUi?.();

  window.addEventListener("resize", () => scheduleSerialFit());
}

function init() {
  enhanceInterface();
  initChatLayoutToggle();
  // The global GPU/WASM badge is now driven by the same capability service
  // used by the LLM panel/model selector. This avoids the old mismatch where
  // the page header only checked navigator.gpu while the LLM panel checked the
  // real GPUAdapter/features such as shader-f16.
  window.BA_syncLLMCapabilityBadges?.(window.BA_LLM?.capabilities || null, "ready");
  window.BA_ensureLLMCapabilities?.({ source: "startup" }).catch((error) => {
    console.warn("[llm-capabilities] startup check failed", error);
  });
  addMessage("agent", "Pídeme comandos simples para la VM.");
  loadProfiles();
  renderConsoleTabs();

  $("console-help")?.addEventListener("click", showConsoleHelpModal);
  $("cancel-tool")?.addEventListener("click", cancelCurrentTool);
  $("new-console")?.addEventListener("click", createHumanConsoleTab);
  $("redraw-console")?.addEventListener("click", redrawActiveConsoleScreen);
  $("close-console")?.addEventListener("click", () => closeHumanConsoleTab(getActiveConsoleTab()?.id));
  $("start-vm").addEventListener("click", toggleVmPower);
  $("save-state")?.addEventListener("click", saveSnapshot);
  $("restore-state")?.addEventListener("click", openRestoreSnapshotPicker);
  $("restore-state-file")?.addEventListener("change", restoreSnapshotFromFile);
  $("check-disk")?.addEventListener("click", toggleDiskInVm);
  $("run-checks").addEventListener("click", runChecks);
  $("connect-ws").addEventListener("click", connectWs);
  $("copy-docker-command")?.addEventListener("click", copyDockerCommand);
  $("copy-docker-stop-command")?.addEventListener("click", copyDockerCommand);
  $("vm-profile")?.addEventListener("change", () => {
    state.assetBuffers = null;
    state.assetCacheKey = "";
    updateProfileHint({ applyDefaults: true });
    updateDiskHint();
    runChecks();
  });
  $("vm-ram-mb")?.addEventListener("change", () => { state.assetBuffers = null; state.assetCacheKey = ""; });
  $("vm-vram-mb")?.addEventListener("change", () => { state.assetBuffers = null; state.assetCacheKey = ""; });
  $("vm-disk")?.addEventListener("change", () => { updateDiskHint(); syncDiskCheckButton(); });
  updateDiskHint();
  window.BA_ORIGIN?.syncWarnings?.();
  syncPowerButtons();
  syncDiskCheckButton();
  syncSnapshotButtons();
  syncWsButton();
  syncChecksButton();
  $("command-form").addEventListener("submit", runCommandFromInput);
  $("chat-form").addEventListener("submit", sendChat);
  initChatInputKeys();

  window.setTimeout(() => runChecks({ probeWsRelay: false }), 400);
}

function initChatInputKeys() {
  const input = $("chat-input");
  if (!input || input.dataset.chatKeysBound === "1") return;
  input.dataset.chatKeysBound = "1";
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    $("chat-form")?.requestSubmit?.();
  });
}

init();
