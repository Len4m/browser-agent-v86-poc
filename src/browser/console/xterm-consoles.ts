// Browser Agent v86 - direct xterm console sessions.
// Tab 1 uses the real boot serial0 xterm. Extra tabs use PTYs inside the VM
// through the serial2 daemon.

import { $, NL, state, type ConsoleTab } from "../app/state";
import { t } from "../app/i18n";
import { trimLines } from "../app/text-utils";
import { appEvents } from "../core/events";
import { showBaModal, showBaModalPanel } from "../ui/modal";
import { blurSerialConsole, logTool, setBadge } from "../ui/status-controls";
import { backgroundToolsApi } from "../vm/background-tools-serial1";
import {
  getSerialTerm,
  focusSerialConsole,
  scheduleSerialFit,
} from "../vm/serial-vm";
import {
  consoleControlApi,
  type ConsoleControlResult,
  type ConsoleControlSession,
} from "../vm/console-control-serial2";

interface Disposable {
  dispose?: () => void;
}

interface XtermTerminal {
  write?: (data: string | Uint8Array) => void;
  clear?: () => void;
  dispose?: () => void;
  open?: (container: HTMLElement) => void;
  focus?: () => void;
  scrollToBottom?: () => void;
  hasSelection?: () => boolean;
  attachCustomKeyEventHandler?: (handler: (event: KeyboardEvent) => boolean) => void;
  onData?: (handler: (data: string) => void) => Disposable;
}

interface XtermConstructor {
  new (options: Record<string, unknown>): XtermTerminal;
}

type ManagedConsoleTab = ConsoleTab & {
  inputDisposable?: Disposable | null;
  term?: XtermTerminal | null;
  container?: HTMLElement | null;
  restarting?: boolean;
  restored?: boolean;
};

interface PendingCommand {
  raw: string;
  timer: number;
  resolve: (result: { code: number; stdout: string; stderr: string }) => void;
}

interface VmSerial0Api {
  serial0_send: (text: string) => void;
}

type XtermRuntimeWindow = Window & typeof globalThis & {
  Terminal?: unknown;
};

let initialized = false;
const decoder = new TextDecoder();

function xtermRuntimeWindow(): XtermRuntimeWindow {
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

function safeText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return `${value}`;
  if (typeof value === "symbol") return value.description ? `Symbol(${value.description})` : "Symbol()";
  if (typeof value === "function") return value.name ? `[function ${value.name}]` : "[function]";
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string") return json;
  } catch {
    // Fall through to a stable object tag.
  }
  return Object.prototype.toString.call(value);
}

function asManagedTab(tab: ConsoleTab): ManagedConsoleTab {
  return tab as ManagedConsoleTab;
}

function tabs(): ManagedConsoleTab[] {
  return state.consoleTabs.tabs.map(asManagedTab);
}

function asXtermTerminal(value: unknown): XtermTerminal | null {
  return isRecord(value) ? value : null;
}

function isXtermConstructor(value: unknown): value is XtermConstructor {
  return typeof value === "function";
}

function hasSerial0Send(value: unknown): value is VmSerial0Api {
  return isRecord(value) && typeof value.serial0_send === "function";
}

function vmSerial0Send(text: string): boolean {
  const vm = state.vm;
  if (!hasSerial0Send(vm)) return false;
  try {
    vm.serial0_send(text);
    return true;
  } catch (error) {
    logTool(`${NL}[consola] ${t("console.inputError", { error: errorMessage(error) })}${NL}`);
    return false;
  }
}

function isPendingCommand(value: unknown): value is PendingCommand {
  return isRecord(value)
    && typeof value.raw === "string"
    && typeof value.timer === "number"
    && typeof value.resolve === "function";
}

function successResult(): ConsoleControlResult {
  return { code: 0, stdout: "", stderr: "" };
}

function getConsoleTab(id: string): ManagedConsoleTab | null {
  return tabs().find((tab) => tab.id === id) || null;
}

export function getActiveConsoleTab(): ManagedConsoleTab | null {
  return getConsoleTab(state.consoleTabs.activeId)
    || tabs().find((tab) => tab.owner === "human")
    || null;
}

function isConsoleControlBusy(): boolean {
  return Boolean(state.pending || state.agentBusy || state.consoleTabs.controlBusy);
}

