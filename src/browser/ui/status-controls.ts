// @ts-nocheck
// Browser Agent v86 - 01 ui state
// Split from app.js in v9.35. Load order is defined in index.html.

function setBadge(el, text, tone = "") {
  if (!el) return;
  el.textContent = text;
  el.className = `badge ${tone}`.trim();
}

const TOOL_LOG_MAX_CHARS = 50000;

function safeTrim(text, max = TOOL_LOG_MAX_CHARS) {
  if (!text) return "";
  return text.length > max ? text.slice(text.length - max) : text;
}

function appendBoundedText(current, addition, max = TOOL_LOG_MAX_CHARS) {
  const next = String(addition ?? "");
  if (next.length >= max) return next.slice(next.length - max);
  const keepCurrent = Math.max(0, max - next.length);
  const previous = String(current ?? "");
  return `${previous.length > keepCurrent ? previous.slice(previous.length - keepCurrent) : previous}${next}`;
}

function logTool(text, { strip = true } = {}) {
  const terminal = $("terminal");
  if (!terminal) return;
  const cleanText = strip ? stripAnsi(text) : String(text ?? "");
  terminal.textContent = appendBoundedText(terminal.textContent, cleanText);
  terminal.scrollTop = terminal.scrollHeight;
}

function formatLoggedCommand(command, max = 360) {
  const text = String(command || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)} … ${tn("vm.controls.charsTruncated", text.length, "[{count} carácter]", "[{count} caracteres]")}`;
}

function syncDiskCheckButton() {
  const button = $("check-disk");
  if (!button) return;
  const hasBootDisk = Boolean(state.vm && state.activeRuntime?.hda);
  button.hidden = !hasBootDisk;
  button.disabled = !hasBootDisk || !state.vmReady || state.agentBusy || Boolean(state.pending) || Boolean(state.bgTools?.pending);
  button.textContent = state.diskMounted
    ? t("vm.controls.disk.unmount", "Desmontar disco")
    : t("vm.controls.disk.mount", "Montar disco");
  button.title = state.diskMounted
    ? t("vm.controls.disk.unmount.title", "Sincroniza y desmonta /mnt/hda. Fallará si algún proceso está usando el disco.")
    : t("vm.controls.disk.mount.title", "Monta el disco hda en /mnt/hda y comprueba lectura/escritura.");
}

function syncSnapshotButtons() {
  const saveButton = $("save-state");
  const restoreButton = $("restore-state");
  if (saveButton) saveButton.disabled = !state.vm || state.vmStarting || state.agentBusy || Boolean(state.pending) || Boolean(state.bgTools?.pending);
  if (restoreButton) restoreButton.disabled = state.vmStarting || state.agentBusy || Boolean(state.pending) || Boolean(state.bgTools?.pending);
}

function syncPowerButtons() {
  const powerButton = $("start-vm");
  const vmVisible = Boolean(state.vm || state.vmStarting);
  const vmOn = Boolean(state.vm);

  document.body.classList.toggle("vm-console-active", vmVisible);

  if (powerButton) {
    powerButton.disabled = state.vmStarting || (vmOn && (state.agentBusy || Boolean(state.pending) || Boolean(state.bgTools?.pending)));
    powerButton.textContent = state.vmStarting
      ? t("vm.controls.power.starting", "Arrancando…")
      : vmOn
        ? t("vm.controls.power.off", "Apagar VM")
        : t("vm.controls.power.on", "Arrancar VM");
    powerButton.title = vmOn
      ? t("vm.controls.power.off.title", "Apaga la VM. Se pedirá confirmación antes de perder cambios sin snapshot.")
      : t("vm.controls.power.on.title", "Arranca la VM con la configuración actual.");
    powerButton.classList.toggle("danger", vmOn);
    powerButton.classList.toggle("secondary", false);
  }
}

function isWsConnected() {
  return Boolean(state.wsSocket && state.wsSocket.readyState === WebSocket.OPEN);
}

function syncWsButton() {
  const button = $("connect-ws");
  if (!button) return;

  const connected = isWsConnected();
  button.disabled = state.wsConnecting;
  button.textContent = state.wsConnecting
    ? t("vm.controls.ws.connecting", "Conectando…")
    : connected
      ? t("common.disconnect", "Desconectar")
      : t("common.connect", "Conectar");
  button.classList.toggle("danger-light", connected);
  button.classList.toggle("secondary", connected);
  button.title = connected
    ? t("vm.controls.ws.disconnect.title", "Desconecta el proxy WebSocket local. Se pedirá confirmación.")
    : t("vm.controls.ws.connect.title", "Conecta el proxy WebSocket local wsnic.");
}

function syncChecksButton() {
  const button = $("run-checks");
  if (!button) return;
  button.disabled = Boolean(state.checksRunning || state.bgTools?.pending);
  button.textContent = state.checksRunning
    ? t("vm.controls.checks.running", "Comprobando…")
    : (state.bgTools?.pending
      ? t("vm.controls.checks.toolActive", "Herramienta activa…")
      : t("vm.controls.checks.run", "Comprobar"));
  button.setAttribute("aria-busy", state.checksRunning ? "true" : "false");
}

function blurSerialConsole() {
  const active = document.activeElement;
  if (active?.closest?.("#serial-console, .xterm, .xterm-helper-textarea")) {
    try { active.blur(); } catch {}
  }
}

function setAgentBusy(value, detail = "") {
  state.agentBusy = value;
  document.body.classList.toggle("agent-busy", value);

  const overlay = $("vm-lock-overlay");
  if (overlay) overlay.textContent = value ? (detail || t("vm.controls.agentBusy", "El agente está usando la VM…")) : "";

  const chatInput = $("chat-input");
  const chatButton = document.getElementById("chat-submit-btn");
  const commandInput = $("command-input");
  const commandButton = document.querySelector("#command-form button");

  if (chatInput) chatInput.disabled = value;
  if (chatButton) chatButton.disabled = value;
  if (commandInput) commandInput.disabled = value;
  if (commandButton) commandButton.disabled = value;

  if (value) blurSerialConsole();
  syncPowerButtons();
  syncDiskCheckButton();
  syncSnapshotButtons();
  syncWsButton();
  syncChecksButton();
  renderConsoleTabs();
  syncConsoleInputLock();

  // v9.37.8: the chat is controlled by the local LLM state, not by the
  // VM/network buttons. setAgentBusy() is used by many VM operations and it
  // can temporarily disable the input; always let the LLM agent recompute the
  // final enabled/disabled state after VM UI synchronization. This prevents
  // unrelated actions such as WS connect/disconnect from being required to
  // re-enable the chat after a model load.
  window.BA_LLM_AGENT?.updateChatAvailability?.();
}

window.addEventListener("ba:langchange", () => {
  syncDiskCheckButton();
  syncSnapshotButtons();
  syncPowerButtons();
  syncWsButton();
  syncChecksButton();
});
