// Browser Agent v86 - wsnic endpoint and in-VM network operations.

import {
  $,
  DOCKER_WSNIC_COMMAND,
  DOCKER_WSNIC_ISOLATED_COMMAND,
  NL,
  VM_NETWORK_COMMAND,
  state,
} from "../app/state";
import { t } from "../app/i18n";
import { isPublishedOrigin } from "../app/origin-awareness";
import { errorMessage } from "../app/value-utils";
import { showBaModal } from "../ui/modal";
import {
  isWsConnected,
  logTool,
  setBadge,
  syncWsButton,
} from "../ui/status-controls";
import { getWsRelayUrl } from "./profile-config";
import {
  checkWsRelayEndpoint,
  wsValidationErrorDetail,
} from "./runtime-assets";
import { execVm } from "./exec-vm";
import {
  getWsRetryDelay,
  PUBLIC_RELAY_URL,
  urlForWsPreset,
  validateWsUrl,
  type WsPreset,
} from "./ws-network-config";

async function configureNetworkInVm(): Promise<void> {
  if (state.networkConfiguring || state.networkConfigured) return;

  if (!state.vm || !state.vmReady) {
    logTool(`${NL}[network] ${t("net.wsnicReadyWillConfig")}${NL}`);
    return;
  }

  if (state.pending || state.agentBusy) {
    window.setTimeout(() => {
      void configureNetworkInVm();
    }, 450);
    return;
  }

  state.networkConfiguring = true;
  logTool(`${NL}[network] ${t("net.configuringAuto")}${NL}`);
  const result = await execVm(VM_NETWORK_COMMAND, {
    lock: true,
    label: t("net.configuringLabel"),
    timeoutMs: 60000,
  });

  if (result.stdout) logTool(`${NL}${result.stdout}${NL}`);
  if (result.stderr) logTool(`${NL}[network stderr] ${result.stderr}${NL}`);

  const isolatedLocal = $<HTMLSelectElement>("ws-preset")?.value === "local-ws"
    && $<HTMLInputElement>("ws-enable-internet")?.checked === false;
  const ok = result.stdout.includes("DHCP_OK")
    && (isolatedLocal || (result.stdout.includes("DNS_UDP_OK") && result.stdout.includes("TCP_OK")));
  state.networkConfigured = ok;
  state.networkConfiguring = false;

  if (ok) {
    if (isolatedLocal) {
      setBadge($("ws-detail"), t("net.badge.isolatedVm"), "good");
      logTool(`[network] ${t("net.isolatedVerified")}${NL}`);
    } else {
      setBadge($("ws-detail"), t("net.badge.connectedVm"), "good");
      logTool(`[network] ${t("net.connectionVerified")}${NL}`);
    }
  } else {
    setBadge($("ws-detail"), t("net.badge.wsnicOkNoNet"), "warn");
    logTool(`[network] ${t("net.wsnicRespondsNotConfigured")}${NL}`);
  }
}

export function maybeConfigureNetwork(): void {
  if (!state.networkAutoRequested || state.networkConfigured || state.networkConfiguring) return;
  void configureNetworkInVm();
}

export function syncWsEndpointControls(): void {
  const input = $<HTMLInputElement>("ws-url");
  const preset = $<HTMLSelectElement>("ws-preset");
  const url = input?.value.trim() || "";
  const selected = (preset?.value || "local-ws") as WsPreset;
  const publicWarning = $("ws-public-warning");
  const customNote = $("ws-custom-note");
  const certCheck = $<HTMLAnchorElement>("ws-cert-check");
  const localHelp = $("ws-local-help");
  const internetAccess = $<HTMLInputElement>("ws-enable-internet");
  const dockerCommand = $("docker-command");
  if (input) {
    input.readOnly = selected !== "custom";
    if (selected === "custom") input.dataset.customUrl = input.value;
  }
  if (publicWarning) publicWarning.hidden = selected !== "public-relay";
  if (customNote) customNote.hidden = selected !== "custom";
  if (localHelp) localHelp.hidden = selected !== "local-ws";
  if (dockerCommand) {
    dockerCommand.textContent = internetAccess?.checked === false
      ? DOCKER_WSNIC_ISOLATED_COMMAND
      : DOCKER_WSNIC_COMMAND;
  }
  const validation = validateWsUrl(url);
  if (certCheck) {
    const showCertificate = validation.ok && validation.url.startsWith("wss://");
    certCheck.hidden = !showCertificate;
    if (showCertificate) certCheck.href = `https://${new URL(validation.url).host}/`;
  }
}

