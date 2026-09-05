// Browser Agent v86 - background tools over serial1/ttyS1.
// Tools run through UART1 while the user keeps interactive xterm consoles separate.

import { state } from "../app/state";
import { t } from "../app/i18n";
import { clampInt, stripAnsi, trimLinesSimple, utf8ToBase64 } from "../app/text-utils";
import { errorMessage, isRecord, safeText, setDisabled } from "../app/value-utils";
import { appEvents } from "../core/events";
import {
  formatLoggedCommand,
  logTool,
  setBadge,
  syncChecksButton,
  syncPowerButtons,
  syncSnapshotButtons,
} from "../ui/status-controls";

const MAX_LIVE_CHARS = 64 * 1024;
const MAX_DIAGNOSTIC_CHARS = 16 * 1024;
const MAX_PENDING_RAW_OVERHEAD_CHARS = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_MAX_OUTPUT_BYTES = 65536;
const encoder = new TextEncoder();

interface BackgroundToolResult {
  code: number;
  stdout: string;
  stderr: string;
  raw?: string;
}

export interface BackgroundToolDiagnostics {
  serial1Available: boolean;
  serial1Seen: boolean;
  runnerReady: boolean;
  pending: boolean;
  lastError: string;
  diagnosticText: string;
}

interface BackgroundExecVmOptions {
  label?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  timeoutGraceMs?: number;
  log?: boolean;
  skipReadyCheck?: boolean;
}

interface BackgroundToolsApi {
  enabled: () => boolean;
  mountUi: () => void;
  onSerial1Byte: (byte: number) => void;
  execVm: (command: string, options?: BackgroundExecVmOptions) => Promise<BackgroundToolResult>;
  cancelCurrent: () => void;
  cancelPending: (reason?: string) => boolean;
  sendSerial1Text: (text: string) => boolean;
  probeRunnerReady: (options?: { timeoutMs?: number }) => Promise<boolean>;
  diagnostics: () => BackgroundToolDiagnostics;
  isRunnerReady: () => boolean;
  waitForRunnerReady: (timeoutMs?: number) => Promise<boolean>;
  reset: (reason?: string) => void;
  syncUi: () => void;
}

interface BackgroundToolPending {
  id: string;
  marker: string;
  label: string;
  raw: string;
  resolve: (result: BackgroundToolResult) => void;
  timer: number | null;
  settled: boolean;
  maxRawChars: number;
  cancelRequested?: boolean;
}

interface BackgroundToolsState {
  pending: BackgroundToolPending | null;
  lastResult: BackgroundToolResult | null;
  liveText: string;
  diagnosticText: string;
  serial1Seen: boolean;
  runnerReady: boolean;
  lastError: string;
  mounted: boolean;
}

interface VmSerial1Api {
  serial_send_bytes?: (port: number, bytes: Uint8Array) => void;
  serial1_send?: (text: string) => void;
}

let initialized = false;

function vmSerial1Api(): VmSerial1Api | null {
  return isRecord(state.vm) ? state.vm : null;
}

function bgState(): BackgroundToolsState {
  return state.bgTools as BackgroundToolsState;
}

function cleanRunnerOutput(text: unknown): string {
  return safeText(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => !/^\[ba-s1\]\s+(start|end)\b/.test(line.trim()))
    .join("\n");
}

