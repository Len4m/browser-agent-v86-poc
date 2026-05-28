// @ts-nocheck
// Browser Agent v86 - direct xterm console sessions
// Tab 1 uses the real boot serial0 xterm. Extra tabs use PTYs inside
// the VM through the serial2 daemon.

function getConsoleTab(id) {
  return state.consoleTabs.tabs.find((tab) => tab.id === id) || null;
}

function getActiveConsoleTab() {
  return getConsoleTab(state.consoleTabs.activeId)
    || state.consoleTabs.tabs.find((tab) => tab.owner === "human")
    || null;
}

function isConsoleControlBusy() {
  return Boolean(state.pending || state.agentBusy || state.consoleTabs.controlBusy);
}

function isSerialConsoleTab(tab) {
  return tab?.transport === "serial0" || tab?.id === "human-1";
}

function rawSerialSend(text) {
  const active = getActiveConsoleTab();
  if (active?.sessionId && !isSerialConsoleTab(active) && window.BA_CONSOLE_CONTROL?.sendInput) {
    return window.BA_CONSOLE_CONTROL.sendInput(active.sessionId, text);
  }
  if (!state.vm?.serial0_send) return false;
  try {
    state.vm.serial0_send(text);
    return true;
  } catch (error) {
    logTool(`${NL}[consola] error enviando entrada: ${error.message}${NL}`);
    return false;
  }
}

function ensureDirectConsoleHost() {
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

function directConsoleCols() {
  return state.consoleTabs.fixedCols || 100;
}

function directConsoleRows() {
  return state.consoleTabs.fixedRows || 24;
}

function getNextHumanConsoleNumber() {
  const used = new Set(state.consoleTabs.tabs.map((tab) => Number(tab.humanNumber || 0)));
  for (let i = 1; i <= state.consoleTabs.maxHumanConsoles; i += 1) {
    if (!used.has(i)) return i;
  }
  return 0;
}

function disposeConsoleTab(tab) {
  if (!tab) return;
  if (tab.inputDisposable?.dispose) {
    try { tab.inputDisposable.dispose(); } catch {}
  }
  tab.inputDisposable = null;
  if (tab.term?.dispose) {
    try { tab.term.dispose(); } catch {}
  }
  tab.term = null;
  if (tab.container?.remove) {
    try { tab.container.remove(); } catch {}
  }
  tab.container = null;
}

function writeToConsoleTab(tab, bytes) {
  if (!tab?.term) return;
  try {
    tab.term.write(bytes);
  } catch {
    try { tab.term.write(new TextDecoder().decode(bytes)); } catch {}
  }
  try { tab.term.scrollToBottom?.(); } catch {}
}

function findConsoleTabBySession(sessionId) {
  return state.consoleTabs.tabs.find((item) => item.sessionId === String(sessionId)) || null;
}

function shouldConfirmConsoleClose(tab) {
  return Boolean(tab?.userInputSeen && tab.status !== "closed" && !isSerialConsoleTab(tab));
}

function defaultConsoleTitle(tab) {
  return String(tab?.humanNumber || 1);
}

function displayConsoleTitle(tab) {
  return String(tab?.title || defaultConsoleTitle(tab));
}

function shortConsoleLabel(tab) {
  const title = displayConsoleTitle(tab).trim();
  const fallback = defaultConsoleTitle(tab);
  return title || fallback;
}

async function renameConsoleTab(id) {
  const tab = getConsoleTab(id);
  if (!tab || tab.owner !== "human" || isConsoleControlBusy()) return;
  if (state.consoleTabs.renameOpen) return;

  const currentTitle = displayConsoleTitle(tab);
  let next = null;

  state.consoleTabs.renameOpen = true;
  try {
    if (typeof showBaModalPanel === "function") {
      const inputId = "ba-console-rename-input";
      let modalValue = currentTitle;
      const result = await showBaModalPanel({
        title: `Renombrar ${currentTitle}`,
        closeOnBackdrop: false,
        buttons: [
          { id: "cancel", label: "Cancelar", variant: "secondary", cancel: true },
          { id: "save", label: "Guardar", variant: "primary" },
        ],
        onMount(bodyEl) {
          const wrap = document.createElement("label");
          wrap.className = "ba-console-rename-field";
          wrap.textContent = "Nombre";

          const input = document.createElement("input");
          input.id = inputId;
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
              $("ba-modal-actions")?.querySelector(".ba-modal-button.primary")?.click?.();
            }
          });

          wrap.appendChild(input);
          bodyEl.appendChild(wrap);
          window.setTimeout(() => {
            try {
              input.focus();
              input.select();
            } catch {}
          }, 0);
        },
      });
      if (result !== "save") return;
      next = modalValue;
    } else {
      next = window.prompt("Nombre", currentTitle);
      if (next === null) return;
    }
  } finally {
    state.consoleTabs.renameOpen = false;
  }

  const clean = String(next).replace(/\s+/g, " ").trim().slice(0, 32);
  tab.title = clean || defaultConsoleTitle(tab);
  renderConsoleTabs();
}

