// Browser Agent v86 - serial VM lifecycle and serial0 console helpers.

import { $, CR, NL, state } from "../app/state";
import { t } from "../app/i18n";
import { trimLines } from "../app/text-utils";
import { confirmVmShutdown, showBaModal } from "../ui/modal";
import {
  logTool,
  safeTrim,
  setAgentBusy,
  setBadge,
  syncPowerButtons,
  syncSnapshotButtons,
} from "../ui/status-controls";
import { maybeConfigureNetwork, syncWorkspaceControls, type ExecVmResult } from "./operations";
import {
  checkAsset,
  isAbortError,
  makeAbortError,
  nextPaint,
  preloadVmAssets,
  setLoading,
  throwIfAborted,
  v86RestoreState,
} from "./runtime-assets";
import {
  getConfig,
  getVmRuntimeConfig,
  getWsRelayUrl,
  reflectRuntimeSelection,
  setVmOptionsLocked,
} from "./profile-config";
import { backgroundToolsApi } from "./background-tools-serial1";
import { consoleControlApi } from "./console-control-serial2";
import {
  finalizeConsoleTabsReady,
  focusSerialConsole,
  initConsoleTabsAfterBoot,
  renderConsoleTabs,
  resetConsoleTabs,
  syncConsoleTabsFromDaemon,
} from "../console/xterm-consoles";
import {
  resetSerialConsoleDom,
  scheduleSerialFit,
  setupSerialTerminalHelpers,
  teardownSerialTerminalHelpers,
} from "./serial-console";
import {
  escapeRegExp,
  extractBetweenLast,
  normalizeTerminalStreamForMarkers,
} from "./terminal-markers";
import { createRuntimeCowDisk, requestDurableBrowserStorage, type CowBlock } from "./indexeddb-cow-disk";
import {
  resolveVmRuntime,
  type AssetIdentity,
  type ResolvedVmRuntime,
} from "./runtime-config";
import { sha256 } from "./storage-hash";
import type { SnapshotConsoleUiState } from "../console/console-state";

interface V86VmApi {
  serial0_send?: (text: string) => void;
  serial_send_bytes?: (port: number, bytes: Uint8Array) => void;
  serial1_send?: (text: string) => void;
  add_listener?: (eventName: string, callback: (...args: unknown[]) => void) => void;
  stop?: () => unknown;
  destroy?: () => unknown;
  run?: () => void;
}

interface V86Constructor {
  new (options: Record<string, unknown>): V86VmApi;
}

interface StartVmOptions {
  restoreStateBuffer?: ArrayBuffer | null;
  resolvedRuntime?: ResolvedVmRuntime | null;
  restoreDiskBlocks?: CowBlock[];
  restoreDiskCheckpoint?: string | null;
  restoreConsoleUi?: SnapshotConsoleUiState | null;
}

interface StopVmOptions {
  confirmShutdown?: boolean;
}

interface PendingCommand {
  marker: string;
  raw: string;
  resolve: (result: ExecVmResult) => void;
  timer: number;
  resolveOnTokens: string[];
  rejectOnTokens: string[];
  bytesSinceParse: number;
  maxRawChars: number;
}

type VmRuntimeWindow = Window & typeof globalThis & {
  V86Starter?: unknown;
  V86?: unknown;
  Terminal?: unknown;
};

function vmRuntimeWindow(): VmRuntimeWindow {
  return window;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Error";
}

async function identifyAsset(url: string, bytes: ArrayBuffer | undefined, declared?: AssetIdentity): Promise<AssetIdentity> {
  if (declared) return declared;
  const buffer = bytes || await (await fetch(url, { cache: "force-cache" })).arrayBuffer();
  return { url, bytes: buffer.byteLength, sha256: await sha256(buffer) };
}

function vmApi(): V86VmApi | null {
  return isRecord(state.vm) ? state.vm : null;
}

