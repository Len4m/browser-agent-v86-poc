// @ts-nocheck
// Browser Agent v86 - console control over serial2/ttyS2
// Dedicated low-latency channel for tmux UI actions. Unlike serial1 tools,
// this never executes arbitrary shell and does not stream output into the DOM.

(function initConsoleControlSerial2() {
  const MAX_RAW_CHARS = 48 * 1024;
  const DEFAULT_TIMEOUT_MS = 4500;

  const ctl = {
    pending: null,
    runnerReady: false,
    serial2Seen: false,
    lastError: "",
    diagnosticText: "",
  };

  function safeText(value) { return String(value ?? ""); }

  function randomId() {
    return `c2_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  }

  function serial2Available() {
    return Boolean(state.vm && typeof state.vm.serial_send_bytes === "function");
  }

  function sendSerial2Text(text) {
    if (!serial2Available()) throw new Error("serial2 no disponible en esta build de v86");
    state.vm.serial_send_bytes(2, new TextEncoder().encode(safeText(text)));
  }

  function buildFrame(id, action, args = []) {
    const cleanAction = safeText(action).replace(/[^a-z-]/g, "");
    const cleanArgs = [args[0] ?? "", args[1] ?? ""].map((value) => safeText(value).replace(/[^A-Za-z0-9_.-]/g, ""));
    return `__BA_CTL:${id}:${cleanAction}:${cleanArgs[0]}:${cleanArgs[1]}\n`;
  }

  function parseDone(pending) {
    const clean = normalizeNewlines(safeText(pending.raw));
    const endToken = `BA_CTL_END:${pending.id}:`;
    const idx = clean.lastIndexOf(endToken);
    if (idx < 0) return null;
    const rcText = clean.slice(idx + endToken.length).match(/-?\d+/)?.[0];
    if (rcText == null) return null;

    const liveStart = `BA_CTL_LIVE_START:${pending.id}`;
    const liveEnd = `BA_CTL_LIVE_END:${pending.id}`;
    const s = clean.lastIndexOf(liveStart, idx);
    const e = clean.lastIndexOf(liveEnd, idx);
    const body = s >= 0 && e > s ? clean.slice(s + liveStart.length, e) : clean.slice(0, idx);
    return {
      code: Number.parseInt(rcText, 10),
      stdout: trimLinesSimple(stripAnsi(body)),
      stderr: "",
      raw: clean,
    };
  }

  function finishPending(result) {
    const pending = ctl.pending;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    ctl.pending = null;
    pending.resolve(result);
  }

  function appendDiagnostic(char) {
    ctl.diagnosticText += char;
    if (ctl.diagnosticText.length > 8192) ctl.diagnosticText = ctl.diagnosticText.slice(-8192);
    if (ctl.diagnosticText.includes("BA_SERIAL2_CONSOLE_READY")) {
      ctl.runnerReady = true;
      ctl.lastError = "";
    }
    const errorMatch = ctl.diagnosticText.match(/BA_CTL_ERROR:([^\s]+)/);
    if (errorMatch) ctl.lastError = errorMatch[1];
  }

  function onSerial2Byte(byte) {
    ctl.serial2Seen = true;
    const char = String.fromCharCode(byte);
    if (!char || char === "\0") return;

    if (!ctl.pending) {
      appendDiagnostic(char);
      return;
    }

    const pending = ctl.pending;
    pending.raw += char;
    if (pending.raw.length > MAX_RAW_CHARS) pending.raw = pending.raw.slice(-MAX_RAW_CHARS);
    const result = parseDone(pending);
    if (result) finishPending(result);
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
    if (!state.vm) return { code: 1, stdout: "", stderr: "v86 no está arrancada" };
    if (!state.vmReady) return { code: 1, stdout: "", stderr: "la VM está arrancando" };
    if (!serial2Available()) return { code: 1, stdout: "", stderr: "serial2 no disponible" };
    if (!options.skipReadyCheck && !ctl.runnerReady) {
      const ready = await waitForRunnerReady(options.readyTimeoutMs || 900);
      if (!ready) return { code: 1, stdout: "", stderr: "runner serial2/ttyS2 no preparado" };
    }
    if (ctl.pending) return { code: 75, stdout: "", stderr: "ya hay una acción de consola en curso por serial2" };

    const id = randomId();
    const frame = buildFrame(id, action, args);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        finishPending({ code: 124, stdout: "", stderr: "timeout esperando serial2/ttyS2", raw: ctl.pending?.raw || "" });
      }, timeoutMs + 1000);

      ctl.pending = { id, raw: "", resolve, timer };
      try {
        sendSerial2Text(frame);
      } catch (error) {
        window.clearTimeout(timer);
        ctl.pending = null;
        resolve({ code: 1, stdout: "", stderr: error?.message || String(error) });
      }
    });
  }

  function diagnostics() {
    return {
      serial2Available: serial2Available(),
      serial2Seen: ctl.serial2Seen,
      runnerReady: ctl.runnerReady,
      pending: Boolean(ctl.pending),
      lastError: ctl.lastError,
      diagnosticText: ctl.diagnosticText,
    };
  }

  async function probeRunnerReady({ timeoutMs = 1600 } = {}) {
    if (!state.vm || !state.vmReady || !serial2Available()) return false;
    const result = await exec("list", [], {
      timeoutMs,
      readyTimeoutMs: 0,
      skipReadyCheck: true,
    });
    const ok = result.code === 0 && String(result.stdout || "").includes("BA_CONSOLE_WINDOW:");
    if (ok) {
      ctl.runnerReady = true;
      ctl.lastError = "";
    }
    return ok;
  }

  function reset(reason = "reset") {
    if (ctl.pending?.timer) window.clearTimeout(ctl.pending.timer);
    if (ctl.pending?.resolve) {
      try { ctl.pending.resolve({ code: 130, stdout: "", stderr: `control cancelado por ${reason}` }); } catch {}
    }
    ctl.pending = null;
    ctl.runnerReady = false;
    ctl.serial2Seen = false;
    ctl.lastError = "";
    ctl.diagnosticText = "";
  }

  window.BA_CONSOLE_CONTROL = {
    exec,
    onSerial2Byte,
    diagnostics,
    waitForRunnerReady,
    probeRunnerReady,
    reset,
  };
})();
