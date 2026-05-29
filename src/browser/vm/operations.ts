// @ts-nocheck
// Browser Agent v86 - 07 tools network disk snapshot
// Split from app.js in v9.35. Load order is defined in index.html.

function buildExecVmWrappedCommand(command, marker, maxOutputBytes) {
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
    v9.44: stdout/stderr no se capturan desde el repintado visual de la consola.
    El comando real se redirige a ficheros temporales y solo después se emite
    una copia limitada directamente a /dev/ttyS0 entre secciones únicas.
    Esto evita fragmentos de eco como "__rc", "___END:$__rc" o letras sueltas
    mezcladas con la salida real.
  */
  return [
    `__ba_tty=/dev/ttyS0`,
    `__ba_dir=/tmp/ba-execvm`,
    `__ba_out="$__ba_dir/${safeId}.out"`,
    `__ba_err="$__ba_dir/${safeId}.err"`,
    `mkdir -p "$__ba_dir" 2>/dev/null || true`,
    `rm -f "$__ba_out" "$__ba_err" 2>/dev/null || true`,
    `printf '\n${markerStart}\n${markerStdoutStart}\n' > "$__ba_tty" 2>/dev/null || printf '\n${markerStart}\n${markerStdoutStart}\n'`,
    `( TERM=dumb; export TERM; ${safeCommand} ) > "$__ba_out" 2> "$__ba_err"`,
    `__rc=$?`,
    `head -c ${limit} "$__ba_out" > "$__ba_tty" 2>/dev/null || true`,
    `printf '\n${markerStdoutEnd}\n${markerStderrStart}\n' > "$__ba_tty" 2>/dev/null || printf '\n${markerStdoutEnd}\n${markerStderrStart}\n'`,
    `head -c ${errLimit} "$__ba_err" > "$__ba_tty" 2>/dev/null || true`,
    `printf '\n${markerStderrEnd}\n${markerEnd}:%s\n' "$__rc" > "$__ba_tty" 2>/dev/null || printf '\n${markerStderrEnd}\n${markerEnd}:%s\n' "$__rc"`,
    `rm -f "$__ba_out" "$__ba_err" 2>/dev/null || true`,
    `stty echo 2>/dev/null || true`,
  ].join("; ") + NL;
}