function isV86Constructor(value: unknown): value is V86Constructor {
  return typeof value === "function";
}

function isPendingCommand(value: unknown): value is PendingCommand {
  return isRecord(value)
    && typeof value.marker === "string"
    && typeof value.raw === "string"
    && typeof value.resolve === "function"
    && typeof value.timer === "number"
    && Array.isArray(value.resolveOnTokens)
    && Array.isArray(value.rejectOnTokens);
}

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

async function resyncVmAfterRestore(consoleUi: SnapshotConsoleUiState | null): Promise<void> {
  logTool(`[snapshot] revalidando seriales y consolas xterm tras restore...${NL}`);

  const [serial1Ok, serial2Ok] = await Promise.all([
    backgroundToolsApi.probeRunnerReady({ timeoutMs: 1800 }).catch(() => false),
    consoleControlApi.probeRunnerReady({ timeoutMs: 2600 }).catch(() => false),
  ]);

  if (serial1Ok) logTool(`[snapshot] serial1/ttyS1 revalidado.${NL}`);
  else logTool(`[snapshot] aviso: serial1/ttyS1 no ha respondido al probe; las tools pueden no estar listas.${NL}`);

  if (serial2Ok) logTool(`[snapshot] serial2/ttyS2 revalidado.${NL}`);
  else logTool(`[snapshot] aviso: serial2/ttyS2 no ha respondido al probe; las consolas xterm pueden no estar listas.${NL}`);

  await finalizeConsoleTabsReady({ extraReady: serial2Ok });

  if (serial2Ok) {
    const before = state.consoleTabs.tabs.length;
    const consolesSynced = await syncConsoleTabsFromDaemon({
      repaint: false,
      createMissing: true,
      reactivateRestored: true,
      restoredUi: consoleUi,
    }).catch(() => false);
    if (consolesSynced) {
      const restoredCount = Math.max(0, state.consoleTabs.tabs.length - before);
      logTool(`[snapshot] consolas xterm sincronizadas con el snapshot${restoredCount ? ` (${restoredCount} pestaña(s) restaurada(s))` : ""}.${NL}`);
    } else {
      logTool(`[snapshot] aviso: no se pudo listar sesiones xterm restauradas.${NL}`);
    }
  }

  renderConsoleTabs();
  focusSerialConsole();
  syncSnapshotButtons();
  maybeConfigureNetwork();
}

function cancelVmStart(): boolean {
  const controller = state.vmStartAbortController;
  if (!state.vmStarting || !controller || controller.signal.aborted) return false;
  const error = makeAbortError(t("vm.loading.cancelled"));
  logTool(`${NL}[host] ${t("vm.loading.cancelLog")}${NL}`);
  setBadge($("vm-detail"), t("common.operationCancelled"), "warn");
  setLoading(true, {
    title: t("vm.loading.cancelling"),
    detail: t("vm.loading.cancellingDetail"),
    percent: null,
    indeterminate: true,
  });
  controller.abort(error);
  return true;
}

export async function toggleVmPower(): Promise<void> {
  if (state.vm) {
    await stopVm({ confirmShutdown: true });
    return;
  }
  await startVm();
}

