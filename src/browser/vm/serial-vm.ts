// @ts-nocheck
// Browser Agent v86 - 06 serial vm
// Split from app.js in v9.35. Load order is defined in index.html.

function getSerialTerm() {
  return state.vm?.serial_adapter?.term || state.vm?.serial_adapter?.terminal || null;
}

function getXtermCellSize(term, container) {
  const cell = term?._core?._renderService?.dimensions?.css?.cell;
  if (cell?.width > 0 && cell?.height > 0) return { width: cell.width, height: cell.height };

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

function sizeSerialContainerToGrid(container, term, cols, rows) {
  const cell = getXtermCellSize(term, container);

  // v86 serial no recibe SIGWINCH real desde el navegador. La consola de
  // arranque mantiene una geometría estable; las consolas de usuario directas
  // usan sus propios xterm dentro del mismo marco visual.
  const width = Math.ceil((cell.width || 9) * cols);
  const height = Math.ceil((cell.height || 18) * rows + 6);
  const targets = [
    container,
    $("vm-console-shell"),
  ].filter(Boolean);

  for (const el of targets) {
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.minHeight = `${height}px`;
    el.style.maxHeight = `${height}px`;
  }

  const wrap = container.closest?.(".vm-screen-wrap");
  if (wrap) {
    wrap.style.setProperty("--ba-console-width", `${width}px`);
    wrap.style.setProperty("--ba-console-height", `${height}px`);
  }
}

function fitSerialTerminal() {
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
  } catch {}
}

function scheduleSerialFit({ focus = false } = {}) {
  if (state.serialFitRaf) window.cancelAnimationFrame(state.serialFitRaf);
  state.serialFitRaf = window.requestAnimationFrame(() => {
    state.serialFitRaf = 0;
    fitSerialTerminal();
    if (focus) focusSerialConsole();
  });
}

function scheduleSerialScrollToBottom() {
  const term = getSerialTerm();
  if (!term || typeof term.scrollToBottom !== "function") return;
  if (state.serialScrollRaf) return;
  state.serialScrollRaf = window.requestAnimationFrame(() => {
    state.serialScrollRaf = 0;
    try { term.scrollToBottom(); } catch {}
  });
}

function teardownSerialTerminalHelpers() {
  if (state.serialResizeObserver) {
    try { state.serialResizeObserver.disconnect(); } catch {}
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
    try { state.serialWriteDisposable.dispose(); } catch {}
  }
  state.serialWriteDisposable = null;
  state.serialKeyHandlerAttached = false;
}

function setupSerialTerminalHelpers() {
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
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return true;
      if (String(event.key || "").toLowerCase() !== "c") return true;
      if (typeof term.hasSelection === "function" && term.hasSelection()) return true;
      try { state.vm?.serial0_send?.("\x03"); } catch {}
      return false;
    });
    state.serialKeyHandlerAttached = true;
  }

  try {
    term.options.scrollback = 0;
    term.options.cursorBlink = true;
  } catch {}

  scheduleSerialFit({ focus: true });
}

function resetSerialConsoleDom() {
  teardownSerialTerminalHelpers();
  const serialConsole = $("serial-console");
  if (serialConsole) serialConsole.replaceChildren();
}

function focusSerialConsole() {
  const activeTab = typeof getActiveConsoleTab === "function" ? getActiveConsoleTab() : null;
  if (activeTab?.term && document.body.classList.contains("xterm-direct-console-mode")) {
    try { activeTab.term.focus(); return; } catch {}
  }
  const term = getSerialTerm();
  if (term && typeof term.focus === "function") {
    try { term.focus(); return; } catch {}
  }
}

