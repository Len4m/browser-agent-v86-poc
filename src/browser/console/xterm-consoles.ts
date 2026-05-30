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
    logTool(`${NL}[consola] ${t("console.inputError", { error: error.message })}${NL}`);
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
      next = window.prompt(t("console.rename.fieldLabel"), currentTitle);
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
  if (!tab?.sessionId || !window.BA_CONSOLE_CONTROL?.createSession) return { code: 1, stderr: t("console.controlUnavailable") };
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
      if (announce) tab.term?.write?.(`[${t("console.restarting")}]\r\n`);
    } catch {}
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

function handleConsoleClosedEvent(sessionId) {
  const tab = findConsoleTabBySession(sessionId);
  if (!tab) return;
  tab.status = "closed";
  renderConsoleTabs();

  tab.term?.write?.(`\r\n[${t("console.shellEnded")}]\r\n`);
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
    if (result.code !== 0 && tab.term) tab.term.write(`\r\n[${t("console.ptyCreateError", { error: result.stderr || result.stdout || result.code })}]\r\n`);
  }

  renderConsoleTabs();
  window.setTimeout(() => {
    focusSerialConsole();
  }, 120);
  logTool(`[consola] ${t("console.tabsInfo")}${NL}`);
}

function failConsoleTabsInit(message = t("console.unavailable")) {
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

  if (state.consoleTabs.controlBusy) setConsoleTabsStatus(t("console.status.updating"), "warn");
  else if (state.consoleTabs.ready) setConsoleTabsStatus(extraReady ? t("console.status.count", { count: humanCount }) : t("console.status.serialOnly"), extraReady ? "good" : "warn");
  else if (state.consoleTabs.initializing) setConsoleTabsStatus(t("console.status.starting"), "warn");
  else setConsoleTabsStatus(t("console.status.none"), "");

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
    failConsoleTabsInit(t("console.error.xtermNotLoaded"));
    return;
  }

  state.consoleTabs.initializing = true;
  renderConsoleTabs();
  logTool(`${NL}[consola] ${t("console.waitingDaemon")}${NL}`);

  const ready = await window.BA_CONSOLE_CONTROL?.probeRunnerReady?.({ timeoutMs: 3500 }).catch(() => false);
  if (!ready) {
    logTool(`${NL}[consola] ${t("console.daemonUnavailable")}${NL}`);
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
      tab.term?.write?.(`\r\n[${t("console.ptyCreateError", { error: result.stderr || result.stdout || result.code })}]\r\n`);
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
    const result = tab.status === "closed"
      ? { code: 0 }
      : await window.BA_CONSOLE_CONTROL.closeSession(tab.sessionId);
    if (result.code !== 0) {
      logTool(`${NL}[consola] ${t("console.closeFailed", { title: tab.title, error: result.stderr || `exit ${result.code}` })}${NL}`);
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
  logTool(`${NL}[tool] ${t("console.cancelTool.log")}${NL}`);
  rawSerialSend("\x03");

  window.setTimeout(() => {
    if (state.pending !== pending) return;
    window.clearTimeout(pending.timer);
    state.pending = null;
    pending.resolve({ code: 130, stdout: trimLines(pending.raw), stderr: t("common.cancelledByUser") });
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

function buildConsoleHelpPlainText() {
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

function showConsoleHelpModal() {
  if (typeof showBaModalPanel === "function") {
    showBaModalPanel({
      title: t("console.help.modalTitle"),
      onMount(bodyEl) {
        bodyEl.innerHTML = buildConsoleHelpHtml();
      },
      buttons: [{ id: "close", label: t("console.help.gotIt"), variant: "primary", cancel: true }],
    });
    return;
  }

  const detail = buildConsoleHelpPlainText();
  if (typeof showBaModal === "function") {
    showBaModal({
      title: t("console.help.modalTitle"),
      message: t("console.help.modalMessage"),
      detail,
      buttons: [{ id: "ok", label: t("console.help.gotIt"), variant: "primary", cancel: true }],
    });
    return;
  }

  alert(detail);
}

window.addEventListener("ba:langchange", () => {
  try { renderConsoleTabs(); } catch {}
});