function handleConsoleTabClick(event, tab) {
  event.preventDefault();
  event.stopPropagation();

  if (state.consoleTabs.clickTimer) {
    window.clearTimeout(state.consoleTabs.clickTimer);
    state.consoleTabs.clickTimer = 0;
  }

  if (event.detail >= 2) {
    renameConsoleTab(tab.id);
    return;
  }

  state.consoleTabs.clickTimer = window.setTimeout(() => {
    state.consoleTabs.clickTimer = 0;
    selectConsoleTab(tab.id);
  }, 180);
}

async function ensureConsoleSession(tab) {
  if (isSerialConsoleTab(tab)) {
    tab.status = state.vmReady ? "ready" : "pending";
    return { code: 0, stdout: "", stderr: "" };
  }
  if (!tab?.sessionId || !window.BA_CONSOLE_CONTROL?.createSession) return { code: 1, stderr: "control de consola no disponible" };
  tab.status = "connecting";
  renderConsoleTabs();
  const result = await window.BA_CONSOLE_CONTROL.createSession(tab.sessionId, {
    cols: directConsoleCols(),
    rows: directConsoleRows(),
  });
  tab.status = result.code === 0 ? "ready" : "error";
  if (result.code === 0) tab.userInputSeen = false;
  return result;
}

async function restartConsoleTab(tab, { announce = true } = {}) {
  if (!tab || tab.restarting) return false;
  tab.restarting = true;
  try {
    try {
      tab.term?.clear?.();
      tab.term?.write?.("\x1b[3J\x1b[H\x1b[2J");
      if (announce) tab.term?.write?.("[reiniciando consola]\r\n");
    } catch {}
    const result = await ensureConsoleSession(tab);
    if (result.code !== 0) {
      tab.term?.write?.(`\r\n[error reiniciando PTY: ${result.stderr || result.stdout || result.code}]\r\n`);
      return false;
    }
    window.setTimeout(() => tab.term?.focus?.(), 100);
    return true;
  } finally {
    tab.restarting = false;
    renderConsoleTabs();
  }
}

function handleConsoleClosedEvent(sessionId) {
  const tab = findConsoleTabBySession(sessionId);
  if (!tab) return;
  tab.status = "closed";
  renderConsoleTabs();

  tab.term?.write?.("\r\n[la shell termino; puedes refrescar para reiniciar o cerrar esta consola]\r\n");
}

function ensureConsoleOutputSubscription() {
  if (state.consoleTabs.outputDisposable || !window.BA_CONSOLE_CONTROL?.onOutput) return;
  state.consoleTabs.outputDisposable = window.BA_CONSOLE_CONTROL.onOutput((sessionId, bytes) => {
    const tab = findConsoleTabBySession(sessionId);
    if (tab) writeToConsoleTab(tab, bytes);
  });
  state.consoleTabs.eventDisposable = window.BA_CONSOLE_CONTROL.onEvent?.((event) => {
    if (event?.type === "closed") {
      handleConsoleClosedEvent(event.sessionId);
    }
  });
}

