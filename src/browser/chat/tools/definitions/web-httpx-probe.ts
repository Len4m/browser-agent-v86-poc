import { t } from "../../../app/i18n";
import { clampInt, shellQuote } from "../../../app/text-utils";
import { captureCommand, normalizeBool, normalizeUrl, standardFormat, summaryToolFailedOn, summaryToolOn, textValue, toolPrompt } from "../shared";
import type { ToolArgs, ToolDefinition } from "../types";

const HTTPX_RUNTIME_CHECK = "command -v httpx";

function limitedBodyCommand(prefix: unknown, bodyCommand: string, outputCommand: string): string {
  const safePrefix = (textValue(prefix) || "ba-tool").replace(/[^A-Za-z0-9_.-]/g, "-");
  return `(__ba_tmp_dir=/run/ba-tools; mkdir -p "$__ba_tmp_dir" 2>/dev/null || __ba_tmp_dir=/tmp; out=$(mktemp "$__ba_tmp_dir/${safePrefix}.out.XXXXXX" 2>/dev/null || echo "$__ba_tmp_dir/${safePrefix}.out.$$"); ( ${bodyCommand} ) > "$out" 2>&1; rc=$?; ${outputCommand}; rm -f "$out"; exit $rc)`;
}

function buildHttpxProbeCommand(args: ToolArgs): string {
  const techFlag = args.techDetect ? " -tech-detect" : "";
  const threads = clampInt(args.threads, 1, 5, 2);
  const rate = clampInt(args.rate, 1, 30, 10);
  const timeoutSec = clampInt(args.timeoutSec, 1, 10, 3);
  const httpxCommand = `httpx -u ${shellQuote(args.url)} -silent -no-color -disable-update-check -no-stdin -x GET -method -status-code -content-length -content-type -web-server -response-time -title${techFlag} -follow-redirects -threads ${threads} -rate-limit ${rate} -timeout ${timeoutSec} -retries 0 -response-size-to-read 32768`;
  const outputCommand = `if [ -s "$out" ]; then sed -n '1,120p' "$out"; else printf 'ERROR: httpx returned no results for %s\\n' ${shellQuote(args.url)}; rc=1; fi`;
  return limitedBodyCommand("ba-httpx", httpxCommand, outputCommand);
}

export const toolDefinition: ToolDefinition = {
  name: "web.httpx.probe", get label() { return t("tools.name.web.httpx.probe"); }, riskLevel: 3, category: "web.http",
  requiresVm: true, requiresConsole: true, timeoutMs: 45000, maxOutputBytes: 24000,
  requiredPackages: ["httpx"],
  runtimeChecks: [{ label: "httpx", command: HTTPX_RUNTIME_CHECK }],
  get description() { return t("tools.desc.web.httpx.probe"); },
  get promptDescription() { return toolPrompt(this.label, '{"url":"https://example.com","rate":10,"threads":2,"techDetect":false}'); },
  buildInputSchema(z) {
    return z.object({
      url: z.string().describe(t("tools.schema.url")),
      rate: z.number().optional(),
      threads: z.number().optional(),
      timeoutSec: z.number().optional(),
      techDetect: z.boolean().optional().describe(t("tools.schema.techDetect")),
    });
  },
  normalizeArgs(args = {}) {
    return {
      url: normalizeUrl(args.url || args.target),
      rate: clampInt(args.rate, 1, 30, 10),
      threads: clampInt(args.threads, 1, 5, 2),
      timeoutSec: clampInt(args.timeoutSec, 1, 10, 3),
      techDetect: normalizeBool(args.techDetect ?? args.detectTech, false),
    };
  },
  buildCommand(args) {
    return captureCommand("ba-httpx", ["httpx"], buildHttpxProbeCommand(args));
  },
  formatResult(result, args) {
    return standardFormat(this, result, args, () => summaryToolOn("HTTPX", args.url), () => summaryToolFailedOn("HTTPX", args.url));
  },
};
