import { t } from "../../../app/i18n";
import { clampInt, shellQuote } from "../../../app/text-utils";
import {
  captureCommand,
  cleanToolOutput,
  normalizeUrl,
  summaryToolFailedOn,
  summaryToolOn,
  textValue,
  toolFailureDetail,
  toolPrompt,
  truncateToolOutput,
} from "../shared";
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
  const niktoCommand = `timeout ${hardLimitSec}s nikto.pl ${niktoArgs}`;
  return sedLinesBodyCommand("ba-nikto", niktoCommand, 180);
}

function formatNiktoResult(toolDef: Pick<ToolDefinition, "maxOutputBytes">, result: ToolExecutionResult, args: ToolArgs): ToolExecutionResult {
  const cleanStdout = cleanToolOutput(result.stdout || "").replace(/^\s*Terminated\s*\n?/i, "").trim();
  const cleanStderr = cleanToolOutput(result.stderr || "");
  const out = truncateToolOutput(cleanStdout, toolDef.maxOutputBytes || 32768);
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
    stderr: ok ? "" : toolFailureDetail(cleanStderr, out.text, code),
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
  requiredPackages: ["nikto", "perl-net-ssleay", "perl-io-socket-ssl"],
  runtimeChecks: [
    { label: "nikto.pl", command: "command -v nikto.pl" },
    { label: "timeout", command: "command -v timeout" },
    { label: "Net::SSLeay", command: "perl -MNet::SSLeay -e 1" },
    { label: "IO::Socket::SSL", command: "perl -MIO::Socket::SSL -e 1" },
  ],
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
    return captureCommand("ba-nikto", ["nikto.pl", "timeout"], buildNiktoQuickCommand(args));
  },
  formatResult(result, args) {
    return formatNiktoResult(this, result, args);
  },
};
