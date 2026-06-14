// Browser Agent v86 - xterm console control over serial2/ttyS2.
// serial2 carries a small framed protocol that multiplexes real PTY-backed
// consoles. It does not execute arbitrary shell commands.

import { state } from "../app/state";
import { t } from "../app/i18n";
import { clampInt } from "../app/text-utils";

const MAX_RAW_CHARS = 96 * 1024;
const DEFAULT_TIMEOUT_MS = 4500;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ConsoleControlResult {
  code: number;
  stdout: string;
  stderr: string;
  raw?: string;
}

export type ConsoleControlSession = Record<string, unknown>;

interface ConsoleControlEvent {
  type: string;
  sessionId: string;
  detail: string;
}

interface ConsoleControlDiagnostics {
  serial2Available: boolean;
  serial2Seen: boolean;
  runnerReady: boolean;
  pending: boolean;
  lastError: string;
  diagnosticText: string;
}

interface ConsoleControlDisposable {
  dispose: () => void;
}

interface ConsoleControlApi {
  exec: (action: string, args?: Array<string | number>, options?: ConsoleControlExecOptions) => Promise<ConsoleControlResult>;
  createSession: (sessionId: string, options?: ConsoleControlSessionOptions) => Promise<ConsoleControlResult>;
  closeSession: (sessionId: string) => Promise<ConsoleControlResult>;
  resizeSession: (sessionId: string, cols: number, rows: number) => Promise<ConsoleControlResult>;
  listSessions: () => Promise<ConsoleControlSession[]>;
  sendInput: (sessionId: string, text: string) => boolean;
  onOutput: (handler: ConsoleControlOutputHandler) => ConsoleControlDisposable;
  onEvent: (handler: ConsoleControlEventHandler) => ConsoleControlDisposable;
  onSerial2Byte: (byte: number) => void;
  diagnostics: () => ConsoleControlDiagnostics;
  waitForRunnerReady: (timeoutMs?: number) => Promise<boolean>;
  probeRunnerReady: (options?: ConsoleControlProbeOptions) => Promise<boolean>;
  reset: (reason?: string) => void;
}

interface ConsoleControlExecOptions {
  timeoutMs?: number;
  readyTimeoutMs?: number;
  skipReadyCheck?: boolean;
}

interface ConsoleControlSessionOptions {
  cols?: number;
  rows?: number;
}

interface ConsoleControlProbeOptions {
  timeoutMs?: number;
}

type ConsoleControlOutputHandler = (sessionId: string, bytes: Uint8Array) => void;
type ConsoleControlEventHandler = (event: ConsoleControlEvent) => void;

interface PendingReply {
  resolve: (result: ConsoleControlResult) => void;
  timer: number;
}

interface ConsoleControlState {
  pending: Map<string, PendingReply>;
  runnerReady: boolean;
  serial2Seen: boolean;
  lastError: string;
  diagnosticText: string;
  lineBuffer: string;
  outputHandlers: Set<ConsoleControlOutputHandler>;
  eventHandlers: Set<ConsoleControlEventHandler>;
}

interface VmSerial2Api {
  serial_send_bytes?: (port: number, bytes: Uint8Array) => void;
}

const ctl: ConsoleControlState = {
  pending: new Map(),
  runnerReady: false,
  serial2Seen: false,
  lastError: "",
  diagnosticText: "",
  lineBuffer: "",
  outputHandlers: new Set(),
  eventHandlers: new Set(),
};

function safeText(value: unknown): string {
  if (value == null) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return `${value}`;
    case "symbol":
      return value.description ? `Symbol(${value.description})` : "Symbol()";
    case "function":
      return value.name ? `[function ${value.name}]` : "[function]";
    case "object": {
      try {
        const json = JSON.stringify(value);
        if (typeof json === "string") return json;
      } catch {
        // Fall through to a stable object tag.
      }
      return Object.prototype.toString.call(value);
    }
  }
  return "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function vmSerial2Api(): VmSerial2Api | null {
  return isRecord(state.vm) ? state.vm : null;
}

