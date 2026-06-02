// @ts-nocheck
// Browser Agent v86 - 16 LLM tool registry
// v9.37.23: profile-aware VM tools catalog with conservative command builders.
//
// This file intentionally does not execute tools by itself. It declares which
// tools exist, which profile can use them, their risk level, argument limits and
// the shell command builder. js/17-llm-tool-executor.js is the only module that
// executes them through execVm().

(function initLLMToolRegistry() {
  const SECURITY_LEVELS = [
    { level: 0, id: "none", get label() { return t("tools.level.none.label"); }, get description() { return t("tools.level.none.desc"); } },
    { level: 1, id: "read", get label() { return t("tools.level.read.label"); }, get description() { return t("tools.level.read.desc"); } },
    { level: 2, id: "diagnostic", get label() { return t("tools.level.diagnostic.label"); }, get description() { return t("tools.level.diagnostic.desc"); } },
    { level: 3, id: "active", get label() { return t("tools.level.active.label"); }, get description() { return t("tools.level.active.desc"); } },
    { level: 99, id: "free", get label() { return t("tools.level.free.label"); }, get description() { return t("tools.level.free.desc"); } },
  ];

  // Define base and additive tool sets for profile composition to avoid duplication.
  const BASE_PROFILE_TOOL_NAMES = [
    "vm.fs.list", "vm.fs.read", "vm.fs.write", "vm.cmd.which", "vm.sys.info", "vm.console.status", "vm.pkg.info",
    "web.curl.head", "web.curl.fetch_text", "vm.python.exec", "vm.sh.exec",
  ];

  const PENTEST_LITE_ADDITIONAL = [
    "net.dns.lookup", "net.ip.status", "net.nmap.quick", "web.ffuf.dir_light"
  ];

  const PENTEST_WEB_ADDITIONAL = [
    ...PENTEST_LITE_ADDITIONAL,
    "web.httpx.probe", "web.nikto.quick", "tls.openssl.cert"
  ];

  const PROFILE_TOOL_NAMES = {
    manual: BASE_PROFILE_TOOL_NAMES,
    "alpine-base": BASE_PROFILE_TOOL_NAMES,
    "alpine-pentest-lite": [
      ...BASE_PROFILE_TOOL_NAMES,
      ...PENTEST_LITE_ADDITIONAL,
    ],
    "alpine-pentest-web": [
      ...BASE_PROFILE_TOOL_NAMES,
      ...PENTEST_WEB_ADDITIONAL,
    ],
  };

  const DEFAULT_WORDLISTS = {
    common: "/usr/share/seclists/Discovery/Web-Content/common.txt",
    quickhits: "/usr/share/seclists/Discovery/Web-Content/quickhits.txt",
    raft_dirs: "/usr/share/seclists/Discovery/Web-Content/raft-small-directories-lowercase.txt",
    raft_files: "/usr/share/seclists/Discovery/Web-Content/raft-small-files.txt",
  };
  const MAX_WRITE_CONTENT_BYTES = 16 * 1024;

  function normalizeBool(value, fallback = false) {
    if (value === true || value === false) return value;
    if (typeof value === "string") return /^(1|true|yes|si|sí)$/i.test(value.trim());
    return fallback;
  }

  function normalizeVmPath(value, fallback = ".") {
    const raw = String(value || fallback).trim() || fallback;
    if (raw.includes("\0") || /[\r\n]/.test(raw)) {
      throw new Error(t("tools.error.pathNewlinesNull"));
    }
    if (raw.length > 240) throw new Error(t("tools.error.pathTooLong"));
    return raw;
  }

  function isBlockedVmWritePath(path) {
    return /^(?:\/dev|\/proc|\/sys)(?:\/|$)/.test(String(path || ""));
  }

  function normalizeWriteArgs(args = {}) {
    const rawPath = String(args.path || "").trim();
    if (!rawPath) throw new Error(t("tools.error.pathEmpty"));
    const path = normalizeVmPath(rawPath, rawPath);
    if (path === "." || path.endsWith("/")) throw new Error(t("tools.error.writePathNotFile"));
    if (isBlockedVmWritePath(path)) throw new Error(t("tools.error.writePathBlocked"));
    const content = String(args.content ?? "");
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

  function normalizeShellCommand(value) {
    const command = String(value || "").trim();
    if (!command) throw new Error(t("tools.error.shellEmpty"));
    if (command.includes("\0")) throw new Error(t("tools.error.commandNull"));
    if (command.length > 2400) throw new Error(t("tools.error.commandTooLong"));
    // Guard rail for the most dangerous mistakes. This is not a sandbox; the
    // real protection is the confirmation policy and the fact that it runs only
    // inside the VM, but these patterns prevent accidental catastrophic wipes.
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

  function normalizeUrl(value) {
    let url = String(value || "").trim();
    if (!url) throw new Error(t("tools.error.urlEmpty"));
    if (url.includes("\0") || /[\r\n\s]/.test(url)) throw new Error(t("tools.error.urlSpaces"));
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    if (url.length > 500) throw new Error(t("tools.error.urlTooLong"));
    return url;
  }

  function normalizeHost(value) {
    const host = String(value || "").trim();
    if (!host) throw new Error(t("tools.error.hostEmpty"));
    if (host.includes("\0") || /[\r\n\s]/.test(host)) throw new Error(t("tools.error.hostSpaces"));
    if (!/^[A-Za-z0-9._:\/[\]-]+$/.test(host)) throw new Error(t("tools.error.hostInvalidChars"));
    if (host.length > 220) throw new Error(t("tools.error.hostTooLong"));
    return host;
  }

  function normalizePortList(value) {
    const raw = Array.isArray(value) ? value.join(",") : String(value || "").trim();
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

  function normalizeDnsType(value) {
    const t = String(value || "A").trim().toUpperCase();
    const allowed = new Set(["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "ANY"]);
    return allowed.has(t) ? t : "A";
  }

  function normalizeWordlist(value) {
    const raw = String(value || "common").trim();
    if (DEFAULT_WORDLISTS[raw]) return DEFAULT_WORDLISTS[raw];
    const path = normalizeVmPath(raw, DEFAULT_WORDLISTS.common);
    if (!path.startsWith("/usr/share/seclists/") && !path.startsWith("/usr/share/wordlists/")) {
      throw new Error(t("tools.error.wordlistNotAllowed"));
    }
    return path;
  }

  function normalizeFfufMetricFilter(value) {
    const rawValue = Array.isArray(value) ? value.join(",") : String(value ?? "").trim();
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

  function buildTempFileCommand(prefix) {
    const safePrefix = String(prefix || "ba-tool").replace(/[^A-Za-z0-9_.-]/g, "-");
    return `__ba_tmp_dir=/run/ba-tools; mkdir -p "$__ba_tmp_dir" 2>/dev/null || __ba_tmp_dir=/tmp; tmp=$(mktemp "$__ba_tmp_dir/${safePrefix}.XXXXXX" 2>/dev/null || echo "$__ba_tmp_dir/${safePrefix}-$$"); : > "$tmp"`;
  }

  function commandCheck(required) {
    const commands = (Array.isArray(required) ? required : [required]).filter(Boolean);
    if (!commands.length) return "";
    const body = commands.map((cmd) => `command -v ${shellQuote(cmd)} >/dev/null 2>&1 || { printf 'ERROR: missing command: %s\\n' ${shellQuote(cmd)} > "$tmp"; rc=127; missing=1; }`).join("; ");
    return `missing=0; ${body}`;
  }

  function captureCommand(prefix, requiredCommands, bodyCommand) {
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

  function limitedBodyCommand(prefix, bodyCommand, outputCommand) {
    const safePrefix = String(prefix || "ba-tool").replace(/[^A-Za-z0-9_.-]/g, "-");
    return `(__ba_tmp_dir=/run/ba-tools; mkdir -p "$__ba_tmp_dir" 2>/dev/null || __ba_tmp_dir=/tmp; out=$(mktemp "$__ba_tmp_dir/${safePrefix}.out.XXXXXX" 2>/dev/null || echo "$__ba_tmp_dir/${safePrefix}.out.$$"); ( ${bodyCommand} ) > "$out" 2>&1; rc=$?; ${outputCommand}; rm -f "$out"; exit $rc)`;
  }

  function headBytesBodyCommand(prefix, bodyCommand, maxBytes) {
    return limitedBodyCommand(prefix, bodyCommand, `head -c ${maxBytes} "$out"`);
  }

  function sedLinesBodyCommand(prefix, bodyCommand, maxLines) {
    return limitedBodyCommand(prefix, bodyCommand, `sed -n '1,${maxLines}p' "$out"`);
  }

  function buildWriteFileCommand(args) {
    const payload = utf8ToBase64(args.content);
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

  function buildCurlFetchTextCommand(args) {
    const rawBytes = Math.min(Math.max(args.maxBytes * 6, 65536), 262144);
    const flags = [
      "-sS", "--http1.1", "--no-keepalive", "-H", "Connection: close",
      "--connect-timeout", "4", "--max-time", String(args.timeoutSec),
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
    const curlCommand = `body="$tmp.body"; curl ${flags.map(shellQuote).join(" ")} -o "$body" ${shellQuote(args.url)}; rc=$?; if [ "$rc" -eq 0 ]; then python3 -c ${shellQuote(code)} "$body" ${args.maxBytes}; pyrc=$?; if [ "$pyrc" -ne 0 ]; then rc=$pyrc; fi; elif [ -s "$body" ]; then head -c ${args.maxBytes} "$body"; fi; rm -f "$body"; exit $rc`;
    return captureCommand("ba-curl-fetch", ["curl", "python3", "head"], curlCommand);
  }

  function normalizeFfufArgs(args = {}) {
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

  function normalizeNiktoTuning(value) {
    const raw = String(value || "123b").trim();
    if (!/^[0-9a-ex]+$/i.test(raw) || raw.length > 16) throw new Error(t("tools.error.niktoTuningInvalid"));
    return raw;
  }

  function buildFfufLightCommand(args) {
    const explicitMaxTime = Number.isFinite(Number(args.maxTimeSec)) ? Number(args.maxTimeSec) : 0;
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
      `rate=${args.rate}`,
      `estimated_time=$(( (word_count + rate - 1) / rate ))`,
      `max_time=${explicitMaxTime}`,
      `if [ "$max_time" -le 0 ]; then max_time=$(( estimated_time + 30 )); fi`,
      `if [ "$max_time" -lt 15 ]; then max_time=15; fi`,
      `if [ "$max_time" -gt 1200 ]; then max_time=1200; fi`,
      `ffuf -u ${url} -w ${wordlist} -t ${args.threads} -rate ${args.rate} -maxtime "$max_time" -timeout 5 -ac -noninteractive -s ${ignoreBodyFlag} ${filterFlags} -of json -o "$json" > "$log" 2>&1`,
      `rc=$?`,
      `python3 -c ${shellQuote(code)} "$json" "$log" ${url} ${wordlist} "$word_count" "$rate" ${args.threads} "$estimated_time" "$max_time" "$rc" ${shellQuote(args.filterLength || "-")} ${shellQuote(args.filterWords || "-")} ${shellQuote(args.filterLines || "-")}`,
      `pyrc=$?`,
      `rm -f "$json" "$log"`,
      `if [ "$pyrc" -ne 0 ]; then exit "$pyrc"; fi`,
      `exit "$rc"`,
    ].join("; ");
  }

  function buildHttpxProbeCommand(args) {
    const techFlag = args.techDetect ? " -tech-detect" : "";
    const httpxCommand = `httpx -u ${shellQuote(args.url)} -silent -no-color -disable-update-check -no-stdin -x GET -method -status-code -content-length -content-type -web-server -response-time -title${techFlag} -follow-redirects -threads ${args.threads} -rate-limit ${args.rate} -timeout ${args.timeoutSec} -retries 0 -response-size-to-read 32768`;
    const outputCommand = `if [ -s "$out" ]; then sed -n '1,120p' "$out"; else printf 'ERROR: httpx returned no results for %s\\n' ${shellQuote(args.url)}; rc=1; fi`;
    return limitedBodyCommand("ba-httpx", httpxCommand, outputCommand);
  }

  function buildNiktoQuickCommand(args) {
    const hardLimitSec = Math.min(args.maxTimeSec + 15, 150);
    const niktoArgs = [
      "-h", args.url,
      "-nointeractive",
      "-ask", "no",
      "-Cgidirs", "none",
      "-no404",
      "-Tuning", args.tuning,
      "-timeout", String(args.timeoutSec),
      "-maxtime", `${args.maxTimeSec}s`,
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

  function truncateText(text, maxBytes = 32768) {
    const value = String(text || "");
    if (value.length <= maxBytes) return { text: value, truncated: false };
    return { text: value.slice(0, maxBytes) + `\n...[salida truncada a ${maxBytes} caracteres]`, truncated: true };
  }

  function splitCleanLines(text) {
    return stripAnsiAndControls(text).replace(/\n{3,}/g, "\n\n").split("\n").map((line) => line.replace(/\s+$/g, ""));
  }

  function removeToolNoise(text) {
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

  function failureDetail(cleanStderr, cleanStdout, code) {
    const stderr = String(cleanStderr || "").trim();
    if (stderr) return stderr;

    const errorLine = String(cleanStdout || "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^(?:ERROR\b|Traceback\b|curl:\s*\(\d+\)|(?:\/bin\/)?sh:|python\d*:|dig:|nmap:|ffuf:|httpx:|nikto:)/i.test(line));
    return errorLine || `exit code ${code}`;
  }

  function standardFormat(toolDef, result, args, okSummary, failSummary) {
    const cleanStdout = removeToolNoise(result.stdout || "");
    const cleanStderr = removeToolNoise(result.stderr || "");
    const out = truncateText(cleanStdout, toolDef.maxOutputBytes || 32768);
    return {
      ok: result.code === 0,
      code: result.code,
      stdout: out.text,
      stderr: result.code === 0 ? cleanStderr : failureDetail(cleanStderr, out.text, result.code),
      truncated: out.truncated,
      summary: result.code === 0 ? okSummary(args) : failSummary(args),
    };
  }

  function formatNiktoResult(toolDef, result, args) {
    const cleanStdout = removeToolNoise(result.stdout || "").replace(/^\s*Terminated\s*\n?/i, "").trim();
    const cleanStderr = removeToolNoise(result.stderr || "");
    const out = truncateText(cleanStdout, toolDef.maxOutputBytes || 32768);
    const combined = `${cleanStdout}\n${cleanStderr}`;
    const boundedUseful = [124, 137, 143].includes(Number(result.code))
      && /Nikto\s+v|Target\s+(?:IP|Hostname|Port):/i.test(combined)
      && /Server:|item\(s\)|anti-clickjacking|X-Content-Type-Options|outdated/i.test(combined);
    const ok = result.code === 0 || boundedUseful;
    return {
      ok,
      code: result.code,
      stdout: out.text,
      stderr: ok ? "" : failureDetail(cleanStderr, out.text, result.code),
      truncated: out.truncated,
      summary: boundedUseful
        ? t("tools.summary.niktoBoundedOk", { url: args.url, code: result.code })
        : result.code === 0
          ? summaryToolOn("Nikto", args.url)
          : summaryToolFailedOn("Nikto", args.url),
    };
  }

  function toolPrompt(action, args, extra = "") {
    return t("tools.prompt.generic", {
      action,
      args,
      extra: extra ? ` ${extra}` : "",
    });
  }

  function summaryHeadTarget(phraseKey, target) {
    return t("common.summaryHeadTarget", {
      head: t(phraseKey),
      target,
    });
  }

  function summaryCouldNot(verbKey, target) {
    return t("common.summaryCouldNot", {
      action: t(verbKey),
      target,
    });
  }

  function summaryToolOn(tool, target) {
    return t("common.summaryToolOn", { tool, target });
  }

  function summaryToolFailedOn(tool, target) {
    return t("common.summaryToolFailedOn", { tool, target });
  }

  function baseRuntimeContext() {
    const activeProfile = state.activeRuntime?.profile?.id
      || getSelectedProfile?.()?.id
      || (document.getElementById("vm-profile")?.value || "manual");
    return {
      vmPresent: Boolean(state.vm),
      vmReady: Boolean(state.vmReady),
      consoleReady: Boolean(state.consoleTabs?.ready),
      backgroundToolsReady: Boolean(window.BA_BG_TOOLS?.enabled?.()),
      toolsConsoleAvailable: Boolean(window.BA_BG_TOOLS?.enabled?.() || state.consoleTabs?.tabs?.some((tab) => tab.id === "tools")),
      pendingCommand: Boolean(state.pending),
      backgroundToolBusy: Boolean(state.bgTools?.pending),
      agentBusy: Boolean(state.agentBusy),
      activeProfile,
      networkConfigured: Boolean(state.networkConfigured),
      diskMounted: Boolean(state.diskMounted),
    };
  }

  function isToolEnabledForProfile(tool, profileId = baseRuntimeContext().activeProfile) {
    if (!tool) return false;
    const allowed = PROFILE_TOOL_NAMES[profileId];
    if (Array.isArray(allowed) && !allowed.includes(tool.name)) return false;
    const requiredPackages = Array.isArray(tool.requiredPackages) ? tool.requiredPackages : [];
    if (!requiredPackages.length) return true;
    const profile = state.activeRuntime?.profile?.id === profileId
      ? state.activeRuntime.profile
      : state.profiles?.find((item) => item.id === profileId);
    if (!profile || !Array.isArray(profile.packages)) return true;
    const packages = new Set(profile.packages);
    return requiredPackages.every((packageName) => packages.has(packageName));
  }

  function assertVmToolPreconditions() {
    const ctx = baseRuntimeContext();
    if (!ctx.vmPresent) throw new Error(t("tools.error.vmNotBooted"));
    if (!ctx.vmReady) throw new Error(t("tools.error.vmShellNotReady"));
    if (!ctx.toolsConsoleAvailable) throw new Error(t("tools.error.toolsConsoleMissing"));
    // Las tools del agente LLM van por serial1 (BA_BG_TOOLS), no por serial0/consola visible.
    // state.agentBusy solo marca bloqueo de la consola principal (snapshot, comandos manuales, etc.)
    // y no debe impedir vm.fs.* mientras el modelo planifica en GPU.
    if (ctx.backgroundToolBusy) throw new Error(t("tools.error.serial1Busy"));
    if (ctx.pendingCommand) throw new Error(t("tools.error.serial0Pending"));
    return ctx;
  }

  function normalizeListArgs(args = {}) { return { path: normalizeVmPath(args.path || "."), maxEntries: clampInt(args.maxEntries, 1, 300, 120) }; }
  function normalizeReadArgs(args = {}) { return { path: normalizeVmPath(args.path || ""), maxBytes: clampInt(args.maxBytes, 256, 32768, 8192) }; }

  const TOOLS = {
    "vm.fs.list": {
      name: "vm.fs.list", get label() { return t("tools.name.vm.fs.list"); }, riskLevel: 1, category: "vm.fs",
      requiresVm: true, requiresConsole: true, timeoutMs: 12000, maxOutputBytes: 32768,
      get description() { return t("tools.desc.vm.fs.list"); },
      get promptDescription() { return toolPrompt(this.label, '{"path":"/ruta","maxEntries":120}'); },
      normalizeArgs: normalizeListArgs,
      buildCommand(args) {
        const safePath = shellQuote(args.path); const limit = clampInt(args.maxEntries, 1, 300, 120);
        return captureCommand("ba-fs-list", [], [`p=${safePath}`, "rc=0", `if [ ! -e "$p" ]; then printf 'ERROR: not found: %s\\n' "$p"; rc=2; elif [ ! -d "$p" ]; then printf 'ERROR: not a directory: %s\\n' "$p"; ls -ld "$p" 2>&1; rc=2; else ls -la "$p" 2>&1 | sed -n '1,${limit}p'; rc=$?; fi`, "exit $rc"].join("; "));
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => summaryHeadTarget("common.phrase.listingOf", args.path), () => summaryCouldNot("common.verb.list", args.path)); },
    },

    "vm.fs.read": {
      name: "vm.fs.read", get label() { return t("tools.name.vm.fs.read"); }, riskLevel: 1, category: "vm.fs",
      requiresVm: true, requiresConsole: true, timeoutMs: 12000, maxOutputBytes: 32768,
      get description() { return t("tools.desc.vm.fs.read"); },
      get promptDescription() { return toolPrompt(this.label, '{"path":"/ruta/archivo","maxBytes":8192}'); },
      normalizeArgs: normalizeReadArgs,
      buildCommand(args) {
        const safePath = shellQuote(args.path); const bytes = clampInt(args.maxBytes, 256, 32768, 8192);
        return [`p=${safePath}`, "rc=0", `if [ ! -e "$p" ]; then printf 'ERROR: not found: %s\\n' "$p"; rc=2; elif [ ! -f "$p" ]; then printf 'ERROR: not a regular file: %s\\n' "$p"; ls -ld "$p" 2>&1; rc=2; else head -c ${bytes} "$p" 2>&1; rc=$?; printf '\\012'; fi`, "exit $rc"].join("; ");
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => summaryHeadTarget("common.phrase.readOf", args.path), () => summaryCouldNot("common.verb.read", args.path)); },
    },

    "vm.fs.write": {
      name: "vm.fs.write", get label() { return t("tools.name.vm.fs.write"); }, riskLevel: 3, category: "vm.fs",
      requiresVm: true, requiresConsole: true, timeoutMs: 12000, maxOutputBytes: 12000,
      requiredPackages: ["python3"],
      get description() { return t("tools.desc.vm.fs.write"); },
      get promptDescription() { return toolPrompt(this.label, '{"path":"/tmp/nota.txt","content":"texto","createDirs":false,"overwrite":false}'); },
      normalizeArgs: normalizeWriteArgs,
      buildCommand: buildWriteFileCommand,
      formatResult(result, args) { return standardFormat(this, result, args, () => t("tools.summary.fsWriteOk", { path: args.path }), () => summaryCouldNot("common.verb.write", args.path)); },
    },

    "vm.cmd.which": {
      name: "vm.cmd.which", get label() { return t("tools.name.vm.cmd.which"); }, riskLevel: 1, category: "vm.system",
      requiresVm: true, requiresConsole: true, timeoutMs: 8000, maxOutputBytes: 12000,
      get description() { return t("tools.desc.vm.cmd.which"); },
      get promptDescription() { return toolPrompt(this.label, '{"commands":["curl","nmap"]}'); },
      normalizeArgs(args = {}) {
        const commands = Array.isArray(args.commands) ? args.commands : String(args.command || args.commands || "").split(/[\s,]+/);
        const clean = commands.map((c) => String(c || "").trim()).filter(Boolean).slice(0, 20);
        if (!clean.length) throw new Error(t("tools.error.commandAtLeastOne"));
        if (clean.some((c) => !/^[A-Za-z0-9_.+-]+$/.test(c))) throw new Error(t("tools.error.commandInvalidName"));
        return { commands: clean };
      },
      buildCommand(args) {
        const checks = args.commands.map((cmd) => `if command -v ${shellQuote(cmd)} >/dev/null 2>&1; then printf '%s: ' ${shellQuote(cmd)}; command -v ${shellQuote(cmd)}; else printf '%s: missing\\n' ${shellQuote(cmd)}; fi`).join("; ");
        return captureCommand("ba-cmd-which", [], checks);
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => summaryHeadTarget("common.phrase.checkOf", args.commands.join(", ")), () => summaryCouldNot("common.verb.check", t("common.noun.commands"))); },
    },

    "vm.sys.info": {
      name: "vm.sys.info", get label() { return t("tools.name.vm.sys.info"); }, riskLevel: 1, category: "vm.system",
      requiresVm: true, requiresConsole: true, timeoutMs: 10000, maxOutputBytes: 24000,
      get description() { return t("tools.desc.vm.sys.info"); },
      get promptDescription() { return toolPrompt(this.label, '{}'); },
      normalizeArgs() { return {}; },
      buildCommand() { return captureCommand("ba-sys-info", [], "uname -a; printf '\\n--- os-release ---\\n'; cat /etc/os-release 2>/dev/null || true; printf '\\n--- memory ---\\n'; free -m 2>/dev/null || true; printf '\\n--- disk ---\\n'; df -h 2>/dev/null || true; printf '\\n--- uptime ---\\n'; uptime 2>/dev/null || true"); },
      formatResult(result) { return standardFormat(this, result, {}, () => t("tools.summary.sysInfoOk"), () => summaryCouldNot("common.verb.get", t("common.noun.basicStatus"))); },
    },

    "vm.console.status": {
      name: "vm.console.status", get label() { return t("common.xtermConsoleStatus"); }, riskLevel: 1, category: "vm.system",
      requiresVm: true, requiresConsole: true, timeoutMs: 8000, maxOutputBytes: 16000,
      get description() { return t("tools.desc.vm.console.status"); },
      get promptDescription() { return toolPrompt(this.label, '{}'); },
      normalizeArgs() { return {}; },
      buildCommand() { return captureCommand("ba-console-status", [], "printf '%s\\n' '--- serial devices ---'; ls -l /dev/ttyS0 /dev/ttyS1 /dev/ttyS2 2>&1 || true; printf '%s\\n' '--- xterm daemon ---'; ps | grep '[b]a-serial2-console-runner' || true; printf '%s\\n' '--- python ---'; python3 --version 2>&1 || true; printf '%s\\n' '--- runner log ---'; tail -40 /tmp/ba-serial2-console-runner.log 2>/dev/null || true"); },
      formatResult(result) { return standardFormat(this, result, {}, () => t("common.xtermConsoleStatus"), () => summaryCouldNot("common.verb.get", t("common.noun.consoleStatus"))); },
    },

    "vm.pkg.info": {
      name: "vm.pkg.info", get label() { return t("tools.name.vm.pkg.info"); }, riskLevel: 1, category: "vm.system",
      requiresVm: true, requiresConsole: true, timeoutMs: 10000, maxOutputBytes: 24000,
      get description() { return t("tools.desc.vm.pkg.info"); },
      get promptDescription() { return toolPrompt(this.label, '{"filter":"curl"}'); },
      normalizeArgs(args = {}) { return { filter: String(args.filter || "").trim().slice(0, 80) }; },
      buildCommand(args) {
        const f = shellQuote(args.filter || "");
        return captureCommand("ba-pkg-info", [], `packages=$(sed -n 's/^P://p' /lib/apk/db/installed 2>/dev/null); if [ -n ${f} ]; then matches=$(printf '%s\\n' "$packages" | grep -i -- ${f} | sed -n '1,120p'); if [ -n "$matches" ]; then printf '%s\\n' "$matches"; else printf 'ERROR: no installed packages match: %s\\n' ${f}; exit 1; fi; else printf '%s\\n' "$packages" | sed -n '1,160p'; fi`);
      },
      formatResult(result) { return standardFormat(this, result, {}, () => t("tools.summary.pkgInfoOk"), () => summaryCouldNot("common.verb.query", t("common.noun.packages"))); },
    },

    "web.curl.head": {
      name: "web.curl.head", get label() { return t("tools.name.web.curl.head"); }, riskLevel: 2, category: "web.http",
      requiresVm: true, requiresConsole: true, timeoutMs: 30000, maxOutputBytes: 24000,
      requiredPackages: ["curl"],
      get description() { return t("tools.desc.web.curl.head"); },
      get promptDescription() { return toolPrompt(this.label, '{"url":"https://example.com","followRedirects":true,"insecure":true,"timeoutSec":8}'); },
      normalizeArgs(args = {}) { return { url: normalizeUrl(args.url || args.target), followRedirects: normalizeBool(args.followRedirects, true), insecure: normalizeBool(args.insecure, true), timeoutSec: clampInt(args.timeoutSec, 3, 20, 8) }; },
      buildCommand(args) {
        const flags = ["-I", "-sS", "--http1.1", "--no-keepalive", "-H", "Connection: close", "--connect-timeout", "4", "--max-time", String(args.timeoutSec)];
        if (args.followRedirects) flags.push("-L"); if (args.insecure) flags.push("-k");
        flags.push(args.url);
        return captureCommand("ba-curl-head", ["curl"], `curl ${flags.map(shellQuote).join(" ")}`);
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => summaryHeadTarget("common.phrase.headersOf", args.url), () => summaryCouldNot("common.verb.query", args.url)); },
    },

    "web.curl.fetch_text": {
      name: "web.curl.fetch_text", get label() { return t("tools.name.web.curl.fetch_text"); }, riskLevel: 2, category: "web.http",
      requiresVm: true, requiresConsole: true, timeoutMs: 35000, maxOutputBytes: 32768,
      requiredPackages: ["curl", "python3"],
      get description() { return t("tools.desc.web.curl.fetch_text"); },
      get promptDescription() { return toolPrompt(this.label, '{"url":"https://example.com","maxBytes":8192}'); },
      normalizeArgs(args = {}) { return { url: normalizeUrl(args.url || args.target), followRedirects: normalizeBool(args.followRedirects, true), insecure: normalizeBool(args.insecure, true), timeoutSec: clampInt(args.timeoutSec, 3, 25, 10), maxBytes: clampInt(args.maxBytes, 512, 32768, 8192) }; },
      buildCommand: buildCurlFetchTextCommand,
      formatResult(result, args) { return standardFormat(this, result, args, () => summaryHeadTarget("common.phrase.contentsOf", args.url), () => summaryCouldNot("common.verb.download", args.url)); },
    },

    "net.dns.lookup": {
      name: "net.dns.lookup", get label() { return t("tools.name.net.dns.lookup"); }, riskLevel: 2, category: "net.dns",
      requiresVm: true, requiresConsole: true, timeoutMs: 10000, maxOutputBytes: 16000,
      requiredPackages: ["bind-tools"],
      get description() { return t("tools.desc.net.dns.lookup"); },
      get promptDescription() { return toolPrompt(this.label, '{"host":"example.com","type":"A"}'); },
      normalizeArgs(args = {}) { return { host: normalizeHost(args.host || args.domain || args.target), type: normalizeDnsType(args.type) }; },
      buildCommand(args) { return captureCommand("ba-dns", ["dig"], `dig +time=3 +tries=1 ${shellQuote(args.type)} ${shellQuote(args.host)}; printf '\\n--- short ---\\n'; dig +short +time=3 +tries=1 ${shellQuote(args.type)} ${shellQuote(args.host)}`); },
      formatResult(result, args) { return standardFormat(this, result, args, () => t("common.summaryDns", { type: args.type, host: args.host }), () => summaryCouldNot("common.verb.resolve", args.host)); },
    },

    "net.ip.status": {
      name: "net.ip.status", get label() { return t("common.vmNetworkStatus"); }, riskLevel: 1, category: "net.local",
      requiresVm: true, requiresConsole: true, timeoutMs: 10000, maxOutputBytes: 24000,
      requiredPackages: ["iproute2"],
      get description() { return t("tools.desc.net.ip.status"); },
      get promptDescription() { return toolPrompt(this.label, '{}'); },
      normalizeArgs() { return {}; },
      buildCommand() { return captureCommand("ba-ip-status", ["ip"], "ip addr show; printf '\\n--- route ---\\n'; ip route show; printf '\\n--- sockets ---\\n'; ss -tuna 2>/dev/null | sed -n '1,80p' || true"); },
      formatResult(result) { return standardFormat(this, result, {}, () => t("common.vmNetworkStatus"), () => summaryCouldNot("common.verb.get", t("common.noun.networkStatus"))); },
    },

    "net.nmap.quick": {
      name: "net.nmap.quick", get label() { return t("tools.name.net.nmap.quick"); }, riskLevel: 3, category: "net.scan",
      requiresVm: true, requiresConsole: true, timeoutMs: 70000, maxOutputBytes: 32768,
      requiredPackages: ["nmap"],
      get description() { return t("tools.desc.net.nmap.quick"); },
      get promptDescription() { return toolPrompt(this.label, '{"target":"192.168.1.10","ports":"80,443,8000"}'); },
      normalizeArgs(args = {}) {
        const ports = normalizePortList(args.ports || args.portList || args.port);
        return { target: normalizeHost(args.target || args.host), ports, topPorts: ports ? null : clampInt(args.topPorts, 10, 100, 30) };
      },
      buildCommand(args) {
        const target = shellQuote(args.target);
        const scanTarget = args.ports
          ? `-p ${shellQuote(args.ports)} ${target}`
          : `--top-ports ${args.topPorts} ${target}`;
        return captureCommand("ba-nmap-quick", ["nmap"], `nmap -Pn -sT -T2 --max-retries 1 --host-timeout 55s ${scanTarget}`);
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => summaryToolOn(t("common.toolShort.nmap"), args.target), () => summaryToolFailedOn("Nmap", args.target)); },
    },

    "web.ffuf.dir_light": {
      name: "web.ffuf.dir_light", get label() { return t("tools.name.web.ffuf.dir_light"); }, riskLevel: 3, category: "web.fuzz",
      requiresVm: true, requiresConsole: true, timeoutMs: 1230000, maxOutputBytes: 24000,
      requiredPackages: ["ffuf", "python3"],
      get description() { return t("tools.desc.web.ffuf.dir_light"); },
      get promptDescription() { return toolPrompt(this.label, '{"url":"http://host/FUZZ","wordlist":"common","threads":2,"rate":10}', t("tools.prompt.ffufNoOptionalDefaults")); },
      normalizeArgs: normalizeFfufArgs,
      buildCommand(args) { return captureCommand("ba-ffuf-light", ["ffuf", "python3"], buildFfufLightCommand(args)); },
      formatResult(result, args) { return standardFormat(this, result, args, () => summaryToolOn(t("common.toolShort.ffuf"), args.url), () => summaryToolFailedOn("FFUF", args.url)); },
    },

    "vm.python.exec": {
      name: "vm.python.exec", get label() { return t("tools.name.vm.python.exec"); }, riskLevel: 3, category: "vm.exec",
      requiresVm: true, requiresConsole: true, timeoutMs: 25000, maxOutputBytes: 32768,
      requiredPackages: ["python3"],
      get description() { return t("tools.desc.vm.python.exec"); },
      get promptDescription() { return toolPrompt(this.label, '{"code":"print(\'hi\')"}'); },
      normalizeArgs(args = {}) {
        const code = String(args.code || "").trim();
        if (!code) throw new Error(t("tools.error.pythonEmpty"));
        if (code.length > 2500) throw new Error(t("tools.error.pythonTooLong"));
        return { code };
      },
      buildCommand(args) { return captureCommand("ba-python", ["python3"], `python3 -c ${shellQuote(args.code)}`); },
      formatResult(result) { return standardFormat(this, result, {}, () => t("common.summaryExecuted", { label: "Python" }), () => t("common.pythonFailed")); },
    },

    "web.httpx.probe": {
      name: "web.httpx.probe", get label() { return t("tools.name.web.httpx.probe"); }, riskLevel: 3, category: "web.http",
      requiresVm: true, requiresConsole: true, timeoutMs: 45000, maxOutputBytes: 24000,
      requiredPackages: ["httpx"],
      get description() { return t("tools.desc.web.httpx.probe"); },
      get promptDescription() { return toolPrompt(this.label, '{"url":"https://example.com","rate":10,"threads":2,"techDetect":false}'); },
      normalizeArgs(args = {}) {
        return {
          url: normalizeUrl(args.url || args.target),
          rate: clampInt(args.rate, 1, 30, 10),
          threads: clampInt(args.threads, 1, 5, 2),
          timeoutSec: clampInt(args.timeoutSec, 1, 10, 3),
          techDetect: normalizeBool(args.techDetect ?? args.detectTech, false),
        };
      },
      buildCommand(args) { return captureCommand("ba-httpx", ["httpx"], buildHttpxProbeCommand(args)); },
      formatResult(result, args) { return standardFormat(this, result, args, () => summaryToolOn("HTTPX", args.url), () => summaryToolFailedOn("HTTPX", args.url)); },
    },

    "web.nikto.quick": {
      name: "web.nikto.quick", get label() { return t("tools.name.web.nikto.quick"); }, riskLevel: 3, category: "web.scan",
      requiresVm: true, requiresConsole: true, timeoutMs: 170000, maxOutputBytes: 32768,
      requiredPackages: ["nikto"],
      get description() { return t("tools.desc.web.nikto.quick"); },
      get promptDescription() { return toolPrompt(this.label, '{"url":"https://example.com","maxTimeSec":60,"timeoutSec":5,"tuning":"123b"}'); },
      normalizeArgs(args = {}) {
        return {
          url: normalizeUrl(args.url || args.target),
          maxTimeSec: clampInt(args.maxTimeSec, 15, 120, 60),
          timeoutSec: clampInt(args.timeoutSec, 2, 15, 5),
          tuning: normalizeNiktoTuning(args.tuning),
        };
      },
      buildCommand(args) { return captureCommand("ba-nikto", ["perl"], buildNiktoQuickCommand(args)); },
      formatResult(result, args) { return formatNiktoResult(this, result, args); },
    },

    "tls.openssl.cert": {
      name: "tls.openssl.cert", get label() { return t("tools.name.tls.openssl.cert"); }, riskLevel: 2, category: "tls",
      requiresVm: true, requiresConsole: true, timeoutMs: 18000, maxOutputBytes: 16000,
      requiredPackages: ["openssl"],
      get description() { return t("tools.desc.tls.openssl.cert"); },
      get promptDescription() { return toolPrompt(this.label, '{"host":"example.com","port":443}'); },
      normalizeArgs(args = {}) { return { host: normalizeHost(args.host || args.target), port: clampInt(args.port, 1, 65535, 443) }; },
      buildCommand(args) { return captureCommand("ba-openssl-cert", ["openssl"], `echo | openssl s_client -servername ${shellQuote(args.host)} -connect ${shellQuote(`${args.host}:${args.port}`)} 2>/dev/null | openssl x509 -noout -subject -issuer -dates -fingerprint -sha256`); },
      formatResult(result, args) { return standardFormat(this, result, args, () => t("common.summaryTlsOk", { host: args.host, port: args.port }), () => t("common.summaryTlsFail", { host: args.host, port: args.port })); },
    },

    "vm.sh.exec": {
      name: "vm.sh.exec", get label() { return t("tools.name.vm.sh.exec"); }, riskLevel: 3, category: "vm.exec",
      requiresVm: true, requiresConsole: true, timeoutMs: 30000, maxOutputBytes: 32768,
      get description() { return t("tools.desc.vm.sh.exec"); },
      get promptDescription() { return toolPrompt(this.label, '{"command":"uname -a","timeoutMs":10000,"maxOutputBytes":8192}', t("tools.prompt.onlyIfNoSpecific")); },
      normalizeArgs(args = {}) { return { command: normalizeShellCommand(args.command || args.cmd), timeoutMs: clampInt(args.timeoutMs, 1000, 30000, 10000), maxOutputBytes: clampInt(args.maxOutputBytes, 512, 32768, 8192) }; },
      buildCommand(args) { return captureCommand("ba-sh-exec", ["sh"], `sh -lc ${shellQuote(args.command)}`); },
      formatResult(result, args) {
        const oldMax = this.maxOutputBytes; this.maxOutputBytes = args.maxOutputBytes;
        const formatted = standardFormat(this, result, args, () => t("common.summaryExecuted", { label: t("common.noun.shCommand") }), () => t("common.shCommandFailed"));
        this.maxOutputBytes = oldMax;
        return formatted;
      },
    },
  };

  function getTool(name) { return TOOLS[String(name || "")]; }

  // Orden coherente de presentación: primero por dominio/categoría (VM, red, web,
  // TLS) y, dentro de cada grupo, por nivel de riesgo ascendente y luego nombre.
  const TOOL_CATEGORY_ORDER = [
    "vm.fs", "vm.system", "vm.exec",
    "net.local", "net.dns", "net.scan",
    "web.http", "web.fuzz", "web.scan",
    "tls",
  ];

  function toolCategoryRank(category) {
    const idx = TOOL_CATEGORY_ORDER.indexOf(String(category || ""));
    return idx === -1 ? TOOL_CATEGORY_ORDER.length : idx;
  }

  function compareToolsForDisplay(a, b) {
    const byCategory = toolCategoryRank(a.category) - toolCategoryRank(b.category);
    if (byCategory !== 0) return byCategory;
    const byRisk = (Number(a.riskLevel) || 0) - (Number(b.riskLevel) || 0);
    if (byRisk !== 0) return byRisk;
    return String(a.name).localeCompare(String(b.name));
  }

  function listTools({ profileId = baseRuntimeContext().activeProfile, includeUnavailable = false } = {}) {
    return Object.values(TOOLS)
      .filter((tool) => includeUnavailable || isToolEnabledForProfile(tool, profileId))
      .sort(compareToolsForDisplay)
      .map((tool) => ({
        name: tool.name,
        label: tool.label,
        riskLevel: tool.riskLevel,
        category: tool.category,
        description: tool.description,
        promptDescription: tool.promptDescription,
        requiresVm: tool.requiresVm,
        requiresConsole: tool.requiresConsole,
        timeoutMs: tool.timeoutMs,
        requiredPackages: tool.requiredPackages || [],
      }));
  }

  function buildPromptToolCatalog() {
    return listTools().map((tool) => [
      `- ${tool.name}`,
      t("prompt.catalog.security", { level: tool.riskLevel }),
      t("prompt.catalog.usage", { usage: tool.promptDescription }),
      t("prompt.catalog.requirements", {
        vm: tool.requiresVm ? t("prompt.catalog.vmBooted") : t("prompt.catalog.noVm"),
        console: tool.requiresConsole ? t("prompt.catalog.serial1") : "",
      }),
    ].join("\n")).join("\n");
  }

  function buildPromptRuntimeContextCompact({ toolNames = null } = {}) {
    const ctx = baseRuntimeContext();
    const allow = toolNames?.length ? new Set(toolNames) : null;
    const enabled = listTools({ profileId: ctx.activeProfile })
      .map((t) => t.name)
      .filter((name) => !allow || allow.has(name));
    const vm = ctx.vmReady ? "ok" : (ctx.vmPresent ? "boot" : "off");
    const serial1 = ctx.toolsConsoleAvailable ? "ok" : "no";
    const toolsLine = enabled.length
      ? enabled.slice(0, 10).join(", ") + (enabled.length > 10 ? ", …" : "")
      : t("prompt.none");
    return [
      t("prompt.runtime.compact", {
        vm, serial1,
        profile: ctx.activeProfile || "manual",
        net: ctx.networkConfigured ? t("common.yes") : t("common.no"),
      }),
      t("prompt.runtime.activeTools", { count: enabled.length, tools: toolsLine }),
    ].join("\n");
  }

  function buildPromptRuntimeContext() {
    const ctx = baseRuntimeContext();
    const yes = t("common.yes");
    const no = t("common.no");
    return [
      t("prompt.runtime.title"),
      t("prompt.runtime.vmBooted", { v: ctx.vmPresent ? yes : no }),
      t("prompt.runtime.shellReady", { v: ctx.vmReady ? yes : no }),
      t("prompt.runtime.consoleReady", { v: ctx.consoleReady ? yes : no }),
      t("prompt.runtime.toolsReady", { v: ctx.toolsConsoleAvailable ? yes : no }),
      t("prompt.runtime.profile", { profile: ctx.activeProfile || "manual" }),
      t("prompt.runtime.network", { v: ctx.networkConfigured ? yes : no }),
      t("prompt.runtime.disk", { v: ctx.diskMounted ? yes : no }),
      t("prompt.runtime.serials", {
        s0: ctx.pendingCommand || ctx.agentBusy ? t("common.busyFem") : t("prompt.free"),
        s1: ctx.backgroundToolBusy ? t("common.busy") : t("prompt.free"),
      }),
      t("prompt.runtime.availableTools"),
      buildPromptToolCatalog(),
    ].join("\n");
  }

  function normalizeToolCall(value) {
    if (!value || typeof value !== "object") throw new Error(t("tools.error.responseNotObject"));
    const toolName = value.tool || value.name;
    if (value.type && value.type !== "tool_call") {
      throw new Error(t("tools.error.unsupportedInvocation", { type: value.type }));
    }
    const tool = getTool(toolName);
    if (!tool) throw new Error(t("tools.error.toolNotAvailable", { name: toolName || t("tools.error.emptyToolName") }));
    if (!isToolEnabledForProfile(tool)) {
      const ctx = baseRuntimeContext();
      throw new Error(t("tools.error.toolNotEnabled", { tool: tool.name, profile: ctx.activeProfile }));
    }
    const args = tool.normalizeArgs ? tool.normalizeArgs(value.arguments || {}) : (value.arguments || {});
    return { type: "tool_call", tool: tool.name, arguments: args, reason: String(value.reason || t("tools.exec.reasonDefault")).slice(0, 400), riskLevel: tool.riskLevel };
  }

  window.BA_LLM_TOOL_REGISTRY = {
    SECURITY_LEVELS,
    PROFILE_TOOL_NAMES,
    getTool,
    listTools,
    normalizeToolCall,
    buildPromptRuntimeContext,
    buildPromptRuntimeContextCompact,
    assertVmToolPreconditions,
  };
})();
