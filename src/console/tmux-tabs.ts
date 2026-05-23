// @ts-nocheck
// Browser Agent v86 - 03 console tabs
// Split from app.js in v9.35. Load order is defined in index.html.

function getConsoleTab(id) {
  return state.consoleTabs.tabs.find((tab) => tab.id === id) || null;
}

function getActiveConsoleTab() {
  return getConsoleTab(state.consoleTabs.activeId)
    || state.consoleTabs.tabs.find((tab) => tab.owner === "human")
    || null;
}

function isDedicatedConsoleControlReady() {
  const diag = window.BA_CONSOLE_CONTROL?.diagnostics?.();
  return Boolean(diag?.serial2Available && diag?.runnerReady);
}

function isConsoleControlBusy() {
  const needsSerial1Fallback = !isDedicatedConsoleControlReady();
  return Boolean(
    state.pending
    || state.agentBusy
    || state.consoleTabs.controlBusy
    || (needsSerial1Fallback && state.bgTools?.pending)
  );
}

function rawSerialSend(text) {
  if (!state.vm?.serial0_send) return false;
  try {
    state.vm.serial0_send(text);
    return true;
  } catch (error) {
    logTool(`${NL}[tabs] error enviando a serial: ${error.message}${NL}`);
    return false;
  }
}

function clearSerialTerminalBuffer() {
  const term = getSerialTerm();
  try {
    if (term && typeof term.clear === "function") term.clear();
    // CSI 3J limpia también el scrollback local de xterm.js. Esto NO se envía
    // a la VM; solo limpia la visualización local del navegador.
    if (term && typeof term.write === "function") term.write("\x1b[3J\x1b[H\x1b[2J");
    if (term && typeof term.scrollToBottom === "function") term.scrollToBottom();
  } catch {}

  const fallback = $("serial-textarea");
  if (fallback && !fallback.hidden) fallback.value = "";
}

function setTerminalScrollbackForTmux(enabled) {
  const term = getSerialTerm();
  if (!term) return;
  try {
    // Con tmux, el scrollback debe pertenecer a tmux, no a xterm.js.
    // Si xterm mantiene scrollback global, al cambiar de ventana se mezclan
    // líneas de la consola anterior con la nueva.
    term.options.scrollback = enabled ? 0 : 2000;
  } catch {}
}

function finalizeConsoleTabsReady() {
  if (!state.consoleTabs.initializing && state.consoleTabs.ready) return;
  if (state.consoleTabs.initTimer) {
    window.clearTimeout(state.consoleTabs.initTimer);
    state.consoleTabs.initTimer = 0;
  }
  state.consoleTabs.initializing = false;
  state.consoleTabs.ready = true;
  state.consoleTabs.activeId = "human-1";
  setTerminalScrollbackForTmux(true);

  // No limpiamos la terminal en la activación inicial. En v86 serial + tmux,
  // limpiar xterm justo después del arranque puede borrar el prompt ya pintado
  // por tmux, y como no usamos Ctrl+B+r para refrescar, la pantalla queda vacía
  // hasta que el usuario cambia de pestaña. Los cambios posteriores de pestaña
  // sí limpian antes de seleccionar otra ventana, porque el cambio de ventana
  // fuerza el repintado de tmux.
  renderConsoleTabs();
  syncConsoleTabsFromTmux({ repaint: true }).catch(() => {});
  window.setTimeout(() => {
    scheduleSerialScrollToBottom();
    scheduleSerialFit({ focus: true });
  }, 120);
  logTool(`[tabs] tmux activo: hasta 4 consolas de usuario. Control por serial2/ttyS2 con fallback a serial1/ttyS1.${NL}`);
}

