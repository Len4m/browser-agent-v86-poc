import { t } from "../../app/i18n";
import { clampInt, shellQuote, stripAnsiAndControls, utf8ToBase64 } from "../../app/text-utils";
import type { ToolArgs, ToolArgValue, ToolDefinition, ToolExecutionResult } from "./types";

const DEFAULT_WORDLISTS: Record<string, string> = {
  common: "/usr/share/seclists/Discovery/Web-Content/common.txt",
  quickhits: "/usr/share/seclists/Discovery/Web-Content/quickhits.txt",
  raft_dirs: "/usr/share/seclists/Discovery/Web-Content/raft-small-directories-lowercase.txt",
  raft_files: "/usr/share/seclists/Discovery/Web-Content/raft-small-files.txt",
};
const MAX_WRITE_CONTENT_BYTES = 16 * 1024;

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

function isBlockedVmWritePath(path: unknown): boolean {
  return /^(?:\/dev|\/proc|\/sys)(?:\/|$)/.test(textValue(path));
}

export function normalizeWriteArgs(args: ToolArgs = {}): ToolArgs {
  const rawPath = textValue(args.path).trim();
  if (!rawPath) throw new Error(t("tools.error.pathEmpty"));
  const path = normalizeVmPath(rawPath, rawPath);
  if (path === "." || path.endsWith("/")) throw new Error(t("tools.error.writePathNotFile"));
  if (isBlockedVmWritePath(path)) throw new Error(t("tools.error.writePathBlocked"));
  const content = textValue(args.content);
  if (content.includes("\0")) throw new Error(t("tools.error.contentNull"));
  const contentBytes = new TextEncoder().encode(content).length;
  if (contentBytes > MAX_WRITE_CONTENT_BYTES) {
    throw new Error(t("tools.error.contentTooLong", { max: MAX_WRITE_CONTENT_BYTES }));
  }
  return {
    path,
    content,
    createDirs: normalizeBool(args.createDirs ?? args.createDirectories, false),
    overwrite: normalizeBool(args.overwrite, false),
  };
}

export function normalizeShellCommand(value: unknown): string {
  const command = textValue(value).trim();
  if (!command) throw new Error(t("tools.error.shellEmpty"));
  if (command.includes("\0")) throw new Error(t("tools.error.commandNull"));
  if (command.length > 2400) throw new Error(t("tools.error.commandTooLong"));
  if (/\brm\s+-[^\n;]*r[^\n;]*f[^\n;]*(?:\/\s*$|\/\s|\/\*|--no-preserve-root)/i.test(command)) {
    throw new Error(t("tools.error.blockedRmrf"));
  }
  if (/\b(?:mkfs|mkswap|fdisk|parted)\b/i.test(command)) {
    throw new Error(t("tools.error.blockedDisk"));
  }
  if (/\bdd\b[^\n;]*\bof=\/dev\//i.test(command)) {
    throw new Error(t("tools.error.blockedDevWrite"));
  }
  return command;
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

export function normalizePortList(value: unknown): string {
  const raw = Array.isArray(value) ? value.join(",") : textValue(value).trim();
  if (!raw) return "";
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(raw)) throw new Error(t("tools.error.portsInvalid"));
  const parts = raw.split(",");
  if (parts.length > 20) throw new Error(t("tools.error.portsTooMany"));
  for (const part of parts) {
    const [startRaw, endRaw = startRaw] = part.split("-");
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
      throw new Error(t("tools.error.portsInvalid"));
    }
  }
  return raw;
}

