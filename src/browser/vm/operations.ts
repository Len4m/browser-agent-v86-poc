// Browser Agent v86 - VM tools, network, disk and snapshot operations.

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
import { clampExecVmOutputBytes } from "../app/text-utils";
import { appEvents } from "../core/events";
import { showBaModal } from "../ui/modal";
import {
  formatLoggedCommand,
  isWsConnected,
  logTool,
  setAgentBusy,
  setBadge,
  syncSnapshotButtons,
  syncWsButton,
} from "../ui/status-controls";
import { backgroundToolsApi } from "./background-tools-serial1";
import {
  getSelectedProfile,
  getVmRuntimeConfig,
  getWsRelayUrl,
  selectedProfileHasPersistedWorkspace,
  syncProfilePersistenceIndicators,
} from "./profile-config";
import {
  checkWsRelayEndpoint,
  downloadArrayBuffer,
  formatBytes,
  nextPaint,
  normalizeLs,
  setLoading,
  timestampForFilename,
  v86SaveState,
  wsValidationErrorDetail,
} from "./runtime-assets";
import {
  assertSnapshotCompatible,
  createSnapshotContainer,
  decodeDiskBlocks,
  decodePortable,
  SNAPSHOT_MAGIC,
  type PortableSnapshotManifest,
  type SnapshotConsoleUiState,
} from "./portable-state";
import { isResolvedVmRuntime, resolveVmRuntime, runtimeInputFromProfile, type ResolvedVmRuntime, type VmProfile } from "./runtime-config";
import { diskRootHash, sha256 } from "./storage-hash";
import { browserStorageStatus, createRuntimeCowDisk, type CowDisk } from "./indexeddb-cow-disk";
import {
  getWsRetryDelay,
  PUBLIC_RELAY_URL,
  urlForWsPreset,
  validateWsUrl,
  type WsPreset,
} from "./ws-network-config";

export interface ExecVmOptions {
  lock?: boolean;
  label?: string;
  timeoutMs?: number;
  log?: boolean;
  targetTools?: boolean;
  resolveOnTokens?: string[];
  rejectOnTokens?: string[];
  maxOutputBytes?: number;
}

export interface ExecVmResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface VmSerialApi {
  serial0_send?: (text: string) => void;
}

interface ExecVmPending {
  marker: string;
  raw: string;
  resolve: (result: ExecVmResult) => void;
  timer: number;
  resolveOnTokens: string[];
  rejectOnTokens: string[];
  bytesSinceParse: number;
  maxRawChars: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Error";
}