function failConsoleTabsInit(message = "tmux no disponible") {
  if (state.consoleTabs.initTimer) {
    window.clearTimeout(state.consoleTabs.initTimer);
    state.consoleTabs.initTimer = 0;
  }
  state.consoleTabs.initializing = false;
  state.consoleTabs.ready = false;
  setConsoleTabsStatus(message, "bad");
  renderConsoleTabs();
  logTool(`${NL}[tabs] ${message}. Reconstruye perfiles con npm run setup y recarga sin caché.${NL}`);
}

function setConsoleTabsStatus(text, tone = "") {
  const status = $("console-tabs-status");
  if (status) setBadge(status, text, tone);
}

function parseConsoleControlCommand(command) {
  const parts = String(command || "").trim().split(/\s+/).filter(Boolean);
  if (parts[0] !== "ba-consolectl" || !parts[1]) return null;
  return { action: parts[1], args: parts.slice(2) };
}

function shouldFallbackConsoleControl(result) {
  const text = `${result?.stderr || ""}\n${result?.stdout || ""}`;
  return result?.code === 1 && /serial2|ttyS2|runner/.test(text);
}

async function runConsoleControl(command, {
  label = "Actualizando consola tmux…",
  timeoutMs = 5000,
  maxOutputBytes = 24000,
} = {}) {
  if (!state.consoleTabs.ready && !command.startsWith("ba-consolectl list")) {
    return { code: 1, stdout: "", stderr: "tmux no está listo" };
  }
  if (state.consoleTabs.controlBusy) {
    return { code: 75, stdout: "", stderr: "ya hay una acción de consola en curso" };
  }
  state.consoleTabs.controlBusy = true;
  renderConsoleTabs();
  try {
    const request = parseConsoleControlCommand(command);
    if (request && window.BA_CONSOLE_CONTROL?.exec) {
      const result = await window.BA_CONSOLE_CONTROL.exec(request.action, request.args, {
        timeoutMs,
        readyTimeoutMs: command.startsWith("ba-consolectl list") ? 350 : 900,
      });
      if (!shouldFallbackConsoleControl(result)) return result;
    }

    return await execVm(command, {
      lock: false,
      label,
      timeoutMs,
      log: false,
      targetTools: true,
      maxOutputBytes,
    });
  } finally {
    state.consoleTabs.controlBusy = false;
    renderConsoleTabs();
  }
}

function parseConsoleListOutput(text) {
  const windows = [];
  const panesByIndex = new Map();
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("BA_CONSOLE_WINDOW:")) {
      const parts = line.split(":");
      const tmuxWindowId = parts[1] || "";
      const index = Number(parts[2]);
      if (!Number.isInteger(index)) continue;
      const title = parts[3] || `Consola ${index + 1}`;
      const active = parts[4] === "1";
      const paneCount = Number(parts[5]) || 1;
      const zoomed = parts[6] === "1";
      windows.push({ tmuxWindowId, index, title, active, paneCount, zoomed });
      continue;
    }
    if (line.startsWith("BA_CONSOLE_PANE:")) {
      const parts = line.split(":");
      const index = Number(parts[1]);
      if (!Number.isInteger(index)) continue;
      const pane = {
        paneId: parts[2] || "",
        paneIndex: Number(parts[3]) || 0,
        active: parts[4] === "1",
        command: parts.slice(5).join(":") || "",
      };
      const panes = panesByIndex.get(index) || [];
      panes.push(pane);
      panesByIndex.set(index, panes);
    }
  }
  windows.sort((a, b) => a.index - b.index);
  return windows.map((item) => ({ ...item, panes: panesByIndex.get(item.index) || [] }));
}