function createBrowserTerminal(tab) {
  if (isSerialConsoleTab(tab)) return getSerialTerm();
  if (tab.term) return tab.term;
  const host = ensureDirectConsoleHost();
  if (!host || !window.Terminal) return null;

  const container = document.createElement("div");
  container.className = "xterm-console-pane";
  container.dataset.consoleId = tab.id;
  container.hidden = tab.id !== state.consoleTabs.activeId;
  host.appendChild(container);

  const term = new window.Terminal({
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

  term.open(container);
  tab.container = container;
  tab.term = term;
  if (typeof term.attachCustomKeyEventHandler === "function") {
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return true;
      if (String(event.key || "").toLowerCase() !== "c") return true;
      if (typeof term.hasSelection === "function" && term.hasSelection()) return true;
      if (tab.status !== "closed" && tab.sessionId) {
        tab.userInputSeen = true;
        window.BA_CONSOLE_CONTROL?.sendInput?.(tab.sessionId, "\x03");
      }
      return false;
    });
  }
  tab.inputDisposable = term.onData((data) => {
    if (!tab.sessionId) return;
    if (tab.status === "closed") return;
    if (data) tab.userInputSeen = true;
    window.BA_CONSOLE_CONTROL?.sendInput?.(tab.sessionId, data);
  });

  try { term.focus(); } catch {}
  return term;
}

function setActiveConsolePane(id) {
  const active = getConsoleTab(id);
  const serialActive = isSerialConsoleTab(active);
  document.body.classList.toggle("console-serial-active", serialActive);
  document.body.classList.toggle("console-extra-active", Boolean(active && !serialActive));
  for (const tab of state.consoleTabs.tabs) {
    if (tab.container) tab.container.hidden = tab.id !== id;
  }
  if (serialActive) scheduleSerialFit({ focus: false });
}

async function finalizeConsoleTabsReady({ extraReady = true } = {}) {
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

  for (const tab of state.consoleTabs.tabs) {
    createBrowserTerminal(tab);
  }
  setActiveConsolePane(state.consoleTabs.activeId);
  renderConsoleTabs();

  for (const tab of state.consoleTabs.tabs) {
    if (isSerialConsoleTab(tab)) {
      tab.status = state.vmReady ? "ready" : "pending";
      continue;
    }
    if (!state.consoleTabs.extraReady) {
      tab.status = "error";
      continue;
    }
    const result = await ensureConsoleSession(tab);
    if (result.code !== 0 && tab.term) tab.term.write(`\r\n[error creando PTY: ${result.stderr || result.stdout || result.code}]\r\n`);
  }

  renderConsoleTabs();
  window.setTimeout(() => {
    focusSerialConsole();
  }, 120);
  logTool(`[consola] pestaña 1 por serial0; pestañas 2-4 por PTY serial2.${NL}`);
}

function failConsoleTabsInit(message = "consola xterm no disponible") {
  if (state.consoleTabs.initTimer) {
    window.clearTimeout(state.consoleTabs.initTimer);
    state.consoleTabs.initTimer = 0;
  }
  state.consoleTabs.initializing = false;
  state.consoleTabs.ready = false;
  setConsoleTabsStatus(message, "bad");
  renderConsoleTabs();
  logTool(`${NL}[consola] ${message}. Reconstruye perfiles con npm run setup y recarga sin cache.${NL}`);
}

function setConsoleTabsStatus(text, tone = "") {
  const status = $("console-tabs-status");
  if (status) setBadge(status, text, tone);
}

