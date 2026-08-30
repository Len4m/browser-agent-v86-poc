import { t } from "../../../app/i18n";
import { clampInt, shellQuote } from "../../../app/text-utils";
import { captureCommand, normalizeUrl, normalizeVmPath, standardFormat, summaryToolFailedOn, summaryToolOn, textValue, toolPrompt } from "../shared";
import type { ToolArgs, ToolDefinition } from "../types";

const DEFAULT_WORDLISTS: Record<string, string> = {
  common: "/usr/share/seclists/Discovery/Web-Content/common.txt",
  quickhits: "/usr/share/seclists/Discovery/Web-Content/quickhits.txt",
  raft_dirs: "/usr/share/seclists/Discovery/Web-Content/raft-small-directories-lowercase.txt",
  raft_files: "/usr/share/seclists/Discovery/Web-Content/raft-small-files.txt",
};

function normalizeWordlist(value: unknown): string {
  const raw = (textValue(value) || "common").trim();
  if (DEFAULT_WORDLISTS[raw]) return DEFAULT_WORDLISTS[raw];
  const path = normalizeVmPath(raw, DEFAULT_WORDLISTS.common);
  if (!path.startsWith("/usr/share/seclists/") && !path.startsWith("/usr/share/wordlists/")) {
    throw new Error(t("tools.error.wordlistNotAllowed"));
  }
  return path;
}

function normalizeFfufMetricFilter(value: unknown): string {
  const rawValue = Array.isArray(value) ? value.join(",") : textValue(value).trim();
  if (!rawValue) return "";
  const raw = rawValue.replace(/\s+/g, "");
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(raw)) throw new Error(t("tools.error.ffufFilterInvalid"));
  const parts = raw.split(",");
  if (parts.length > 20) throw new Error(t("tools.error.ffufFilterTooMany"));
  for (const part of parts) {
    const [startRaw, endRaw = startRaw] = part.split("-");
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 100000000 || start > end) {
      throw new Error(t("tools.error.ffufFilterInvalid"));
    }
  }
  return raw;
}

function normalizeFfufArgs(args: ToolArgs = {}): ToolArgs {
  let url = normalizeUrl(args.url || args.target);
  if (!url.includes("FUZZ")) url = url.replace(/\/?$/, "/FUZZ");
  const rawMaxTime = Number(args.maxTimeSec);
  return {
    url,
    wordlist: normalizeWordlist(args.wordlist || "common"),
    threads: clampInt(args.threads, 1, 8, 3),
    rate: clampInt(args.rate, 1, 50, 20),
    maxTimeSec: Number.isFinite(rawMaxTime) ? clampInt(rawMaxTime, 15, 1200, 120) : null,
    filterLength: normalizeFfufMetricFilter(args.filterLength ?? args.filterSize ?? args.fs),
    filterWords: normalizeFfufMetricFilter(args.filterWords ?? args.fw),
    filterLines: normalizeFfufMetricFilter(args.filterLines ?? args.fl),
  };
}

