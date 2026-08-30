// Browser Agent v86 - shared UI state controls.

import { $, state } from "../app/state";
import { t, tn } from "../app/i18n";
import { stripAnsi } from "../app/text-utils";
import { appEvents } from "../core/events";

const TOOL_LOG_MAX_CHARS = 50000;

function setDisabled(el: Element | null, disabled: boolean): void {
  if (
    el instanceof HTMLButtonElement
    || el instanceof HTMLInputElement
    || el instanceof HTMLSelectElement
    || el instanceof HTMLTextAreaElement
  ) {
    el.disabled = disabled;
  }
}

function activeRuntimeHasHda(): boolean {
  const runtime = state.activeRuntime;
  return Boolean(runtime && typeof runtime === "object" && "hda" in runtime && (runtime as { hda?: unknown }).hda);
}

export function setBadge(el: Element | null, text: string, tone = ""): void {
  if (!el) return;
  el.textContent = text;
  el.className = `badge ${tone}`.trim();
}

export function safeTrim(text: string, max = TOOL_LOG_MAX_CHARS): string {
  if (!text) return "";
  return text.length > max ? text.slice(text.length - max) : text;
}

function appendBoundedText(current: string, addition: string, max = TOOL_LOG_MAX_CHARS): string {
  const next = addition;
  if (next.length >= max) return next.slice(next.length - max);
  const keepCurrent = Math.max(0, max - next.length);
  const previous = current;
  return `${previous.length > keepCurrent ? previous.slice(previous.length - keepCurrent) : previous}${next}`;
}

export function logTool(text: string, { strip = true }: { strip?: boolean } = {}): void {
  const terminal = $("terminal");
  if (!terminal) return;
  const cleanText = strip ? stripAnsi(text) : text;
  terminal.textContent = appendBoundedText(terminal.textContent || "", cleanText);
  terminal.scrollTop = terminal.scrollHeight;
}

export function formatLoggedCommand(command: string, max = 360): string {
  const text = command.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)} … ${tn("vm.controls.charsTruncated", text.length)}`;
}

export function syncDiskCheckButton(): void {
  const button = $("check-disk");
  if (!button) return;
  const hasBootDisk = Boolean(state.vm && activeRuntimeHasHda());
  button.hidden = !hasBootDisk;
  setDisabled(button, !hasBootDisk || !state.vmReady || state.agentBusy || Boolean(state.pending) || Boolean(state.bgTools.pending));
  button.textContent = state.diskMounted
    ? t("vm.controls.disk.unmount")
    : t("vm.controls.disk.mount");
  button.title = state.diskMounted
    ? t("vm.controls.disk.unmount.title")
    : t("vm.controls.disk.mount.title");
}

export function syncSnapshotButtons(): void {
  setDisabled($("save-state"), !state.vm || state.vmStarting || state.agentBusy || Boolean(state.pending) || Boolean(state.bgTools.pending));
  setDisabled($("restore-state"), state.vmStarting || state.agentBusy || Boolean(state.pending) || Boolean(state.bgTools.pending));
}

export function syncPowerButtons(): void {
  const powerButton = $("start-vm");
  const vmVisible = Boolean(state.vm || state.vmStarting);
  const vmOn = Boolean(state.vm);

  document.body.classList.toggle("vm-console-active", vmVisible);

  if (powerButton) {
    setDisabled(powerButton, state.vmStarting || (vmOn && (state.agentBusy || Boolean(state.pending) || Boolean(state.bgTools.pending))));
    powerButton.textContent = state.vmStarting
      ? t("vm.controls.power.starting")
      : vmOn
        ? t("common.shutdownVm")
        : t("vm.controls.power.on");
    powerButton.title = vmOn
      ? t("vm.controls.power.off.title")
      : t("vm.controls.power.on.title");
    powerButton.classList.toggle("danger", vmOn);
    powerButton.classList.toggle("secondary", false);
  }
}

export function isWsConnected(): boolean {
  return Boolean(state.wsSocket && state.wsSocket.readyState === WebSocket.OPEN);
}

export function syncWsButton(): void {
  const button = $("connect-ws");
  if (!button) return;

  const connected = isWsConnected() || Boolean(state.wsRetryTimer);
  setDisabled(button, state.wsConnecting);
  button.textContent = state.wsConnecting
    ? t("common.connectingEllipsis")
    : connected
      ? t("common.disconnect")
      : t("common.connect");
  button.classList.toggle("danger-light", connected);
  button.classList.toggle("secondary", connected);
  button.title = connected
    ? t("vm.controls.ws.disconnect.title")
    : t("vm.controls.ws.connect.title");
}

export function syncChecksButton(): void {
  const button = $("run-checks");
  if (!button) return;
  setDisabled(button, Boolean(state.checksRunning || state.bgTools.pending));
  button.textContent = state.checksRunning
    ? t("common.checkingEllipsis")
    : (state.bgTools.pending
      ? t("vm.controls.checks.toolActive")
      : t("common.runChecks"));
  button.setAttribute("aria-busy", state.checksRunning ? "true" : "false");
}

export function blurSerialConsole(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest("#serial-console, .xterm, .xterm-helper-textarea")) {
    try {
      active.blur();
    } catch {
      // Focus changes are best-effort.
    }
  }
}

export function setAgentBusy(value: boolean, detail = ""): void {
  state.agentBusy = value;
  document.body.classList.toggle("agent-busy", value);

  const overlay = $("vm-lock-overlay");
  if (overlay) overlay.textContent = value ? (detail || t("common.agentUsingVm")) : "";

  setDisabled($("chat-input"), value);
  setDisabled(document.getElementById("chat-submit-btn"), value);
  setDisabled($("command-input"), value);
  setDisabled(document.querySelector("#command-form button"), value);

  if (value) blurSerialConsole();
  syncPowerButtons();
  syncDiskCheckButton();
  syncSnapshotButtons();
  syncWsButton();
  syncChecksButton();

  appEvents.emit("console:state-changed", { source: "status-controls" });

  // v9.37.8: the chat is controlled by the local LLM state, not by the
  // VM/network buttons. setAgentBusy() is used by many VM operations and it
  // can temporarily disable the input; always let the LLM agent recompute the
  // final enabled/disabled state after VM UI synchronization. This prevents
  // unrelated actions such as WS connect/disconnect from being required to
  // re-enable the chat after a model load.
  appEvents.emit("llm:availability-refresh-requested", { source: "status-controls" });
}

export function initStatusControls(): void {
  appEvents.on("app:language-changed", () => {
    syncDiskCheckButton();
    syncSnapshotButtons();
    syncPowerButtons();
    syncWsButton();
    syncChecksButton();
  });
}