async function syncConsoleTabsFromDaemon({ repaint = true } = {}) {
  if (!state.vm || !state.vmReady || !window.BA_CONSOLE_CONTROL?.listSessions) return false;
  const sessions = await window.BA_CONSOLE_CONTROL.listSessions().catch(() => []);
  if (!Array.isArray(sessions)) return false;
  state.consoleTabs.extraReady = true;
  const seen = new Set();
  for (const session of sessions) {
    seen.add(String(session.id));
    const tab = findConsoleTabBySession(session.id);
    if (tab) tab.status = session.alive ? "ready" : "closed";
  }
  for (const tab of state.consoleTabs.tabs) {
    if (!isSerialConsoleTab(tab) && tab.owner === "human" && tab.sessionId && tab.status === "ready" && !seen.has(String(tab.sessionId))) {
      tab.status = "closed";
    }
  }
  if (repaint) renderConsoleTabs();
  return true;
}

function syncConsoleInputLock() {
  document.body.classList.remove("console-readonly");
  const overlay = $("vm-lock-overlay");
  if (!overlay) return;
  if (state.agentBusy) return;
  overlay.dataset.readonlyMessage = "";
  overlay.textContent = "";
}

function renderConsoleTabs() {
  const list = $("console-tabs-list");
  const cancelButton = $("cancel-tool");
  const newButton = $("new-console");
  const redrawButton = $("redraw-console");
  const closeConsoleButton = $("close-console");
  if (!list) return;

  const active = getActiveConsoleTab();
  const busy = isConsoleControlBusy();
  const humanCount = state.consoleTabs.tabs.filter((tab) => tab.owner === "human").length;
  const ready = Boolean(state.consoleTabs.ready);
  const extraReady = Boolean(state.consoleTabs.extraReady);

  list.replaceChildren();
  for (const tab of state.consoleTabs.tabs) {
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
    button.title = `${displayConsoleTitle(tab)} · doble clic para renombrar · ${
      isSerialConsoleTab(tab)
      ? "Pestaña serial0 real de arranque de la VM."
      : "Pestaña xterm con PTY propia dentro de la VM."
    }`;
    button.addEventListener("click", (event) => handleConsoleTabClick(event, tab));

    if (tab.closable) {
      const close = document.createElement("span");
      close.className = "console-tab-close";
      close.textContent = "×";
      close.title = "Cerrar consola";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeHumanConsoleTab(tab.id);
      });
      button.appendChild(close);
    }

    list.appendChild(button);
  }

  if (cancelButton) cancelButton.disabled = !state.bgTools?.pending;
  if (newButton) newButton.disabled = !ready || !extraReady || busy || humanCount >= state.consoleTabs.maxHumanConsoles;
  if (redrawButton) redrawButton.disabled = !ready || busy || !active;
  if (closeConsoleButton) closeConsoleButton.disabled = !ready || busy || !active || !active.closable;

  if (state.consoleTabs.controlBusy) setConsoleTabsStatus("actualizando", "warn");
  else if (state.consoleTabs.ready) setConsoleTabsStatus(extraReady ? `${humanCount}/4 consolas` : "solo serial0", extraReady ? "good" : "warn");
  else if (state.consoleTabs.initializing) setConsoleTabsStatus("iniciando xterm", "warn");
  else setConsoleTabsStatus("sin consola", "");

  syncConsoleInputLock();
}

function resetConsoleTabs() {
  if (state.consoleTabs.outputDisposable?.dispose) {
    try { state.consoleTabs.outputDisposable.dispose(); } catch {}
  }
  if (state.consoleTabs.eventDisposable?.dispose) {
    try { state.consoleTabs.eventDisposable.dispose(); } catch {}
  }
  for (const tab of state.consoleTabs.tabs || []) disposeConsoleTab(tab);
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

async function initConsoleTabsAfterBoot() {
  if (!state.vm || !state.vmReady || state.consoleTabs.ready || state.consoleTabs.initializing) return;
  if (state.pending || state.agentBusy) {
    window.setTimeout(() => initConsoleTabsAfterBoot(), 500);
    return;
  }
  if (!window.Terminal) {
    failConsoleTabsInit("xterm.js no cargado");
    return;
  }

  state.consoleTabs.initializing = true;
  renderConsoleTabs();
  logTool(`${NL}[consola] esperando daemon xterm/PTY por serial2...${NL}`);

  const ready = await window.BA_CONSOLE_CONTROL?.probeRunnerReady?.({ timeoutMs: 3500 }).catch(() => false);
  if (!ready) {
    logTool(`${NL}[consola] aviso: daemon xterm/PTY no disponible; queda activa la pestaña 1 por serial0.${NL}`);
    await finalizeConsoleTabsReady({ extraReady: false });
    return;
  }
  await finalizeConsoleTabsReady({ extraReady: true });
}

async function selectConsoleTab(id, { force = false } = {}) {
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
    try { tab.term?.focus?.(); } catch {}
  } else {
    blurSerialConsole();
  }
  return true;
}

