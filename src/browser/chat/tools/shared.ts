import { t } from "../../app/i18n";
import { shellQuote, stripAnsiAndControls } from "../../app/text-utils";
import type { ToolArgs, ToolArgValue, ToolDefinition, ToolExecutionResult } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isToolArgValue(value: unknown): value is ToolArgValue {
  if (value == null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
}

export function textValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

export function toToolArgs(value: unknown): ToolArgs {
  if (!isRecord(value)) return {};
  const out: ToolArgs = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isToolArgValue(entry) ? entry : textValue(entry);
  }
  return out;
}

export function normalizeBool(value: unknown, fallback = false): boolean {
  if (value === true || value === false) return value;
  if (typeof value === "string") return /^(1|true|yes|si|sí)$/i.test(value.trim());
  return fallback;
}

export function normalizeVmPath(value: unknown, fallback = "."): string {
  const raw = (textValue(value) || fallback).trim() || fallback;
  if (raw.includes("\0") || /[\r\n]/.test(raw)) {
    throw new Error(t("tools.error.pathNewlinesNull"));
  }
  if (raw.length > 240) throw new Error(t("tools.error.pathTooLong"));
  return raw;
}

export function normalizeUrl(value: unknown): string {
  let url = textValue(value).trim();
  if (!url) throw new Error(t("tools.error.urlEmpty"));
  if (url.includes("\0") || /[\r\n\s]/.test(url)) throw new Error(t("tools.error.urlSpaces"));
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  if (url.length > 500) throw new Error(t("tools.error.urlTooLong"));
  return url;
}

export function normalizeHost(value: unknown): string {
  const host = textValue(value).trim();
  if (!host) throw new Error(t("tools.error.hostEmpty"));
  if (host.includes("\0") || /[\r\n\s]/.test(host)) throw new Error(t("tools.error.hostSpaces"));
  if (!/^[A-Za-z0-9._:\/[\]-]+$/.test(host)) throw new Error(t("tools.error.hostInvalidChars"));
  if (host.length > 220) throw new Error(t("tools.error.hostTooLong"));
  return host;
}

function buildTempFileCommand(prefix: unknown): string {
  const safePrefix = (textValue(prefix) || "ba-tool").replace(/[^A-Za-z0-9_.-]/g, "-");
  return `__ba_tmp_dir=/run/ba-tools; mkdir -p "$__ba_tmp_dir" 2>/dev/null || __ba_tmp_dir=/tmp; tmp=$(mktemp "$__ba_tmp_dir/${safePrefix}.XXXXXX" 2>/dev/null || echo "$__ba_tmp_dir/${safePrefix}-$$"); : > "$tmp"`;
}

function commandCheck(required: unknown): string {
  const commands = (Array.isArray(required) ? required : [required]).filter(Boolean);
  if (!commands.length) return "";
  const body = commands.map((cmd) => `command -v ${shellQuote(cmd)} >/dev/null 2>&1 || { printf 'ERROR: missing command: %s\\n' ${shellQuote(cmd)} > "$tmp"; rc=127; missing=1; }`).join("; ");
  return `missing=0; ${body}`;
}

export function captureCommand(prefix: unknown, requiredCommands: unknown, bodyCommand: string): string {
  const checks = commandCheck(requiredCommands);
  return [
    buildTempFileCommand(prefix),
    "rc=0",
    checks || "missing=0",
    `if [ "$missing" = "0" ]; then ( ${bodyCommand} ) > "$tmp" 2>&1; rc=$?; fi`,
    `cat "$tmp"`,
    `rm -f "$tmp"`,
    "exit $rc",
  ].join("; ");
}

export function truncateToolOutput(text: unknown, maxBytes = 32768): { text: string; truncated: boolean } {
  const value = textValue(text);
  if (value.length <= maxBytes) return { text: value, truncated: false };
  return { text: value.slice(0, maxBytes) + `\n...[salida truncada a ${maxBytes} caracteres]`, truncated: true };
}

function splitCleanLines(text: unknown): string[] {
  return stripAnsiAndControls(text).replace(/\n{3,}/g, "\n\n").split("\n").map((line) => line.replace(/\s+$/g, ""));
}

export function cleanToolOutput(text: unknown): string {
  const lines = splitCleanLines(text);
  return lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^BA_(TOOL|FILE|FS)_[A-Z0-9_:-]+/.test(trimmed)) return false;
    if (/^__BAGENT_[A-Za-z0-9_]+___(?:START|END(?::\d+)?)$/.test(trimmed)) return false;
    if (/^browser-[^#%$>]*[#$>]\s*/.test(trimmed)) return false;
    if (/^>\s*(?:__ba_tty=|echo BA_|p=|if \[|head -c|ls -la|printf)/.test(trimmed)) return false;
    if (/^(?:__ba_tty=|echo BA_|p=|if \[|head -c|ls -la|printf|__rc=)/.test(trimmed)) return false;
    return true;
  }).join("\n").replace(/^\n+|\n+$/g, "");
}

export function toolFailureDetail(cleanStderr: unknown, cleanStdout: unknown, code: unknown): string {
  const stderr = textValue(cleanStderr).trim();
  if (stderr) return stderr;

  const errorLine = textValue(cleanStdout)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^(?:ERROR\b|Traceback\b|curl:\s*\(\d+\)|(?:\/bin\/)?sh:|python\d*:|dig:|nmap:|ffuf:|httpx:|nikto(?:\.pl)?:)/i.test(line));
  return errorLine || `exit code ${textValue(code)}`;
}

export function standardFormat(
  toolDef: Pick<ToolDefinition, "maxOutputBytes">,
  result: ToolExecutionResult,
  args: ToolArgs,
  okSummary: (args: ToolArgs) => string,
  failSummary: (args: ToolArgs) => string,
): ToolExecutionResult {
  const cleanStdout = cleanToolOutput(result.stdout || "");
  const cleanStderr = cleanToolOutput(result.stderr || "");
  const out = truncateToolOutput(cleanStdout, toolDef.maxOutputBytes || 32768);
  const code = Number(result.code ?? 1);
  return {
    ok: code === 0,
    code,
    stdout: out.text,
    stderr: code === 0 ? cleanStderr : toolFailureDetail(cleanStderr, out.text, code),
    truncated: out.truncated,
    summary: code === 0 ? okSummary(args) : failSummary(args),
  };
}

export function toolPrompt(action: string, args: string, extra = ""): string {
  return t("tools.prompt.generic", {
    action,
    args,
    extra: extra ? ` ${extra}` : "",
  });
}

export function summaryHeadTarget(phraseKey: string, target: unknown): string {
  return t("common.summaryHeadTarget", {
    head: t(phraseKey),
    target: textValue(target),
  });
}

export function summaryCouldNot(verbKey: string, target: unknown): string {
  return t("common.summaryCouldNot", {
    action: t(verbKey),
    target: textValue(target),
  });
}

export function summaryToolOn(tool: string, target: unknown): string {
  return t("common.summaryToolOn", { tool, target: textValue(target) });
}

export function summaryToolFailedOn(tool: string, target: unknown): string {
  return t("common.summaryToolFailedOn", { tool, target: textValue(target) });
}
