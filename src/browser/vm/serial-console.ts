import { $, state } from "../app/state";

export interface SerialTerminal {
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

interface SerialVmApi {
  serial_adapter?: {
    term?: unknown;
    terminal?: unknown;
  };
  serial0_send?: (text: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asSerialTerminal(value: unknown): SerialTerminal | null {
  return isRecord(value) ? value : null;
}

function vmApi(): SerialVmApi | null {
  return isRecord(state.vm) ? state.vm : null;
}

export function getSerialTerm(): SerialTerminal | null {
  const adapter = vmApi()?.serial_adapter;
  if (!adapter) return null;
  return asSerialTerminal(adapter.term) || asSerialTerminal(adapter.terminal);
}

function getXtermCellSize(term: SerialTerminal | null, container: HTMLElement): { width: number; height: number } {
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

function sizeSerialContainerToGrid(container: HTMLElement, term: SerialTerminal, cols: number, rows: number): void {
  const cell = getXtermCellSize(term, container);
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
    term.refresh?.(0, Math.max(0, rows - 1));
    term.scrollToBottom?.();
  } catch {
    // Fitting the terminal is best-effort.
  }
}

export function focusBootSerialConsole(): void {
  try {
    getSerialTerm()?.focus?.();
  } catch {
    // Focus is best-effort.
  }
}

export function scheduleSerialFit({ focus = false }: { focus?: boolean } = {}): void {
  if (state.serialFitRaf) window.cancelAnimationFrame(state.serialFitRaf);
  state.serialFitRaf = window.requestAnimationFrame(() => {
    state.serialFitRaf = 0;
    fitSerialTerminal();
    if (focus) focusBootSerialConsole();
  });
}

function scheduleSerialScrollToBottom(): void {
  const term = getSerialTerm();
  if (!term || typeof term.scrollToBottom !== "function" || state.serialScrollRaf) return;
  state.serialScrollRaf = window.requestAnimationFrame(() => {
    state.serialScrollRaf = 0;
    try {
      term.scrollToBottom?.();
    } catch {
      // Scrolling xterm is best-effort.
    }
  });
}

function getSerialSelectionText(term: SerialTerminal | null): string {
  if (!term) return "";
  try {
    return typeof term.getSelection === "function" ? String(term.getSelection() || "") : "";
  } catch {
    return "";
  }
}

function getSerialHelperTextarea(term: SerialTerminal | null, container = $("serial-console")): HTMLTextAreaElement | null {
  if (term?.textarea instanceof HTMLTextAreaElement) return term.textarea;
  if (term?._core?.textarea instanceof HTMLTextAreaElement) return term._core.textarea;
  return container?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea") || null;
}

function primeSerialClipboardTextarea(term: SerialTerminal, container: HTMLElement, text: string): boolean {
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

export function teardownSerialTerminalHelpers(): void {
  try {
    state.serialResizeObserver?.disconnect();
  } catch {
    // ResizeObserver cleanup is best-effort.
  }
  state.serialResizeObserver = null;
  if (state.serialFitRaf) window.cancelAnimationFrame(state.serialFitRaf);
  if (state.serialScrollRaf) window.cancelAnimationFrame(state.serialScrollRaf);
  state.serialFitRaf = 0;
  state.serialScrollRaf = 0;
  try {
    state.serialWriteDisposable?.dispose?.();
  } catch {
    // xterm disposable cleanup is best-effort.
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

export function setupSerialTerminalHelpers(): void {
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
      if (event.type !== "keydown" || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return true;
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
    state.serialContextMenuHandler = () => {
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

export function resetSerialConsoleDom(): void {
  teardownSerialTerminalHelpers();
  $("serial-console")?.replaceChildren();
}
