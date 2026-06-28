// Browser Agent v86 - VM tools, network, disk and snapshot operations.

import {
  $,
  DOCKER_WSNIC_COMMAND,
  NL,
  VM_DISK_MOUNT_COMMAND,
  VM_DISK_UNMOUNT_COMMAND,
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
  syncDiskCheckButton,
  syncSnapshotButtons,
  syncWsButton,
} from "../ui/status-controls";
import { backgroundToolsApi } from "./background-tools-serial1";
import { getVmRuntimeConfig, getWsRelayUrl, type VmRuntimeConfig } from "./profile-config";
import {
  downloadArrayBuffer,
  formatBytes,
  nextPaint,
  normalizeLs,
  setLoading,
  timestampForFilename,
  v86SaveState,
} from "./runtime-assets";

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

function isVmRuntimeConfig(value: unknown): value is VmRuntimeConfig {
  return isRecord(value)
    && typeof value.ramMb === "number"
    && typeof value.vramMb === "number"
    && typeof value.diskMode === "string"
    && ("hda" in value);
}

function activeRuntimeConfig(): VmRuntimeConfig | null {
  return isVmRuntimeConfig(state.activeRuntime) ? state.activeRuntime : null;
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

  const ok = result.stdout.includes("HTTP_BROWSER_AGENT_OK") || result.stdout.includes("bytes from");
  state.networkConfigured = ok;
  state.networkConfiguring = false;

  if (ok) {
    setBadge($("ws-detail"), t("net.badge.connectedVm"), "good");
    logTool(`[network] ${t("net.connectionVerified")}${NL}`);
  } else {
    setBadge($("ws-detail"), t("net.badge.wsnicOkNoNet"), "warn");
    logTool(`[network] ${t("net.wsnicRespondsNotConfigured")}${NL}`);
  }
}

export async function toggleDiskInVm(): Promise<void> {
  const runtime = activeRuntimeConfig();
  if (!runtime?.hda) return;

  if (!state.vm || !state.vmReady) {
    logTool(`${NL}[disk] ${t("vm.disk.bootFirst")}${NL}`);
    return;
  }

  const mounting = !state.diskMounted;
  const result = await execVm(mounting ? VM_DISK_MOUNT_COMMAND : VM_DISK_UNMOUNT_COMMAND, {
    lock: true,
    label: mounting ? t("vm.disk.mounting") : t("vm.disk.unmounting"),
    timeoutMs: mounting ? 45000 : 20000,
  });

  if (result.stdout) logTool(`${NL}${result.stdout}${NL}`);
  if (result.stderr) logTool(`${NL}[disk stderr] ${result.stderr}${NL}`);

  if (mounting) {
    if (result.stdout.includes("DISK_MOUNT_OK")) {
      state.diskMounted = true;
      setBadge($("vm-detail"), t("vm.disk.badge.mounted"), "good");
      logTool(`[disk] ${t("vm.disk.mountedAt")}${NL}`);
    } else {
      setBadge($("vm-detail"), t("vm.disk.badge.notMounted"), "warn");
      logTool(`[disk] ${t("vm.disk.mountFailed")}${NL}`);
    }
  } else if (result.stdout.includes("DISK_UNMOUNT_OK") || result.stdout.includes("DISK_NOT_MOUNTED")) {
    state.diskMounted = false;
    setBadge($("vm-detail"), t("vm.disk.badge.unmounted"), "good");
    logTool(`[disk] ${t("vm.disk.unmountedAt")}${NL}`);
  } else {
    state.diskMounted = true;
    setBadge($("vm-detail"), t("vm.disk.badge.inUse"), "warn");
    logTool(`[disk] ${t("vm.disk.unmountFailed")}${NL}`);
  }

  syncDiskCheckButton();
}

