// @ts-nocheck
// Browser Agent v86 - xterm console control over serial2/ttyS2
// serial2 now carries a small framed protocol that multiplexes up to four
// real PTY-backed consoles. It does not execute arbitrary shell commands.

(function initXtermConsoleControlSerial2() {
  const MAX_RAW_CHARS = 96 * 1024;
  const DEFAULT_TIMEOUT_MS = 4500;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const ctl = {
    pending: new Map(),
    runnerReady: false,
    serial2Seen: false,
    lastError: "",
    diagnosticText: "",
    lineBuffer: "",
    outputHandlers: new Set(),
    eventHandlers: new Set(),
  };

  function safeText(value) { return String(value ?? ""); }

  function randomId() {
    return `x2_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  }

  function serial2Available() {
    return Boolean(state.vm && typeof state.vm.serial_send_bytes === "function");
  }

  function sendSerial2Text(text) {
    if (!serial2Available()) throw new Error(t("common.serialUnavailableBuild", { port: "2" }));
    state.vm.serial_send_bytes(2, encoder.encode(safeText(text)));
  }

  function b64EncodeBytes(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function b64DecodeBytes(text) {
    const binary = atob(safeText(text));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function b64EncodeText(text) {
    return b64EncodeBytes(encoder.encode(safeText(text)));
  }

  function b64DecodeText(text) {
    return decoder.decode(b64DecodeBytes(text));
  }

  function cleanToken(value) {
    return safeText(value).replace(/[^A-Za-z0-9_.-]/g, "_");
  }

  function buildFrame(id, action, args = []) {
    const cleanAction = cleanToken(action).replace(/[^a-z-]/g, "");
    const cleanArgs = [
      args[0] ?? "",
      args[1] ?? "",
      args[2] ?? "",
      args[3] ?? "",
    ].map(cleanToken);
    return `__BA_XTERM:${id}:${cleanAction}:${cleanArgs[0]}:${cleanArgs[1]}:${cleanArgs[2]}:${cleanArgs[3]}\n`;
  }

  function appendDiagnostic(line) {
    ctl.diagnosticText += `${line}\n`;
    if (ctl.diagnosticText.length > 8192) ctl.diagnosticText = ctl.diagnosticText.slice(-8192);
    if (line.startsWith("BA_XTERM_READY")) {
      ctl.runnerReady = true;
      ctl.lastError = "";
    }
    const errorMatch = line.match(/BA_XTERM_ERROR:([^\s]+)/);
    if (errorMatch) ctl.lastError = errorMatch[1];
  }

  function finishPending(id, result) {
    const pending = ctl.pending.get(id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    ctl.pending.delete(id);
    pending.resolve(result);
  }

  function emitOutput(sessionId, bytes) {
    for (const handler of ctl.outputHandlers) {
      try { handler(sessionId, bytes); } catch (error) { console.warn("[xterm-control] output handler failed", error); }
    }
  }

  function emitEvent(event) {
    for (const handler of ctl.eventHandlers) {
      try { handler(event); } catch (error) { console.warn("[xterm-control] event handler failed", error); }
    }
  }

  function handleLine(rawLine) {
    const line = safeText(rawLine).replace(/\r$/, "");
    if (!line) return;

    if (line.startsWith("BA_XTERM_OUT:")) {
      const parts = line.split(":");
      const sessionId = parts[1] || "";
      const payload = parts.slice(2).join(":");
      if (!sessionId || !payload) return;
      try { emitOutput(sessionId, b64DecodeBytes(payload)); } catch (error) { ctl.lastError = `decode-output:${error.message}`; }
      return;
    }

    if (line.startsWith("BA_XTERM_REPLY:")) {
      const parts = line.split(":");
      const id = parts[1] || "";
      const code = Number.parseInt(parts[2] || "1", 10);
      const payload = parts.slice(3).join(":");
      const text = payload ? b64DecodeText(payload) : "";
      finishPending(id, { code: Number.isFinite(code) ? code : 1, stdout: text, stderr: code === 0 ? "" : text, raw: line });
      return;
    }

    if (line.startsWith("BA_XTERM_EVENT:")) {
      const parts = line.split(":");
      emitEvent({ type: parts[1] || "", sessionId: parts[2] || "", detail: parts.slice(3).join(":") });
      return;
    }

    appendDiagnostic(line);
  }

  function onSerial2Byte(byte) {
    ctl.serial2Seen = true;
    const char = String.fromCharCode(byte);
    if (!char || char === "\0") return;

    ctl.lineBuffer += char;
    if (ctl.lineBuffer.length > MAX_RAW_CHARS) ctl.lineBuffer = ctl.lineBuffer.slice(-MAX_RAW_CHARS);

    let idx = ctl.lineBuffer.indexOf("\n");
    while (idx >= 0) {
      const line = ctl.lineBuffer.slice(0, idx);
      ctl.lineBuffer = ctl.lineBuffer.slice(idx + 1);
      handleLine(line);
      idx = ctl.lineBuffer.indexOf("\n");
    }
  }

  function waitForRunnerReady(timeoutMs = 900) {
    if (ctl.runnerReady) return Promise.resolve(true);
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (ctl.runnerReady) return resolve(true);
        if (Date.now() - started >= timeoutMs) return resolve(false);
        window.setTimeout(tick, 80);
      };
      tick();
    });
  }

  async function exec(action, args = [], options = {}) {
    const timeoutMs = clampInt(options.timeoutMs, 500, 30000, DEFAULT_TIMEOUT_MS);
    if (!state.vm) return { code: 1, stdout: "", stderr: t("common.v86NotStarted") };
    if (!state.vmReady) return { code: 1, stdout: "", stderr: t("common.vmBooting") };
    if (!serial2Available()) return { code: 1, stdout: "", stderr: t("common.serialUnavailable", { port: "2" }) };
    if (!options.skipReadyCheck && !ctl.runnerReady) {
      const ready = await waitForRunnerReady(options.readyTimeoutMs || 1200);
      if (!ready) return { code: 1, stdout: "", stderr: t("console.ctl.error.daemonNotReady") };
    }

    const id = randomId();
    const frame = buildFrame(id, action, args);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        ctl.pending.delete(id);
        resolve({ code: 124, stdout: "", stderr: t("console.ctl.error.timeout"), raw: "" });
      }, timeoutMs + 1000);

      ctl.pending.set(id, { resolve, timer });
      try {
        sendSerial2Text(frame);
      } catch (error) {
        window.clearTimeout(timer);
        ctl.pending.delete(id);
        resolve({ code: 1, stdout: "", stderr: error?.message || String(error) });
      }
    });
  }

  async function createSession(sessionId, { cols = 100, rows = 24 } = {}) {
    return exec("create", [sessionId, cols, rows], { timeoutMs: 6000 });
  }

  async function closeSession(sessionId) {
    return exec("close", [sessionId], { timeoutMs: 4000 });
  }

  async function resizeSession(sessionId, cols, rows) {
    return exec("resize", [sessionId, cols, rows], { timeoutMs: 2500 });
  }

  async function listSessions() {
    const result = await exec("list", [], { timeoutMs: 2500 });
    if (result.code !== 0) return [];
    try { return JSON.parse(result.stdout || "[]"); } catch { return []; }
  }

  function sendInput(sessionId, text) {
    if (!serial2Available()) return false;
    try {
      const payload = b64EncodeText(text);
      sendSerial2Text(`__BA_XTERM_IN:${cleanToken(sessionId)}:${payload}\n`);
      return true;
    } catch (error) {
      ctl.lastError = error?.message || String(error);
      return false;
    }
  }

  function onOutput(handler) {
    ctl.outputHandlers.add(handler);
    return { dispose: () => ctl.outputHandlers.delete(handler) };
  }

  function onEvent(handler) {
    ctl.eventHandlers.add(handler);
    return { dispose: () => ctl.eventHandlers.delete(handler) };
  }

  function diagnostics() {
    return {
      serial2Available: serial2Available(),
      serial2Seen: ctl.serial2Seen,
      runnerReady: ctl.runnerReady,
      pending: ctl.pending.size > 0,
      lastError: ctl.lastError,
      diagnosticText: ctl.diagnosticText,
    };
  }

  async function probeRunnerReady({ timeoutMs = 1600 } = {}) {
    if (!state.vm || !state.vmReady || !serial2Available()) return false;
    if (!ctl.runnerReady) {
      try { sendSerial2Text("__BA_XTERM_PING\n"); } catch {}
      await waitForRunnerReady(timeoutMs);
    }
    if (!ctl.runnerReady) return false;
    const result = await exec("list", [], {
      timeoutMs,
      readyTimeoutMs: 0,
      skipReadyCheck: true,
    });
    const ok = result.code === 0;
    if (ok) {
      ctl.runnerReady = true;
      ctl.lastError = "";
    }
    return ok;
  }

  function reset(reason = "reset") {
    for (const [id, pending] of ctl.pending.entries()) {
      if (pending?.timer) window.clearTimeout(pending.timer);
      try { pending.resolve({ code: 130, stdout: "", stderr: t("console.ctl.cancelledBy", { reason }) }); } catch {}
      ctl.pending.delete(id);
    }
    ctl.runnerReady = false;
    ctl.serial2Seen = false;
    ctl.lastError = "";
    ctl.diagnosticText = "";
    ctl.lineBuffer = "";
  }

  window.BA_CONSOLE_CONTROL = {
    exec,
    createSession,
    closeSession,
    resizeSession,
    listSessions,
    sendInput,
    onOutput,
    onEvent,
    onSerial2Byte,
    diagnostics,
    waitForRunnerReady,
    probeRunnerReady,
    reset,
  };
})();