export async function startVm(options: StartVmOptions = {}): Promise<void> {
  const restoreStateBuffer = options.restoreStateBuffer || null;
  const restoreConsoleUi = options.restoreConsoleUi || null;
  const selectedConfig = getConfig();
  const selectedRuntime = getVmRuntimeConfig();
  const requestedRuntime = options.resolvedRuntime || null;
  const cfg = requestedRuntime ? {
    libv86: requestedRuntime.assets.libv86.url,
    wasm: requestedRuntime.assets.wasm.url,
    bios: requestedRuntime.assets.bios.url,
    vgaBios: requestedRuntime.assets.vgaBios.url,
    bzimage: requestedRuntime.assets.kernel.url,
    initrd: requestedRuntime.assets.initramfs.url,
    profile: requestedRuntime.profile,
  } : selectedConfig;
  const startButton = $("start-vm");

  if (state.vmStarting) return;
  if (state.vm) {
    setBadge($("vm-detail"), state.vmReady ? t("vm.badge.shellReady") : t("vm.badge.alreadyBooted"), state.vmReady ? "good" : "warn");
    focusSerialConsole();
    return;
  }

  if (requestedRuntime) reflectRuntimeSelection(requestedRuntime);

  if (restoreStateBuffer) {
    logTool(`${NL}[snapshot] ${t("vm.snapshot.restoringValidated")}${NL}`);
  }

  state.vmStarting = true;
  const startAbortController = new AbortController();
  state.vmStartAbortController = startAbortController;
  const startCancelOptions = {
    cancelable: true,
    cancelLabel: t("vm.loading.cancel"),
    onCancel: cancelVmStart,
  };
  setVmOptionsLocked(true);
  setDisabled(startButton, true);
  setBadge($("badge-vm"), t("vm.badge.loading"), "warn");
  setBadge($("vm-detail"), t("common.downloadingLower"), "warn");

  try {
    setLoading(true, {
      title: t("vm.loading.preparing"),
      detail: t("vm.loading.startingDownload"),
      percent: null,
      indeterminate: true,
      ...startCancelOptions,
    });
    await nextPaint();
    logTool(`${NL}[host] preparando assets de v86...${NL}`);

    const buffers = await preloadVmAssets(cfg, {
      signal: startAbortController.signal,
      onCancel: cancelVmStart,
    });
    throwIfAborted(startAbortController.signal);

    const declared = cfg.profile?.assets;
    const runtime = requestedRuntime || resolveVmRuntime({
      profile: cfg.profile,
      ramMb: selectedRuntime.ramMb,
      vramMb: selectedRuntime.vramMb,
      workspace: {
        mode: selectedRuntime.workspaceMode,
      },
      wsRelayUrl: getWsRelayUrl(),
      assets: {
        libv86: await identifyAsset(cfg.libv86, buffers.libv86, declared?.libv86),
        wasm: await identifyAsset(cfg.wasm, buffers.wasm, declared?.wasm),
        bios: await identifyAsset(cfg.bios, buffers.bios, declared?.bios),
        vgaBios: await identifyAsset(cfg.vgaBios, buffers.vgaBios, declared?.vgaBios),
        kernel: await identifyAsset(cfg.bzimage, buffers.bzimage, declared?.kernel),
        initramfs: await identifyAsset(cfg.initrd, buffers.initrd, declared?.initramfs),
      },
    });

    const rootDisk = runtime.storage.disks.find((disk) => disk.kind === "immutable-root");
    const overlayDisk = runtime.storage.disks.find((disk) => disk.kind === "overlay-cow");
    if (rootDisk) {
      const firstPart = rootDisk.asset.url.replace(/\.img\.zst(?:\?.*)?$/, `-0-${rootDisk.fixedChunkSize}.img.zst`);
      const [rootCheck, seedCheck] = await Promise.all([
        checkAsset(firstPart, { signal: startAbortController.signal }),
        checkAsset(overlayDisk?.seed.url || "", { signal: startAbortController.signal }),
      ]);
      if (!rootCheck.ok || !seedCheck.ok) throw new Error("Faltan los assets HDA/HDB del perfil persistente. Ejecuta pnpm setup.");
    }

    let cowDisk: ReturnType<typeof createRuntimeCowDisk> = null;
    if (overlayDisk) {
      state.workspaceStatus = overlayDisk.persistence === "persistent"
        ? await requestDurableBrowserStorage()
        : "temporary";
      cowDisk = createRuntimeCowDisk(runtime, (status, error) => {
          state.workspaceStatus = status;
          if (error) logTool(`[workspace] ${errorMessage(error)}${NL}`);
      }, overlayDisk.persistence === "persistent" ? () => { void syncWorkspaceControls(); } : undefined);
      if (!cowDisk) throw new Error("No se pudo resolver el disco OverlayFS del perfil.");
      await cowDisk.load();
      if (options.restoreDiskBlocks && options.restoreDiskCheckpoint) {
        await cowDisk.importBlocks(options.restoreDiskBlocks, options.restoreDiskCheckpoint, { provisional: true });
      }
    }

    const vmRuntime = vmRuntimeWindow();
    const Starter = vmRuntime.V86Starter || vmRuntime.V86;
    if (!isV86Constructor(Starter)) throw new Error("window.V86Starter no existe");
    if (!vmRuntime.Terminal) throw new Error("xterm.js no cargado");

    resetSerialConsoleDom();
    backgroundToolsApi.reset("vm-starting");
    consoleControlApi.reset("vm-starting");
    state.vmReady = false;
    state.networkConfigured = false;
    state.networkConfiguring = false;
    state.bootBuffer = "";
    state.pending = null;
    state.activeRuntime = runtime;
    state.activeCowDisk = cowDisk;
    state.snapshotRestoring = Boolean(restoreStateBuffer);
    resetConsoleTabs();
    syncSnapshotButtons();
    void syncWorkspaceControls();

    const relayUrl = runtime.network.relayUrl;
    logTool(`[network] v86 virtio net_device.relay_url = ${relayUrl}${NL}`);
    logTool(`[host] RAM ${runtime.ramMb} MB · VRAM ${runtime.vramMb} MB · Almacenamiento ${runtime.storage.layout}/${runtime.storage.mode}${NL}`);
    logTool(`[profile] ${cfg.profile.name || cfg.profile.id} · ${cfg.profile.output || ""}${NL}`);

    const vm = new Starter({
      wasm_path: cfg.wasm,
      memory_size: runtime.ramMb * 1024 * 1024,
      vga_memory_size: runtime.vramMb * 1024 * 1024,
      bios: { buffer: buffers.bios },
      vga_bios: { buffer: buffers.vgaBios },
      bzimage: { buffer: buffers.bzimage },
      ...(buffers.initrd ? { initrd: { buffer: buffers.initrd } } : {}),
      ...(rootDisk ? { hda: { url: rootDisk.asset.url, async: true, size: rootDisk.sizeBytes, use_parts: true, fixed_chunk_size: rootDisk.fixedChunkSize } } : {}),
      ...(cowDisk ? { hdb: cowDisk } : {}),
      // virtio-net is faster on modern Alpine and is supported by the generated initramfs.
      net_device: { type: "virtio", relay_url: relayUrl },
      filesystem: {},
      // UART1 is reserved for non-interactive background tools.
      // UART2 is reserved for the browser xterm/PTY daemon.
      // serial0/ttyS0 remains the boot console and fallback.
      uart1: true,
      uart2: true,
      cmdline: runtime.cmdline,
      autostart: !restoreStateBuffer,
      disable_keyboard: true,
      screen_container: $("screen-container"),
      serial_console: { type: "xtermjs", container: $("serial-console"), xterm_lib: vmRuntime.Terminal },
    });
    state.vm = vm;
    setupSerialTerminalHelpers();

    if (typeof vm.add_listener !== "function" || typeof vm.serial0_send !== "function") {
      throw new Error("Esta build no expone serial0_send/add_listener");
    }

    vm.add_listener("serial0-output-byte", (byte) => onSerialByte(Number(byte)));
    vm.add_listener("serial1-output-byte", (byte) => backgroundToolsApi.onSerial1Byte(Number(byte)));
    vm.add_listener("serial2-output-byte", (byte) => consoleControlApi.onSerial2Byte(Number(byte)));
    vm.add_listener("eth-transmit-end", (bytes) => logTool(`[network] eth transmit ${String(bytes)} bytes${NL}`));
    vm.add_listener("eth-receive-end", (bytes) => logTool(`[network] eth receive ${String(bytes)} bytes${NL}`));
    let restoreApplied = false;

    const applyRestoreState = async (): Promise<void> => {
      if (!restoreStateBuffer || restoreApplied) return;
      restoreApplied = true;
      try {
        setLoading(true, {
          title: t("vm.loading.restoringSnapshot"),
          detail: t("vm.loading.applyingState"),
          percent: null,
          indeterminate: true,
        });
        await nextPaint();
        await v86RestoreState(restoreStateBuffer);
        await cowDisk?.commitImport();
        if (typeof vm.run === "function") vm.run();
        state.vmReady = true;
        state.snapshotRestoring = false;
        setBadge($("badge-vm"), t("vm.badge.ready"), "good");
        setBadge($("vm-detail"), t("vm.badge.snapshotRestored"), "good");
        logTool(`[snapshot] snapshot restaurado. Si la consola queda sin prompt, pulsa Enter.${NL}`);
        window.setTimeout(() => {
          try {
            vm.serial0_send?.(NL);
          } catch {
            // Prompt nudging is best-effort.
          }
          scheduleSerialFit({ focus: true });
          resyncVmAfterRestore(restoreConsoleUi).catch((error: unknown) => {
            logTool(`[snapshot] aviso resync restore: ${errorMessage(error)}${NL}`);
            maybeConfigureNetwork();
          });
        }, 300);
      } catch (error) {
        await cowDisk?.rollbackImport().catch((rollbackError: unknown) => {
          logTool(`[snapshot] error revirtiendo HDB: ${errorMessage(rollbackError)}${NL}`);
        });
        state.snapshotRestoring = false;
        setBadge($("badge-vm"), t("vm.badge.errorRestore"), "bad");
        setBadge($("vm-detail"), t("common.snapshotError"), "bad");
        logTool(`[snapshot] error restaurando: ${errorMessage(error)}${NL}`);
      } finally {
        setLoading(false);
        syncSnapshotButtons();
      }
    };

    vm.add_listener("emulator-ready", () => {
      setBadge($("vm-detail"), restoreStateBuffer ? t("common.restoringSnapshot") : t("vm.badge.booting"), "warn");
      window.setTimeout(() => scheduleSerialFit({ focus: true }), 150);
      void applyRestoreState();
    });
    vm.add_listener("emulator-loaded", () => {
      scheduleSerialFit({ focus: true });
    });

    setBadge($("badge-vm"), t("vm.badge.starting"), "warn");
    setBadge($("vm-detail"), t("common.waitingShell"), "warn");
    logTool(`[host] v86 arrancando. La pestaña 1 es serial0; las pestañas extra usan PTYs por serial2.${NL}`);
    if (state.networkAutoRequested) {
      logTool(`[network] wsnic ya verificado. La red se comprobará automáticamente al detectar la shell.${NL}`);
    } else {
      logTool(`[network] pulsa Conectar en Red WS para verificar wsnic, configurar la interfaz y comprobar conexión HTTP.${NL}`);
    }
    window.setTimeout(() => scheduleSerialFit({ focus: true }), 250);
    setLoading(false);
  } catch (error) {
    if (isAbortError(error)) {
      setBadge($("badge-vm"), t("common.v86Inactive"), "");
      setBadge($("vm-detail"), t("common.operationCancelled"), "warn");
      logTool(`[host] ${t("vm.loading.cancelled")}${NL}`);
    } else {
      setBadge($("badge-vm"), t("vm.badge.error"), "bad");
      setBadge($("vm-detail"), errorMessage(error), "bad");
      logTool(`[host] error: ${errorMessage(error)}${NL}`);
    }
    state.activeRuntime = null;
    state.activeCowDisk = null;
    setLoading(false);
  } finally {
    if (state.vmStartAbortController === startAbortController) state.vmStartAbortController = null;
    state.vmStarting = false;
    setVmOptionsLocked(Boolean(state.vm));
    syncPowerButtons();
    syncSnapshotButtons();
    void syncWorkspaceControls();
  }
}