async function resyncVmAfterRestore() {
  logTool(`[snapshot] revalidando seriales y consolas xterm tras restore...${NL}`);

  const serial1Probe = window.BA_BG_TOOLS?.probeRunnerReady?.({ timeoutMs: 1800 }) || Promise.resolve(false);
  const serial2Probe = window.BA_CONSOLE_CONTROL?.probeRunnerReady?.({ timeoutMs: 1600 }) || Promise.resolve(false);
  const [serial1Ok, serial2Ok] = await Promise.all([
    serial1Probe.catch(() => false),
    serial2Probe.catch(() => false),
  ]);

  if (serial1Ok) logTool(`[snapshot] serial1/ttyS1 revalidado.${NL}`);
  else logTool(`[snapshot] aviso: serial1/ttyS1 no ha respondido al probe; las tools pueden no estar listas.${NL}`);

  if (serial2Ok) logTool(`[snapshot] serial2/ttyS2 revalidado.${NL}`);
  else logTool(`[snapshot] aviso: serial2/ttyS2 no ha respondido al probe; las consolas xterm pueden no estar listas.${NL}`);

  const consolesSynced = typeof syncConsoleTabsFromDaemon === "function"
    ? await syncConsoleTabsFromDaemon({ repaint: false }).catch(() => false)
    : false;
  if (consolesSynced) {
    state.consoleTabs.initializing = false;
    state.consoleTabs.ready = true;
    logTool(`[snapshot] consolas xterm sincronizadas con el snapshot.${NL}`);
  } else {
    state.consoleTabs.initializing = true;
    renderConsoleTabs();
    window.setTimeout(() => finalizeConsoleTabsReady(), 700);
    logTool(`[snapshot] se reintentará la inicialización de consolas xterm.${NL}`);
  }

  renderConsoleTabs();
  syncDiskCheckButton();
  syncSnapshotButtons();
  maybeConfigureNetwork();
}

async function toggleVmPower() {
  if (state.vm) {
    return stopVm({ confirmShutdown: true });
  }
  return startVm();
}