export function selectWsPreset(): void {
  const select = $<HTMLSelectElement>("ws-preset");
  const input = $<HTMLInputElement>("ws-url");
  if (!select || !input) return;
  const selected = select.value as WsPreset;
  if (selected === "custom") {
    input.value = input.dataset.customUrl || "";
  } else {
    if (!input.readOnly) input.dataset.customUrl = input.value;
    input.value = urlForWsPreset(selected);
  }
  syncWsEndpointControls();
}

export async function testWsEndpoint(): Promise<void> {
  const button = $<HTMLButtonElement>("test-ws");
  if (button) button.disabled = true;
  setBadge($("ws-detail"), t("ws.test.testing"), "warn");
  try {
    const result = await checkWsRelayEndpoint(getWsRelayUrl(), 6000);
    setBadge($("ws-detail"), result.detail, result.ok ? "good" : "bad");
  } finally {
    if (button) button.disabled = false;
  }
}

function clearWsRetry(resetAttempt = true): void {
  if (state.wsRetryTimer) window.clearTimeout(state.wsRetryTimer);
  state.wsRetryTimer = 0;
  if (resetAttempt) state.wsRetryAttempt = 0;
}

function scheduleWsReconnect(url: string): void {
  if (state.wsManualDisconnect || state.wsRetryTimer) return;
  const maxAttempts = 6;
  if (state.wsRetryAttempt >= maxAttempts) {
    setBadge($("badge-ws"), t("ws.badge.error"), "bad");
    setBadge($("ws-detail"), t("ws.reconnect.exhausted"), "bad");
    syncWsButton();
    return;
  }

  const attempt = state.wsRetryAttempt + 1;
  const delay = getWsRetryDelay(state.wsRetryAttempt);
  state.wsRetryAttempt = attempt;
  setBadge($("badge-ws"), t("ws.badge.reconnecting"), "warn");
  setBadge($("ws-detail"), t("ws.reconnect.scheduled", {
    attempt,
    max: maxAttempts,
    seconds: Math.max(1, Math.round(delay / 1000)),
  }), "warn");
  state.wsRetryTimer = window.setTimeout(() => {
    state.wsRetryTimer = 0;
    const current = validateWsUrl(getWsRelayUrl(), window.location.protocol);
    if (state.wsManualDisconnect || !current.ok || current.url !== url) return;
    if (!navigator.onLine) {
      state.wsRetryAttempt -= 1;
      setBadge($("ws-detail"), t("ws.reconnect.offline"), "warn");
      scheduleWsReconnect(url);
      return;
    }
    void openWs(url);
  }, delay);
  syncWsButton();
}

async function confirmWsDisconnect(): Promise<boolean> {
  const result = await showBaModal({
    title: t("ws.disconnect.title"),
    message: t("ws.disconnect.message"),
    detail: t("ws.disconnect.detail"),
    buttons: [
      { id: "cancel", label: t("common.cancel"), variant: "secondary", cancel: true },
      { id: "disconnect", label: t("common.disconnect"), variant: "danger" },
    ],
  });
  return result === "disconnect";
}

async function disconnectWs({ confirmDisconnect = true }: { confirmDisconnect?: boolean } = {}): Promise<void> {
  if (!state.wsSocket && !state.wsConnecting && !state.wsRetryTimer) {
    state.wsManualDisconnect = true;
    clearWsRetry();
    state.networkAutoRequested = false;
    state.networkConfigured = false;
    state.networkConfiguring = false;
    setBadge($("badge-ws"), t("ws.badge.disconnected"), "");
    setBadge($("ws-detail"), t("common.disconnected"), "");
    syncWsButton();
    return;
  }

  if (confirmDisconnect) {
    const ok = await confirmWsDisconnect();
    if (!ok) return;
  }

  const socket = state.wsSocket;
  state.wsManualDisconnect = true;
  clearWsRetry();
  state.wsSocket = null;
  state.wsConnecting = false;
  state.networkAutoRequested = false;
  state.networkConfigured = false;
  state.networkConfiguring = false;

  try {
    socket?.close();
  } catch {
    // Closing a WebSocket is best-effort.
  }

  setBadge($("badge-ws"), t("ws.badge.disconnected"), "");
  setBadge($("ws-detail"), t("common.disconnected"), "");
  logTool(`${NL}[host] ${t("ws.host.disconnected")}${NL}`);
  syncWsButton();
}