function isSerialConsoleTab(tab: ManagedConsoleTab | null | undefined): boolean {
  return tab?.transport === "serial0" || tab?.id === "human-1";
}

function rawSerialSend(text: string): boolean {
  const active = getActiveConsoleTab();
  if (active?.sessionId && !isSerialConsoleTab(active)) {
    return consoleControlApi.sendInput(active.sessionId, text);
  }
  return vmSerial0Send(text);
}

function ensureDirectConsoleHost(): HTMLElement | null {
  let host = $("xterm-console-host");
  if (host) return host;
  const shell = $("vm-console-shell");
  if (!shell) return null;
  host = document.createElement("div");
  host.id = "xterm-console-host";
  host.className = "xterm-console-host";
  shell.appendChild(host);
  return host;
}

function directConsoleCols(): number {
  return state.consoleTabs.fixedCols || 100;
}

function directConsoleRows(): number {
  return state.consoleTabs.fixedRows || 24;
}

function getNextHumanConsoleNumber(): number {
  const used = new Set(tabs().map((tab) => Number(tab.humanNumber || 0)));
  for (let i = 1; i <= state.consoleTabs.maxHumanConsoles; i += 1) {
    if (!used.has(i)) return i;
  }
  return 0;
}

function disposeConsoleTab(tab: ManagedConsoleTab | null): void {
  if (!tab) return;
  if (tab.inputDisposable?.dispose) {
    try {
      tab.inputDisposable.dispose();
    } catch {
      // xterm disposable cleanup is best-effort.
    }
  }
  tab.inputDisposable = null;
  if (tab.term?.dispose) {
    try {
      tab.term.dispose();
    } catch {
      // Terminal disposal is best-effort.
    }
  }
  tab.term = null;
  if (tab.container?.remove) {
    try {
      tab.container.remove();
    } catch {
      // DOM cleanup is best-effort.
    }
  }
  tab.container = null;
}

function writeToConsoleTab(tab: ManagedConsoleTab | null, bytes: Uint8Array): void {
  if (!tab?.term) return;
  try {
    tab.term.write?.(bytes);
  } catch {
    try {
      tab.term.write?.(decoder.decode(bytes));
    } catch {
      // Broken terminal writes are ignored.
    }
  }
  try {
    tab.term.scrollToBottom?.();
  } catch {
    // Scrolling is best-effort.
  }
}

function findConsoleTabBySession(sessionId: unknown): ManagedConsoleTab | null {
  return tabs().find((item) => item.sessionId === String(sessionId)) || null;
}

function shouldConfirmConsoleClose(tab: ManagedConsoleTab | null): boolean {
  return Boolean(tab?.userInputSeen && tab.status !== "closed" && !isSerialConsoleTab(tab));
}

function defaultConsoleTitle(tab: ManagedConsoleTab | null): string {
  return String(tab?.humanNumber || 1);
}

function displayConsoleTitle(tab: ManagedConsoleTab): string {
  return String(tab.title || defaultConsoleTitle(tab));
}

function shortConsoleLabel(tab: ManagedConsoleTab): string {
  const title = displayConsoleTitle(tab).trim();
  const fallback = defaultConsoleTitle(tab);
  return title || fallback;
}

async function renameConsoleTab(id: string): Promise<void> {
  const tab = getConsoleTab(id);
  if (!tab || tab.owner !== "human" || isConsoleControlBusy()) return;
  if (state.consoleTabs.renameOpen) return;

  const currentTitle = displayConsoleTitle(tab);
  let next: string | null = null;

  state.consoleTabs.renameOpen = true;
  try {
    let modalValue = currentTitle;
    const result = await showBaModalPanel({
      title: t("console.rename.title", { title: currentTitle }),
      closeOnBackdrop: false,
      buttons: [
        { id: "cancel", label: t("common.cancel"), variant: "secondary", cancel: true },
        { id: "save", label: t("common.save"), variant: "primary" },
      ],
      onMount(bodyEl) {
        const wrap = document.createElement("label");
        wrap.className = "ba-console-rename-field";
        wrap.textContent = t("console.rename.fieldLabel");

        const input = document.createElement("input");
        input.id = "ba-console-rename-input";
        input.type = "text";
        input.maxLength = 32;
        input.value = currentTitle;
        input.autocomplete = "off";
        input.spellcheck = false;
        input.addEventListener("input", () => {
          modalValue = input.value;
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            $("ba-modal-actions")?.querySelector<HTMLButtonElement>(".ba-modal-button.primary")?.click();
          }
        });

        wrap.appendChild(input);
        bodyEl.appendChild(wrap);
        window.setTimeout(() => {
          try {
            input.focus();
            input.select();
          } catch {
            // Focus is best-effort.
          }
        }, 0);
      },
    });
    if (result !== "save") return;
    next = modalValue;
  } finally {
    state.consoleTabs.renameOpen = false;
  }

  const clean = String(next).replace(/\s+/g, " ").trim().slice(0, 32);
  tab.title = clean || defaultConsoleTitle(tab);
  renderConsoleTabs();
}

