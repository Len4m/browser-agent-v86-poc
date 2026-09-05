import { $, NL, state } from "../app/state";
import { t } from "../app/i18n";
import { clampExecVmOutputBytes } from "../app/text-utils";
import { appEvents } from "../core/events";
import { formatLoggedCommand, logTool, setAgentBusy } from "../ui/status-controls";
import { backgroundToolsApi } from "./background-tools-serial1";
import { normalizeLs } from "./runtime-assets";

export interface ExecVmOptions {
  lock?: boolean;
  label?: string;
  timeoutMs?: number;
  log?: boolean;
  targetTools?: boolean;
  resolveOnTokens?: string[];
  rejectOnTokens?: string[];
  maxOutputBytes?: number;
}

export interface ExecVmResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecVmPending {
  marker: string;
  raw: string;
  resolve: (result: ExecVmResult) => void;
  timer: number;
  resolveOnTokens: string[];
  rejectOnTokens: string[];
  bytesSinceParse: number;
  maxRawChars: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Error";
}

function normalizeExecVmResult(result: unknown): ExecVmResult {
  if (!isRecord(result)) return { code: 1, stdout: "", stderr: "invalid execVm result" };
  return {
    code: Number.isFinite(Number(result.code)) ? Number(result.code) : 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function buildExecVmWrappedCommand(command: string, marker: string, maxOutputBytes: number | undefined): string {
  const safeCommand = normalizeLs(command);
  const limit = clampExecVmOutputBytes(maxOutputBytes);
  const errLimit = Math.max(1024, Math.min(32768, limit));
  const safeId = marker.replace(/[^A-Za-z0-9_.-]/g, "_");
  return [
    "__ba_tty=/dev/ttyS0",
    "__ba_dir=/tmp/ba-execvm",
    `__ba_out="$__ba_dir/${safeId}.out"`,
    `__ba_err="$__ba_dir/${safeId}.err"`,
    'mkdir -p "$__ba_dir" 2>/dev/null || true',
    'rm -f "$__ba_out" "$__ba_err" 2>/dev/null || true',
    `printf '\n${marker}_START\n${marker}_STDOUT_START\n' > "$__ba_tty" 2>/dev/null || printf '\n${marker}_START\n${marker}_STDOUT_START\n'`,
    `( TERM=dumb; export TERM; ${safeCommand} ) > "$__ba_out" 2> "$__ba_err"`,
    "__rc=$?",
    `head -c ${limit} "$__ba_out" > "$__ba_tty" 2>/dev/null || true`,
    `printf '\n${marker}_STDOUT_END\n${marker}_STDERR_START\n' > "$__ba_tty" 2>/dev/null || printf '\n${marker}_STDOUT_END\n${marker}_STDERR_START\n'`,
    `head -c ${errLimit} "$__ba_err" > "$__ba_tty" 2>/dev/null || true`,
    `printf '\n${marker}_STDERR_END\n${marker}_END:%s\n' "$__rc" > "$__ba_tty" 2>/dev/null || printf '\n${marker}_STDERR_END\n${marker}_END:%s\n' "$__rc"`,
    'rm -f "$__ba_out" "$__ba_err" 2>/dev/null || true',
    "stty echo 2>/dev/null || true",
  ].join("; ") + NL;
}

export async function execVm(command: string, {
  lock = true,
  label = t("common.agentUsingVm"),
  timeoutMs = 25000,
  log = true,
  targetTools = true,
  resolveOnTokens = [],
  rejectOnTokens = [],
  maxOutputBytes = 65536,
}: ExecVmOptions = {}): Promise<ExecVmResult> {
  if (!state.vm) return { code: 1, stdout: "", stderr: t("common.v86NotStarted") };
  if (!state.vmReady) return { code: 1, stdout: "", stderr: t("common.vmBooting") };

  if (targetTools) {
    try {
      return normalizeExecVmResult(await backgroundToolsApi.execVm(command, {
        label,
        timeoutMs,
        maxOutputBytes: clampExecVmOutputBytes(maxOutputBytes),
        log,
      }));
    } catch (error) {
      return { code: 1, stdout: "", stderr: errorMessage(error) };
    }
  }

  if (state.pending || state.agentBusy || state.bgTools.pending) return { code: 1, stdout: "", stderr: t("vm.error.busy") };
  const sendSerial0 = isRecord(state.vm) && typeof state.vm.serial0_send === "function"
    ? state.vm.serial0_send as (text: string) => void
    : null;
  if (!sendSerial0) return { code: 1, stdout: "", stderr: t("checks.item.serial0Api") };

  const outputLimit = clampExecVmOutputBytes(maxOutputBytes);
  const marker = `__BAGENT_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
  const wrapped = buildExecVmWrappedCommand(command, marker, outputLimit);
  if (lock) setAgentBusy(true, label);
  if (log) logTool(`${NL}[tool] ${formatLoggedCommand(command)}${NL}`);

  return new Promise<ExecVmResult>((resolve) => {
    const finish = (result: ExecVmResult): void => {
      if (lock) setAgentBusy(false);
      resolve(result);
    };
    const requestRender = (): void => appEvents.emit("console:state-changed", { source: "vm-exec" });
    const timer = window.setTimeout(() => {
      state.pending = null;
      requestRender();
      finish({ code: 124, stdout: "", stderr: t("vm.error.timeoutSerial") });
    }, timeoutMs);
    const pending = {
      marker,
      raw: "",
      resolve: finish,
      timer,
      resolveOnTokens,
      rejectOnTokens,
      bytesSinceParse: 0,
      maxRawChars: outputLimit + 96 * 1024,
    } satisfies ExecVmPending;
    state.pending = pending;
    requestRender();
    try {
      sendSerial0(wrapped);
    } catch (error) {
      window.clearTimeout(timer);
      state.pending = null;
      requestRender();
      finish({ code: 1, stdout: "", stderr: errorMessage(error) });
    }
  });
}

export async function runCommandFromInput(event: Event): Promise<void> {
  event.preventDefault();
  const command = $<HTMLInputElement>("command-input")?.value.trim() || "";
  if (!command) return;
  const result = await execVm(command, { lock: true, label: t("vm.exec.manualLabel") });
  if (result.stdout) logTool(`${NL}${result.stdout}${NL}`);
  if (result.stderr) logTool(`${NL}[stderr] ${result.stderr}${NL}`);
}