async function startVm(options = {}) {
  const restoreStateBuffer = options?.restoreStateBuffer || null;
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

  if (runtime.hda) {
    const diskCheck = await checkAsset(runtime.hda.url);
    if (!diskCheck.ok) {
      setBadge($("vm-detail"), t("vm.badge.diskNotFound"), "bad");
      logTool(`${NL}[host] no existe la imagen de disco ${runtime.hda.url}. Genera esa imagen raw o usa Disco: RAM/initramfs.${NL}`);
      return;
    }
  }

  state.vmStarting = true;
  setVmOptionsLocked(true);
  if (startButton) startButton.disabled = true;
  setBadge($("badge-vm"), t("vm.badge.loading"), "warn");
  setBadge($("vm-detail"), t("common.downloadingLower"), "warn");
  setLoading(true, { title: t("vm.loading.preparing"), detail: t("vm.loading.startingDownload"), percent: null, indeterminate: true });
  await nextPaint();
  logTool(`${NL}[host] preparando assets de v86...${NL}`);

  try {
    const buffers = await preloadVmAssets(cfg);

    const Starter = window.V86Starter || window.V86;
    if (!Starter) throw new Error("window.V86Starter no existe");
    if (!window.Terminal) throw new Error("xterm.js no cargado");

    resetSerialConsoleDom();
    window.BA_BG_TOOLS?.reset?.("vm-starting");
    window.BA_CONSOLE_CONTROL?.reset?.("vm-starting");
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
    if (cfg.profile) logTool(`[profile] ${cfg.profile.name || cfg.profile.id} · ${cfg.profile.output}${NL}`);
    else logTool(`[profile] libre / manual${NL}`);

    state.vm = new Starter({
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
      // UART1 queda reservado para tools background no interactivas.
      // UART2 queda reservado para el daemon xterm/PTY del navegador.
      // serial0/ttyS0 queda como consola de arranque y fallback.
      uart1: true,
      uart2: true,
      cmdline: "rw rdinit=/init console=ttyS0,115200 console=tty0 edd=off nowatchdog tsc=reliable mitigations=off random.trust_cpu=on",
      autostart: !restoreStateBuffer,
      disable_keyboard: true,
      screen_container: $("screen-container"),
      serial_console: { type: "xtermjs", container: $("serial-console"), xterm_lib: window.Terminal },
    });
    setupSerialTerminalHelpers();

    if (!state.vm.add_listener || !state.vm.serial0_send) {
      throw new Error("Esta build no expone serial0_send/add_listener");
    }

    state.vm.add_listener("serial0-output-byte", onSerialByte);
    state.vm.add_listener("serial1-output-byte", (byte) => window.BA_BG_TOOLS?.onSerial1Byte?.(byte));
    state.vm.add_listener("serial2-output-byte", (byte) => window.BA_CONSOLE_CONTROL?.onSerial2Byte?.(byte));
    state.vm.add_listener("eth-transmit-end", (bytes) => logTool(`[network] eth transmit ${bytes} bytes${NL}`));
    state.vm.add_listener("eth-receive-end", (bytes) => logTool(`[network] eth receive ${bytes} bytes${NL}`));
    let restoreApplied = false;
    state.vm.add_listener("emulator-ready", async () => {
      setBadge($("vm-detail"), restoreStateBuffer ? t("common.restoringSnapshot") : t("vm.badge.booting"), "warn");
      window.setTimeout(() => scheduleSerialFit({ focus: true }), 150);

      if (restoreStateBuffer && !restoreApplied) {
        restoreApplied = true;
        try {
          setLoading(true, { title: t("vm.loading.restoringSnapshot"), detail: t("vm.loading.applyingState"), percent: null, indeterminate: true });
          await nextPaint();
          await v86RestoreState(restoreStateBuffer);
          if (typeof state.vm.run === "function") state.vm.run();
          state.vmReady = true;
          state.snapshotRestoring = false;
          setBadge($("badge-vm"), t("vm.badge.ready"), "good");
          setBadge($("vm-detail"), t("vm.badge.snapshotRestored"), "good");
          logTool(`[snapshot] snapshot restaurado. Si la consola queda sin prompt, pulsa Enter.${NL}`);
          window.setTimeout(() => {
            try { state.vm?.serial0_send(NL); } catch {}
            scheduleSerialFit({ focus: true });
            resyncVmAfterRestore().catch((error) => {
              logTool(`[snapshot] aviso resync restore: ${error.message}${NL}`);
              maybeConfigureNetwork();
            });
          }, 300);
        } catch (error) {
          state.snapshotRestoring = false;
          setBadge($("badge-vm"), t("vm.badge.errorRestore"), "bad");
          setBadge($("vm-detail"), t("common.snapshotError"), "bad");
          logTool(`[snapshot] error restaurando: ${error.message}${NL}`);
        } finally {
          setLoading(false);
          syncSnapshotButtons();
        }
      }
    });
    state.vm.add_listener("emulator-loaded", () => {
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
    setBadge($("badge-vm"), t("vm.badge.error"), "bad");
    setBadge($("vm-detail"), error.message, "bad");
    logTool(`[host] error: ${error.message}${NL}`);
    state.activeRuntime = null;
    state.diskMounted = false;
    syncDiskCheckButton();
    setLoading(false);
  } finally {
    state.vmStarting = false;
    setVmOptionsLocked(Boolean(state.vm));
    syncPowerButtons();
    syncDiskCheckButton();
    syncSnapshotButtons();
  }
}

async function stopVm({ confirmShutdown = true } = {}) {
  if (!state.vm || state.vmStarting || state.agentBusy || state.pending || state.bgTools?.pending) return;

  if (confirmShutdown) {
    const ok = await confirmVmShutdown();
    if (!ok) return;
  }

  const vm = state.vm;
  const startButton = $("start-vm");
  const stopButton = $("stop-vm");

  if (stopButton) stopButton.disabled = true;
  if (startButton) startButton.disabled = true;
  setAgentBusy(true, t("vm.badge.shuttingDown"));
  setBadge($("badge-vm"), t("vm.badge.stopping"), "warn");
  setBadge($("vm-detail"), t("vm.badge.poweringOff"), "warn");
  logTool(`${NL}[host] apagando VM...${NL}`);

  try {
    if (state.vmReady && typeof vm.serial0_send === "function") {
      try { vm.serial0_send("sync" + NL); } catch {}
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }

    if (typeof vm.stop === "function") {
      try { await vm.stop(); } catch (error) { logTool(`[host] aviso stop(): ${error.message}${NL}`); }
    }

    if (typeof vm.destroy === "function") {
      try { await vm.destroy(); } catch (error) { logTool(`[host] aviso destroy(): ${error.message}${NL}`); }
    }
  } finally {
    teardownSerialTerminalHelpers();
    state.vm = null;
    state.vmReady = false;
    state.pending = null;
    window.BA_BG_TOOLS?.reset?.("vm-stopped");
    window.BA_CONSOLE_CONTROL?.reset?.("vm-stopped");
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

function onSerialByte(byte) {
  onSerialChar(String.fromCharCode(byte));
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTerminalStreamForMarkers(text) {
  // serial0 es un terminal visual, no un canal stdout puro. Los marcadores
  // pueden venir mezclados con CSI, CR o movimientos de cursor.
  let value = stripAnsi(String(text || "")).split(CR).join(NL);
  for (let i = 0; i < 8 && value.includes("\b"); i += 1) {
    value = value.replace(/[^\n]\b/g, "");
  }
  return value;
}

function finishPendingCommand(pending, result) {
  window.clearTimeout(pending.timer);
  if (state.pending === pending) state.pending = null;
  renderConsoleTabs();
  pending.resolve(result);
}

function extractBetweenLast(text, beginToken, endToken, beforeIndex = text.length) {
  const endIndex = text.lastIndexOf(endToken, beforeIndex);
  if (endIndex < 0) return null;
  const beginIndex = text.lastIndexOf(beginToken, endIndex);
  if (beginIndex < 0) return null;
  return text.slice(beginIndex + beginToken.length, endIndex);
}

function parsePendingCommandBuffer(pending) {
  const clean = normalizeTerminalStreamForMarkers(pending.raw);
  const startToken = `${pending.marker}_START`;
  const stdoutStartToken = `${pending.marker}_STDOUT_START`;
  const stdoutEndToken = `${pending.marker}_STDOUT_END`;
  const stderrStartToken = `${pending.marker}_STDERR_START`;
  const stderrEndToken = `${pending.marker}_STDERR_END`;
  const endToken = `${pending.marker}_END:`;

  /*
    v9.44: execVm emite stdout/stderr en secciones únicas escritas desde
    ficheros temporales a /dev/ttyS0. Si esas secciones están presentes, las
    usamos como fuente de verdad y no el transcript visual de la consola.
  */
  const endRegex = new RegExp(`${escapeRegExp(endToken)}[ \\t]*(-?\\d+)[ \\t]*\\n`);
  const endMatch = clean.match(endRegex);
  if (endMatch) {
    const outputEnd = endMatch.index;
    const startIndex = clean.lastIndexOf(startToken, outputEnd);
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

  if (Array.isArray(pending.resolveOnTokens) && pending.resolveOnTokens.length) {
    const seen = pending.resolveOnTokens.find((token) => clean.includes(token));
    if (seen) {
      const hasErrorToken = pending.rejectOnTokens?.some((token) => clean.includes(token));
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

function onSerialChar(char) {
  state.bootBuffer = safeTrim(state.bootBuffer + char, 6000);

  const prompts = ["~% ", "~# ", "/ # ", "# ", "$ "];
  if (!state.vmReady && prompts.some((prompt) => state.bootBuffer.endsWith(prompt))) {
    state.vmReady = true;
    setBadge($("badge-vm"), t("vm.badge.ready"), "good");
    setBadge($("vm-detail"), t("vm.badge.shellReady"), "good");
    syncDiskCheckButton();
    scheduleSerialFit({ focus: true });
    window.setTimeout(() => initConsoleTabsAfterBoot(), 500);
    window.setTimeout(() => maybeConfigureNetwork(), 1800);
  }

  if (!state.pending) return;

  const pending = state.pending;
  pending.raw += char;
  if (pending.maxRawChars && pending.raw.length > pending.maxRawChars) {
    pending.raw = pending.raw.slice(-pending.maxRawChars);
  }
  pending.bytesSinceParse = (pending.bytesSinceParse || 0) + 1;

  // El render serial puede no llegar como líneas limpias. Parseamos en salto de
  // línea y también cada 128 bytes para detectar tokens visibles aunque no haya NL.
  if (char !== NL && char !== CR && pending.bytesSinceParse < 128) return;
  pending.bytesSinceParse = 0;
  parsePendingCommandBuffer(pending);
}