function handleConsoleTabClick(event: MouseEvent, tab: ManagedConsoleTab): void {
  event.preventDefault();
  event.stopPropagation();

  if (state.consoleTabs.clickTimer) {
    window.clearTimeout(state.consoleTabs.clickTimer);
    state.consoleTabs.clickTimer = 0;
  }

  if (event.detail >= 2) {
    void renameConsoleTab(tab.id);
    return;
  }

  state.consoleTabs.clickTimer = window.setTimeout(() => {
    state.consoleTabs.clickTimer = 0;
    selectConsoleTab(tab.id);
  }, 180);
}

async function ensureConsoleSession(tab: ManagedConsoleTab): Promise<ConsoleControlResult> {
  if (isSerialConsoleTab(tab)) {
    tab.status = state.vmReady ? "ready" : "pending";
    return successResult();
  }
  if (!tab.sessionId) return { code: 1, stdout: "", stderr: t("console.controlUnavailable") };
  tab.status = "connecting";
  renderConsoleTabs();
  const result = await consoleControlApi.createSession(tab.sessionId, {
    cols: directConsoleCols(),
    rows: directConsoleRows(),
  });
  tab.status = result.code === 0 ? "ready" : "error";
  if (result.code === 0) tab.userInputSeen = false;
  return result;
}

async function restartConsoleTab(tab: ManagedConsoleTab | null, { announce = true }: { announce?: boolean } = {}): Promise<boolean> {
  if (!tab || tab.restarting) return false;
  tab.restarting = true;
  try {
    try {
      tab.term?.clear?.();
      tab.term?.write?.("\x1b[3J\x1b[H\x1b[2J");
      if (announce) tab.term?.write?.(`[${t("console.restarting")}]\r\n`);
    } catch {
      // Terminal repaint is best-effort.
    }
    const result = await ensureConsoleSession(tab);
    if (result.code !== 0) {
      tab.term?.write?.(`\r\n[${t("console.ptyRestartError", { error: result.stderr || result.stdout || result.code })}]\r\n`);
      return false;
    }
    window.setTimeout(() => tab.term?.focus?.(), 100);
    return true;
  } finally {
    tab.restarting = false;
    renderConsoleTabs();
  }
}

function handleConsoleClosedEvent(sessionId: string): void {
  const tab = findConsoleTabBySession(sessionId);
  if (!tab) return;
  tab.status = "closed";
  renderConsoleTabs();

  tab.term?.write?.(`\r\n[${t("console.shellEnded")}]\r\n`);
}

function ensureConsoleOutputSubscription(): void {
  if (state.consoleTabs.outputDisposable) return;
  state.consoleTabs.outputDisposable = consoleControlApi.onOutput((sessionId, bytes) => {
    const tab = findConsoleTabBySession(sessionId);
    if (tab) writeToConsoleTab(tab, bytes);
  });
  state.consoleTabs.eventDisposable = consoleControlApi.onEvent((event) => {
    if (event.type === "closed") {
      handleConsoleClosedEvent(event.sessionId);
    }
  });
}