export async function stopVm({ confirmShutdown = true }: StopVmOptions = {}): Promise<void> {
  const vm = vmApi();
  if (!vm || state.vmStarting || state.agentBusy || state.pending || state.bgTools.pending) return;

  if (confirmShutdown) {
    const ok = await confirmVmShutdown({ persistent: state.activeRuntime?.storage.mode === "persistent" });
    if (!ok) return;
  }

  if (state.vmReady) {
    while (true) {
      const result = await import("./operations").then(({ execVm }) => execVm("sync", {
        lock: true, log: false, timeoutMs: 30000,
      }));
      if (result.code === 0) break;
      const choice = await showBaModal({
        title: t("vm.shutdown.syncFailed"),
        message: t("vm.shutdown.syncFailedDetail", { error: result.stderr || result.stdout || String(result.code) }),
        buttons: [
          { id: "cancel", label: t("common.cancel"), variant: "secondary", cancel: true },
          { id: "retry", label: t("common.retry"), variant: "primary" },
          { id: "force", label: t("vm.shutdown.force"), variant: "danger" },
        ],
      });
      if (choice === "retry") continue;
      if (choice === "cancel") return;
      logTool(`[host] ${t("vm.shutdown.forcedWarning")}${NL}`);
      break;
    }
  }

  setDisabled($("stop-vm"), true);
  setDisabled($("start-vm"), true);
  setAgentBusy(true, t("vm.badge.shuttingDown"));
  setBadge($("badge-vm"), t("vm.badge.stopping"), "warn");
  setBadge($("vm-detail"), t("vm.badge.poweringOff"), "warn");
  logTool(`${NL}[host] apagando VM...${NL}`);

  try {
    // Stop the emulated CPU before the final host-side flush. Otherwise the
    // guest can submit another HDB write between flush() and destroy().
    if (typeof vm.stop === "function") {
      try {
        await vm.stop();
      } catch (error) {
        logTool(`[host] aviso stop(): ${errorMessage(error)}${NL}`);
      }
    }

    if (state.activeCowDisk) {
      const durability = state.workspaceStatus === "evictable" || state.workspaceStatus === "degraded"
        ? state.workspaceStatus
        : "persisted";
      state.workspaceStatus = "syncing";
      await state.activeCowDisk.flush();
      await state.activeCowDisk.checkpoint();
      state.workspaceStatus = state.activeRuntime?.storage.mode === "persistent" ? durability : "temporary";
    }

    if (typeof vm.destroy === "function") {
      try {
        await vm.destroy();
      } catch (error) {
        logTool(`[host] aviso destroy(): ${errorMessage(error)}${NL}`);
      }
    }
  } finally {
    teardownSerialTerminalHelpers();
    state.vm = null;
    state.vmReady = false;
    state.pending = null;
    backgroundToolsApi.reset("vm-stopped");
    consoleControlApi.reset("vm-stopped");
    state.bootBuffer = "";
    state.networkConfigured = false;
    state.networkConfiguring = false;
    state.activeRuntime = null;
    state.activeCowDisk = null;
    resetConsoleTabs();
    setAgentBusy(false);
    setVmOptionsLocked(false);
    setBadge($("badge-vm"), t("common.v86Inactive"), "");
    setBadge($("vm-detail"), t("common.offLower"), "");
    syncPowerButtons();
    syncSnapshotButtons();
    void syncWorkspaceControls();
    logTool(`[host] VM apagada. Puedes cambiar perfil o almacenamiento y arrancar de nuevo.${NL}`);
  }
}

