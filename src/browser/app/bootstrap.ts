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
    button.setAttribute("aria-label", enabled
      ? t("app.chatToggle.collapse.aria", "Vista dividida")
      : t("app.chatToggle.expand.aria", "Ampliar chat"));
    button.textContent = "";
    button.title = enabled
      ? t("app.chatToggle.collapse.title", "Vista dividida: volver a chat y VM en paralelo")
      : t("app.chatToggle.expand.title", "Ampliar chat: usar todo el ancho y mover la VM debajo");
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

  const terminal = $("terminal");
  const screen = $("screen-container");
  const vmPanel = terminal?.closest(".panel");

  const serialConsole = $("serial-console");
  if (screen) {
    screen.classList.add("hidden-vga");
  }
  if (serialConsole) {
    serialConsole.classList.add("serial-screen");
  }

  if (terminal && vmPanel) {
    terminal.className = "terminal tool-log";
    terminal.textContent = t("app.toolLog.intro", "Log de tools. Las consolas interactivas son las pestañas xterm superiores.") + "\n";

    const details = document.createElement("details");
    details.className = "tool-log-details";
    const summary = document.createElement("summary");
    summary.textContent = t("app.toolLog.summary", "Log de tools y ejecución manual");
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
    commandButton.textContent = t("common.tool", "Tool");
    commandButton.classList.add("manual-tool-btn");
    commandButton.title = commandButton.title || t("app.manualTool.title", "Ejecutar comando en la VM por serial1/ttyS1 sin bloquear la consola del usuario");
  }

  window.BA_BG_TOOLS?.mountUi?.();

  window.addEventListener("resize", () => scheduleSerialFit());
}

function applyDockerCopyLabels() {
  const pairs = [
    { id: "copy-docker-command", action: t("common.dockerAction.start", "abrir") },
    { id: "copy-docker-stop-command", action: t("common.dockerAction.stop", "cerrar") },
  ];
  for (const { id, action } of pairs) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.setAttribute("aria-label", t("common.copyDockerAria", "Copiar comando para {action} el proxy Docker", { action }));
    btn.setAttribute("title", t("common.copyDockerTitle", "Copiar comando para {action}", { action }));
  }
}

function init() {
  enhanceInterface();
  applyDockerCopyLabels();
  initChatLayoutToggle();
  window.addEventListener("ba:langchange", () => {
    setChatExpanded(document.body.classList.contains("chat-expanded"), { persist: false });
    applyDockerCopyLabels();
  });
  // The global GPU/WASM badge is now driven by the same capability service
  // used by the LLM panel/model selector. This avoids the old mismatch where
  // the page header only checked navigator.gpu while the LLM panel checked the
  // real GPUAdapter/features such as shader-f16.
  window.BA_syncLLMCapabilityBadges?.(window.BA_LLM?.capabilities || null, "ready");
  window.BA_ensureLLMCapabilities?.({ source: "startup" }).catch((error) => {
    console.warn("[llm-capabilities] startup check failed", error);
  });
  const welcomeMessage = addMessage("agent", t("app.chat.welcome", "Pídeme comandos simples para la VM."));
  welcomeMessage?.querySelector?.(".bubble")?.setAttribute("data-i18n", "app.chat.welcome");
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