function createBrowserTerminal(tab: ManagedConsoleTab): XtermTerminal | null {
  if (isSerialConsoleTab(tab)) return asXtermTerminal(getSerialTerm());
  if (tab.term) return tab.term;
  const host = ensureDirectConsoleHost();
  const Terminal = xtermRuntimeWindow().Terminal;
  if (!host || !isXtermConstructor(Terminal)) return null;

  const container = document.createElement("div");
  container.className = "xterm-console-pane";
  container.dataset.consoleId = tab.id;
  container.hidden = tab.id !== state.consoleTabs.activeId;
  host.appendChild(container);

  const term = new Terminal({
    cols: directConsoleCols(),
    rows: directConsoleRows(),
    cursorBlink: true,
    scrollback: 2000,
    convertEol: false,
    theme: {
      background: "#000000",
      foreground: "#e5e7eb",
      cursor: "#ffffff",
      selectionBackground: "#2563eb66",
    },
  });

  term.open?.(container);
  tab.container = container;
  tab.term = term;
  if (typeof term.attachCustomKeyEventHandler === "function") {
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== "keydown") return true;
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return true;
      if (String(event.key || "").toLowerCase() !== "c") return true;
      if (typeof term.hasSelection === "function" && term.hasSelection()) return true;
      if (tab.status !== "closed" && tab.sessionId) {
        tab.userInputSeen = true;
        consoleControlApi.sendInput(tab.sessionId, "\x03");
      }
      return false;
    });
  }
  tab.inputDisposable = term.onData?.((data) => {
    if (!tab.sessionId) return;
    if (tab.status === "closed") return;
    if (data) tab.userInputSeen = true;
    consoleControlApi.sendInput(tab.sessionId, data);
  }) || null;

  try {
    term.focus?.();
  } catch {
    // Initial terminal focus is best-effort.
  }
  return term;
}

function setActiveConsolePane(id: string): void {
  const active = getConsoleTab(id);
  const serialActive = isSerialConsoleTab(active);
  document.body.classList.toggle("console-serial-active", serialActive);
  document.body.classList.toggle("console-extra-active", Boolean(active && !serialActive));
  for (const tab of tabs()) {
    if (tab.container) tab.container.hidden = tab.id !== id;
  }
  if (serialActive) scheduleSerialFit({ focus: false });
}

export async function finalizeConsoleTabsReady({ extraReady = true }: { extraReady?: boolean } = {}): Promise<void> {
  if (!state.consoleTabs.initializing && state.consoleTabs.ready) return;
  if (state.consoleTabs.initTimer) {
    window.clearTimeout(state.consoleTabs.initTimer);
    state.consoleTabs.initTimer = 0;
  }

  state.consoleTabs.initializing = false;
  state.consoleTabs.ready = true;
  state.consoleTabs.extraReady = Boolean(extraReady);
  document.body.classList.add("xterm-direct-console-mode");
  document.body.classList.remove("xterm-direct-console-mode-pending");
  if (state.consoleTabs.extraReady) ensureConsoleOutputSubscription();

  if (!state.consoleTabs.tabs.length) {
    state.consoleTabs.tabs = [];
  }
  if (!getConsoleTab("human-1")) {
    state.consoleTabs.tabs.push({
      id: "human-1",
      owner: "human",
      title: "1",
      transport: "serial0",
      humanNumber: 1,
      closable: false,
      status: state.vmReady ? "ready" : "pending",
      userInputSeen: false,
    });
  }
  state.consoleTabs.activeId = state.consoleTabs.activeId || "human-1";

  for (const tab of tabs()) {
    createBrowserTerminal(tab);
  }
  setActiveConsolePane(state.consoleTabs.activeId);
  renderConsoleTabs();

  for (const tab of tabs()) {
    if (isSerialConsoleTab(tab)) {
      tab.status = state.vmReady ? "ready" : "pending";
      continue;
    }
    if (!state.consoleTabs.extraReady) {
      tab.status = "error";
      continue;
    }
    const result = await ensureConsoleSession(tab);
    if (result.code !== 0 && tab.term) {
      tab.term.write?.(`\r\n[${t("console.ptyCreateError", { error: result.stderr || result.stdout || result.code })}]\r\n`);
    }
  }

  renderConsoleTabs();
  window.setTimeout(() => {
    focusSerialConsole();
  }, 120);
  logTool(`[consola] ${t("console.tabsInfo")}${NL}`);
}

function failConsoleTabsInit(message = t("console.unavailable")): void {
  if (state.consoleTabs.initTimer) {
    window.clearTimeout(state.consoleTabs.initTimer);
    state.consoleTabs.initTimer = 0;
  }
  state.consoleTabs.initializing = false;
  state.consoleTabs.ready = false;
  setConsoleTabsStatus(message, "bad");
  renderConsoleTabs();
  logTool(`${NL}[consola] ${t("console.rebuildHint", { message })}${NL}`);
}

