// Browser Agent v86 - serial VM lifecycle and serial0 console helpers.

import { $, CR, NL, state } from "../app/state";
import { t } from "../app/i18n";
import { trimLines } from "../app/text-utils";
import { confirmVmShutdown } from "../ui/modal";
import {
  logTool,
  safeTrim,
  setAgentBusy,
  setBadge,
  syncDiskCheckButton,
  syncPowerButtons,
  syncSnapshotButtons,
} from "../ui/status-controls";
import { maybeConfigureNetwork, type ExecVmResult } from "./operations";
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
  setVmOptionsLocked,
} from "./profile-config";
import { backgroundToolsApi } from "./background-tools-serial1";
import { consoleControlApi } from "./console-control-serial2";
import {
  finalizeConsoleTabsReady,
  getActiveConsoleTab,
  initConsoleTabsAfterBoot,
  renderConsoleTabs,
  resetConsoleTabs,
  syncConsoleTabsFromDaemon,
} from "../console/xterm-consoles";
import {
  escapeRegExp,
  extractBetweenLast,
  normalizeTerminalStreamForMarkers,
} from "./terminal-markers";

interface TerminalLike {
  cols?: number;
  rows?: number;
  options?: {
    scrollback?: number;
    cursorBlink?: boolean;
  };
  textarea?: HTMLTextAreaElement | null;
  _core?: {
    textarea?: HTMLTextAreaElement | null;
    _renderService?: {
      dimensions?: {
        css?: {
          cell?: {
            width?: number;
            height?: number;
          };
        };
      };
    };
  };
  resize?: (cols: number, rows: number) => void;
  refresh?: (start: number, end: number) => void;
  scrollToBottom?: () => void;
  focus?: () => void;
  getSelection?: () => string;
  onWriteParsed?: (handler: () => void) => { dispose?: () => void };
  attachCustomKeyEventHandler?: (handler: (event: KeyboardEvent) => boolean) => void;
}