function applyTmuxConsoleState(windows) {
  if (!Array.isArray(windows) || !windows.length) return false;
  const tabs = windows
    .filter((item) => item.index >= 0 && item.index < state.consoleTabs.maxHumanConsoles)
    .map((item) => ({
      id: `human-${item.index + 1}`,
      owner: "human",
      title: item.title || `Consola ${item.index + 1}`,
      tmuxIndex: item.index,
      tmuxWindowId: item.tmuxWindowId,
      humanNumber: item.index + 1,
      closable: windows.length > 1,
      paneCount: item.paneCount || Math.max(1, item.panes?.length || 1),
      zoomed: Boolean(item.zoomed),
      activePane: item.panes?.find((pane) => pane.active) || null,
      panes: item.panes || [],
    }));
  if (!tabs.length) return false;
  state.consoleTabs.tabs = tabs;
  const active = windows.find((item) => item.active);
  const activeId = active ? `human-${active.index + 1}` : state.consoleTabs.activeId;
  state.consoleTabs.activeId = tabs.some((tab) => tab.id === activeId) ? activeId : tabs[0].id;
  return true;
}

async function syncConsoleTabsFromTmux({ repaint = true } = {}) {
  if (!state.vm || !state.vmReady || (!window.BA_CONSOLE_CONTROL?.exec && !window.BA_BG_TOOLS?.execVm)) return false;
  const result = await runConsoleControl("ba-consolectl list", {
    label: "Leyendo consolas tmux…",
    timeoutMs: 4000,
  });
  if (result.code !== 0) {
    if (repaint) renderConsoleTabs();
    return false;
  }
  const clean = normalizeTerminalStreamForMarkers(result.stdout);
  const ok = applyTmuxConsoleState(parseConsoleListOutput(clean));
  if (repaint) renderConsoleTabs();
  return ok;
}

