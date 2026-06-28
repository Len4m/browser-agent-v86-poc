import { t } from "../../../app/i18n";
import { clampInt, shellQuote, stripAnsiAndControls } from "../../../app/text-utils";
import { captureCommand, normalizeUrl, summaryToolFailedOn, summaryToolOn, textValue, toolPrompt } from "../shared";
import type { ToolArgs, ToolDefinition, ToolExecutionResult } from "../types";

function normalizeNiktoTuning(value: unknown): string {
  const raw = (textValue(value) || "123b").trim();
  if (!/^[0-9a-ex]+$/i.test(raw) || raw.length > 16) throw new Error(t("tools.error.niktoTuningInvalid"));
  return raw;
}

function limitedBodyCommand(prefix: unknown, bodyCommand: string, outputCommand: string): string {
  const safePrefix = (textValue(prefix) || "ba-tool").replace(/[^A-Za-z0-9_.-]/g, "-");
  return `(__ba_tmp_dir=/run/ba-tools; mkdir -p "$__ba_tmp_dir" 2>/dev/null || __ba_tmp_dir=/tmp; out=$(mktemp "$__ba_tmp_dir/${safePrefix}.out.XXXXXX" 2>/dev/null || echo "$__ba_tmp_dir/${safePrefix}.out.$$"); ( ${bodyCommand} ) > "$out" 2>&1; rc=$?; ${outputCommand}; rm -f "$out"; exit $rc)`;
}

function sedLinesBodyCommand(prefix: unknown, bodyCommand: string, maxLines: number): string {
  return limitedBodyCommand(prefix, bodyCommand, `sed -n '1,${maxLines}p' "$out"`);
}

function buildNiktoQuickCommand(args: ToolArgs): string {
  const maxTimeSec = clampInt(args.maxTimeSec, 15, 120, 60);
  const timeoutSec = clampInt(args.timeoutSec, 2, 15, 5);
  const hardLimitSec = Math.min(maxTimeSec + 15, 150);
  const niktoArgs = [
    "-h", args.url,
    "-nointeractive",
    "-ask", "no",
    "-Cgidirs", "none",
    "-no404",
    "-Tuning", args.tuning,
    "-timeout", String(timeoutSec),
    "-maxtime", `${maxTimeSec}s`,
  ].map(shellQuote).join(" ");
  const niktoCommand = [
    "nikto_cmd=$(command -v nikto 2>/dev/null || command -v nikto.pl 2>/dev/null || true)",
    "if [ -z \"$nikto_cmd\" ]; then for p in /usr/bin/nikto.pl /usr/share/nikto/program/nikto.pl /usr/share/nikto/nikto.pl; do if [ -f \"$p\" ]; then nikto_cmd=\"$p\"; break; fi; done; fi",
    "if [ -z \"$nikto_cmd\" ]; then printf 'ERROR: missing command: nikto\\n'; exit 127; fi",
    `case "$nikto_cmd" in *.pl) nikto_run="perl $nikto_cmd ${niktoArgs}" ;; *) nikto_run="$nikto_cmd ${niktoArgs}" ;; esac`,
    `if command -v timeout >/dev/null 2>&1; then timeout ${hardLimitSec}s sh -lc "exec $nikto_run"; else sh -lc "exec $nikto_run"; fi`,
  ].join("; ");
  return sedLinesBodyCommand("ba-nikto", niktoCommand, 180);
}

function truncateText(text: unknown, maxBytes = 32768): { text: string; truncated: boolean } {
  const value = textValue(text);
  if (value.length <= maxBytes) return { text: value, truncated: false };
  return { text: value.slice(0, maxBytes) + `\n...[salida truncada a ${maxBytes} caracteres]`, truncated: true };
}

function splitCleanLines(text: unknown): string[] {
  return stripAnsiAndControls(text).replace(/\n{3,}/g, "\n\n").split("\n").map((line) => line.replace(/\s+$/g, ""));
}

function removeToolNoise(text: unknown): string {
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

function failureDetail(cleanStderr: unknown, cleanStdout: unknown, code: unknown): string {
  const stderr = textValue(cleanStderr).trim();
  if (stderr) return stderr;

  const errorLine = textValue(cleanStdout)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^(?:ERROR\b|Traceback\b|curl:\s*\(\d+\)|(?:\/bin\/)?sh:|python\d*:|dig:|nmap:|ffuf:|httpx:|nikto:)/i.test(line));
  return errorLine || `exit code ${textValue(code)}`;
}

function formatNiktoResult(toolDef: Pick<ToolDefinition, "maxOutputBytes">, result: ToolExecutionResult, args: ToolArgs): ToolExecutionResult {
  const cleanStdout = removeToolNoise(result.stdout || "").replace(/^\s*Terminated\s*\n?/i, "").trim();
  const cleanStderr = removeToolNoise(result.stderr || "");
  const out = truncateText(cleanStdout, toolDef.maxOutputBytes || 32768);
  const combined = `${cleanStdout}\n${cleanStderr}`;
  const code = Number(result.code ?? 1);
  const boundedUseful = [124, 137, 143].includes(code)
    && /Nikto\s+v|Target\s+(?:IP|Hostname|Port):/i.test(combined)
    && /Server:|item\(s\)|anti-clickjacking|X-Content-Type-Options|outdated/i.test(combined);
  const ok = code === 0 || boundedUseful;
  return {
    ok,
    code,
    stdout: out.text,
    stderr: ok ? "" : failureDetail(cleanStderr, out.text, code),
    truncated: out.truncated,
    summary: boundedUseful
      ? t("tools.summary.niktoBoundedOk", { url: textValue(args.url), code })
      : code === 0
        ? summaryToolOn("Nikto", args.url)
        : summaryToolFailedOn("Nikto", args.url),
  };
}

export const toolDefinition: ToolDefinition = {
  name: "web.nikto.quick", get label() { return t("tools.name.web.nikto.quick"); }, riskLevel: 3, category: "web.scan",
  requiresVm: true, requiresConsole: true, timeoutMs: 170000, maxOutputBytes: 32768,
  requiredPackages: ["nikto"],
  get description() { return t("tools.desc.web.nikto.quick"); },
  get promptDescription() { return toolPrompt(this.label, '{"url":"https://example.com","maxTimeSec":60,"timeoutSec":5,"tuning":"123b"}'); },
  buildInputSchema(z) {
    return z.object({
      url: z.string().describe(t("tools.schema.url")),
      maxTimeSec: z.number().optional(),
      timeoutSec: z.number().optional().describe(t("tools.schema.timeoutSec")),
      tuning: z.string().optional().describe(t("tools.schema.niktoTuning")),
    });
  },
  normalizeArgs(args = {}) {
    return {
      url: normalizeUrl(args.url || args.target),
      maxTimeSec: clampInt(args.maxTimeSec, 15, 120, 60),
      timeoutSec: clampInt(args.timeoutSec, 2, 15, 5),
      tuning: normalizeNiktoTuning(args.tuning),
    };
  },
  buildCommand(args) {
    return captureCommand("ba-nikto", ["perl"], buildNiktoQuickCommand(args));
  },
  formatResult(result, args) {
    return formatNiktoResult(this, result, args);
  },
};