interface V86VmApi {
  serial_adapter?: {
    term?: unknown;
    terminal?: unknown;
  };
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

function asTerminalLike(value: unknown): TerminalLike | null {
  return isRecord(value) ? value : null;
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

export function getSerialTerm(): TerminalLike | null {
  const vm = vmApi();
  const adapter = vm?.serial_adapter;
  if (!adapter) return null;
  return asTerminalLike(adapter.term) || asTerminalLike(adapter.terminal);
}

function getXtermCellSize(term: TerminalLike | null, container: HTMLElement): { width: number; height: number } {
  const cell = term?._core?._renderService?.dimensions?.css?.cell;
  if (cell && Number(cell.width) > 0 && Number(cell.height) > 0) {
    return { width: Number(cell.width), height: Number(cell.height) };
  }

  const probe = document.createElement("span");
  probe.textContent = "W";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.style.font = "15px/18px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace";
  container.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return { width: rect.width || 9, height: rect.height || 18 };
}

function sizeSerialContainerToGrid(container: HTMLElement, term: TerminalLike, cols: number, rows: number): void {
  const cell = getXtermCellSize(term, container);

  // v86 serial does not receive real SIGWINCH from the browser. The boot
  // console keeps stable geometry; user consoles use separate xterm instances.
  const width = Math.ceil((cell.width || 9) * cols);
  const height = Math.ceil((cell.height || 18) * rows + 6);
  const shell = $("vm-console-shell");
  const targets = [container, shell].filter((el): el is HTMLElement => Boolean(el));

  for (const el of targets) {
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.minHeight = `${height}px`;
    el.style.maxHeight = `${height}px`;
  }

  const wrap = container.closest(".vm-screen-wrap");
  if (wrap instanceof HTMLElement) {
    wrap.style.setProperty("--ba-console-width", `${width}px`);
    wrap.style.setProperty("--ba-console-height", `${height}px`);
  }
}

function fitSerialTerminal(): void {
  const container = $("serial-console");
  const term = getSerialTerm();
  if (!container || !term || typeof term.resize !== "function") return;

  const cols = state.consoleTabs.fixedCols || 80;
  const rows = state.consoleTabs.fixedRows || 24;
  try {
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    sizeSerialContainerToGrid(container, term, cols, rows);
    if (typeof term.refresh === "function") term.refresh(0, Math.max(0, rows - 1));
    if (typeof term.scrollToBottom === "function") term.scrollToBottom();
  } catch {
    // Fitting the terminal is best-effort.
  }
}

export function scheduleSerialFit({ focus = false }: { focus?: boolean } = {}): void {
  if (state.serialFitRaf) window.cancelAnimationFrame(state.serialFitRaf);
  state.serialFitRaf = window.requestAnimationFrame(() => {
    state.serialFitRaf = 0;
    fitSerialTerminal();
    if (focus) focusSerialConsole();
  });
}

function scheduleSerialScrollToBottom(): void {
  const term = getSerialTerm();
  if (!term || typeof term.scrollToBottom !== "function") return;
  if (state.serialScrollRaf) return;
  state.serialScrollRaf = window.requestAnimationFrame(() => {
    state.serialScrollRaf = 0;
    try {
      term.scrollToBottom?.();
    } catch {
      // Scrolling xterm is best-effort.
    }
  });
}

function getSerialSelectionText(term: TerminalLike | null): string {
  if (!term) return "";
  try {
    if (typeof term.getSelection === "function") return String(term.getSelection() || "");
  } catch {
    // Selection access is best-effort.
  }
  return "";
}

function getSerialHelperTextarea(term: TerminalLike | null, container = $("serial-console")): HTMLTextAreaElement | null {
  if (term?.textarea instanceof HTMLTextAreaElement) return term.textarea;
  if (term?._core?.textarea instanceof HTMLTextAreaElement) return term._core.textarea;
  return container?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea") || null;
}

function primeSerialClipboardTextarea(term: TerminalLike, container: HTMLElement, text: string): boolean {
  const textarea = getSerialHelperTextarea(term, container);
  if (!textarea) return false;
  try {
    textarea.value = text;
    textarea.focus({ preventScroll: true });
    textarea.select();
    return true;
  } catch {
    return false;
  }
}

function teardownSerialTerminalHelpers(): void {
  if (state.serialResizeObserver) {
    try {
      state.serialResizeObserver.disconnect();
    } catch {
      // ResizeObserver cleanup is best-effort.
    }
    state.serialResizeObserver = null;
  }
  if (state.serialFitRaf) {
    window.cancelAnimationFrame(state.serialFitRaf);
    state.serialFitRaf = 0;
  }
  if (state.serialScrollRaf) {
    window.cancelAnimationFrame(state.serialScrollRaf);
    state.serialScrollRaf = 0;
  }
  if (state.serialWriteDisposable?.dispose) {
    try {
      state.serialWriteDisposable.dispose();
    } catch {
      // xterm disposable cleanup is best-effort.
    }
  }
  state.serialWriteDisposable = null;
  if (state.serialContextMenuContainer && state.serialContextMenuHandler) {
    try {
      state.serialContextMenuContainer.removeEventListener("contextmenu", state.serialContextMenuHandler);
    } catch {
      // Listener cleanup is best-effort.
    }
  }
  state.serialContextMenuContainer = null;
  state.serialContextMenuHandler = null;
  state.serialKeyHandlerAttached = false;
}

function setupSerialTerminalHelpers(): void {
  const container = $("serial-console");
  const term = getSerialTerm();
  if (!container || !term) return;

  if (!state.serialResizeObserver && "ResizeObserver" in window) {
    state.serialResizeObserver = new ResizeObserver(() => scheduleSerialFit());
    state.serialResizeObserver.observe(container);
  }

  if (!state.serialWriteDisposable && typeof term.onWriteParsed === "function") {
    state.serialWriteDisposable = term.onWriteParsed(() => scheduleSerialScrollToBottom());
  }

  if (!state.serialKeyHandlerAttached && typeof term.attachCustomKeyEventHandler === "function") {
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== "keydown") return true;
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return true;
      if (String(event.key || "").toLowerCase() !== "c") return true;
      try {
        vmApi()?.serial0_send?.("\x03");
      } catch {
        // Serial interrupt is best-effort.
      }
      return false;
    });
    state.serialKeyHandlerAttached = true;
  }

  if (!state.serialContextMenuHandler) {
    state.serialContextMenuHandler = (_event: Event) => {
      const selected = getSerialSelectionText(term);
      if (selected) primeSerialClipboardTextarea(term, container, selected);
    };
    container.addEventListener("contextmenu", state.serialContextMenuHandler);
    state.serialContextMenuContainer = container;
  }

  try {
    if (!term.options) term.options = {};
    term.options.scrollback = 0;
    term.options.cursorBlink = true;
  } catch {
    // xterm option assignment is best-effort.
  }

  scheduleSerialFit({ focus: true });
}