export function maybeConfigureNetwork(): void {
  if (!state.networkAutoRequested || state.networkConfigured || state.networkConfiguring) return;
  void configureNetworkInVm();
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
  if (!state.wsSocket && !state.wsConnecting) {
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

export async function connectWs(): Promise<void> {
  if (isWsConnected()) {
    await disconnectWs({ confirmDisconnect: true });
    return;
  }

  const url = getWsRelayUrl();
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
    const timeout = window.setTimeout(() => {
      if (state.wsSocket === socket) state.wsSocket = null;
      state.wsConnecting = false;
      try {
        socket.close();
      } catch {
        // Closing a timed-out probe socket is best-effort.
      }
      setBadge($("badge-ws"), t("ws.badge.disconnected"), "");
      setBadge($("ws-detail"), t("common.noResponse"), "warn");
      syncWsButton();
    }, 1800);

    socket.onopen = (): void => {
      window.clearTimeout(timeout);
      state.wsSocket = socket;
      state.wsConnecting = false;
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
      setBadge($("ws-detail"), t("common.cannotConnect"), "bad");
      syncWsButton();
    };
    socket.onclose = (): void => {
      window.clearTimeout(timeout);
      if (state.wsSocket === socket) state.wsSocket = null;
      state.wsConnecting = false;
      state.networkAutoRequested = false;
      state.networkConfigured = false;
      state.networkConfiguring = false;
      setBadge($("badge-ws"), t("ws.badge.disconnected"), "");
      setBadge($("ws-detail"), t("common.closed"), "");
      syncWsButton();
    };
  } catch (error) {
    state.wsConnecting = false;
    setBadge($("badge-ws"), t("ws.badge.error"), "bad");
    setBadge($("ws-detail"), errorMessage(error), "bad");
    syncWsButton();
  }
}

export async function saveSnapshot(): Promise<void> {
  if (!state.vm || state.vmStarting || state.agentBusy || state.pending || state.bgTools.pending) return;

  const runtime = activeRuntimeConfig() ?? getVmRuntimeConfig();
  const diskLabel = runtime.hda ? `hda-${runtime.hda.sizeMb}mb` : "initramfs";
  const filename = `browser-agent-v86-${runtime.ramMb}mb-${diskLabel}-${timestampForFilename()}.v86state`;

  setAgentBusy(true, t("vm.snapshot.saving"));
  setLoading(true, {
    title: t("vm.snapshot.savingTitle"),
    detail: t("vm.snapshot.savingDetail"),
    percent: null,
    indeterminate: true,
  });
  await nextPaint();
  logTool(`${NL}[snapshot] ${t("vm.snapshot.savingLog")}${NL}`);
  if (runtime.hda) {
    logTool(`[snapshot] ${t("vm.snapshot.noHdaWarning", { url: runtime.hda.url })}${NL}`);
  }

  try {
    const buffer = await v86SaveState();
    downloadArrayBuffer(buffer, filename);
    logTool(`[snapshot] ${t("vm.snapshot.downloaded", { filename, size: formatBytes(buffer.byteLength) })}${NL}`);
  } catch (error) {
    logTool(`[snapshot] ${t("vm.snapshot.saveError", { error: errorMessage(error) })}${NL}`);
    setBadge($("vm-detail"), t("common.snapshotError"), "bad");
  } finally {
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

async function startVmForRestore(buffer: ArrayBuffer): Promise<void> {
  const { startVm } = await import("./serial-vm");
  await startVm({ restoreStateBuffer: buffer });
}

export async function restoreSnapshotFromFile(event: Event): Promise<void> {
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  const file = input?.files?.[0] || null;
  if (!file) return;

  const shouldContinue = !state.vm || await confirmRestoreSnapshot();
  if (!shouldContinue) return;

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
    logTool(`[snapshot] ${t("vm.snapshot.hdaNotInSnapshot")}${NL}`);
    setAgentBusy(false);

    if (state.vm) await stopVmForRestore();
    await startVmForRestore(buffer);
  } catch (error) {
    logTool(`[snapshot] ${t("vm.snapshot.restoreError", { error: errorMessage(error) })}${NL}`);
    setLoading(false);
    setAgentBusy(false);
    syncSnapshotButtons();
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