async function createHumanConsoleTab() {
  if (!state.consoleTabs.ready || isConsoleControlBusy()) return;
  if (!state.consoleTabs.extraReady) return;
  const humanCount = state.consoleTabs.tabs.filter((tab) => tab.owner === "human").length;
  if (humanCount >= state.consoleTabs.maxHumanConsoles) return;
  const number = getNextHumanConsoleNumber();
  if (!number) return;

  const tab = {
    id: `human-${number}`,
    owner: "human",
    title: String(number),
    sessionId: String(number),
    humanNumber: number,
    closable: true,
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
      tab.term?.write?.(`\r\n[error creando PTY: ${result.stderr || result.stdout || result.code}]\r\n`);
    }
  } finally {
    state.consoleTabs.controlBusy = false;
    renderConsoleTabs();
    window.setTimeout(() => tab.term?.focus?.(), 100);
  }
}

async function redrawConsoleScreen(tab, { sync = true } = {}) {
  if (!tab) return false;
  if (isSerialConsoleTab(tab)) {
    try {
      const term = getSerialTerm();
      term?.clear?.();
      term?.write?.("\x1b[3J\x1b[H\x1b[2J");
    } catch {}
    state.vm?.serial0_send?.("\x0c");
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
  } catch {}
  window.BA_CONSOLE_CONTROL?.sendInput?.(tab.sessionId, "\x0c");
  window.setTimeout(() => tab.term?.focus?.(), 100);
  return true;
}

async function redrawActiveConsoleScreen() {
  if (!state.consoleTabs.ready || isConsoleControlBusy()) return;
  const tab = getActiveConsoleTab();
  if (!tab) return;
  await redrawConsoleScreen(tab, { sync: true });
  renderConsoleTabs();
}