async function execVm(command, { lock = true, label = t("vm.exec.busyDefault", "El agente está usando la VM…"), timeoutMs = 25000, log = true, targetTools = true, resolveOnTokens = [], rejectOnTokens = [], maxOutputBytes = 65536 } = {}) {
  if (!state.vm) return { code: 1, stdout: "", stderr: t("vm.error.notStarted", "v86 no está arrancada") };
  if (!state.vmReady) return { code: 1, stdout: "", stderr: t("vm.error.booting", "la VM está arrancando") };

  // Las operaciones internas/tools usan UART1/ttyS1 y no cambian la consola visible.
  // No hacemos fallback silencioso a serial0 para evitar interferir con el usuario.
  if (targetTools) {
    if (window.BA_BG_TOOLS?.execVm) {
      return window.BA_BG_TOOLS.execVm(command, { label, timeoutMs, maxOutputBytes, log });
    }
    return { code: 1, stdout: "", stderr: t("vm.error.serial1NotInit", "canal serial1 de tools no inicializado") };
  }

  if (state.pending || state.agentBusy || state.bgTools?.pending) return { code: 1, stdout: "", stderr: t("vm.error.busy", "la VM está ocupada") };

  const marker = `__BAGENT_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
  const wrapped = buildExecVmWrappedCommand(command, marker, maxOutputBytes);

  if (lock) setAgentBusy(true, label);
  if (log) logTool(`${NL}[tool] ${formatLoggedCommand(command)}${NL}`);

  return new Promise((resolve) => {
    const finish = (result) => {
      if (lock) setAgentBusy(false);
      resolve(result);
    };

    const timer = window.setTimeout(() => {
      state.pending = null;
      renderConsoleTabs();
      finish({ code: 124, stdout: "", stderr: t("vm.error.timeoutSerial", "timeout esperando serial") });
    }, timeoutMs);

    state.pending = {
      marker,
      raw: "",
      resolve: finish,
      timer,
      resolveOnTokens,
      rejectOnTokens,
      bytesSinceParse: 0,
      // Keep enough tail for limited stdout/stderr plus markers. This prevents
      // accidental unbounded growth if serial0 emits noise while a command hangs.
      maxRawChars: clampExecVmOutputBytes(maxOutputBytes) + 96 * 1024,
    };
    renderConsoleTabs();
    try {
      state.vm.serial0_send(wrapped);
    } catch (error) {
      window.clearTimeout(timer);
      state.pending = null;
      renderConsoleTabs();
      finish({ code: 1, stdout: "", stderr: error.message });
    }
  });
}

async function runCommandFromInput(event) {
  event.preventDefault();
  const command = $("command-input").value.trim();
  if (!command) return;
  const result = await execVm(command, { lock: true, label: t("vm.exec.manualLabel", "Herramienta manual usando la VM…") });
  if (result.stdout) logTool(`${NL}${result.stdout}${NL}`);
  if (result.stderr) logTool(`${NL}[stderr] ${result.stderr}${NL}`);
}

async function sendChat(event) {
  event.preventDefault();
  if (window.BA_LLM_AGENT?.isChatOperationActive?.()) {
    window.BA_LLM_AGENT.stopActiveTurn?.();
    return;
  }
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text || state.agentBusy || window.BA_LLM?.generating) return;
  input.value = "";
  addMessage("user", text);

  // v9.37.2: the chat is now real-LLM only. The old mock command mapper is
  // intentionally disabled so we can validate the local model path before
  // connecting autonomous tools to the VM in the next step.
  if (window.BA_LLM_AGENT?.handleUserMessage) {
    await window.BA_LLM_AGENT.handleUserMessage(text);
    return;
  }

  addMessage("agent", t("chat.agentTransformersNotReady", "El módulo Transformers.js local no está inicializado. Revisa la carga de los ficheros js/10-* a js/15-*. "));
}


async function configureNetworkInVm() {
  if (state.networkConfiguring || state.networkConfigured) return;

  if (!state.vm || !state.vmReady) {
    logTool(`${NL}[network] ${t("net.wsnicReadyWillConfig", "wsnic listo. La red se configurará cuando la shell de la VM esté lista.")}${NL}`);
    return;
  }

  if (state.pending || state.agentBusy) {
    window.setTimeout(() => configureNetworkInVm(), 450);
    return;
  }

  state.networkConfiguring = true;
  logTool(`${NL}[network] ${t("net.configuringAuto", "configurando red automáticamente...")}${NL}`);
  const result = await execVm(VM_NETWORK_COMMAND, {
    lock: true,
    label: t("net.configuringLabel", "Configurando red de la VM…"),
    timeoutMs: 60000,
  });

  if (result.stdout) logTool(`${NL}${result.stdout}${NL}`);
  if (result.stderr) logTool(`${NL}[network stderr] ${result.stderr}${NL}`);

  const ok = result.stdout.includes("HTTP_GOOGLE_OK") || result.stdout.includes("bytes from");
  state.networkConfigured = ok;
  state.networkConfiguring = false;

  if (ok) {
    setBadge($("ws-detail"), t("net.badge.connectedVm", "conectado + VM"), "good");
    logTool(`[network] ${t("net.connectionVerified", "conexión comprobada.")}${NL}`);
  } else {
    setBadge($("ws-detail"), t("net.badge.wsnicOkNoNet", "wsnic ok, VM sin red"), "warn");
    logTool(`[network] ${t("net.wsnicRespondsNotConfigured", "wsnic responde, pero la configuración dentro de la VM no se ha completado.")}${NL}`);
  }

}


async function toggleDiskInVm() {
  const runtime = state.activeRuntime;
  if (!runtime?.hda) return;

  if (!state.vm || !state.vmReady) {
    logTool(`${NL}[disk] ${t("vm.disk.bootFirst", "arranca la VM y espera la shell antes de montar o desmontar el disco.")}${NL}`);
    return;
  }

  const mounting = !state.diskMounted;
  const result = await execVm(mounting ? VM_DISK_MOUNT_COMMAND : VM_DISK_UNMOUNT_COMMAND, {
    lock: true,
    label: mounting ? t("vm.disk.mounting", "Montando disco hda…") : t("vm.disk.unmounting", "Desmontando disco hda…"),
    timeoutMs: mounting ? 45000 : 20000,
  });

  if (result.stdout) logTool(`${NL}${result.stdout}${NL}`);
  if (result.stderr) logTool(`${NL}[disk stderr] ${result.stderr}${NL}`);

  if (mounting) {
    if (result.stdout.includes("DISK_MOUNT_OK")) {
      state.diskMounted = true;
      setBadge($("vm-detail"), t("vm.disk.badge.mounted", "disco montado"), "good");
      logTool(`[disk] ${t("vm.disk.mountedAt", "disco montado en /mnt/hda.")}${NL}`);
    } else {
      setBadge($("vm-detail"), t("vm.disk.badge.notMounted", "disco no montado"), "warn");
      logTool(`[disk] ${t("vm.disk.mountFailed", "no se ha podido montar el disco dentro de la VM.")}${NL}`);
    }
  } else {
    if (result.stdout.includes("DISK_UNMOUNT_OK") || result.stdout.includes("DISK_NOT_MOUNTED")) {
      state.diskMounted = false;
      setBadge($("vm-detail"), t("vm.disk.badge.unmounted", "disco desmontado"), "good");
      logTool(`[disk] ${t("vm.disk.unmountedAt", "disco desmontado de /mnt/hda.")}${NL}`);
    } else {
      state.diskMounted = true;
      setBadge($("vm-detail"), t("vm.disk.badge.inUse", "disco en uso"), "warn");
      logTool(`[disk] ${t("vm.disk.unmountFailed", "no se ha podido desmontar. Cierra procesos o sal del directorio /mnt/hda y vuelve a probar.")}${NL}`);
    }
  }

  syncDiskCheckButton();
}

function maybeConfigureNetwork() {
  if (!state.networkAutoRequested || state.networkConfigured || state.networkConfiguring) return;
  configureNetworkInVm();
}

async function confirmWsDisconnect() {
  const result = await showBaModal({
    title: t("ws.disconnect.title", "Desconectar Red WS"),
    message: t("ws.disconnect.message", "Se cerrará la conexión con el proxy WebSocket local."),
    detail: t("ws.disconnect.detail", "La VM puede conservar temporalmente su IP, pero dejará de tener salida real por wsnic hasta que vuelvas a conectar y configurar la red."),
    buttons: [
      { id: "cancel", label: t("common.cancel", "Cancelar"), variant: "secondary", cancel: true },
      { id: "disconnect", label: t("common.disconnect", "Desconectar"), variant: "danger" },
    ],
  });
  return result === "disconnect";
}

async function disconnectWs({ confirmDisconnect = true } = {}) {
  if (!state.wsSocket && !state.wsConnecting) {
    state.networkAutoRequested = false;
    state.networkConfigured = false;
    state.networkConfiguring = false;
    setBadge($("badge-ws"), t("ws.badge.disconnected", "wsnic desconectado"), "");
    setBadge($("ws-detail"), t("ws.detail.disconnected", "desconectado"), "");
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

  try { socket?.close?.(); } catch {}

  setBadge($("badge-ws"), t("ws.badge.disconnected", "wsnic desconectado"), "");
  setBadge($("ws-detail"), t("ws.detail.disconnected", "desconectado"), "");
  logTool(`${NL}[host] ${t("ws.host.disconnected", "wsnic desconectado.")}${NL}`);
  syncWsButton();
}

async function connectWs() {
  if (isWsConnected()) {
    await disconnectWs({ confirmDisconnect: true });
    return;
  }

  const url = getWsRelayUrl();
  if (window.BA_ORIGIN?.isPublishedOrigin?.()) {
    logTool(`${NL}[network] ${t("net.localPermissionNotice", "Chrome/Edge puede pedir permiso de red local para {url}. Se intentará conectar igualmente.", { url })}${NL}`);
  }
  if (!window.WebSocket) {
    setBadge($("badge-ws"), t("ws.badge.error", "wsnic error"), "bad");
    setBadge($("ws-detail"), t("ws.detail.unavailable", "no disponible"), "bad");
    syncWsButton();
    return;
  }

  state.wsConnecting = true;
  syncWsButton();
  setBadge($("badge-ws"), t("ws.badge.connecting", "wsnic conectando"), "warn");
  setBadge($("ws-detail"), t("ws.detail.connecting", "conectando"), "warn");

  try {
    const socket = new WebSocket(url);
    const timeout = window.setTimeout(() => {
      if (state.wsSocket === socket) state.wsSocket = null;
      state.wsConnecting = false;
      try { socket.close(); } catch {}
      setBadge($("badge-ws"), t("ws.badge.disconnected", "wsnic desconectado"), "");
      setBadge($("ws-detail"), t("ws.detail.noResponse", "no responde"), "warn");
      syncWsButton();
    }, 1800);

    socket.onopen = () => {
      window.clearTimeout(timeout);
      state.wsSocket = socket;
      state.wsConnecting = false;
      state.networkAutoRequested = true;
      state.networkConfigured = false;
      setBadge($("badge-ws"), t("ws.badge.connected", "wsnic conectado"), "good");
      setBadge($("ws-detail"), t("ws.detail.connected", "conectado"), "good");
      logTool(`${NL}[host] ${t("ws.host.connected", "wsnic conectado: {url}", { url })}${NL}`);
      syncWsButton();
      maybeConfigureNetwork();
    };
    socket.onerror = () => {
      window.clearTimeout(timeout);
      if (state.wsSocket === socket) state.wsSocket = null;
      state.wsConnecting = false;
      setBadge($("badge-ws"), t("ws.badge.error", "wsnic error"), "bad");
      setBadge($("ws-detail"), t("ws.detail.cannotConnect", "no conecta"), "bad");
      syncWsButton();
    };
    socket.onclose = () => {
      window.clearTimeout(timeout);
      if (state.wsSocket === socket) state.wsSocket = null;
      state.wsConnecting = false;
      state.networkAutoRequested = false;
      state.networkConfigured = false;
      state.networkConfiguring = false;
      setBadge($("badge-ws"), t("ws.badge.disconnected", "wsnic desconectado"), "");
      setBadge($("ws-detail"), t("ws.detail.closed", "cerrado"), "");
      syncWsButton();
    };
  } catch (error) {
    state.wsConnecting = false;
    setBadge($("badge-ws"), t("ws.badge.error", "wsnic error"), "bad");
    setBadge($("ws-detail"), error.message, "bad");
    syncWsButton();
  }
}

async function saveSnapshot() {
  if (!state.vm || state.vmStarting || state.agentBusy || state.pending || state.bgTools?.pending) return;

  const runtime = state.activeRuntime || getVmRuntimeConfig();
  const diskLabel = runtime.hda ? `hda-${runtime.hda.sizeMb}mb` : "initramfs";
  const filename = `browser-agent-v86-${runtime.ramMb}mb-${diskLabel}-${timestampForFilename()}.v86state`;

  setAgentBusy(true, t("vm.snapshot.saving", "Guardando snapshot…"));
  setLoading(true, { title: t("vm.snapshot.savingTitle", "Guardando snapshot"), detail: t("vm.snapshot.savingDetail", "Serializando estado de la VM…"), percent: null, indeterminate: true });
  await nextPaint();
  logTool(`${NL}[snapshot] ${t("vm.snapshot.savingLog", "guardando estado de v86...")}${NL}`);
  if (runtime.hda) {
    logTool(`[snapshot] ${t("vm.snapshot.noHdaWarning", "aviso: este fichero NO incluye los cambios del disco hda ({url}).", { url: runtime.hda.url })}${NL}`);
  }

  try {
    const buffer = await v86SaveState();
    downloadArrayBuffer(buffer, filename);
    logTool(`[snapshot] ${t("vm.snapshot.downloaded", "descargado {filename} ({size}).", { filename, size: formatBytes(buffer.byteLength) })}${NL}`);
  } catch (error) {
    logTool(`[snapshot] ${t("vm.snapshot.saveError", "error guardando: {error}", { error: error.message })}${NL}`);
    setBadge($("vm-detail"), t("vm.snapshot.badge.saveError", "error snapshot"), "bad");
  } finally {
    setLoading(false);
    setAgentBusy(false);
    syncSnapshotButtons();
  }
}

function openRestoreSnapshotPicker() {
  const input = $("restore-state-file");
  if (!input || state.vmStarting || state.agentBusy || state.pending || state.bgTools?.pending) return;
  input.value = "";
  input.click();
}

async function restoreSnapshotFromFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const shouldContinue = !state.vm || window.confirm(t("vm.snapshot.restoreConfirm", "Esto apagará la VM actual y restaurará el snapshot seleccionado. Asegúrate de usar la misma RAM/disco/configuración que al guardarlo. ¿Continuar?"));
  if (!shouldContinue) return;

  setAgentBusy(true, t("vm.snapshot.reading", "Leyendo snapshot…"));
  setLoading(true, { title: t("vm.snapshot.readingTitle", "Leyendo snapshot"), detail: `${file.name} · ${formatBytes(file.size)}`, percent: null, indeterminate: true });
  await nextPaint();

  try {
    const buffer = await file.arrayBuffer();
    logTool(`${NL}[snapshot] ${t("vm.snapshot.loaded", "cargado {filename} ({size}).", { filename: file.name, size: formatBytes(buffer.byteLength) })}${NL}`);
    logTool(`[snapshot] ${t("vm.snapshot.hdaNotInSnapshot", "aviso: los discos hda no se guardan dentro del snapshot. Usa la misma imagen de disco si seleccionaste hda.")}${NL}`);
    setAgentBusy(false);

    if (state.vm) await stopVm({ confirmShutdown: false });
    await startVm({ restoreStateBuffer: buffer });
  } catch (error) {
    logTool(`[snapshot] ${t("vm.snapshot.restoreError", "error leyendo/restaurando: {error}", { error: error.message })}${NL}`);
    setLoading(false);
    setAgentBusy(false);
    syncSnapshotButtons();
  }
}

async function copyDockerCommand(event) {
  const targetId = event?.currentTarget?.dataset?.copyTarget || "docker-command";
  const command = $(targetId)?.textContent?.trim() || DOCKER_WSNIC_COMMAND;
  const status = $("copy-docker-status");

  async function fallbackCopy(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.className = "clipboard-fallback";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    if (!ok) throw new Error(t("docker.copyError", "No se pudo copiar"));
  }

  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(command);
    } else {
      await fallbackCopy(command);
    }
    if (status) status.textContent = t("common.copied", "Copiado");
    logTool(`${NL}[host] ${t("docker.copiedLog", "comando Docker copiado al portapapeles.")}${NL}`);
  } catch (error) {
    if (status) status.textContent = t("docker.copyFailed", "No se pudo copiar");
    logTool(`${NL}[host] ${t("docker.copyFailedLog", "no se pudo copiar el comando Docker: {error}", { error: error.message })}${NL}`);
  }

  window.setTimeout(() => {
    if (status) status.textContent = "";
  }, 1800);
}