function resetSerialConsoleDom(): void {
  teardownSerialTerminalHelpers();
  const serialConsole = $("serial-console");
  if (serialConsole) serialConsole.replaceChildren();
}

export function focusSerialConsole(): void {
  const activeTab = getActiveConsoleTab();
  const activeTerm = asTerminalLike(activeTab?.term);
  if (activeTerm?.focus && document.body.classList.contains("xterm-direct-console-mode")) {
    try {
      activeTerm.focus();
      return;
    } catch {
      // Fall through to the boot serial console.
    }
  }
  const term = getSerialTerm();
  if (term?.focus) {
    try {
      term.focus();
    } catch {
      // Focus is best-effort.
    }
  }
}

async function resyncVmAfterRestore(): Promise<void> {
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
    const consolesSynced = await syncConsoleTabsFromDaemon({ repaint: false, createMissing: true }).catch(() => false);
    if (consolesSynced) {
      const restoredCount = Math.max(0, state.consoleTabs.tabs.length - before);
      logTool(`[snapshot] consolas xterm sincronizadas con el snapshot${restoredCount ? ` (${restoredCount} pestaña(s) restaurada(s))` : ""}.${NL}`);
    } else {
      logTool(`[snapshot] aviso: no se pudo listar sesiones xterm restauradas.${NL}`);
    }
  }

  renderConsoleTabs();
  syncDiskCheckButton();
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
  const cfg = getConfig();
  const runtime = getVmRuntimeConfig();
  const startButton = $("start-vm");

  if (state.vmStarting) return;
  if (state.vm) {
    setBadge($("vm-detail"), state.vmReady ? t("vm.badge.shellReady") : t("vm.badge.alreadyBooted"), state.vmReady ? "good" : "warn");
    focusSerialConsole();
    return;
  }

  if (restoreStateBuffer) {
    logTool(`${NL}[snapshot] restaurando snapshot. Debes usar la misma RAM/disco/configuración que al guardarlo. Los discos hda no están incluidos en el snapshot.${NL}`);
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
    if (runtime.hda) {
      setLoading(true, {
        title: t("vm.loading.preparing"),
        detail: t("vm.loading.checkingDisk"),
        percent: null,
        indeterminate: true,
        ...startCancelOptions,
      });
      await nextPaint();
      const diskCheck = await checkAsset(runtime.hda.url, { signal: startAbortController.signal });
      throwIfAborted(startAbortController.signal);
      if (!diskCheck.ok) {
        setBadge($("vm-detail"), t("vm.badge.diskNotFound"), "bad");
        logTool(`${NL}[host] no existe la imagen de disco ${runtime.hda.url}. Genera esa imagen raw o usa Disco: RAM/initramfs.${NL}`);
        setLoading(false);
        return;
      }
    }

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
    state.diskMounted = false;
    state.snapshotRestoring = Boolean(restoreStateBuffer);
    resetConsoleTabs();
    syncDiskCheckButton();
    syncSnapshotButtons();

    const relayUrl = getWsRelayUrl();
    logTool(`[network] v86 ne2k net_device.relay_url = ${relayUrl}${NL}`);
    logTool(`[host] RAM ${runtime.ramMb} MB · VRAM ${runtime.vramMb} MB · Disco ${runtime.hda ? runtime.hda.url : "initramfs/RAM"}${NL}`);
    if (cfg.profile) logTool(`[profile] ${cfg.profile.name || cfg.profile.id} · ${cfg.profile.output || ""}${NL}`);
    else logTool(`[profile] libre / manual${NL}`);

    const vm = new Starter({
      wasm_path: cfg.wasm,
      memory_size: runtime.ramMb * 1024 * 1024,
      vga_memory_size: runtime.vramMb * 1024 * 1024,
      bios: { buffer: buffers.bios },
      vga_bios: { buffer: buffers.vgaBios },
      bzimage: { buffer: buffers.bzimage },
      ...(buffers.initrd ? { initrd: { buffer: buffers.initrd } } : {}),
      ...(runtime.hda ? { hda: { url: runtime.hda.url, async: true, size: runtime.hda.sizeMb * 1024 * 1024 } } : {}),
      // NE2000/RTL8029. v86 creates this as PCI 10ec:8029 and Alpine loads it with ne2k-pci.
      net_device: { type: "ne2k", relay_url: relayUrl },
      filesystem: {},
      // UART1 is reserved for non-interactive background tools.
      // UART2 is reserved for the browser xterm/PTY daemon.
      // serial0/ttyS0 remains the boot console and fallback.
      uart1: true,
      uart2: true,
      cmdline: "rw rdinit=/init console=ttyS0,115200 console=tty0 edd=off nowatchdog tsc=reliable mitigations=off random.trust_cpu=on",
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
          resyncVmAfterRestore().catch((error: unknown) => {
            logTool(`[snapshot] aviso resync restore: ${errorMessage(error)}${NL}`);
            maybeConfigureNetwork();
          });
        }, 300);
      } catch (error) {
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
    state.diskMounted = false;
    syncDiskCheckButton();
    setLoading(false);
  } finally {
    if (state.vmStartAbortController === startAbortController) state.vmStartAbortController = null;
    state.vmStarting = false;
    setVmOptionsLocked(Boolean(state.vm));
    syncPowerButtons();
    syncDiskCheckButton();
    syncSnapshotButtons();
  }
}

