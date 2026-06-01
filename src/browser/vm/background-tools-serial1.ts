// @ts-nocheck
// Browser Agent v86 - background tools over serial1/ttyS1
// Tools run through UART1 while the user keeps interactive xterm consoles separate.

(function initBackgroundToolsSerial1() {
  const MAX_LIVE_CHARS = 64 * 1024;
  const MAX_DIAGNOSTIC_CHARS = 16 * 1024;
  const MAX_PENDING_RAW_OVERHEAD_CHARS = 64 * 1024;
  const DEFAULT_TIMEOUT_MS = 25000;
  const DEFAULT_MAX_OUTPUT_BYTES = 65536;

  function safeText(value) { return String(value ?? ""); }

  function ensureState() {
    if (!state.bgTools) {
      state.bgTools = {
        pending: null,
        lastResult: null,
        liveText: "",
        diagnosticText: "",
        serial1Seen: false,
        runnerReady: false,
        lastError: "",
        mounted: false,
      };
    }
    return state.bgTools;
  }

  function cleanRunnerOutput(text) {
    return safeText(text)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .filter((line) => !/^\[ba-s1\]\s+(start|end)\b/.test(line.trim()))
      .join("\n");
  }

  function randomId() {
    return `s1_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  }

  function getLivePre() { return document.getElementById("bg-tool-live"); }
  function getStatusEl() { return document.getElementById("bg-tool-status"); }
  function getHeadingEl() { return document.getElementById("bg-tool-heading"); }

  function appendBounded(prop, text, max) {
    const bg = ensureState();
    bg[prop] = safeText(bg[prop] + safeText(text));
    if (bg[prop].length > max) bg[prop] = bg[prop].slice(bg[prop].length - max);
    return bg[prop];
  }

  function appendLive(text) {
    const value = appendBounded("liveText", text, MAX_LIVE_CHARS);
    const pre = getLivePre();
    if (pre) {
      pre.textContent = value || t("bgtools.noActiveRun");
      pre.scrollTop = pre.scrollHeight;
    }
  }

  function setStatus(text, tone = "") {
    const el = getStatusEl();
    if (el && typeof setBadge === "function") setBadge(el, text, tone);
    else if (el) el.textContent = text;
  }

  function serial1Available() {
    return Boolean(state.vm && (typeof state.vm.serial_send_bytes === "function" || typeof state.vm.serial1_send === "function"));
  }

  function isRunnerReady() {
    return Boolean(ensureState().runnerReady);
  }

  function enabled() {
    return Boolean(state.vm && state.vmReady && serial1Available() && isRunnerReady());
  }

  function diagnostics() {
    const bg = ensureState();
    return {
      serial1Available: serial1Available(),
      serial1Seen: Boolean(bg.serial1Seen),
      runnerReady: Boolean(bg.runnerReady),
      pending: Boolean(bg.pending),
      lastError: bg.lastError || "",
      diagnosticText: bg.diagnosticText || "",
    };
  }

  function refreshDependentUi() {
    try { syncPowerButtons?.(); } catch {}
    try { syncDiskCheckButton?.(); } catch {}
    try { syncSnapshotButtons?.(); } catch {}
    try { syncChecksButton?.(); } catch {}
    try { renderConsoleTabs?.(); } catch {}
    try { window.BA_LLM_AGENT?.updateChatAvailability?.(); } catch {}
    try { window.BA_LLM_EVENTS?.emit?.("resource", window.BA_LLM_RESOURCE_GOVERNOR?.getSnapshot?.() || {}); } catch {}
  }

  function syncUi() {
    const bg = ensureState();
    const busy = Boolean(bg.pending);
    document.body.classList.toggle("bg-tool-busy", busy);

    const commandInput = document.getElementById("command-input");
    const commandButton = document.querySelector("#command-form button");
    if (commandInput) commandInput.disabled = busy || Boolean(state.agentBusy);
    if (commandButton) commandButton.disabled = busy || Boolean(state.agentBusy);

    const heading = getHeadingEl();
    if (heading) heading.textContent = busy ? t("bgtools.heading.busy", { label: bg.pending?.label || t("bgtools.runningFallback") }) : t("bgtools.heading.idle");

    if (busy) setStatus(t("bgtools.status.running"), "warn");
    else if (bg.runnerReady) setStatus(bg.lastResult ? t("bgtools.status.lastReady") : t("bgtools.status.serial1Ready"), "good");
    else if (serial1Available()) setStatus(t("bgtools.status.waitingRunner"), "warn");
    else setStatus(t("common.serialUnavailable", { port: "1" }), "bad");

    const details = document.getElementById("bg-tool-details");
    if (details && busy) details.open = true;
    refreshDependentUi();
  }

  function mountUi() {
    const bg = ensureState();
    if (bg.mounted || document.getElementById("bg-tool-details")) return;

    const terminal = document.getElementById("terminal");
    const parent = terminal?.parentNode || document.querySelector(".panel");
    if (!parent) return;

    const details = document.createElement("details");
    details.id = "bg-tool-details";
    details.className = "bg-tool-details";
    details.open = false;
    details.innerHTML = `
      <summary class="bg-tool-summary">
        <strong id="bg-tool-heading">${t("bgtools.heading.idle")}</strong>
        <span id="bg-tool-status" class="badge">${t("bgtools.status.pendingSerial1")}</span>
      </summary>
      <div class="bg-tool-note">
        ${t("bgtools.note")}
      </div>
      <pre id="bg-tool-live" class="terminal bg-tool-live" aria-live="polite">${t("bgtools.noActiveRun")}</pre>
    `;

    if (terminal?.parentNode) terminal.parentNode.insertBefore(details, terminal.nextSibling);
    else parent.appendChild(details);
    bg.mounted = true;
    const pre = getLivePre();
    if (pre && bg.liveText) pre.textContent = bg.liveText;
    syncUi();
  }

  function sendSerial1Text(text) {
    if (!state.vm) throw new Error(t("common.v86NotStarted"));
    const value = safeText(text);
    if (typeof state.vm.serial_send_bytes === "function") {
      state.vm.serial_send_bytes(1, new TextEncoder().encode(value));
      return true;
    }
    if (typeof state.vm.serial1_send === "function") {
      state.vm.serial1_send(value);
      return true;
    }
    throw new Error(t("bgtools.error.noSerialApi"));
  }

  function buildPayload({ id, marker, command, timeoutMs, maxOutputBytes }) {
    const timeoutSeconds = clampInt(Math.ceil(timeoutMs / 1000), 1, 600, 25);
    const maxBytes = clampInt(maxOutputBytes, 1024, 1024 * 1024, DEFAULT_MAX_OUTPUT_BYTES);
    const encoded = utf8ToBase64(command);
    const lines = encoded.match(/.{1,72}/g) || [""];
    return [
      `__BA_S1_BEGIN:${id}:${timeoutSeconds}:${maxBytes}:${marker}`,
      ...lines,
      `__BA_S1_END:${id}`,
      "",
    ].join("\n");
  }

  function parseDone(pending) {
    const clean = safeText(pending.raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const endToken = `${pending.marker}_END:`;
    const idx = clean.lastIndexOf(endToken);
    if (idx < 0) return null;
    const escaped = endToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = clean.slice(idx).match(new RegExp(`^${escaped}[ \\t]*(-?\\d+)[ \\t]*\\n`));
    if (!match) return null;

    const liveStart = `${pending.marker}_LIVE_START`;
    const liveEnd = `${pending.marker}_LIVE_END`;
    const s = clean.lastIndexOf(liveStart, idx);
    const e = clean.lastIndexOf(liveEnd, idx);
    const stdout = s >= 0 && e > s ? clean.slice(s + liveStart.length, e) : clean.slice(0, idx);
    const cleanedStdout = cleanRunnerOutput(stripAnsi(stdout));
    return {
      code: Number.parseInt(match[1] || "0", 10),
      stdout: trimLinesSimple(cleanedStdout),
      stderr: "",
      raw: clean,
    };
  }

  function finishPending(result) {
    const bg = ensureState();
    const pending = bg.pending;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    bg.pending = null;
    bg.lastResult = result;
    appendLive(`\n[serial1] ${t("bgtools.live.end", { code: result.code })}\n`);
    syncUi();
    pending.resolve(result);
  }

  function processDiagnosticChar(char) {
    const bg = ensureState();
    const text = appendBounded("diagnosticText", char, MAX_DIAGNOSTIC_CHARS);
    if (text.includes("BA_SERIAL1_RUNNER_READY")) {
      bg.runnerReady = true;
      bg.lastError = "";
      syncUi();
    }
    const errorMatch = text.match(/BA_SERIAL1_ERROR:([^\s]+)/);
    if (errorMatch) {
      bg.lastError = errorMatch[1];
      syncUi();
    }
  }

  function onSerial1Byte(byte) {
    const bg = ensureState();
    bg.serial1Seen = true;
    const char = String.fromCharCode(byte);
    if (!char || char === "\0") return;

    if (!bg.pending) {
      processDiagnosticChar(char);
      appendLive(char);
      return;
    }

    const pending = bg.pending;
    pending.raw += char;
    if (pending.maxRawChars && pending.raw.length > pending.maxRawChars) {
      pending.raw = pending.raw.slice(-pending.maxRawChars);
    }
    appendLive(char);
    const result = parseDone(pending);
    if (result) finishPending(result);
  }

  function waitForRunnerReady(timeoutMs = 1500) {
    if (isRunnerReady()) return Promise.resolve(true);
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (isRunnerReady()) return resolve(true);
        if (Date.now() - started >= timeoutMs) return resolve(false);
        window.setTimeout(tick, 100);
      };
      tick();
    });
  }

  async function execVmSerial1(command, options = {}) {
    const {
      label = t("bgtools.exec.defaultLabel"),
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
      timeoutGraceMs = 5000,
      log = true,
      skipReadyCheck = false,
    } = options || {};

    if (!state.vm) return { code: 1, stdout: "", stderr: t("common.v86NotStarted") };
    if (!state.vmReady) return { code: 1, stdout: "", stderr: t("common.vmBooting") };
    if (!serial1Available()) return { code: 1, stdout: "", stderr: t("common.serialUnavailableBuild", { port: "1" }) };

    mountUi();
    if (!skipReadyCheck && !isRunnerReady()) {
      const ready = await waitForRunnerReady(1800);
      if (!ready) return { code: 1, stdout: "", stderr: t("bgtools.error.runnerNotReady") };
    }

    const bg = ensureState();
    if (bg.pending) return { code: 75, stdout: "", stderr: t("bgtools.error.alreadyRunning") };

    bg.liveText = "";
    const id = randomId();
    const marker = `__BA_S1_${id}__`;
    const payload = buildPayload({ id, marker, command, timeoutMs, maxOutputBytes });
    if (log && typeof logTool === "function") logTool(`\n[bg-tool] ${typeof formatLoggedCommand === "function" ? formatLoggedCommand(command) : command}\n`);
    appendLive(`[serial1] ${t("bgtools.live.launching", { label })}\n`);
    syncUi();

    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        finishPending({ code: 124, stdout: "", stderr: t("bgtools.error.timeout"), raw: bg.pending?.raw || "" });
      }, timeoutMs + timeoutGraceMs);

      bg.pending = {
        id,
        marker,
        label,
        raw: "",
        resolve,
        timer,
        maxRawChars: clampInt(maxOutputBytes, 1024, 1024 * 1024, DEFAULT_MAX_OUTPUT_BYTES) + MAX_PENDING_RAW_OVERHEAD_CHARS,
      };
      syncUi();

      try {
        sendSerial1Text(payload);
      } catch (error) {
        window.clearTimeout(timer);
        bg.pending = null;
        syncUi();
        resolve({ code: 1, stdout: "", stderr: error?.message || String(error) });
      }
    });
  }

  async function probeRunnerReady({ timeoutMs = 1800 } = {}) {
    const bg = ensureState();
    if (!state.vm || !state.vmReady || !serial1Available()) return false;
    const result = await execVmSerial1("printf 'BA_S1_PROBE_OK\\n'", {
      label: t("bgtools.exec.probeLabel"),
      timeoutMs,
      timeoutGraceMs: 700,
      maxOutputBytes: 4096,
      log: false,
      skipReadyCheck: true,
    });
    const ok = result.code === 0 && String(result.stdout || "").includes("BA_S1_PROBE_OK");
    if (ok) {
      bg.runnerReady = true;
      bg.lastError = "";
      syncUi();
    }
    return ok;
  }

  function cancelPending(reason = t("bgtools.reason.user")) {
    const bg = ensureState();
    const pending = bg.pending;
    if (!pending) return false;
    if (pending.timer) window.clearTimeout(pending.timer);
    const resolve = pending.resolve;
    bg.pending = null;
    syncUi();
    appendLive(`\n[serial1] ${t("bgtools.live.cancelled", { reason })}\n`);
    try {
      resolve({ code: 130, stdout: "", stderr: t("bgtools.cancelledBy", { reason }) });
    } catch {}
    return true;
  }

  function cancelCurrent() {
    cancelPending(t("bgtools.reason.user"));
  }

  function reset(reason = "reset") {
    const bg = ensureState();
    if (bg.pending?.timer) window.clearTimeout(bg.pending.timer);
    if (bg.pending?.resolve) {
      try { bg.pending.resolve({ code: 130, stdout: "", stderr: t("bgtools.cancelledBy", { reason }) }); } catch {}
    }
    bg.pending = null;
    bg.lastResult = null;
    bg.liveText = "";
    bg.diagnosticText = "";
    bg.serial1Seen = false;
    bg.runnerReady = false;
    bg.lastError = "";
    const pre = getLivePre();
    if (pre) pre.textContent = t("bgtools.noActiveRun");
    syncUi();
  }

  window.addEventListener("ba:langchange", () => {
    try {
      const note = document.querySelector("#bg-tool-details .bg-tool-note");
      if (note) note.textContent = t("bgtools.note");
      const pre = getLivePre();
      if (pre && !ensureState().liveText) pre.textContent = t("bgtools.noActiveRun");
      syncUi();
    } catch {}
  });

  window.BA_BG_TOOLS = {
    enabled,
    mountUi,
    onSerial1Byte,
    execVm: execVmSerial1,
    cancelCurrent,
    cancelPending,
    sendSerial1Text,
    probeRunnerReady,
    diagnostics,
    isRunnerReady,
    waitForRunnerReady,
    reset,
    syncUi,
  };
})();