function onSerialByte(byte: number): void {
  onSerialChar(String.fromCharCode(byte));
}

function finishPendingCommand(pending: PendingCommand, result: ExecVmResult): void {
  window.clearTimeout(pending.timer);
  if (state.pending === pending) state.pending = null;
  renderConsoleTabs();
  pending.resolve(result);
}

function parsePendingCommandBuffer(pending: PendingCommand): boolean {
  const clean = normalizeTerminalStreamForMarkers(pending.raw);
  const startToken = `${pending.marker}_START`;
  const stdoutStartToken = `${pending.marker}_STDOUT_START`;
  const stdoutEndToken = `${pending.marker}_STDOUT_END`;
  const stderrStartToken = `${pending.marker}_STDERR_START`;
  const stderrEndToken = `${pending.marker}_STDERR_END`;
  const endToken = `${pending.marker}_END:`;

  /*
    v9.44: execVm emits stdout/stderr as single sections written from temp files
    to /dev/ttyS0. When those sections are present, they are the source of truth.
  */
  const endRegex = new RegExp(`${escapeRegExp(endToken)}[ \\t]*(-?\\d+)[ \\t]*\\n`);
  const endMatch = clean.match(endRegex);
  if (endMatch) {
    const outputEnd = endMatch.index ?? -1;
    const startIndex = outputEnd >= 0 ? clean.lastIndexOf(startToken, outputEnd) : -1;
    if (startIndex >= 0) {
      const code = Number(endMatch[1] || "0");
      const section = clean.slice(startIndex + startToken.length, outputEnd);
      const stdoutSection = extractBetweenLast(section, stdoutStartToken, stdoutEndToken);
      const stderrSection = extractBetweenLast(section, stderrStartToken, stderrEndToken);
      const stdout = stdoutSection !== null ? trimLines(stdoutSection) : trimLines(section);
      const stderr = stderrSection !== null ? trimLines(stderrSection) : (code === 0 ? "" : `exit code ${code}`);
      finishPendingCommand(pending, { code, stdout, stderr });
      return true;
    }
  }

  if (pending.resolveOnTokens.length) {
    const seen = pending.resolveOnTokens.find((token) => clean.includes(token));
    if (seen) {
      const hasErrorToken = pending.rejectOnTokens.some((token) => clean.includes(token));
      const startIndex = clean.lastIndexOf(startToken);
      const stdout = startIndex >= 0 ? trimLines(clean.slice(startIndex + startToken.length)) : trimLines(clean);
      finishPendingCommand(pending, {
        code: hasErrorToken ? 1 : 0,
        stdout,
        stderr: hasErrorToken ? `token de error detectado: ${seen}` : "",
      });
      return true;
    }
  }

  return false;
}