export function normalizeDnsType(value: unknown): string {
  const type = (textValue(value) || "A").trim().toUpperCase();
  const allowed = new Set(["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "ANY"]);
  return allowed.has(type) ? type : "A";
}

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

export function normalizeFfufArgs(args: ToolArgs = {}): ToolArgs {
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

export function normalizeNiktoTuning(value: unknown): string {
  const raw = (textValue(value) || "123b").trim();
  if (!/^[0-9a-ex]+$/i.test(raw) || raw.length > 16) throw new Error(t("tools.error.niktoTuningInvalid"));
  return raw;
}

export function normalizeListArgs(args: ToolArgs = {}): ToolArgs {
  return { path: normalizeVmPath(args.path || "."), maxEntries: clampInt(args.maxEntries, 1, 300, 120) };
}

export function normalizeReadArgs(args: ToolArgs = {}): ToolArgs {
  return { path: normalizeVmPath(args.path || ""), maxBytes: clampInt(args.maxBytes, 256, 32768, 8192) };
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

function limitedBodyCommand(prefix: unknown, bodyCommand: string, outputCommand: string): string {
  const safePrefix = (textValue(prefix) || "ba-tool").replace(/[^A-Za-z0-9_.-]/g, "-");
  return `(__ba_tmp_dir=/run/ba-tools; mkdir -p "$__ba_tmp_dir" 2>/dev/null || __ba_tmp_dir=/tmp; out=$(mktemp "$__ba_tmp_dir/${safePrefix}.out.XXXXXX" 2>/dev/null || echo "$__ba_tmp_dir/${safePrefix}.out.$$"); ( ${bodyCommand} ) > "$out" 2>&1; rc=$?; ${outputCommand}; rm -f "$out"; exit $rc)`;
}

function sedLinesBodyCommand(prefix: unknown, bodyCommand: string, maxLines: number): string {
  return limitedBodyCommand(prefix, bodyCommand, `sed -n '1,${maxLines}p' "$out"`);
}

export function buildWriteFileCommand(args: ToolArgs): string {
  const payload = utf8ToBase64(textValue(args.content));
  const code = [
    "import base64, os, sys",
    "path = sys.argv[1]",
    "create_dirs = sys.argv[2] == '1'",
    "overwrite = sys.argv[3] == '1'",
    "data = base64.b64decode(sys.argv[4].encode('ascii'), validate=True)",
    "parent = os.path.dirname(path) or '.'",
    "if create_dirs: os.makedirs(parent, exist_ok=True)",
    "if parent != '.' and not os.path.isdir(parent): raise SystemExit('ERROR: parent directory not found: %s' % parent)",
    "if os.path.exists(path) and not os.path.isfile(path): raise SystemExit('ERROR: not a regular file: %s' % path)",
    "if os.path.exists(path) and not overwrite: raise SystemExit('ERROR: file exists: %s' % path)",
    "with open(path, 'wb') as handle: handle.write(data)",
    "print('WROTE %d bytes to %s' % (len(data), path))",
  ].join("\n");
  return captureCommand("ba-fs-write", ["python3"], `python3 -c ${shellQuote(code)} ${shellQuote(args.path)} ${args.createDirs ? "1" : "0"} ${args.overwrite ? "1" : "0"} ${shellQuote(payload)}`);
}

export function buildCurlFetchTextCommand(args: ToolArgs): string {
  const maxBytes = clampInt(args.maxBytes, 512, 32768, 8192);
  const timeoutSec = clampInt(args.timeoutSec, 3, 25, 10);
  const rawBytes = Math.min(Math.max(maxBytes * 6, 65536), 262144);
  const flags = [
    "-sS", "--http1.1", "--no-keepalive", "-H", "Connection: close",
    "--connect-timeout", "4", "--max-time", String(timeoutSec),
    "--range", `0-${rawBytes - 1}`, "--max-filesize", String(rawBytes),
  ];
  if (args.followRedirects) flags.push("-L");
  if (args.insecure) flags.push("-k");

  const code = [
    "import re, sys",
    "from html.parser import HTMLParser",
    "path, max_bytes = sys.argv[1], int(sys.argv[2])",
    "data = open(path, 'rb').read()",
    "text = data.decode('utf-8', 'replace')",
    "sample = text[:4096]",
    "is_html = bool(re.search(r'(?is)<!doctype\\s+html|<html[\\s>]|<body[\\s>]|<head[\\s>]|<title[\\s>]|<(?:p|div|span|a|h[1-6]|li|br|table|section|article|main|nav|header|footer|meta|script|style)(?:\\s|>|/)', sample))",
    "class Extractor(HTMLParser):",
    "    blocks = set('address article aside blockquote br div dl dt dd fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td tfoot th thead tr ul'.split())",
    "    skips = set('script style noscript template svg canvas'.split())",
    "    def __init__(self):",
    "        super().__init__(convert_charrefs=True)",
    "        self.parts = []",
    "        self.skip = 0",
    "    def handle_starttag(self, tag, attrs):",
    "        tag = tag.lower()",
    "        if tag in self.skips:",
    "            self.skip += 1",
    "        elif tag == 'br':",
    "            self.parts.append('\\n')",
    "        elif tag in self.blocks:",
    "            self.parts.append('\\n')",
    "    def handle_endtag(self, tag):",
    "        tag = tag.lower()",
    "        if tag in self.skips and self.skip:",
    "            self.skip -= 1",
    "        elif tag in self.blocks:",
    "            self.parts.append('\\n')",
    "    def handle_data(self, value):",
    "        if not self.skip:",
    "            self.parts.append(value)",
    "def clean(value):",
    "    value = value.replace('\\r\\n', '\\n').replace('\\r', '\\n')",
    "    value = re.sub(r'[\\t\\f\\v ]+', ' ', value)",
    "    value = re.sub(r' *\\n *', '\\n', value)",
    "    value = re.sub(r'\\n{3,}', '\\n\\n', value)",
    "    return value.strip()",
    "if is_html:",
    "    parser = Extractor()",
    "    parser.feed(text)",
    "    output = clean(''.join(parser.parts)) or clean(text)",
    "else:",
    "    output = text.replace('\\r\\n', '\\n').replace('\\r', '\\n').strip()",
    "encoded = output.encode('utf-8')",
    "if len(encoded) > max_bytes:",
    "    output = encoded[:max_bytes].decode('utf-8', 'ignore').rstrip()",
    "sys.stdout.write(output)",
    "if output and not output.endswith('\\n'): sys.stdout.write('\\n')",
  ].join("\n");
  const curlCommand = `body="$tmp.body"; curl ${flags.map(shellQuote).join(" ")} -o "$body" ${shellQuote(args.url)}; rc=$?; if [ "$rc" -eq 0 ]; then python3 -c ${shellQuote(code)} "$body" ${maxBytes}; pyrc=$?; if [ "$pyrc" -ne 0 ]; then rc=$pyrc; fi; elif [ -s "$body" ]; then head -c ${maxBytes} "$body"; fi; rm -f "$body"; exit $rc`;
  return captureCommand("ba-curl-fetch", ["curl", "python3", "head"], curlCommand);
}

export function buildFfufLightCommand(args: ToolArgs): string {
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
    `rc=$?`,
    `python3 -c ${shellQuote(code)} "$json" "$log" ${url} ${wordlist} "$word_count" "$rate" ${threads} "$estimated_time" "$max_time" "$rc" ${shellQuote(args.filterLength || "-")} ${shellQuote(args.filterWords || "-")} ${shellQuote(args.filterLines || "-")}`,
    `pyrc=$?`,
    `rm -f "$json" "$log"`,
    `if [ "$pyrc" -ne 0 ]; then exit "$pyrc"; fi`,
    `exit "$rc"`,
  ].join("; ");
}

export function buildHttpxProbeCommand(args: ToolArgs): string {
  const techFlag = args.techDetect ? " -tech-detect" : "";
  const threads = clampInt(args.threads, 1, 5, 2);
  const rate = clampInt(args.rate, 1, 30, 10);
  const timeoutSec = clampInt(args.timeoutSec, 1, 10, 3);
  const httpxCommand = `httpx -u ${shellQuote(args.url)} -silent -no-color -disable-update-check -no-stdin -x GET -method -status-code -content-length -content-type -web-server -response-time -title${techFlag} -follow-redirects -threads ${threads} -rate-limit ${rate} -timeout ${timeoutSec} -retries 0 -response-size-to-read 32768`;
  const outputCommand = `if [ -s "$out" ]; then sed -n '1,120p' "$out"; else printf 'ERROR: httpx returned no results for %s\\n' ${shellQuote(args.url)}; rc=1; fi`;
  return limitedBodyCommand("ba-httpx", httpxCommand, outputCommand);
}

export function buildNiktoQuickCommand(args: ToolArgs): string {
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

export function standardFormat(
  toolDef: Pick<ToolDefinition, "maxOutputBytes">,
  result: ToolExecutionResult,
  args: ToolArgs,
  okSummary: (args: ToolArgs) => string,
  failSummary: (args: ToolArgs) => string,
): ToolExecutionResult {
  const cleanStdout = removeToolNoise(result.stdout || "");
  const cleanStderr = removeToolNoise(result.stderr || "");
  const out = truncateText(cleanStdout, toolDef.maxOutputBytes || 32768);
  const code = Number(result.code ?? 1);
  return {
    ok: code === 0,
    code,
    stdout: out.text,
    stderr: code === 0 ? cleanStderr : failureDetail(cleanStderr, out.text, code),
    truncated: out.truncated,
    summary: code === 0 ? okSummary(args) : failSummary(args),
  };
}

export function formatNiktoResult(toolDef: Pick<ToolDefinition, "maxOutputBytes">, result: ToolExecutionResult, args: ToolArgs): ToolExecutionResult {
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