function setConsoleTabsStatus(text: string, tone = ""): void {
  const status = $("console-tabs-status");
  if (status) setBadge(status, text, tone);
}

function humanConsoleNumberForRestoredSession(sessionId: unknown): number {
  const value = Number.parseInt(safeText(sessionId), 10);
  const used = new Set(tabs().map((tab) => Number(tab.humanNumber || 0)));
  if (Number.isInteger(value) && value > 1 && value <= state.consoleTabs.maxHumanConsoles && !used.has(value)) {
    return value;
  }
  return getNextHumanConsoleNumber();
}

function sessionIdFrom(session: ConsoleControlSession): string {
  return safeText(session.id);
}

function sessionAlive(session: ConsoleControlSession): boolean {
  return Boolean(session.alive);
}

function ensureConsoleTabForDaemonSession(session: ConsoleControlSession): ManagedConsoleTab | null {
  const sessionId = sessionIdFrom(session);
  if (!sessionId || findConsoleTabBySession(sessionId)) return null;
  if (tabs().filter((tab) => tab.owner === "human").length >= state.consoleTabs.maxHumanConsoles) return null;

  const humanNumber = humanConsoleNumberForRestoredSession(sessionId);
  if (!humanNumber) return null;

  const tab: ManagedConsoleTab = {
    id: `human-${humanNumber}`,
    owner: "human",
    title: String(humanNumber),
    sessionId,
    humanNumber,
    closable: true,
    transport: "serial2",
    status: sessionAlive(session) ? "ready" : "closed",
    userInputSeen: false,
    restored: true,
  };
  state.consoleTabs.tabs.push(tab);
  createBrowserTerminal(tab);
  return tab;
}

export async function syncConsoleTabsFromDaemon({ repaint = true, createMissing = false }: { repaint?: boolean; createMissing?: boolean } = {}): Promise<boolean> {
  if (!state.vm || !state.vmReady) return false;
  const sessions = await consoleControlApi.listSessions().catch(() => []);
  if (!Array.isArray(sessions)) return false;
  state.consoleTabs.extraReady = true;
  ensureConsoleOutputSubscription();
  const seen = new Set<string>();
  for (const session of sessions) {
    const sessionId = sessionIdFrom(session);
    seen.add(sessionId);
    const tab = findConsoleTabBySession(sessionId)
      || (createMissing && sessionAlive(session) ? ensureConsoleTabForDaemonSession(session) : null);
    if (tab) tab.status = sessionAlive(session) ? "ready" : "closed";
  }
  for (const tab of tabs()) {
    if (!isSerialConsoleTab(tab) && tab.owner === "human" && tab.sessionId && tab.status === "ready" && !seen.has(String(tab.sessionId))) {
      tab.status = "closed";
    }
  }
  setActiveConsolePane(state.consoleTabs.activeId || "human-1");
  if (repaint) renderConsoleTabs();
  return true;
}

function syncConsoleInputLock(): void {
  document.body.classList.remove("console-readonly");
  const overlay = $("vm-lock-overlay");
  if (!overlay) return;
  if (state.agentBusy) return;
  overlay.dataset.readonlyMessage = "";
  overlay.textContent = "";
}