function syncConsoleInputLock() {
  // La consola visible siempre pertenece al usuario.
  // Las tools no usan esta sesión tmux, por tanto aquí no existe modo read-only.
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
  const splitVerticalButton = $("split-console-vertical");
  const splitHorizontalButton = $("split-console-horizontal");
  const zoomButton = $("zoom-console-pane");
  const redrawButton = $("redraw-console");
  const closePaneButton = $("close-console-pane");
  if (!list) return;

  const active = getActiveConsoleTab();
  const busy = isConsoleControlBusy();
  const humanCount = state.consoleTabs.tabs.filter((tab) => tab.owner === "human").length;
  const ready = Boolean(state.consoleTabs.ready);

  list.replaceChildren();
  for (const tab of state.consoleTabs.tabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `console-tab ${tab.owner}`;
    button.classList.toggle("active", tab.id === state.consoleTabs.activeId);
    button.disabled = !ready || busy;
    const label = tab.owner === "human"
      ? String(tab.humanNumber || tab.tmuxIndex + 1 || 1)
      : tab.title;
    const labelEl = document.createElement("span");
    labelEl.className = "console-tab-label";
    labelEl.textContent = label;
    button.appendChild(labelEl);
    button.setAttribute("aria-label", tab.title || `Consola ${tab.humanNumber || 1}`);
    button.title = tab.paneCount > 1
      ? `${tab.title}: ${tab.paneCount} paneles tmux.`
      : "Consola interactiva del usuario.";
    button.addEventListener("click", () => selectConsoleTab(tab.id));

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
  if (newButton) newButton.disabled = !ready || busy || humanCount >= state.consoleTabs.maxHumanConsoles;
  if (splitVerticalButton) splitVerticalButton.disabled = !ready || busy || !active;
  if (splitHorizontalButton) splitHorizontalButton.disabled = !ready || busy || !active;
  if (zoomButton) {
    zoomButton.disabled = !ready || busy || !active || (active.paneCount || 1) < 2;
    zoomButton.setAttribute("aria-label", active?.zoomed ? "Restaurar panel" : "Maximizar panel");
    zoomButton.title = active?.zoomed
      ? "Restaurar el panel activo a su tamaño anterior"
      : "Maximizar el panel activo sin cerrar los demás";
    zoomButton.classList.toggle("is-zoomed", Boolean(active?.zoomed));
  }
  if (redrawButton) redrawButton.disabled = !ready || busy || !active;
  if (closePaneButton) closePaneButton.disabled = !ready || busy || !active || (active.paneCount || 1) < 2;

  if (state.consoleTabs.controlBusy) setConsoleTabsStatus("actualizando", "warn");
  else if (state.consoleTabs.ready) setConsoleTabsStatus(`${humanCount}/4 consolas`, "good");
  else if (state.consoleTabs.initializing) setConsoleTabsStatus("iniciando tmux", "warn");
  else setConsoleTabsStatus("sin tmux", "");

  syncConsoleInputLock();
}

function resetConsoleTabs() {
  setTerminalScrollbackForTmux(false);
  state.consoleTabs.ready = false;
  state.consoleTabs.initializing = false;
  state.consoleTabs.controlBusy = false;
  if (state.consoleTabs.initTimer) {
    window.clearTimeout(state.consoleTabs.initTimer);
    state.consoleTabs.initTimer = 0;
  }
  state.consoleTabs.activeId = "human-1";
  state.consoleTabs.tabs = [
    { id: "human-1", owner: "human", title: "Consola usuario", tmuxIndex: 0, humanNumber: 1, closable: false },
  ];
  renderConsoleTabs();
}

function isSelectedRuntimeExpectedToHaveTmux() {
  const profile = getSelectedProfile();
  if (profile) return true;

  // En modo libre/manual no podemos comprobar tmux ejecutando comandos,
  // porque cualquier comprobación se escribe dentro de la consola visible.
  // Por seguridad solo activamos pestañas si el initramfs manual apunta a
  // una imagen de perfil generada por este proyecto, que ya incluye tmux y
  // auto-attach desde /sbin/browser-agent-login.
  const initrd = (getConfig()?.initrd || "").trim();
  return initrd.includes("/v86/images/profiles/alpine-base-initramfs.gz")
    || initrd.includes("/v86/images/profiles/alpine-pentest-lite-initramfs.gz")
    || initrd.includes("/v86/images/profiles/alpine-pentest-web-initramfs.gz");
}

async function initConsoleTabsAfterBoot() {
  if (!state.vm || !state.vmReady || state.consoleTabs.ready || state.consoleTabs.initializing) return;
  if (state.pending || state.agentBusy) {
    window.setTimeout(() => initConsoleTabsAfterBoot(), 500);
    return;
  }

  // No comprobamos $TMUX con execVm(), porque eso escribe comandos visibles
  // en la shell/tmux activa. Activamos pestañas únicamente cuando el perfil o
  // el initramfs seleccionado son imágenes generadas con soporte tmux.
  if (!isSelectedRuntimeExpectedToHaveTmux()) {
    failConsoleTabsInit("tmux desactivado para esta imagen manual");
    return;
  }

  state.consoleTabs.initializing = true;
  renderConsoleTabs();
  logTool(`${NL}[tabs] esperando tmux auto-adjuntado por la VM...${NL}`);

  state.consoleTabs.initTimer = window.setTimeout(() => {
    finalizeConsoleTabsReady();
  }, 900);
}

async function selectConsoleTab(id, { force = false } = {}) {
  const tab = getConsoleTab(id);
  if (!tab) return false;
  if (!state.consoleTabs.ready && id !== state.consoleTabs.activeId) return false;
  if (isConsoleControlBusy() && !force) return false;

  if (state.consoleTabs.ready && state.consoleTabs.activeId !== id) {
    clearSerialTerminalBuffer();
    const action = (tab.paneCount || 1) > 1 ? "select-redraw" : "select";
    const result = await runConsoleControl(`ba-consolectl ${action} ${tab.tmuxIndex}`, {
      label: `Cambiando a ${tab.title}…`,
      timeoutMs: 4500,
    });
    if (result.code !== 0) {
      logTool(`${NL}[tabs] no se pudo cambiar a ${tab.title}: ${result.stderr || `exit ${result.code}`}${NL}`);
      return false;
    }
    await sleepMs(180);
  }

  state.consoleTabs.activeId = id;
  await syncConsoleTabsFromTmux({ repaint: false }).catch(() => false);
  const selectedTab = getConsoleTab(id) || tab;
  scheduleSerialScrollToBottom();
  renderConsoleTabs();

  if (selectedTab.owner === "human") scheduleSerialFit({ focus: true });
  else blurSerialConsole();
  return true;
}

function isShellLikeCommand(command) {
  const value = String(command || "").trim().toLowerCase();
  return !value || ["sh", "ash", "-sh", "bash", "zsh", "fish", "busybox"].includes(value);
}

function lastNonEmptyLine(text) {
  const lines = trimLines(text || "").split(/\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

async function readTmuxPaneCurrentCommand(tab) {
  if (!tab || tab.owner !== "human") return "";
  const result = await execVm(`ba-consolectl status ${tab.tmuxIndex}`, {
    lock: true,
    label: `Comprobando ${tab.title}…`,
    timeoutMs: 3500,
    log: false,
    targetTools: true,
  });
  if (result.code !== 0) return "";
  const match = normalizeTerminalStreamForMarkers(result.stdout).match(/BA_CONSOLE_STATUS:([^\n\r]*)/);
  return (match?.[1] || lastNonEmptyLine(result.stdout)).trim();
}

async function createHumanConsoleTab() {
  if (!state.consoleTabs.ready || isConsoleControlBusy()) return;
  const humanCount = state.consoleTabs.tabs.filter((tab) => tab.owner === "human").length;
  if (humanCount >= state.consoleTabs.maxHumanConsoles) return;
  clearSerialTerminalBuffer();
  const result = await runConsoleControl("ba-consolectl new", {
    label: "Creando consola tmux…",
    timeoutMs: 6000,
  });
  if (result.code !== 0) {
    logTool(`${NL}[tabs] no se pudo crear consola: ${result.stderr || `exit ${result.code}`}${NL}`);
    return;
  }
  await syncConsoleTabsFromTmux({ repaint: false });
  renderConsoleTabs();
  window.setTimeout(() => scheduleSerialFit({ focus: true }), 160);
}

async function splitActiveConsolePane(direction) {
  if (!state.consoleTabs.ready || isConsoleControlBusy()) return;
  const tab = getActiveConsoleTab();
  if (!tab) return;
  const tmuxDirection = direction === "horizontal" ? "horizontal" : "vertical";
  const result = await runConsoleControl(`ba-consolectl split ${tab.tmuxIndex} ${tmuxDirection}`, {
    label: tmuxDirection === "vertical" ? "Dividiendo consola verticalmente…" : "Dividiendo consola horizontalmente…",
    timeoutMs: 5500,
  });
  if (result.code !== 0) {
    logTool(`${NL}[tabs] no se pudo dividir ${tab.title}: ${result.stderr || `exit ${result.code}`}${NL}`);
    return;
  }
  await syncConsoleTabsFromTmux({ repaint: false });
  renderConsoleTabs();
  window.setTimeout(() => scheduleSerialFit({ focus: true }), 160);
}

async function toggleActiveConsolePaneZoom() {
  if (!state.consoleTabs.ready || isConsoleControlBusy()) return;
  const tab = getActiveConsoleTab();
  if (!tab || (tab.paneCount || 1) < 2) return;
  const result = await runConsoleControl(`ba-consolectl zoom ${tab.tmuxIndex}`, {
    label: tab.zoomed ? "Restaurando panel tmux…" : "Maximizando panel tmux…",
    timeoutMs: 4500,
  });
  if (result.code !== 0) {
    logTool(`${NL}[tabs] no se pudo cambiar zoom en ${tab.title}: ${result.stderr || `exit ${result.code}`}${NL}`);
    return;
  }
  await syncConsoleTabsFromTmux({ repaint: false });
  renderConsoleTabs();
  window.setTimeout(() => scheduleSerialFit({ focus: true }), 120);
}

async function redrawConsoleScreen(tab, { sync = true } = {}) {
  if (!tab) return false;
  clearSerialTerminalBuffer();
  const result = await runConsoleControl(`ba-consolectl clear ${tab.tmuxIndex}`, {
    label: "Refrescando consola tmux…",
    timeoutMs: 4500,
  });
  if (result.code !== 0) {
    logTool(`${NL}[tabs] no se pudo refrescar ${tab.title}: ${result.stderr || `exit ${result.code}`}${NL}`);
    return false;
  }
  if (sync) await syncConsoleTabsFromTmux({ repaint: false });
  window.setTimeout(() => {
    scheduleSerialScrollToBottom();
    scheduleSerialFit({ focus: true });
  }, 120);
  return true;
}

async function redrawActiveConsoleScreen() {
  if (!state.consoleTabs.ready || isConsoleControlBusy()) return;
  const tab = getActiveConsoleTab();
  if (!tab) return;

  await redrawConsoleScreen(tab, { sync: true });
  renderConsoleTabs();
}

async function closeActiveConsolePane() {
  if (!state.consoleTabs.ready || isConsoleControlBusy()) return;
  const tab = getActiveConsoleTab();
  if (!tab || (tab.paneCount || 1) < 2) return;

  const activeCommand = tab.activePane?.command || "";
  if (!isShellLikeCommand(activeCommand)) {
    const decision = await showBaModal({
      title: "Cerrar panel activo",
      message: `El panel activo parece tener un proceso en ejecución: ${activeCommand}.`,
      detail: "Cerrar el panel terminará ese proceso.",
      buttons: [
        { id: "cancel", label: "Mantener panel", variant: "secondary", cancel: true },
        { id: "close", label: "Cerrar panel", variant: "danger" },
      ],
    });
    if (decision !== "close") return;
  }

  const result = await runConsoleControl(`ba-consolectl close-pane ${tab.tmuxIndex}`, {
    label: "Cerrando panel tmux…",
    timeoutMs: 5500,
  });
  if (result.code !== 0) {
    logTool(`${NL}[tabs] no se pudo cerrar panel de ${tab.title}: ${result.stderr || `exit ${result.code}`}${NL}`);
    return;
  }
  await syncConsoleTabsFromTmux({ repaint: false });
  renderConsoleTabs();
  window.setTimeout(() => scheduleSerialFit({ focus: true }), 160);
}

async function closeHumanConsoleTab(id) {
  if (!state.consoleTabs.ready || isConsoleControlBusy()) return;
  const tab = getConsoleTab(id);
  if (!tab || tab.owner !== "human" || !tab.closable) return;

  const previousActiveId = state.consoleTabs.activeId;
  const activeCommand = tab.activePane?.command || await readTmuxPaneCurrentCommand(tab).catch(() => "");
  const needsConfirm = (tab.paneCount || 1) > 1 || !isShellLikeCommand(activeCommand);
  if (needsConfirm) {
    const decision = await showBaModal({
      title: `Cerrar ${tab.title}`,
      message: !isShellLikeCommand(activeCommand)
        ? `Esta consola parece tener un proceso activo: ${activeCommand}.`
        : `Esta consola tiene ${tab.paneCount || 1} paneles.`,
      detail: "Cerrar la consola terminará sus paneles y procesos.",
      buttons: [
        { id: "cancel", label: "Mantener abierta", variant: "secondary", cancel: true },
        { id: "close", label: "Cerrar y detener", variant: "danger" },
      ],
    });

    if (decision !== "close") {
      await selectConsoleTab(previousActiveId, { force: true });
      return;
    }
  }

  const result = await runConsoleControl(`ba-consolectl close-window ${tab.tmuxIndex}`, {
    label: `Cerrando ${tab.title}…`,
    timeoutMs: 6000,
  });
  if (result.code !== 0) {
    logTool(`${NL}[tabs] no se pudo cerrar ${tab.title}: ${result.stderr || `exit ${result.code}`}${NL}`);
    await selectConsoleTab(previousActiveId, { force: true });
    return;
  }

  await syncConsoleTabsFromTmux({ repaint: false });
  const fallback = getActiveConsoleTab();
  if (fallback) state.consoleTabs.activeId = fallback.id;
  renderConsoleTabs();
  window.setTimeout(() => scheduleSerialFit({ focus: true }), 160);
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


function escapeTmuxHelpHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function tmuxHelpKbd(parts) {
  return parts.map((part) => `<kbd>${escapeTmuxHelpHtml(part)}</kbd>`).join('<span class="ba-tmux-help-plus">+</span>');
}

function tmuxHelpRow(keysHtml, description) {
  return `<tr><td class="ba-tmux-help-keys">${keysHtml}</td><td>${escapeTmuxHelpHtml(description)}</td></tr>`;
}

function buildTmuxHelpHtml() {
  const prefix = tmuxHelpKbd(["Ctrl", "b"]);
  const rows = [
    tmuxHelpRow(`${prefix} luego ${tmuxHelpKbd(["?"])}`, "Ayuda completa de tmux (dentro de la VM)"),
    tmuxHelpRow(`${prefix} luego ${tmuxHelpKbd(["["])}`, "Modo scroll / copia del historial de la consola"),
    tmuxHelpRow(tmuxHelpKbd(["q"]), "Salir del modo scroll (también Esc)"),
    tmuxHelpRow(`${tmuxHelpKbd(["↑", "↓", "PgUp", "PgDn"])}`, "Desplazarse en modo scroll"),
    tmuxHelpRow(`${prefix} luego ${tmuxHelpKbd(["d"])}`, "Desconectar tmux; la sesión sigue en la VM"),
    tmuxHelpRow(tmuxHelpKbd(["Ctrl", "c"]), "Interrumpir el programa en la shell activa"),
    tmuxHelpRow(`${prefix} luego ${tmuxHelpKbd(["z"])}`, "Maximizar o restaurar el panel activo"),
    tmuxHelpRow(`${prefix} luego ${tmuxHelpKbd(["←", "→", "↑", "↓"])}`, "Mover el foco al panel vecino"),
    tmuxHelpRow(`${prefix} luego ${tmuxHelpKbd(["o"])}`, "Cambiar al siguiente panel"),
    tmuxHelpRow(`${prefix} luego ${tmuxHelpKbd(["Ctrl", "←", "→", "↑", "↓"])}`, "Redimensionar el panel activo en pasos pequeños"),
    tmuxHelpRow(`${prefix} luego ${tmuxHelpKbd(["Alt", "←", "→", "↑", "↓"])}`, "Redimensionar el panel activo en pasos grandes"),
  ].join("");

  return `
    <div class="ba-tmux-help">
      <p class="ba-tmux-help-lead">
        La consola usa <strong>tmux</strong> sobre la UART del navegador. Casi todos los atajos son en dos pasos:
        pulsa y suelta ${prefix}, luego la segunda tecla.
      </p>

      <section class="ba-tmux-help-section">
        <h4>Atajos habituales</h4>
        <table class="ba-tmux-help-table">
          <tbody>${rows}</tbody>
        </table>
      </section>

      <section class="ba-tmux-help-section">
        <h4>En este proyecto</h4>
        <ul class="ba-tmux-help-list">
          <li><strong>Hasta 4 consolas de usuario</strong> gestionadas por botones del navegador. Se ejecutan por <code>serial2</code>, no dentro del shell visible.</li>
          <li><strong>Paneles divididos</strong>: maximizar/restaurar no cierra nada. Cerrar panel actúa sobre el panel activo.</li>
          <li><strong>Redimensionar paneles</strong>: puedes usar los atajos de tmux desde teclado; los botones del navegador se reservan para crear, dividir, maximizar/restaurar y cerrar.</li>
          <li><strong>Herramientas del LLM y comprobaciones</strong> se ejecutan por <code>serial1</code> / <code>ttyS1</code> en segundo plano.</li>
          <li><strong>Cancelar herramienta</strong> (botón junto a esta ayuda) envía interrupción a la herramienta en curso por serial1.</li>
          <li><strong>Scroll del ratón</strong> en el navegador no sustituye al historial de tmux. Para leer salida antigua, usa ${prefix} luego ${tmuxHelpKbd(["["])}.</li>
        </ul>
      </section>

      <section class="ba-tmux-help-section">
        <h4>Navegador</h4>
        <ul class="ba-tmux-help-list">
          <li>Haz <strong>clic dentro de la consola</strong> antes de escribir para asegurar el foco del teclado.</li>
          <li><strong>Pegar</strong>: ${tmuxHelpKbd(["Ctrl", "Shift", "V"])} (o menú contextual del navegador).</li>
          <li><strong>Copiar</strong> texto ya visible: selección normal del ratón fuera del modo scroll de tmux.</li>
        </ul>
      </section>

      <p class="ba-tmux-help-foot">
        Programas a pantalla completa (<code>nano</code>, <code>vim</code>, etc.) usan la rejilla fija de la consola serial.
        Si la VM acaba de arrancar y no ves prompt, espera unos segundos o escribe ${tmuxHelpKbd(["Enter"])}.
      </p>
    </div>
  `;
}

function buildTmuxHelpPlainText() {
  return [
    "Prefijo tmux: Ctrl+b, luego la segunda tecla.",
    "",
    "Ctrl+b ?     Ayuda interna de tmux",
    "Ctrl+b [     Modo scroll / copia",
    "q / Esc      Salir del modo scroll",
    "Ctrl+b d     Desconectar (sesión sigue viva)",
    "Ctrl+c       Interrumpir programa en la shell",
    "Ctrl+b z     Maximizar/restaurar panel activo",
    "Ctrl+b ←/→/↑/↓       Mover foco al panel vecino",
    "Ctrl+b o             Cambiar al siguiente panel",
    "Ctrl+b Ctrl+←/→/↑/↓  Redimensionar panel en pasos pequeños",
    "Ctrl+b Alt+←/→/↑/↓   Redimensionar panel en pasos grandes",
    "",
    "En este proyecto:",
    "- Hasta 4 consolas de usuario gestionadas por botones del navegador.",
    "- Nueva consola, dividir, maximizar y cerrar se ejecutan por serial2/ttyS2.",
    "- Cerrar panel actúa sobre el panel activo; maximizar/restaurar no cierra nada.",
    "- Usa el panel Herramientas para ver salida de herramientas; Cancelar herramienta interrumpe serial1.",
    "- El scroll del ratón no sustituye al historial de tmux: usa Ctrl+b [.",
    "- Evita Ctrl+b r (puede escribir basura en la shell).",
    "",
    "Navegador: clic en la consola para foco; pegar con Ctrl+Shift+V.",
  ].join("\n");
}

function showTmuxHelpModal() {
  if (typeof showBaModalPanel === "function") {
    showBaModalPanel({
      title: "Consola tmux",
      onMount(bodyEl) {
        bodyEl.innerHTML = buildTmuxHelpHtml();
      },
      buttons: [{ id: "close", label: "Entendido", variant: "primary", cancel: true }],
    });
    return;
  }

  const detail = buildTmuxHelpPlainText();
  if (typeof showBaModal === "function") {
    showBaModal({
      title: "Consola tmux",
      message: "Atajos y comportamiento en Browser Agent v86.",
      detail,
      buttons: [{ id: "ok", label: "Entendido", variant: "primary", cancel: true }],
    });
    return;
  }

  alert(detail);
}