function randomId(): string {
  return `s1_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function getLivePre(): HTMLElement | null {
  return document.getElementById("bg-tool-live");
}

function getStatusEl(): HTMLElement | null {
  return document.getElementById("bg-tool-status");
}

function getHeadingEl(): HTMLElement | null {
  return document.getElementById("bg-tool-heading");
}

function appendBounded(prop: "liveText" | "diagnosticText", text: unknown, max: number): string {
  const bg = bgState();
  let value = safeText(bg[prop]) + safeText(text);
  if (value.length > max) value = value.slice(value.length - max);
  bg[prop] = value;
  return value;
}

function appendLive(text: unknown): void {
  const value = appendBounded("liveText", text, MAX_LIVE_CHARS);
  const pre = getLivePre();
  if (pre) {
    pre.textContent = value || t("bgtools.noActiveRun");
    pre.scrollTop = pre.scrollHeight;
  }
}

function setStatus(text: string, tone = ""): void {
  const el = getStatusEl();
  if (el) setBadge(el, text, tone);
}

function serial1Available(): boolean {
  const vm = vmSerial1Api();
  return Boolean(typeof vm?.serial_send_bytes === "function" || typeof vm?.serial1_send === "function");
}

function isRunnerReady(): boolean {
  return Boolean(bgState().runnerReady);
}

function enabled(): boolean {
  return Boolean(state.vm && state.vmReady && serial1Available() && isRunnerReady());
}

function diagnostics(): BackgroundToolDiagnostics {
  const bg = bgState();
  return {
    serial1Available: serial1Available(),
    serial1Seen: Boolean(bg.serial1Seen),
    runnerReady: Boolean(bg.runnerReady),
    pending: Boolean(bg.pending),
    lastError: bg.lastError || "",
    diagnosticText: bg.diagnosticText || "",
  };
}

function refreshDependentUi(): void {
  syncPowerButtons();
  syncSnapshotButtons();
  syncChecksButton();
  appEvents.emit("console:state-changed", { source: "background-tools" });
  appEvents.emit("llm:availability-refresh-requested", { source: "background-tools" });
}

function syncUi(): void {
  const bg = bgState();
  const pending = bg.pending;
  const busy = Boolean(pending);
  document.body.classList.toggle("bg-tool-busy", busy);

  setDisabled(document.getElementById("command-input"), busy || Boolean(state.agentBusy));
  setDisabled(document.querySelector("#command-form button"), busy || Boolean(state.agentBusy));

  const heading = getHeadingEl();
  if (heading) {
    heading.textContent = busy
      ? t("bgtools.heading.busy", { label: pending?.label || t("bgtools.runningFallback") })
      : t("bgtools.heading.idle");
  }

  if (busy) setStatus(t("bgtools.status.running"), "warn");
  else if (bg.runnerReady) setStatus(bg.lastResult ? t("bgtools.status.lastReady") : t("bgtools.status.serial1Ready"), "good");
  else if (serial1Available()) setStatus(t("bgtools.status.waitingRunner"), "warn");
  else setStatus(t("common.serialUnavailable", { port: "1" }), "bad");

  const details = document.getElementById("bg-tool-details");
  if (details instanceof HTMLDetailsElement && busy) details.open = true;
  refreshDependentUi();
}

function mountUi(): void {
  const bg = bgState();
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

function sendSerial1Text(text: string): boolean {
  const vm = vmSerial1Api();
  if (!vm) throw new Error(t("common.v86NotStarted"));
  const value = safeText(text);
  if (typeof vm.serial_send_bytes === "function") {
    vm.serial_send_bytes(1, encoder.encode(value));
    return true;
  }
  if (typeof vm.serial1_send === "function") {
    vm.serial1_send(value);
    return true;
  }
  throw new Error(t("bgtools.error.noSerialApi"));
}

function buildPayload({ id, marker, command, timeoutMs, maxOutputBytes }: {
  id: string;
  marker: string;
  command: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): string {
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

function parseDone(pending: BackgroundToolPending): BackgroundToolResult | null {
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

function finishPending(result: BackgroundToolResult): void {
  const bg = bgState();
  const pending = bg.pending;
  if (!pending) return;
  if (pending.timer) window.clearTimeout(pending.timer);
  bg.pending = null;
  bg.lastResult = result;
  appendLive(`\n[serial1] ${t("bgtools.live.end", { code: result.code })}\n`);
  syncUi();
  if (!pending.settled) {
    pending.settled = true;
    pending.resolve(result);
  }
}

function settlePending(pending: BackgroundToolPending | null, result: BackgroundToolResult): boolean {
  if (!pending || pending.settled) return false;
  pending.settled = true;
  if (pending.timer) {
    window.clearTimeout(pending.timer);
    pending.timer = null;
  }
  pending.resolve(result);
  return true;
}

function schedulePendingClear(pending: BackgroundToolPending | null, result: BackgroundToolResult, delayMs = 5000): void {
  if (!pending) return;
  if (pending.timer) window.clearTimeout(pending.timer);
  pending.timer = window.setTimeout(() => {
    const bg = bgState();
    if (bg.pending?.id !== pending.id) return;
    finishPending({ ...result, raw: bg.pending?.raw || result.raw || "" });
  }, delayMs);
}

function requestRunnerCancel(pending: BackgroundToolPending | null, reason = t("bgtools.reason.user")): boolean {
  if (!pending?.id) return false;
  try {
    sendSerial1Text(`__BA_S1_CANCEL:${pending.id}\n`);
    appendLive(`\n[serial1] ${t("bgtools.live.cancelSignal", { reason })}\n`);
    return true;
  } catch (error) {
    appendLive(`\n[serial1] ${t("bgtools.live.cancelSignalFailed", { error: errorMessage(error) })}\n`);
    return false;
  }
}

function processDiagnosticChar(char: string): void {
  const bg = bgState();
  const text = appendBounded("diagnosticText", char, MAX_DIAGNOSTIC_CHARS);
  if (text.includes("BA_SERIAL1_RUNNER_READY")) {
    bg.runnerReady = true;
    bg.lastError = "";
    syncUi();
  }
  const errorMatch = text.match(/BA_SERIAL1_ERROR:([^\s]+)/);
  if (errorMatch) {
    bg.lastError = errorMatch[1] || "";
    syncUi();
  }
}

function onSerial1Byte(byte: number): void {
  const bg = bgState();
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

function waitForRunnerReady(timeoutMs = 1500): Promise<boolean> {
  if (isRunnerReady()) return Promise.resolve(true);
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      if (isRunnerReady()) {
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      window.setTimeout(tick, 100);
    };
    tick();
  });
}

async function execVmSerial1(command: string, options: BackgroundExecVmOptions = {}): Promise<BackgroundToolResult> {
  const {
    label = t("bgtools.exec.defaultLabel"),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    timeoutGraceMs = 5000,
    log = true,
    skipReadyCheck = false,
  } = options;

  if (!state.vm) return { code: 1, stdout: "", stderr: t("common.v86NotStarted") };
  if (!state.vmReady) return { code: 1, stdout: "", stderr: t("common.vmBooting") };
  if (!serial1Available()) return { code: 1, stdout: "", stderr: t("common.serialUnavailableBuild", { port: "1" }) };

  mountUi();
  if (!skipReadyCheck && !isRunnerReady()) {
    const ready = await waitForRunnerReady(1800);
    if (!ready) return { code: 1, stdout: "", stderr: t("bgtools.error.runnerNotReady") };
  }

  const bg = bgState();
  if (bg.pending) return { code: 75, stdout: "", stderr: t("bgtools.error.alreadyRunning") };

  bg.liveText = "";
  const id = randomId();
  const marker = `__BA_S1_${id}__`;
  const payload = buildPayload({ id, marker, command, timeoutMs, maxOutputBytes });
  if (log) logTool(`\n[bg-tool] ${formatLoggedCommand(command)}\n`);
  appendLive(`[serial1] ${t("bgtools.live.launching", { label })}\n`);
  syncUi();

  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      const pending = bg.pending;
      if (!pending) return;
      requestRunnerCancel(pending, "timeout");
      const result = { code: 124, stdout: "", stderr: t("bgtools.error.timeout"), raw: pending.raw || "" };
      settlePending(pending, result);
      schedulePendingClear(pending, result, 5000);
      syncUi();
    }, timeoutMs + timeoutGraceMs);

    bg.pending = {
      id,
      marker,
      label,
      raw: "",
      resolve,
      timer,
      settled: false,
      maxRawChars: clampInt(maxOutputBytes, 1024, 1024 * 1024, DEFAULT_MAX_OUTPUT_BYTES) + MAX_PENDING_RAW_OVERHEAD_CHARS,
    };
    syncUi();

    try {
      sendSerial1Text(payload);
    } catch (error) {
      window.clearTimeout(timer);
      bg.pending = null;
      syncUi();
      resolve({ code: 1, stdout: "", stderr: errorMessage(error) });
    }
  });
}

async function probeRunnerReady({ timeoutMs = 1800 }: { timeoutMs?: number } = {}): Promise<boolean> {
  const bg = bgState();
  if (!state.vm || !state.vmReady || !serial1Available()) return false;
  const result = await execVmSerial1("printf 'BA_S1_PROBE_OK\\n'", {
    label: t("bgtools.exec.probeLabel"),
    timeoutMs,
    timeoutGraceMs: 700,
    maxOutputBytes: 4096,
    log: false,
    skipReadyCheck: true,
  });
  const ok = result.code === 0 && result.stdout.includes("BA_S1_PROBE_OK");
  if (ok) {
    bg.runnerReady = true;
    bg.lastError = "";
    syncUi();
  }
  return ok;
}

function cancelPending(reason = t("bgtools.reason.user")): boolean {
  const bg = bgState();
  const pending = bg.pending;
  if (!pending) return false;
  if (!pending.cancelRequested) {
    pending.cancelRequested = true;
    requestRunnerCancel(pending, reason);
  }
  appendLive(`\n[serial1] ${t("bgtools.live.cancelled", { reason })}\n`);
  const result = { code: 130, stdout: "", stderr: t("bgtools.cancelledBy", { reason }), raw: pending.raw || "" };
  settlePending(pending, result);
  schedulePendingClear(pending, result, 5000);
  syncUi();
  return true;
}

function cancelCurrent(): void {
  cancelPending(t("bgtools.reason.user"));
}

function reset(reason = "reset"): void {
  const bg = bgState();
  if (bg.pending) requestRunnerCancel(bg.pending, reason);
  const pending = bg.pending;
  if (pending?.timer) window.clearTimeout(pending.timer);
  if (pending?.resolve && !pending.settled) {
    try {
      pending.resolve({ code: 130, stdout: "", stderr: t("bgtools.cancelledBy", { reason }) });
    } catch {
      // Pending resolvers belong to callers outside this serial runner.
    }
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

export function initBackgroundToolsSerial1(): void {
  if (initialized) return;
  initialized = true;
  appEvents.on("app:language-changed", () => {
    try {
      const note = document.querySelector("#bg-tool-details .bg-tool-note");
      if (note) note.textContent = t("bgtools.note");
      const pre = getLivePre();
      if (pre && !bgState().liveText) pre.textContent = t("bgtools.noActiveRun");
      syncUi();
    } catch {
      // The tool panel is optional and may not exist during early startup.
    }
  });
}

export const backgroundToolsApi: BackgroundToolsApi = {
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