export function renderConsoleTabs(): void {
  const list = $("console-tabs-list");
  const cancelButton = $("cancel-tool");
  const newButton = $("new-console");
  const redrawButton = $("redraw-console");
  const closeConsoleButton = $("close-console");
  if (!list) return;

  const active = getActiveConsoleTab();
  const busy = isConsoleControlBusy();
  const humanCount = tabs().filter((tab) => tab.owner === "human").length;
  const ready = Boolean(state.consoleTabs.ready);
  const extraReady = Boolean(state.consoleTabs.extraReady);

  list.replaceChildren();
  for (const tab of tabs()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `console-tab ${tab.owner}`;
    button.classList.toggle("active", tab.id === state.consoleTabs.activeId);
    button.disabled = !ready || busy;
    const labelEl = document.createElement("span");
    labelEl.className = "console-tab-label";
    labelEl.textContent = shortConsoleLabel(tab);
    button.appendChild(labelEl);
    button.setAttribute("aria-label", displayConsoleTitle(tab));
    button.title = `${displayConsoleTitle(tab)} · ${t("console.tab.dblClickRename")} · ${
      isSerialConsoleTab(tab)
        ? t("console.tab.serialTooltip")
        : t("console.tab.ptyTooltip")
    }`;
    button.addEventListener("click", (event) => handleConsoleTabClick(event, tab));

    if (tab.closable) {
      const close = document.createElement("span");
      close.className = "console-tab-close";
      close.textContent = "×";
      close.title = t("common.closeConsole");
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void closeHumanConsoleTab(tab.id);
      });
      button.appendChild(close);
    }

    list.appendChild(button);
  }

  if (cancelButton instanceof HTMLButtonElement) cancelButton.disabled = !state.bgTools.pending;
  if (newButton instanceof HTMLButtonElement) newButton.disabled = !ready || !extraReady || busy || humanCount >= state.consoleTabs.maxHumanConsoles;
  if (redrawButton instanceof HTMLButtonElement) redrawButton.disabled = !ready || busy || !active;
  if (closeConsoleButton instanceof HTMLButtonElement) closeConsoleButton.disabled = !ready || busy || !active || !active.closable;

  if (state.consoleTabs.controlBusy) setConsoleTabsStatus(t("console.status.updating"), "warn");
  else if (state.consoleTabs.ready) setConsoleTabsStatus(extraReady ? t("console.status.count", { count: humanCount }) : t("console.status.serialOnly"), extraReady ? "good" : "warn");
  else if (state.consoleTabs.initializing) setConsoleTabsStatus(t("console.status.starting"), "warn");
  else setConsoleTabsStatus(t("console.status.none"), "");

  syncConsoleInputLock();
}

export function resetConsoleTabs(): void {
  if (state.consoleTabs.outputDisposable?.dispose) {
    try {
      state.consoleTabs.outputDisposable.dispose();
    } catch {
      // Subscription cleanup is best-effort.
    }
  }
  if (state.consoleTabs.eventDisposable?.dispose) {
    try {
      state.consoleTabs.eventDisposable.dispose();
    } catch {
      // Subscription cleanup is best-effort.
    }
  }
  for (const tab of tabs()) disposeConsoleTab(tab);
  state.consoleTabs.outputDisposable = null;
  state.consoleTabs.eventDisposable = null;
  if (state.consoleTabs.clickTimer) {
    window.clearTimeout(state.consoleTabs.clickTimer);
    state.consoleTabs.clickTimer = 0;
  }
  state.consoleTabs.ready = false;
  state.consoleTabs.extraReady = false;
  state.consoleTabs.initializing = false;
  state.consoleTabs.controlBusy = false;
  if (state.consoleTabs.initTimer) {
    window.clearTimeout(state.consoleTabs.initTimer);
    state.consoleTabs.initTimer = 0;
  }
  state.consoleTabs.activeId = "human-1";
  state.consoleTabs.tabs = [
    { id: "human-1", owner: "human", title: "1", transport: "serial0", humanNumber: 1, closable: false, status: "pending", userInputSeen: false },
  ];
  document.body.classList.remove("xterm-direct-console-mode");
  document.body.classList.remove("console-extra-active");
  document.body.classList.add("console-serial-active");
  document.body.classList.add("xterm-direct-console-mode-pending");
  renderConsoleTabs();
}

export async function initConsoleTabsAfterBoot(): Promise<void> {
  if (!state.vm || !state.vmReady || state.consoleTabs.ready || state.consoleTabs.initializing) return;
  if (state.pending || state.agentBusy) {
    window.setTimeout(() => {
      void initConsoleTabsAfterBoot();
    }, 500);
    return;
  }
  if (!isXtermConstructor(xtermRuntimeWindow().Terminal)) {
    failConsoleTabsInit(t("console.error.xtermNotLoaded"));
    return;
  }

  state.consoleTabs.initializing = true;
  renderConsoleTabs();
  logTool(`${NL}[consola] ${t("console.waitingDaemon")}${NL}`);

  const ready = await consoleControlApi.probeRunnerReady({ timeoutMs: 3500 }).catch(() => false);
  if (!ready) {
    logTool(`${NL}[consola] ${t("console.daemonUnavailable")}${NL}`);
    await finalizeConsoleTabsReady({ extraReady: false });
    return;
  }
  await finalizeConsoleTabsReady({ extraReady: true });
}