function buildFfufLightCommand(args: ToolArgs): string {
  const explicitMaxTime = Number.isFinite(Number(args.maxTimeSec)) ? Number(args.maxTimeSec) : 0;
  const rate = clampInt(args.rate, 1, 50, 20);
  const threads = clampInt(args.threads, 1, 8, 3);
  const filterFlags = [
    args.filterLength ? `-fs ${shellQuote(args.filterLength)}` : "",
    args.filterWords ? `-fw ${shellQuote(args.filterWords)}` : "",
    args.filterLines ? `-fl ${shellQuote(args.filterLines)}` : "",
  ].filter(Boolean).join(" ");
  const ignoreBodyFlag = args.filterWords || args.filterLines ? "" : "-ignore-body";
  const code = [
    "import json, os, sys",
    "json_path, log_path, url, wordlist, word_count, rate, threads, estimated_time, max_time, rc, filter_length, filter_words, filter_lines = sys.argv[1:14]",
    "results = []",
    "try:",
    "    if os.path.exists(json_path) and os.path.getsize(json_path):",
    "        with open(json_path, 'r', encoding='utf-8', errors='replace') as handle:",
    "            data = json.load(handle)",
    "        if isinstance(data, dict):",
    "            results = data.get('results') or []",
    "        elif isinstance(data, list):",
    "            results = data",
    "except Exception as exc:",
    "    print('parse_error: %s' % exc)",
    "def val(value):",
    "    if value is None: return '-'",
    "    if isinstance(value, (int, float)): return str(value)",
    "    return str(value)",
    "def input_text(item):",
    "    raw = item.get('input') if isinstance(item, dict) else None",
    "    if isinstance(raw, dict):",
    "        return ','.join('%s=%s' % (key, val(raw[key])) for key in sorted(raw) if key != 'FFUFHASH')",
    "    return val(raw)",
    "def result_url(item):",
    "    if not isinstance(item, dict): return '-'",
    "    direct = item.get('url')",
    "    if direct: return str(direct)",
    "    text = input_text(item)",
    "    token = text.split('=', 1)[-1] if '=' in text else text",
    "    return url.replace('FUZZ', token) if token and token != '-' else url",
    "print('FFUF summary')",
    "print('target: %s' % url)",
    "print('wordlist: %s' % wordlist)",
    "print('word_count: %s' % word_count)",
    "print('rate: %s/s' % rate)",
    "print('threads: %s' % threads)",
    "print('estimated_min_sec: %s' % estimated_time)",
    "print('max_time_sec: %s' % max_time)",
    "if filter_length != '-': print('filter_length: %s' % filter_length)",
    "if filter_words != '-': print('filter_words: %s' % filter_words)",
    "if filter_lines != '-': print('filter_lines: %s' % filter_lines)",
    "try:",
    "    print('scan_limited: %s' % ('yes' if int(max_time) < int(estimated_time) else 'no'))",
    "except Exception:",
    "    pass",
    "print('matches: %d' % len(results))",
    "for item in results[:40]:",
    "    if not isinstance(item, dict):",
    "        print('- %s' % item)",
    "        continue",
    "    print('- status=%s length=%s words=%s lines=%s url=%s' % (val(item.get('status')), val(item.get('length')), val(item.get('words')), val(item.get('lines')), result_url(item)))",
    "if len(results) > 40:",
    "    print('... %d more matches omitted' % (len(results) - 40))",
    "if rc != '0':",
    "    print('ffuf_exit_code: %s' % rc)",
    "    try:",
    "        with open(log_path, 'r', encoding='utf-8', errors='replace') as handle:",
    "            log = handle.read().strip()",
    "        if log:",
    "            print('ffuf_log:')",
    "            print('\\n'.join(log.splitlines()[:40]))",
    "    except Exception:",
    "        pass",
  ].join("\n");
  const wordlist = shellQuote(args.wordlist);
  const url = shellQuote(args.url);
  return [
    `json="$tmp.json"`,
    `log="$tmp.log"`,
    `word_count=$(grep -vE '^[[:space:]]*(#|$)' ${wordlist} 2>/dev/null | wc -l)`,
    `word_count=\${word_count:-0}`,
    `rate=${rate}`,
    `estimated_time=$(( (word_count + rate - 1) / rate ))`,
    `max_time=${explicitMaxTime}`,
    `if [ "$max_time" -le 0 ]; then max_time=$(( estimated_time + 30 )); fi`,
    `if [ "$max_time" -lt 15 ]; then max_time=15; fi`,
    `if [ "$max_time" -gt 1200 ]; then max_time=1200; fi`,
    `ffuf -u ${url} -w ${wordlist} -t ${threads} -rate ${rate} -maxtime "$max_time" -timeout 5 -ac -noninteractive -s ${ignoreBodyFlag} ${filterFlags} -of json -o "$json" > "$log" 2>&1`,
    "rc=$?",
    `python3 -c ${shellQuote(code)} "$json" "$log" ${url} ${wordlist} "$word_count" "$rate" ${threads} "$estimated_time" "$max_time" "$rc" ${shellQuote(args.filterLength || "-")} ${shellQuote(args.filterWords || "-")} ${shellQuote(args.filterLines || "-")}`,
    "pyrc=$?",
    `rm -f "$json" "$log"`,
    `if [ "$pyrc" -ne 0 ]; then exit "$pyrc"; fi`,
    `exit "$rc"`,
  ].join("; ");
}

export const toolDefinition: ToolDefinition = {
  name: "web_ffuf_dir_light", get label() { return t("tools.name.web_ffuf_dir_light"); }, riskLevel: 3, category: "web.fuzz",
  requiresVm: true, requiresConsole: true, timeoutMs: 1230000, maxOutputBytes: 24000,
  requiredPackages: ["ffuf", "python3"],
  runtimeChecks: [
    { label: "ffuf", command: "command -v ffuf" },
    { label: "python3", command: "command -v python3" },
  ],
  get description() { return t("tools.desc.web_ffuf_dir_light"); },
  get promptDescription() { return toolPrompt(this.label, '{"url":"http://host/FUZZ","wordlist":"common","threads":2,"rate":10}', t("tools.prompt.ffufNoOptionalDefaults")); },
  buildInputSchema(z) {
    return z.object({
      url: z.string().describe(t("tools.schema.ffufUrl")),
      wordlist: z.string().optional(),
      threads: z.number().optional(),
      rate: z.number().optional(),
      maxTimeSec: z.number().optional().describe(t("tools.schema.ffufMaxTimeSec")),
      filterLength: z.string().optional().describe(t("tools.schema.ffufFilterLength")),
      filterWords: z.string().optional().describe(t("tools.schema.ffufFilterWords")),
      filterLines: z.string().optional().describe(t("tools.schema.ffufFilterLines")),
    });
  },
  normalizeArgs: normalizeFfufArgs,
  buildCommand(args) {
    return captureCommand("ba-ffuf-light", ["ffuf", "python3"], buildFfufLightCommand(args));
  },
  formatResult(result, args) {
    return standardFormat(this, result, args, () => summaryToolOn(t("common.toolShort.ffuf"), args.url), () => summaryToolFailedOn("FFUF", args.url));
  },
};
