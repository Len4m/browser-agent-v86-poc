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

async function execVm(command, { lock = true, label = t("common.agentUsingVm"), timeoutMs = 25000, log = true, targetTools = true, resolveOnTokens = [], rejectOnTokens = [], maxOutputBytes = 65536 } = {}) {
  if (!state.vm) return { code: 1, stdout: "", stderr: t("common.v86NotStarted") };
  if (!state.vmReady) return { code: 1, stdout: "", stderr: t("common.vmBooting") };

  // Las operaciones internas/tools usan UART1/ttyS1 y no cambian la consola visible.
  // No hacemos fallback silencioso a serial0 para evitar interferir con el usuario.
  if (targetTools) {
    if (window.BA_BG_TOOLS?.execVm) {
      return window.BA_BG_TOOLS.execVm(command, { label, timeoutMs, maxOutputBytes, log });
    }
    return { code: 1, stdout: "", stderr: t("vm.error.serial1NotInit") };
  }

  if (state.pending || state.agentBusy || state.bgTools?.pending) return { code: 1, stdout: "", stderr: t("vm.error.busy") };

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
      finish({ code: 124, stdout: "", stderr: t("vm.error.timeoutSerial") });
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
  const result = await execVm(command, { lock: true, label: t("vm.exec.manualLabel") });
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

  addMessage("agent", t("chat.agentTransformersNotReady"));
}


async function configureNetworkInVm() {
  if (state.networkConfiguring || state.networkConfigured) return;

  if (!state.vm || !state.vmReady) {
    logTool(`${NL}[network] ${t("net.wsnicReadyWillConfig")}${NL}`);
    return;
  }

  if (state.pending || state.agentBusy) {
    window.setTimeout(() => configureNetworkInVm(), 450);
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

  const ok = result.stdout.includes("HTTP_GOOGLE_OK") || result.stdout.includes("bytes from");
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


async function toggleDiskInVm() {
  const runtime = state.activeRuntime;
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
  } else {
    if (result.stdout.includes("DISK_UNMOUNT_OK") || result.stdout.includes("DISK_NOT_MOUNTED")) {
      state.diskMounted = false;
      setBadge($("vm-detail"), t("vm.disk.badge.unmounted"), "good");
      logTool(`[disk] ${t("vm.disk.unmountedAt")}${NL}`);
    } else {
      state.diskMounted = true;
      setBadge($("vm-detail"), t("vm.disk.badge.inUse"), "warn");
      logTool(`[disk] ${t("vm.disk.unmountFailed")}${NL}`);
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

async function disconnectWs({ confirmDisconnect = true } = {}) {
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

  try { socket?.close?.(); } catch {}

  setBadge($("badge-ws"), t("ws.badge.disconnected"), "");
  setBadge($("ws-detail"), t("common.disconnected"), "");
  logTool(`${NL}[host] ${t("ws.host.disconnected")}${NL}`);
  syncWsButton();
}

async function connectWs() {
  if (isWsConnected()) {
    await disconnectWs({ confirmDisconnect: true });
    return;
  }

  const url = getWsRelayUrl();
  if (window.BA_ORIGIN?.isPublishedOrigin?.()) {
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
      try { socket.close(); } catch {}
      setBadge($("badge-ws"), t("ws.badge.disconnected"), "");
      setBadge($("ws-detail"), t("common.noResponse"), "warn");
      syncWsButton();
    }, 1800);

    socket.onopen = () => {
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
    socket.onerror = () => {
      window.clearTimeout(timeout);
      if (state.wsSocket === socket) state.wsSocket = null;
      state.wsConnecting = false;
      setBadge($("badge-ws"), t("ws.badge.error"), "bad");
      setBadge($("ws-detail"), t("common.cannotConnect"), "bad");
      syncWsButton();
    };
    socket.onclose = () => {
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
    setBadge($("ws-detail"), error.message, "bad");
    syncWsButton();
  }
}

async function saveSnapshot() {
  if (!state.vm || state.vmStarting || state.agentBusy || state.pending || state.bgTools?.pending) return;

  const runtime = state.activeRuntime || getVmRuntimeConfig();
  const diskLabel = runtime.hda ? `hda-${runtime.hda.sizeMb}mb` : "initramfs";
  const filename = `browser-agent-v86-${runtime.ramMb}mb-${diskLabel}-${timestampForFilename()}.v86state`;

  setAgentBusy(true, t("vm.snapshot.saving"));
  setLoading(true, { title: t("vm.snapshot.savingTitle"), detail: t("vm.snapshot.savingDetail"), percent: null, indeterminate: true });
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
    logTool(`[snapshot] ${t("vm.snapshot.saveError", { error: error.message })}${NL}`);
    setBadge($("vm-detail"), t("common.snapshotError"), "bad");
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

async function confirmRestoreSnapshot() {
  if (typeof showBaModal !== "function") return window.confirm(t("vm.snapshot.restoreConfirm"));
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

async function restoreSnapshotFromFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const shouldContinue = !state.vm || await confirmRestoreSnapshot();
  if (!shouldContinue) return;

  setAgentBusy(true, t("vm.snapshot.reading"));
  setLoading(true, { title: t("vm.snapshot.readingTitle"), detail: `${file.name} · ${formatBytes(file.size)}`, percent: null, indeterminate: true });
  await nextPaint();

  try {
    const buffer = await file.arrayBuffer();
    logTool(`${NL}[snapshot] ${t("common.loadedFile", { filename: file.name, size: formatBytes(buffer.byteLength) })}${NL}`);
    logTool(`[snapshot] ${t("vm.snapshot.hdaNotInSnapshot")}${NL}`);
    setAgentBusy(false);

    if (state.vm) await stopVm({ confirmShutdown: false });
    await startVm({ restoreStateBuffer: buffer });
  } catch (error) {
    logTool(`[snapshot] ${t("vm.snapshot.restoreError", { error: error.message })}${NL}`);
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
    if (!ok) throw new Error(t("common.copyFailed"));
  }

  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(command);
    } else {
      await fallbackCopy(command);
    }
    if (status) status.textContent = t("common.copied");
    logTool(`${NL}[host] ${t("docker.copiedLog")}${NL}`);
  } catch (error) {
    if (status) status.textContent = t("common.copyFailed");
    logTool(`${NL}[host] ${t("docker.copyFailedLog", { error: error.message })}${NL}`);
  }

  window.setTimeout(() => {
    if (status) status.textContent = "";
  }, 1800);
}