function selectConsoleTab(id: string, { force = false }: { force?: boolean } = {}): boolean {
  const tab = getConsoleTab(id);
  if (!tab) return false;
  if (!state.consoleTabs.ready && id !== state.consoleTabs.activeId) return false;
  if (isConsoleControlBusy() && !force) return false;

  state.consoleTabs.activeId = id;
  setActiveConsolePane(id);
  renderConsoleTabs();
  if (isSerialConsoleTab(tab)) {
    focusSerialConsole();
  } else if (tab.owner === "human") {
    try {
      tab.term?.focus?.();
    } catch {
      // Focus is best-effort.
    }
  } else {
    blurSerialConsole();
  }
  return true;
}

export async function createHumanConsoleTab(): Promise<void> {
  if (!state.consoleTabs.ready || isConsoleControlBusy()) return;
  if (!state.consoleTabs.extraReady) return;
  const humanCount = tabs().filter((tab) => tab.owner === "human").length;
  if (humanCount >= state.consoleTabs.maxHumanConsoles) return;
  const number = getNextHumanConsoleNumber();
  if (!number) return;

  const tab: ManagedConsoleTab = {
    id: `human-${number}`,
    owner: "human",
    title: String(number),
    sessionId: String(number),
    humanNumber: number,
    closable: true,
    transport: "serial2",
    status: "connecting",
    userInputSeen: false,
  };
  state.consoleTabs.tabs.push(tab);
  state.consoleTabs.activeId = tab.id;
  createBrowserTerminal(tab);
  setActiveConsolePane(tab.id);
  renderConsoleTabs();

  state.consoleTabs.controlBusy = true;
  try {
    const result = await ensureConsoleSession(tab);
    if (result.code !== 0) {
      tab.term?.write?.(`\r\n[${t("console.ptyCreateError", { error: result.stderr || result.stdout || result.code })}]\r\n`);
    }
  } finally {
    state.consoleTabs.controlBusy = false;
    renderConsoleTabs();
    window.setTimeout(() => tab.term?.focus?.(), 100);
  }
}

async function redrawConsoleScreen(tab: ManagedConsoleTab | null, { sync = true }: { sync?: boolean } = {}): Promise<boolean> {
  if (!tab) return false;
  if (isSerialConsoleTab(tab)) {
    try {
      const term = asXtermTerminal(getSerialTerm());
      term?.clear?.();
      term?.write?.("\x1b[3J\x1b[H\x1b[2J");
    } catch {
      // Serial redraw is best-effort.
    }
    vmSerial0Send("\x0c");
    window.setTimeout(() => focusSerialConsole(), 100);
    return true;
  }
  if (sync) await syncConsoleTabsFromDaemon({ repaint: false }).catch(() => false);
  if (tab.status === "closed") {
    return restartConsoleTab(tab);
  }
  try {
    tab.term?.clear?.();
    tab.term?.write?.("\x1b[3J\x1b[H\x1b[2J");
  } catch {
    // Terminal redraw is best-effort.
  }
  if (tab.sessionId) consoleControlApi.sendInput(tab.sessionId, "\x0c");
  window.setTimeout(() => tab.term?.focus?.(), 100);
  return true;
}

export async function redrawActiveConsoleScreen(): Promise<void> {
  if (!state.consoleTabs.ready || isConsoleControlBusy()) return;
  const tab = getActiveConsoleTab();
  if (!tab) return;
  await redrawConsoleScreen(tab, { sync: true });
  renderConsoleTabs();
}

export async function closeHumanConsoleTab(id: string | undefined): Promise<void> {
  if (!id || !state.consoleTabs.ready || isConsoleControlBusy()) return;
  const tab = getConsoleTab(id);
  if (!tab || tab.owner !== "human" || !tab.closable) return;

  if (shouldConfirmConsoleClose(tab)) {
    const decision = await showBaModal({
      title: t("console.close.title", { title: tab.title }),
      message: t("console.close.message"),
      detail: t("console.close.detail"),
      buttons: [
        { id: "cancel", label: t("console.close.keepOpen"), variant: "secondary", cancel: true },
        { id: "close", label: t("console.close.confirm"), variant: "danger" },
      ],
    });
    if (decision !== "close") return;
  }

  state.consoleTabs.controlBusy = true;
  try {
    const result = tab.status === "closed" || !tab.sessionId
      ? successResult()
      : await consoleControlApi.closeSession(tab.sessionId);
    if (result.code !== 0) {
      logTool(`${NL}[consola] ${t("console.closeFailed", { title: tab.title, error: result.stderr || `exit ${result.code}` })}${NL}`);
      return;
    }
    state.consoleTabs.tabs = tabs().filter((item) => item.id !== tab.id);
    disposeConsoleTab(tab);
    if (state.consoleTabs.activeId === tab.id) {
      state.consoleTabs.activeId = state.consoleTabs.tabs[0]?.id || "human-1";
      setActiveConsolePane(state.consoleTabs.activeId);
    }
  } finally {
    state.consoleTabs.controlBusy = false;
    renderConsoleTabs();
    focusSerialConsole();
  }
}