async function closeHumanConsoleTab(id) {
  if (!state.consoleTabs.ready || isConsoleControlBusy()) return;
  const tab = getConsoleTab(id);
  if (!tab || tab.owner !== "human" || !tab.closable) return;

  if (shouldConfirmConsoleClose(tab)) {
    const decision = await showBaModal({
      title: `Cerrar ${tab.title}`,
      message: "Cerrar la consola terminara el shell y cualquier proceso activo dentro de esa PTY.",
      detail: "Las otras consolas y las tools por serial1 no se veran afectadas.",
      buttons: [
        { id: "cancel", label: "Mantener abierta", variant: "secondary", cancel: true },
        { id: "close", label: "Cerrar y detener", variant: "danger" },
      ],
    });
    if (decision !== "close") return;
  }

  state.consoleTabs.controlBusy = true;
  try {
    const result = tab.status === "closed"
      ? { code: 0 }
      : await window.BA_CONSOLE_CONTROL.closeSession(tab.sessionId);
    if (result.code !== 0) {
      logTool(`${NL}[consola] no se pudo cerrar ${tab.title}: ${result.stderr || `exit ${result.code}`}${NL}`);
      return;
    }
    state.consoleTabs.tabs = state.consoleTabs.tabs.filter((item) => item.id !== tab.id);
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

function cancelCurrentTool() {
  if (window.BA_BG_TOOLS?.cancelCurrent) {
    window.BA_BG_TOOLS.cancelCurrent();
    return;
  }
  if (!state.pending) return;
  const pending = state.pending;
  logTool(`${NL}[tool] cancelando con Ctrl+C...${NL}`);
  rawSerialSend("\x03");

  window.setTimeout(() => {
    if (state.pending !== pending) return;
    window.clearTimeout(pending.timer);
    state.pending = null;
    pending.resolve({ code: 130, stdout: trimLines(pending.raw), stderr: "cancelado por el usuario" });
  }, 1800);
}

function escapeConsoleHelpHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function consoleHelpKbd(parts) {
  return parts.map((part) => `<kbd>${escapeConsoleHelpHtml(part)}</kbd>`).join('<span class="ba-console-help-plus">+</span>');
}

function buildConsoleHelpHtml() {
  return `
    <div class="ba-console-help">
      <p class="ba-console-help-lead">
        La pestaña 1 usa <strong>serial0</strong>; las pestañas extra usan <strong>xterm.js</strong> con PTY real dentro de la VM.
      </p>

      <section class="ba-console-help-section">
        <h4>Modelo de consola</h4>
        <ul class="ba-console-help-list">
          <li><strong>Pestaña 1</strong> es la consola real de arranque por <code>serial0</code>.</li>
          <li><strong>Pestañas 2-4</strong> tienen shell y PTY propios por <code>serial2</code>.</li>
          <li><strong>Programas de pantalla completa</strong> como <code>nano</code>, <code>vim</code>, <code>watch</code>, <code>top</code> o <code>less</code> escriben directamente en el xterm de su pestaña.</li>
          <li><strong>Herramientas del LLM y comprobaciones</strong> siguen ejecutandose por <code>serial1</code> / <code>ttyS1</code>, separadas de estas consolas.</li>
        </ul>
      </section>

      <section class="ba-console-help-section">
        <h4>Navegador</h4>
        <ul class="ba-console-help-list">
          <li><strong>Pestañas</strong>: clic para cambiar y doble clic sobre el nombre para renombrar.</li>
          <li>Haz <strong>clic dentro de la consola</strong> antes de escribir para asegurar el foco.</li>
          <li><strong>Pegar</strong>: ${consoleHelpKbd(["Ctrl", "Shift", "V"])} o menu contextual del navegador.</li>
          <li><strong>Cancelar proceso</strong>: ${consoleHelpKbd(["Ctrl", "C"])} dentro de la consola activa.</li>
        </ul>
      </section>

      <p class="ba-console-help-foot">
        El boton de refrescar limpia la pantalla local y envia <code>Ctrl+L</code> al shell activo. <code>Ctrl+C</code> interrumpe el proceso activo si no hay texto seleccionado.
      </p>
    </div>
  `;
}

function buildConsoleHelpPlainText() {
  return [
    "Consolas xterm directas",
    "",
    "- Hasta 4 consolas de usuario.",
    "- Pestaña 1 usa serial0 y muestra el arranque real.",
    "- Pestañas 2-4 tienen una PTY propia dentro de la VM.",
    "- Clic para cambiar de pestaña; doble clic en el nombre para renombrar.",
    "- No hay prefijos especiales para cambiar de consola.",
    "- nano, vim, watch, top y less se ejecutan directamente sobre la consola activa.",
    "- Tools y checks siguen separados por serial1/ttyS1.",
    "",
    "Navegador: clic en la consola para foco; pegar con Ctrl+Shift+V.",
  ].join("\n");
}

function showConsoleHelpModal() {
  if (typeof showBaModalPanel === "function") {
    showBaModalPanel({
      title: "Consolas xterm",
      onMount(bodyEl) {
        bodyEl.innerHTML = buildConsoleHelpHtml();
      },
      buttons: [{ id: "close", label: "Entendido", variant: "primary", cancel: true }],
    });
    return;
  }

  const detail = buildConsoleHelpPlainText();
  if (typeof showBaModal === "function") {
    showBaModal({
      title: "Consolas xterm",
      message: "Comportamiento de las consolas en Browser Agent v86.",
      detail,
      buttons: [{ id: "ok", label: "Entendido", variant: "primary", cancel: true }],
    });
    return;
  }

  alert(detail);
}