function normalizeExecVmResult(result: unknown): ExecVmResult {
  if (!isRecord(result)) return { code: 1, stdout: "", stderr: "invalid execVm result" };
  return {
    code: Number.isFinite(Number(result.code)) ? Number(result.code) : 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function vmSerialApi(): VmSerialApi | null {
  return isRecord(state.vm) ? state.vm : null;
}

function requestConsoleRender(source: string): void {
  appEvents.emit("console:state-changed", { source });
}

function activeRuntimeConfig(): ResolvedVmRuntime | null {
  return isResolvedVmRuntime(state.activeRuntime) ? state.activeRuntime : null;
}

function snapshotConsoleUiState(): SnapshotConsoleUiState {
  const humanTabs = state.consoleTabs.tabs.filter((tab) => tab.owner === "human");
  const active = humanTabs.find((tab) => tab.id === state.consoleTabs.activeId);
  const serial = humanTabs.find((tab) => tab.transport === "serial0");
  return {
    activeSessionId: active?.transport === "serial2" && active.sessionId ? String(active.sessionId) : null,
    serialTitle: String(serial?.title || "1").replace(/\s+/g, " ").trim().slice(0, 32) || "1",
    sessions: humanTabs
      .filter((tab) => tab.transport === "serial2" && tab.sessionId)
      .map((tab) => ({
        sessionId: String(tab.sessionId),
        title: String(tab.title || tab.humanNumber || tab.sessionId).replace(/\s+/g, " ").trim().slice(0, 32),
      })),
  };
}

function buildExecVmWrappedCommand(command: string, marker: string, maxOutputBytes: number | undefined): string {
  const safeCommand = normalizeLs(command);
  const limit = clampExecVmOutputBytes(maxOutputBytes);
  const errLimit = Math.max(1024, Math.min(32768, limit));
  const safeId = marker.replace(/[^A-Za-z0-9_.-]/g, "_");
  const markerStart = `${marker}_START`;
  const markerStdoutStart = `${marker}_STDOUT_START`;
  const markerStdoutEnd = `${marker}_STDOUT_END`;
  const markerStderrStart = `${marker}_STDERR_START`;
  const markerStderrEnd = `${marker}_STDERR_END`;
  const markerEnd = `${marker}_END`;

  /*
    v9.44: stdout/stderr are not captured from the visual console repaint.
    The real command writes to temporary files, then emits bounded sections
    directly to /dev/ttyS0 so parser markers do not mix with echoed fragments.
  */
  return [
    "__ba_tty=/dev/ttyS0",
    "__ba_dir=/tmp/ba-execvm",
    `__ba_out="$__ba_dir/${safeId}.out"`,
    `__ba_err="$__ba_dir/${safeId}.err"`,
    'mkdir -p "$__ba_dir" 2>/dev/null || true',
    'rm -f "$__ba_out" "$__ba_err" 2>/dev/null || true',
    `printf '\\n${markerStart}\\n${markerStdoutStart}\\n' > "$__ba_tty" 2>/dev/null || printf '\\n${markerStart}\\n${markerStdoutStart}\\n'`,
    `( TERM=dumb; export TERM; ${safeCommand} ) > "$__ba_out" 2> "$__ba_err"`,
    "__rc=$?",
    `head -c ${limit} "$__ba_out" > "$__ba_tty" 2>/dev/null || true`,
    `printf '\\n${markerStdoutEnd}\\n${markerStderrStart}\\n' > "$__ba_tty" 2>/dev/null || printf '\\n${markerStdoutEnd}\\n${markerStderrStart}\\n'`,
    `head -c ${errLimit} "$__ba_err" > "$__ba_tty" 2>/dev/null || true`,
    `printf '\\n${markerStderrEnd}\\n${markerEnd}:%s\\n' "$__rc" > "$__ba_tty" 2>/dev/null || printf '\\n${markerStderrEnd}\\n${markerEnd}:%s\\n' "$__rc"`,
    'rm -f "$__ba_out" "$__ba_err" 2>/dev/null || true',
    "stty echo 2>/dev/null || true",
  ].join("; ") + NL;
}

export async function execVm(command: string, {
  lock = true,
  label = t("common.agentUsingVm"),
  timeoutMs = 25000,
  log = true,
  targetTools = true,
  resolveOnTokens = [],
  rejectOnTokens = [],
  maxOutputBytes = 65536,
}: ExecVmOptions = {}): Promise<ExecVmResult> {
  if (!state.vm) return { code: 1, stdout: "", stderr: t("common.v86NotStarted") };
  if (!state.vmReady) return { code: 1, stdout: "", stderr: t("common.vmBooting") };

  // Internal tool commands use UART1/ttyS1 and do not touch the visible console.
  // There is no silent fallback to serial0 because that would interfere with the user.
  if (targetTools) {
    try {
      const raw = await backgroundToolsApi.execVm(command, {
        label,
        timeoutMs,
        maxOutputBytes: clampExecVmOutputBytes(maxOutputBytes),
        log,
      });
      return normalizeExecVmResult(raw);
    } catch (error) {
      return { code: 1, stdout: "", stderr: errorMessage(error) };
    }
  }

  if (state.pending || state.agentBusy || state.bgTools.pending) {
    return { code: 1, stdout: "", stderr: t("vm.error.busy") };
  }

  const vm = vmSerialApi();
  const sendSerial0 = vm?.serial0_send;
  if (typeof sendSerial0 !== "function") {
    return { code: 1, stdout: "", stderr: t("checks.item.serial0Api") };
  }

  const outputLimit = clampExecVmOutputBytes(maxOutputBytes);
  const marker = `__BAGENT_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
  const wrapped = buildExecVmWrappedCommand(command, marker, outputLimit);

  if (lock) setAgentBusy(true, label);
  if (log) logTool(`${NL}[tool] ${formatLoggedCommand(command)}${NL}`);

  return new Promise<ExecVmResult>((resolve) => {
    const finish = (result: ExecVmResult): void => {
      if (lock) setAgentBusy(false);
      resolve(result);
    };

    const timer = window.setTimeout(() => {
      state.pending = null;
      requestConsoleRender("vm-operations");
      finish({ code: 124, stdout: "", stderr: t("vm.error.timeoutSerial") });
    }, timeoutMs);

    const pending: ExecVmPending = {
      marker,
      raw: "",
      resolve: finish,
      timer,
      resolveOnTokens,
      rejectOnTokens,
      bytesSinceParse: 0,
      // Keep enough tail for limited stdout/stderr plus markers. This prevents
      // unbounded growth if serial0 emits noise while a command hangs.
      maxRawChars: outputLimit + 96 * 1024,
    };
    state.pending = pending;
    requestConsoleRender("vm-operations");
    try {
      sendSerial0(wrapped);
    } catch (error) {
      window.clearTimeout(timer);
      state.pending = null;
      requestConsoleRender("vm-operations");
      finish({ code: 1, stdout: "", stderr: errorMessage(error) });
    }
  });
}

export async function runCommandFromInput(event: Event): Promise<void> {
  event.preventDefault();
  const command = $<HTMLInputElement>("command-input")?.value.trim() || "";
  if (!command) return;
  const result = await execVm(command, { lock: true, label: t("vm.exec.manualLabel") });
  if (result.stdout) logTool(`${NL}${result.stdout}${NL}`);
  if (result.stderr) logTool(`${NL}[stderr] ${result.stderr}${NL}`);
}

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

export async function saveSnapshot(): Promise<void> {
  if (!state.vm || state.vmStarting || state.agentBusy || state.pending || state.bgTools.pending) return;

  const runtime = activeRuntimeConfig();
  if (!runtime) return;
  const filename = `browser-agent-v86-${runtime.profile.id}-${timestampForFilename()}.bav86snapshot`;

  setAgentBusy(true, t("vm.snapshot.saving"));
  setLoading(true, {
    title: t("vm.snapshot.savingTitle"),
    detail: t("vm.snapshot.savingDetail"),
    percent: null,
    indeterminate: true,
  });
  await nextPaint();
  logTool(`${NL}[snapshot] ${t("vm.snapshot.savingLog")}${NL}`);
  let paused = false;
  try {
    const syncResult = await execVm("sync", { lock: false, log: false, timeoutMs: 30000 });
    if (syncResult.code !== 0) throw new Error(`sync guest falló: ${syncResult.stderr || syncResult.stdout}`);
    const vm = state.vm as { stop?: () => unknown; run?: () => unknown };
    if (typeof vm.stop === "function") {
      await vm.stop();
      paused = true;
    }
    if (state.activeCowDisk) {
      await state.activeCowDisk.flush();
      await state.activeCowDisk.checkpoint();
    }
    const blocks = state.activeCowDisk ? await state.activeCowDisk.exportBlocks() : [];
    const v86State = await v86SaveState();
    const container = await createSnapshotContainer(runtime, v86State, blocks, snapshotConsoleUiState());
    downloadArrayBuffer(container, filename);
    logTool(`[snapshot] ${t("vm.snapshot.downloaded", { filename, size: formatBytes(container.byteLength) })}${NL}`);
  } catch (error) {
    logTool(`[snapshot] ${t("vm.snapshot.saveError", { error: errorMessage(error) })}${NL}`);
    setBadge($("vm-detail"), t("common.snapshotError"), "bad");
  } finally {
    if (paused) {
      try { (state.vm as { run?: () => unknown } | null)?.run?.(); } catch { /* resume is best-effort */ }
    }
    setLoading(false);
    setAgentBusy(false);
    syncSnapshotButtons();
  }
}

export function openRestoreSnapshotPicker(): void {
  const input = $<HTMLInputElement>("restore-state-file");
  if (!input || state.vmStarting || state.agentBusy || state.pending || state.bgTools.pending) return;
  input.value = "";
  input.click();
}

async function confirmRestoreSnapshot(): Promise<boolean> {
  const result = await showBaModal({
    title: t("vm.snapshot.restore"),
    message: t("vm.snapshot.restoreConfirm"),
    buttons: [
      { id: "cancel", label: t("common.cancel"), variant: "secondary", cancel: true },
      { id: "restore", label: t("vm.snapshot.restore"), variant: "danger" },
    ],
  });
  return result === "restore";
}

async function stopVmForRestore(): Promise<void> {
  const { stopVm } = await import("./serial-vm");
  await stopVm({ confirmShutdown: false });
}

async function startVmForRestore(
  buffer: ArrayBuffer,
  runtime: ResolvedVmRuntime,
  blocks: ReturnType<typeof decodeDiskBlocks>,
  checkpoint: string | null,
  consoleUi: SnapshotConsoleUiState | null,
): Promise<void> {
  const { startVm } = await import("./serial-vm");
  await startVm({
    restoreStateBuffer: buffer,
    resolvedRuntime: runtime,
    restoreDiskBlocks: blocks,
    restoreDiskCheckpoint: checkpoint,
    restoreConsoleUi: consoleUi,
  });
}

function knownProfile(id: string | undefined, profileHash: string): VmProfile | null {
  if (!id) return null;
  return state.profiles.find((value): value is VmProfile => {
    return isRecord(value) && value.id === id && value.profileHash === profileHash;
  }) || null;
}

export async function restoreSnapshotFromFile(event: Event): Promise<void> {
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  const file = input?.files?.[0] || null;
  if (!file) return;

  setAgentBusy(true, t("vm.snapshot.reading"));
  setLoading(true, {
    title: t("vm.snapshot.readingTitle"),
    detail: `${file.name} · ${formatBytes(file.size)}`,
    percent: null,
    indeterminate: true,
  });
  await nextPaint();

  try {
    const buffer = await file.arrayBuffer();
    logTool(`${NL}[snapshot] ${t("common.loadedFile", { filename: file.name, size: formatBytes(buffer.byteLength) })}${NL}`);
    const decoded = await decodePortable<PortableSnapshotManifest>(buffer, SNAPSHOT_MAGIC);
    const v86State = decoded.sections.get("v86-state");
    if (!v86State || await sha256(v86State) !== decoded.manifest.stateSha256) throw new Error("El estado v86 no coincide con su manifiesto.");

    const profile = knownProfile(decoded.manifest.runtime.profile?.id, decoded.manifest.runtime.profileHash);
    let available: ResolvedVmRuntime;
    if (profile) {
      const snapshotDisk = decoded.manifest.runtime.storage.disks.find((disk) => disk.kind === "overlay-cow");
      const runtimeInput = runtimeInputFromProfile(profile, getWsRelayUrl(), snapshotDisk ? {
        mode: snapshotDisk.persistence,
      } : { mode: "temporary" });
      available = resolveVmRuntime({
        ...runtimeInput,
        ramMb: decoded.manifest.runtime.ramMb,
        vramMb: decoded.manifest.runtime.vramMb,
      });
    } else if (state.activeRuntime?.profileHash === decoded.manifest.runtime.profileHash) {
      available = state.activeRuntime;
    } else {
      throw new Error("El perfil exacto del snapshot no está publicado en esta aplicación.");
    }
    assertSnapshotCompatible(decoded.manifest, available);

    const cow = available.storage.disks.find((disk) => disk.kind === "overlay-cow");
    const delta = decoded.sections.get("hdb-delta");
    const blocks = cow && delta ? decodeDiskBlocks(delta, cow.blockSize, cow.sizeBytes) : [];
    if (blocks.length !== decoded.manifest.blockCount) throw new Error("Número de bloques HDB incoherente.");
    if (cow && await diskRootHash(blocks) !== decoded.manifest.diskRootHash) throw new Error("Hash raíz HDB incompatible.");

    const shouldContinue = !state.vm || await confirmRestoreSnapshot();
    if (!shouldContinue) {
      setLoading(false);
      setAgentBusy(false);
      return;
    }
    setAgentBusy(false);

    if (state.vm) await stopVmForRestore();
    await startVmForRestore(
      v86State.slice().buffer,
      available,
      blocks,
      decoded.manifest.diskRootHash,
      decoded.manifest.consoleUi || null,
    );
  } catch (error) {
    logTool(`[snapshot] ${t("vm.snapshot.restoreError", { error: errorMessage(error) })}${NL}`);
    setLoading(false);
    setAgentBusy(false);
    syncSnapshotButtons();
  }
}

async function selectedWorkspace(): Promise<{ runtime: ResolvedVmRuntime; disk: CowDisk }> {
  if (state.activeRuntime?.storage.mode === "persistent" && state.activeCowDisk) {
    return { runtime: state.activeRuntime, disk: state.activeCowDisk };
  }
  const profile = getSelectedProfile();
  if (!profile) throw new Error("Selecciona un perfil con workspace persistente.");
  const runtime = resolveVmRuntime(runtimeInputFromProfile(profile, getWsRelayUrl(), { mode: "persistent" }));
  const disk = createRuntimeCowDisk(runtime, (status) => { state.workspaceStatus = status; });
  if (!disk) throw new Error("El perfil no declara un disco OverlayFS.");
  await disk.load();
  return { runtime, disk };
}

export async function syncWorkspaceControls(): Promise<void> {
  await syncProfilePersistenceIndicators();
  const profile = getSelectedProfile();
  const hasPersistedWorkspace = Boolean(profile && selectedProfileHasPersistedWorkspace());
  const persistentModeSelected = getVmRuntimeConfig().workspaceMode === "persistent";
  const toolbar = $("workspace-toolbar");
  if (toolbar) toolbar.hidden = !(hasPersistedWorkspace && persistentModeSelected);
  if (!hasPersistedWorkspace) {
    state.workspaceStatus = profile ? "temporary" : "none";
  }

  let workspaceBytes: number | null = null;
  if (hasPersistedWorkspace && profile) {
    try {
      const { disk } = await selectedWorkspace();
      workspaceBytes = await disk.storedBytes();
      if (state.workspaceStatus !== "degraded" && state.workspaceStatus !== "syncing") {
        state.workspaceStatus = await browserStorageStatus();
      }
    } catch (error) {
      state.workspaceStatus = "degraded";
      logTool(`${NL}[workspace] IndexedDB no disponible: ${errorMessage(error)}${NL}`);
    }
  }

  const storageBadge = $("vm-profile-storage-status");
  if (storageBadge && hasPersistedWorkspace && workspaceBytes != null) {
    storageBadge.textContent = `${t("vm.profile.persistence.saved")} · ${formatBytes(workspaceBytes)}`;
    storageBadge.title = storageBadge.textContent;
  }
  const blocked = state.vmStarting || state.agentBusy;
  const resetButton = $<HTMLButtonElement>("workspace-reset");
  if (resetButton) resetButton.disabled = blocked || !hasPersistedWorkspace || !persistentModeSelected || Boolean(state.vm);
}

export async function resetWorkspace(): Promise<void> {
  if (state.vm || state.vmStarting || state.agentBusy) return;
  const choice = await showBaModal({
    title: t("vm.workspace.reset"),
    message: t("vm.workspace.resetConfirm"),
    buttons: [
      { id: "cancel", label: t("common.cancel"), variant: "secondary", cancel: true },
      { id: "reset", label: t("vm.workspace.reset"), variant: "danger" },
    ],
  });
  if (choice !== "reset") return;
  setAgentBusy(true, t("vm.workspace.resetting"));
  try {
    const { disk } = await selectedWorkspace();
    await disk.reset();
    state.workspaceStatus = "none";
    logTool(`${NL}[workspace] reiniciado desde la semilla inmutable.${NL}`);
  } catch (error) {
    logTool(`${NL}[workspace] error reiniciando: ${errorMessage(error)}${NL}`);
  } finally {
    setAgentBusy(false);
    await syncWorkspaceControls();
  }
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