export function cancelCurrentTool(): void {
  if (backgroundToolsApi.cancelPending(t("bgtools.reason.user"))) return;
  if (!isPendingCommand(state.pending)) return;
  const pending = state.pending;
  logTool(`${NL}[tool] ${t("console.cancelTool.log")}${NL}`);
  rawSerialSend("\x03");

  window.setTimeout(() => {
    if (state.pending !== pending) return;
    window.clearTimeout(pending.timer);
    state.pending = null;
    pending.resolve({ code: 130, stdout: trimLines(pending.raw), stderr: t("common.cancelledByUser") });
  }, 1800);
}

function escapeConsoleHelpHtml(value: unknown): string {
  return safeText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function consoleHelpKbd(parts: string[]): string {
  return parts.map((part) => `<kbd>${escapeConsoleHelpHtml(part)}</kbd>`).join('<span class="ba-console-help-plus">+</span>');
}

function buildConsoleHelpHtml(): string {
  return `
    <div class="ba-console-help">
      <p class="ba-console-help-lead">
        ${t("console.help.lead")}
      </p>

      <section class="ba-console-help-section">
        <h4>${t("console.help.modelTitle")}</h4>
        <ul class="ba-console-help-list">
          <li>${t("console.help.model.tab1")}</li>
          <li>${t("console.help.model.tabs")}</li>
          <li>${t("console.help.model.fullscreen")}</li>
          <li>${t("console.help.model.tools")}</li>
        </ul>
      </section>

      <section class="ba-console-help-section">
        <h4>${t("console.help.browserTitle")}</h4>
        <ul class="ba-console-help-list">
          <li>${t("console.help.browser.tabs")}</li>
          <li>${t("console.help.browser.focus")}</li>
          <li>${t("console.help.browser.paste", { keys: consoleHelpKbd(["Ctrl", "Shift", "V"]) })}</li>
          <li>${t("console.help.browser.cancel", { keys: consoleHelpKbd(["Ctrl", "C"]) })}</li>
        </ul>
      </section>

      <p class="ba-console-help-foot">
        ${t("console.help.foot")}
      </p>
    </div>
  `;
}

function buildConsoleHelpPlainText(): string {
  return [
    t("console.helpText.title"),
    "",
    t("console.helpText.maxConsoles"),
    t("console.helpText.tab1"),
    t("console.helpText.tabs"),
    t("console.helpText.switch"),
    t("console.helpText.noPrefix"),
    t("console.helpText.fullscreen"),
    t("console.helpText.tools"),
    "",
    t("console.helpText.browser"),
  ].join("\n");
}

export function showConsoleHelpModal(): void {
  void showBaModalPanel({
    title: t("console.help.modalTitle"),
    onMount(bodyEl) {
      bodyEl.innerHTML = buildConsoleHelpHtml();
    },
    buttons: [{ id: "close", label: t("console.help.gotIt"), variant: "primary", cancel: true }],
  }).catch(() => {
    const detail = buildConsoleHelpPlainText();
    void showBaModal({
      title: t("console.help.modalTitle"),
      message: t("console.help.modalMessage"),
      detail,
      buttons: [{ id: "ok", label: t("console.help.gotIt"), variant: "primary", cancel: true }],
    });
  });
}

export function initXtermConsoles(): void {
  if (initialized) return;
  initialized = true;
  appEvents.on("console:state-changed", () => {
    try {
      renderConsoleTabs();
      syncConsoleInputLock();
    } catch {
      // Rendering during shared UI changes is best-effort.
    }
  });
  appEvents.on("app:language-changed", () => {
    try {
      renderConsoleTabs();
    } catch {
      // Rendering during language changes is best-effort.
    }
  });
}