function openWs(url: string): void {
  if (isPublishedOrigin()) {
    logTool(`${NL}[network] ${t("net.localPermissionNotice", { url })}${NL}`);
  }
  if (!window.WebSocket) {
    setBadge($("badge-ws"), t("ws.badge.error"), "bad");
    setBadge($("ws-detail"), t("common.unavailable"), "bad");
    syncWsButton();
    return;
  }

  state.wsConnecting = true;
  syncWsButton();
  setBadge($("badge-ws"), t("ws.badge.connecting"), "warn");
  setBadge($("ws-detail"), t("common.connectingLower"), "warn");

  try {
    const socket = new WebSocket(url);
    let retryScheduled = false;
    const retry = (): void => {
      if (retryScheduled) return;
      retryScheduled = true;
      scheduleWsReconnect(url);
    };
    const timeout = window.setTimeout(() => {
      if (state.wsSocket === socket) state.wsSocket = null;
      state.wsConnecting = false;
      try {
        socket.close();
      } catch {
        // Closing a timed-out probe socket is best-effort.
      }
      setBadge($("badge-ws"), t("ws.badge.error"), "bad");
      setBadge($("ws-detail"), t("common.noResponse"), "warn");
      syncWsButton();
      retry();
    }, 6000);

    socket.onopen = (): void => {
      window.clearTimeout(timeout);
      clearWsRetry();
      state.wsSocket = socket;
      state.wsConnecting = false;
      state.wsManualDisconnect = false;
      state.networkAutoRequested = true;
      state.networkConfigured = false;
      setBadge($("badge-ws"), t("ws.badge.connected"), "good");
      setBadge($("ws-detail"), t("common.connected"), "good");
      logTool(`${NL}[host] ${t("ws.host.connected", { url })}${NL}`);
      syncWsButton();
      maybeConfigureNetwork();
    };
    socket.onerror = (): void => {
      window.clearTimeout(timeout);
      if (state.wsSocket === socket) state.wsSocket = null;
      state.wsConnecting = false;
      setBadge($("badge-ws"), t("ws.badge.error"), "bad");
      setBadge($("ws-detail"), url.startsWith("wss://") ? t("ws.error.tlsProbable") : t("common.cannotConnect"), "bad");
      syncWsButton();
      retry();
    };
    socket.onclose = (): void => {
      window.clearTimeout(timeout);
      if (state.wsSocket === socket) state.wsSocket = null;
      state.wsConnecting = false;
      state.networkAutoRequested = false;
      state.networkConfigured = false;
      state.networkConfiguring = false;
      if (state.wsManualDisconnect) {
        setBadge($("badge-ws"), t("ws.badge.disconnected"), "");
        setBadge($("ws-detail"), t("common.closed"), "");
        syncWsButton();
      } else {
        retry();
      }
    };
  } catch (error) {
    state.wsConnecting = false;
    setBadge($("badge-ws"), t("ws.badge.error"), "bad");
    setBadge($("ws-detail"), errorMessage(error), "bad");
    syncWsButton();
    scheduleWsReconnect(url);
  }
}

async function confirmPublicRelay(): Promise<boolean> {
  const result = await showBaModal({
    title: t("ws.publicRelay.title"),
    message: t("ws.publicRelay.message"),
    detail: t("ws.publicRelay.detail"),
    buttons: [
      { id: "cancel", label: t("common.cancel"), variant: "secondary", cancel: true },
      { id: "connect", label: t("common.connect"), variant: "primary" },
    ],
  });
  return result === "connect";
}

export async function connectWs(): Promise<void> {
  if (isWsConnected() || state.wsRetryTimer) {
    await disconnectWs({ confirmDisconnect: true });
    return;
  }

  const validation = validateWsUrl(getWsRelayUrl(), window.location.protocol);
  if (!validation.ok) {
    setBadge($("badge-ws"), t("ws.badge.error"), "bad");
    setBadge($("ws-detail"), wsValidationErrorDetail(validation.error), "bad");
    return;
  }
  if (validation.url === PUBLIC_RELAY_URL && !(await confirmPublicRelay())) return;

  state.wsManualDisconnect = false;
  clearWsRetry();
  openWs(validation.url);
}

export async function copyDockerCommand(event?: Event): Promise<void> {
  const target = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const targetId = target?.dataset.copyTarget || "docker-command";
  const command = $(targetId)?.textContent?.trim() || DOCKER_WSNIC_COMMAND;
  const status = $("copy-docker-status");

  function fallbackCopy(text: string): void {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.className = "clipboard-fallback";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    if (!ok) throw new Error(t("common.copyFailed"));
  }

  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(command);
    } else {
      fallbackCopy(command);
    }
    if (status) status.textContent = t("common.copied");
    logTool(`${NL}[host] ${t("docker.copiedLog")}${NL}`);
  } catch (error) {
    if (status) status.textContent = t("common.copyFailed");
    logTool(`${NL}[host] ${t("docker.copyFailedLog", { error: errorMessage(error) })}${NL}`);
  }

  window.setTimeout(() => {
    if (status) status.textContent = "";
  }, 1800);
}