export async function stopVm({ confirmShutdown = true }: StopVmOptions = {}): Promise<void> {
  const vm = vmApi();
  if (!vm || state.vmStarting || state.agentBusy || state.pending || state.bgTools.pending) return;

  if (confirmShutdown) {
    const ok = await confirmVmShutdown();
    if (!ok) return;
  }

  setDisabled($("stop-vm"), true);
  setDisabled($("start-vm"), true);
  setAgentBusy(true, t("vm.badge.shuttingDown"));
  setBadge($("badge-vm"), t("vm.badge.stopping"), "warn");
  setBadge($("vm-detail"), t("vm.badge.poweringOff"), "warn");
  logTool(`${NL}[host] apagando VM...${NL}`);

  try {
    if (state.vmReady && typeof vm.serial0_send === "function") {
      try {
        vm.serial0_send(`sync${NL}`);
      } catch {
        // Shutdown sync is best-effort.
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 250);
      });
    }

    if (typeof vm.stop === "function") {
      try {
        await vm.stop();
      } catch (error) {
        logTool(`[host] aviso stop(): ${errorMessage(error)}${NL}`);
      }
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
    state.diskMounted = false;
    resetConsoleTabs();
    setAgentBusy(false);
    setVmOptionsLocked(false);
    setBadge($("badge-vm"), t("common.v86Inactive"), "");
    setBadge($("vm-detail"), t("common.offLower"), "");
    syncPowerButtons();
    syncDiskCheckButton();
    syncSnapshotButtons();
    logTool(`[host] VM apagada. Puedes cambiar RAM/disco y arrancar de nuevo.${NL}`);
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
    syncDiskCheckButton();
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