function randomId(): string {
  return `x2_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function serial2Available(): boolean {
  return typeof vmSerial2Api()?.serial_send_bytes === "function";
}

function sendSerial2Text(text: string): void {
  const vm = vmSerial2Api();
  if (typeof vm?.serial_send_bytes !== "function") {
    throw new Error(t("common.serialUnavailableBuild", { port: "2" }));
  }
  vm.serial_send_bytes(2, encoder.encode(safeText(text)));
}

function b64EncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64DecodeBytes(text: unknown): Uint8Array {
  const binary = atob(safeText(text));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64EncodeText(text: unknown): string {
  return b64EncodeBytes(encoder.encode(safeText(text)));
}

function b64DecodeText(text: unknown): string {
  return decoder.decode(b64DecodeBytes(text));
}

function cleanToken(value: unknown): string {
  return safeText(value).replace(/[^A-Za-z0-9_.-]/g, "_");
}

function buildFrame(id: string, action: string, args: Array<string | number> = []): string {
  const cleanAction = cleanToken(action).replace(/[^a-z-]/g, "");
  const cleanArgs = [
    args[0] ?? "",
    args[1] ?? "",
    args[2] ?? "",
    args[3] ?? "",
  ].map(cleanToken);
  return `__BA_XTERM:${id}:${cleanAction}:${cleanArgs[0]}:${cleanArgs[1]}:${cleanArgs[2]}:${cleanArgs[3]}\n`;
}

function appendDiagnostic(line: string): void {
  ctl.diagnosticText += `${line}\n`;
  if (ctl.diagnosticText.length > 8192) ctl.diagnosticText = ctl.diagnosticText.slice(-8192);
  if (line.startsWith("BA_XTERM_READY")) {
    ctl.runnerReady = true;
    ctl.lastError = "";
  }
  const errorMatch = line.match(/BA_XTERM_ERROR:([^\s]+)/);
  if (errorMatch) ctl.lastError = errorMatch[1] || "";
}

function finishPending(id: string, result: ConsoleControlResult): void {
  const pending = ctl.pending.get(id);
  if (!pending) return;
  window.clearTimeout(pending.timer);
  ctl.pending.delete(id);
  pending.resolve(result);
}

function emitOutput(sessionId: string, bytes: Uint8Array): void {
  for (const handler of ctl.outputHandlers) {
    try {
      handler(sessionId, bytes);
    } catch (error) {
      console.warn("[xterm-control] output handler failed", error);
    }
  }
}

function emitEvent(event: ConsoleControlEvent): void {
  for (const handler of ctl.eventHandlers) {
    try {
      handler(event);
    } catch (error) {
      console.warn("[xterm-control] event handler failed", error);
    }
  }
}

function handleLine(rawLine: unknown): void {
  const line = safeText(rawLine).replace(/\r$/, "");
  if (!line) return;

  if (line.startsWith("BA_XTERM_OUT:")) {
    const parts = line.split(":");
    const sessionId = parts[1] || "";
    const payload = parts.slice(2).join(":");
    if (!sessionId || !payload) return;
    try {
      emitOutput(sessionId, b64DecodeBytes(payload));
    } catch (error) {
      ctl.lastError = `decode-output:${errorMessage(error)}`;
    }
    return;
  }

  if (line.startsWith("BA_XTERM_REPLY:")) {
    const parts = line.split(":");
    const id = parts[1] || "";
    const rawCode = Number.parseInt(parts[2] || "1", 10);
    const code = Number.isFinite(rawCode) ? rawCode : 1;
    const payload = parts.slice(3).join(":");
    const text = payload ? b64DecodeText(payload) : "";
    finishPending(id, { code, stdout: text, stderr: code === 0 ? "" : text, raw: line });
    return;
  }

  if (line.startsWith("BA_XTERM_EVENT:")) {
    const parts = line.split(":");
    emitEvent({ type: parts[1] || "", sessionId: parts[2] || "", detail: parts.slice(3).join(":") });
    return;
  }

  appendDiagnostic(line);
}

function onSerial2Byte(byte: number): void {
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

function waitForRunnerReady(timeoutMs = 900): Promise<boolean> {
  if (ctl.runnerReady) return Promise.resolve(true);
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      if (ctl.runnerReady) {
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      window.setTimeout(tick, 80);
    };
    tick();
  });
}

async function exec(action: string, args: Array<string | number> = [], options: ConsoleControlExecOptions = {}): Promise<ConsoleControlResult> {
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
      resolve({ code: 1, stdout: "", stderr: errorMessage(error) });
    }
  });
}

async function createSession(sessionId: string, { cols = 100, rows = 24 }: ConsoleControlSessionOptions = {}): Promise<ConsoleControlResult> {
  return exec("create", [sessionId, cols, rows], { timeoutMs: 6000 });
}

async function closeSession(sessionId: string): Promise<ConsoleControlResult> {
  return exec("close", [sessionId], { timeoutMs: 4000 });
}

async function resizeSession(sessionId: string, cols: number, rows: number): Promise<ConsoleControlResult> {
  return exec("resize", [sessionId, cols, rows], { timeoutMs: 2500 });
}

async function listSessions(): Promise<ConsoleControlSession[]> {
  const result = await exec("list", [], { timeoutMs: 2500 });
  if (result.code !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(result.stdout || "[]");
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function sendInput(sessionId: string, text: string): boolean {
  if (!serial2Available()) return false;
  try {
    const payload = b64EncodeText(text);
    sendSerial2Text(`__BA_XTERM_IN:${cleanToken(sessionId)}:${payload}\n`);
    return true;
  } catch (error) {
    ctl.lastError = errorMessage(error);
    return false;
  }
}

function onOutput(handler: ConsoleControlOutputHandler): ConsoleControlDisposable {
  ctl.outputHandlers.add(handler);
  return { dispose: () => ctl.outputHandlers.delete(handler) };
}

function onEvent(handler: ConsoleControlEventHandler): ConsoleControlDisposable {
  ctl.eventHandlers.add(handler);
  return { dispose: () => ctl.eventHandlers.delete(handler) };
}

function diagnostics(): ConsoleControlDiagnostics {
  return {
    serial2Available: serial2Available(),
    serial2Seen: ctl.serial2Seen,
    runnerReady: ctl.runnerReady,
    pending: ctl.pending.size > 0,
    lastError: ctl.lastError,
    diagnosticText: ctl.diagnosticText,
  };
}

async function probeRunnerReady({ timeoutMs = 1600 }: ConsoleControlProbeOptions = {}): Promise<boolean> {
  if (!state.vm || !state.vmReady || !serial2Available()) return false;
  if (!ctl.runnerReady) {
    try {
      sendSerial2Text("__BA_XTERM_PING\n");
    } catch {
      // The following readiness wait reports the unavailable runner state.
    }
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

function reset(reason = "reset"): void {
  for (const [id, pending] of ctl.pending.entries()) {
    if (pending.timer) window.clearTimeout(pending.timer);
    try {
      pending.resolve({ code: 130, stdout: "", stderr: t("console.ctl.cancelledBy", { reason }) });
    } catch {
      // Pending resolvers are external callbacks from console clients.
    }
    ctl.pending.delete(id);
  }
  ctl.runnerReady = false;
  ctl.serial2Seen = false;
  ctl.lastError = "";
  ctl.diagnosticText = "";
  ctl.lineBuffer = "";
}

export const consoleControlApi: ConsoleControlApi = {
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