function onSerialChar(char: string): void {
  state.bootBuffer = safeTrim(state.bootBuffer + char, 6000);

  const prompts = ["~% ", "~# ", "/ # ", "# ", "$ "];
  if (!state.vmReady && prompts.some((prompt) => state.bootBuffer.endsWith(prompt))) {
    state.vmReady = true;
    setBadge($("badge-vm"), t("vm.badge.ready"), "good");
    setBadge($("vm-detail"), t("vm.badge.shellReady"), "good");
    void syncWorkspaceControls();
    scheduleSerialFit({ focus: true });
    window.setTimeout(() => {
      void initConsoleTabsAfterBoot();
    }, 500);
    window.setTimeout(() => maybeConfigureNetwork(), 1800);
  }

  const pending = state.pending;
  if (!isPendingCommand(pending)) return;

  pending.raw += char;
  if (pending.maxRawChars && pending.raw.length > pending.maxRawChars) {
    pending.raw = pending.raw.slice(-pending.maxRawChars);
  }
  pending.bytesSinceParse = (pending.bytesSinceParse || 0) + 1;

  // Serial rendering may not arrive as clean lines. Parse on newline and every
  // 128 bytes so visible tokens are detected even without NL.
  if (char !== NL && char !== CR && pending.bytesSinceParse < 128) return;
  pending.bytesSinceParse = 0;
  parsePendingCommandBuffer(pending);
}
