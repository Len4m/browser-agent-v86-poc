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
    { level: 0, id: "none", get label() { return t("tools.level.none.label", "Pedir confirmación siempre"); }, get description() { return t("tools.level.none.desc", "El agente nunca ejecuta tools automáticamente."); } },
    { level: 1, id: "read", get label() { return t("tools.level.read.label", "Libre nivel 1 · lectura segura"); }, get description() { return t("tools.level.read.desc", "Permite tools de lectura acotada en la VM, como listar o leer archivos con límite."); } },
    { level: 2, id: "diagnostic", get label() { return t("tools.level.diagnostic.label", "Libre nivel 2 · diagnóstico"); }, get description() { return t("tools.level.diagnostic.desc", "Permite diagnóstico de bajo impacto, como HTTP HEAD, DNS o estado de red."); } },
    { level: 3, id: "active", get label() { return t("tools.level.active.label", "Libre nivel 3 · acciones activas"); }, get description() { return t("tools.level.active.desc", "Permite comandos activos/acotados, como nmap rápido, ffuf ligero o sh controlado."); } },
    { level: 99, id: "free", get label() { return t("tools.level.free.label", "Libre total"); }, get description() { return t("tools.level.free.desc", "Modo avanzado: el agente puede ejecutar cualquier tool disponible sin confirmar."); } },
  ];

  const PROFILE_TOOL_NAMES = {
    "alpine-base": [
      "vm.fs.list", "vm.fs.read", "vm.cmd.which", "vm.sys.info", "vm.console.status", "vm.pkg.info",
      "web.curl.head", "web.curl.fetch_text", "vm.sh.exec",
    ],
    "alpine-pentest-lite": [
      "vm.fs.list", "vm.fs.read", "vm.cmd.which", "vm.sys.info", "vm.console.status", "vm.pkg.info",
      "web.curl.head", "web.curl.fetch_text", "net.dns.lookup", "net.ip.status", "net.nmap.quick",
      "web.ffuf.dir_light", "vm.python.exec", "vm.sh.exec",
    ],
    "alpine-pentest-web": [
      "vm.fs.list", "vm.fs.read", "vm.cmd.which", "vm.sys.info", "vm.console.status", "vm.pkg.info",
      "web.curl.head", "web.curl.fetch_text", "net.dns.lookup", "net.ip.status", "net.nmap.quick",
      "web.ffuf.dir_light", "vm.python.exec", "web.httpx.probe", "web.nikto.quick", "tls.openssl.cert", "vm.sh.exec",
    ],
  };

  const DEFAULT_WORDLISTS = {
    common: "/usr/share/seclists/Discovery/Web-Content/common.txt",
    quickhits: "/usr/share/seclists/Discovery/Web-Content/quickhits.txt",
    raft_dirs: "/usr/share/seclists/Discovery/Web-Content/raft-small-directories-lowercase.txt",
    raft_files: "/usr/share/seclists/Discovery/Web-Content/raft-small-files.txt",
  };

  function normalizeBool(value, fallback = false) {
    if (value === true || value === false) return value;
    if (typeof value === "string") return /^(1|true|yes|si|sí)$/i.test(value.trim());
    return fallback;
  }

  function normalizeVmPath(value, fallback = ".") {
    const raw = String(value || fallback).trim() || fallback;
    if (raw.includes("\0") || /[\r\n]/.test(raw)) {
      throw new Error(t("tools.error.pathNewlinesNull", "La ruta no puede contener saltos de línea ni bytes nulos."));
    }
    if (raw.length > 240) throw new Error(t("tools.error.pathTooLong", "La ruta es demasiado larga para esta tool."));
    return raw;
  }

  function normalizeShellCommand(value) {
    const command = String(value || "").trim();
    if (!command) throw new Error(t("tools.error.shellEmpty", "El comando sh no puede estar vacío."));
    if (command.includes("\0")) throw new Error(t("tools.error.commandNull", "El comando no puede contener bytes nulos."));
    if (command.length > 2400) throw new Error(t("tools.error.commandTooLong", "El comando es demasiado largo para vm.sh.exec."));
    // Guard rail for the most dangerous mistakes. This is not a sandbox; the
    // real protection is the confirmation policy and the fact that it runs only
    // inside the VM, but these patterns prevent accidental catastrophic wipes.
    if (/\brm\s+-[^\n;]*r[^\n;]*f[^\n;]*(?:\/\s*$|\/\s|\/\*|--no-preserve-root)/i.test(command)) {
      throw new Error(t("tools.error.blockedRmrf", "Comando bloqueado por seguridad: patrón rm -rf peligroso."));
    }
    if (/\b(?:mkfs|mkswap|fdisk|parted)\b/i.test(command)) {
      throw new Error(t("tools.error.blockedDisk", "Comando bloqueado por seguridad: operación de disco no permitida en vm.sh.exec."));
    }
    if (/\bdd\b[^\n;]*\bof=\/dev\//i.test(command)) {
      throw new Error(t("tools.error.blockedDevWrite", "Comando bloqueado por seguridad: escritura directa a dispositivo."));
    }
    return command;
  }

  function normalizeUrl(value) {
    let url = String(value || "").trim();
    if (!url) throw new Error(t("tools.error.urlEmpty", "La URL no puede estar vacía."));
    if (url.includes("\0") || /[\r\n\s]/.test(url)) throw new Error(t("tools.error.urlSpaces", "La URL no puede contener espacios ni saltos de línea."));
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    if (url.length > 500) throw new Error(t("tools.error.urlTooLong", "La URL es demasiado larga."));
    return url;
  }

  function normalizeHost(value) {
    const host = String(value || "").trim();
    if (!host) throw new Error(t("tools.error.hostEmpty", "El host/target no puede estar vacío."));
    if (host.includes("\0") || /[\r\n\s]/.test(host)) throw new Error(t("tools.error.hostSpaces", "El host/target no puede contener espacios ni saltos de línea."));
    if (!/^[A-Za-z0-9._:\/[\]-]+$/.test(host)) throw new Error(t("tools.error.hostInvalidChars", "Host/target con caracteres no permitidos."));
    if (host.length > 220) throw new Error(t("tools.error.hostTooLong", "Host/target demasiado largo."));
    return host;
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
      throw new Error(t("tools.error.wordlistNotAllowed", "Wordlist no permitida. Usa common, quickhits, raft_dirs, raft_files o una ruta de /usr/share/seclists/ o /usr/share/wordlists/."));
    }
    return path;
  }

  function buildTempFileCommand(prefix) {
    const safePrefix = String(prefix || "ba-tool").replace(/[^A-Za-z0-9_.-]/g, "-");
    return `tmp=$(mktemp /tmp/${safePrefix}.XXXXXX 2>/dev/null || echo /tmp/${safePrefix}-$$); : > "$tmp"`;
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
      `if [ "$missing" = "0" ]; then ${bodyCommand} > "$tmp" 2>&1; rc=$?; fi`,
      `cat "$tmp"`,
      `rm -f "$tmp"`,
      "exit $rc",
    ].join("; ");
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

  function standardFormat(toolDef, result, args, okSummary, failSummary) {
    const cleanStdout = removeToolNoise(result.stdout || "");
    const cleanStderr = removeToolNoise(result.stderr || "");
    const out = truncateText(cleanStdout, toolDef.maxOutputBytes || 32768);
    const errorText = [cleanStderr, out.text].filter(Boolean).join("\n").trim();
    return {
      ok: result.code === 0,
      code: result.code,
      stdout: out.text,
      stderr: result.code === 0 ? cleanStderr : (errorText || `exit code ${result.code}`),
      truncated: out.truncated,
      summary: result.code === 0 ? okSummary(args) : failSummary(args),
    };
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
    if (profileId === "manual") return true;
    const allowed = PROFILE_TOOL_NAMES[profileId];
    return Array.isArray(allowed) ? allowed.includes(tool.name) : true;
  }

  function assertVmToolPreconditions() {
    const ctx = baseRuntimeContext();
    if (!ctx.vmPresent) throw new Error(t("tools.error.vmNotBooted", "La VM no está arrancada. Arranca v86 antes de usar tools de VM."));
    if (!ctx.vmReady) throw new Error(t("tools.error.vmShellNotReady", "La shell de la VM todavía no está lista."));
    if (!ctx.toolsConsoleAvailable) throw new Error(t("tools.error.toolsConsoleMissing", "Las tools necesitan serial1/ttyS1 activo. Reconstruye perfiles y espera a que el runner esté listo."));
    // Las tools del agente LLM van por serial1 (BA_BG_TOOLS), no por serial0/consola visible.
    // state.agentBusy solo marca bloqueo de la consola principal (snapshot, comandos manuales, etc.)
    // y no debe impedir vm.fs.* mientras el modelo planifica en GPU.
    if (ctx.backgroundToolBusy) throw new Error(t("tools.error.serial1Busy", "Hay otra tool en serial1/ttyS1. Espera a que termine."));
    if (ctx.pendingCommand) throw new Error(t("tools.error.serial0Pending", "La consola principal de la VM tiene un comando pendiente. Espera a que termine."));
    return ctx;
  }

  function normalizeListArgs(args = {}) { return { path: normalizeVmPath(args.path || "."), maxEntries: clampInt(args.maxEntries, 1, 300, 120) }; }
  function normalizeReadArgs(args = {}) { return { path: normalizeVmPath(args.path || ""), maxBytes: clampInt(args.maxBytes, 256, 32768, 8192) }; }

  const TOOLS = {
    "vm.fs.list": {
      name: "vm.fs.list", get label() { return t("tools.name.vm.fs.list", "Listar archivos en la VM"); }, riskLevel: 1, category: "vm.fs",
      requiresVm: true, requiresConsole: true, timeoutMs: 12000, maxOutputBytes: 32768,
      get description() { return t("tools.desc.vm.fs.list", "Lista un directorio dentro de la VM Alpine usando serial1/ttyS1 en background."); },
      get promptDescription() { return t("tools.prompt.vm.fs.list", "Listar un directorio de la VM. Argumentos: {\"path\":\"/ruta\",\"maxEntries\":120}."); },
      normalizeArgs: normalizeListArgs,
      buildCommand(args) {
        const safePath = shellQuote(args.path); const limit = clampInt(args.maxEntries, 1, 300, 120);
        return [buildTempFileCommand("ba-fs-list"), `p=${safePath}`, "rc=0", `if [ ! -e "$p" ]; then printf 'ERROR: not found: %s\\n' "$p" > "$tmp"; rc=2; elif [ ! -d "$p" ]; then printf 'ERROR: not a directory: %s\\n' "$p" > "$tmp"; ls -ld "$p" >> "$tmp" 2>&1; rc=2; else ls -la "$p" 2>&1 | sed -n '1,${limit}p' > "$tmp"; rc=$?; fi`, `cat "$tmp"`, `rm -f "$tmp"`, "exit $rc"].join("; ");
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => t("tools.summary.listOk", "Listado de {path}", { path: args.path }), () => t("tools.summary.listFail", "No se pudo listar {path}", { path: args.path })); },
    },

    "vm.fs.read": {
      name: "vm.fs.read", get label() { return t("tools.name.vm.fs.read", "Leer archivo en la VM"); }, riskLevel: 1, category: "vm.fs",
      requiresVm: true, requiresConsole: true, timeoutMs: 12000, maxOutputBytes: 32768,
      get description() { return t("tools.desc.vm.fs.read", "Lee un archivo de texto dentro de la VM con límite de bytes para no saturar la consola serial."); },
      get promptDescription() { return t("tools.prompt.vm.fs.read", "Leer un archivo de la VM. Argumentos: {\"path\":\"/ruta/archivo\",\"maxBytes\":8192}."); },
      normalizeArgs: normalizeReadArgs,
      buildCommand(args) {
        const safePath = shellQuote(args.path); const bytes = clampInt(args.maxBytes, 256, 32768, 8192);
        return [buildTempFileCommand("ba-fs-read"), `p=${safePath}`, "rc=0", `if [ ! -e "$p" ]; then printf 'ERROR: not found: %s\\n' "$p" > "$tmp"; rc=2; elif [ ! -f "$p" ]; then printf 'ERROR: not a regular file: %s\\n' "$p" > "$tmp"; ls -ld "$p" >> "$tmp" 2>&1; rc=2; else head -c ${bytes} "$p" > "$tmp" 2>&1; rc=$?; printf '\\012' >> "$tmp"; fi`, `cat "$tmp"`, `rm -f "$tmp"`, "exit $rc"].join("; ");
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => t("tools.summary.readOk", "Lectura de {path}", { path: args.path }), () => t("tools.summary.readFail", "No se pudo leer {path}", { path: args.path })); },
    },

    "vm.cmd.which": {
      name: "vm.cmd.which", get label() { return t("tools.name.vm.cmd.which", "Comprobar comandos instalados"); }, riskLevel: 1, category: "vm.system",
      requiresVm: true, requiresConsole: true, timeoutMs: 8000, maxOutputBytes: 12000,
      get description() { return t("tools.desc.vm.cmd.which", "Comprueba si una o varias utilidades existen en la VM usando command -v."); },
      get promptDescription() { return t("tools.prompt.vm.cmd.which", "Comprobar comandos instalados. Argumentos: {\"commands\":[\"curl\",\"nmap\"]}."); },
      normalizeArgs(args = {}) {
        const commands = Array.isArray(args.commands) ? args.commands : String(args.command || args.commands || "").split(/[\s,]+/);
        const clean = commands.map((c) => String(c || "").trim()).filter(Boolean).slice(0, 20);
        if (!clean.length) throw new Error(t("tools.error.commandAtLeastOne", "Indica al menos un comando."));
        if (clean.some((c) => !/^[A-Za-z0-9_.+-]+$/.test(c))) throw new Error(t("tools.error.commandInvalidName", "Nombre de comando no válido."));
        return { commands: clean };
      },
      buildCommand(args) {
        const checks = args.commands.map((cmd) => `if command -v ${shellQuote(cmd)} >/dev/null 2>&1; then printf '%s: ' ${shellQuote(cmd)}; command -v ${shellQuote(cmd)}; else printf '%s: missing\\n' ${shellQuote(cmd)}; fi`).join("; ");
        return captureCommand("ba-cmd-which", [], checks);
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => t("tools.summary.whichOk", "Comprobación de {commands}", { commands: args.commands.join(", ") }), () => t("tools.summary.whichFail", "No se pudo comprobar comandos")); },
    },

    "vm.sys.info": {
      name: "vm.sys.info", get label() { return t("tools.name.vm.sys.info", "Estado básico del sistema VM"); }, riskLevel: 1, category: "vm.system",
      requiresVm: true, requiresConsole: true, timeoutMs: 10000, maxOutputBytes: 24000,
      get description() { return t("tools.desc.vm.sys.info", "Muestra kernel, Alpine, memoria, disco y uptime de la VM."); },
      get promptDescription() { return t("tools.prompt.vm.sys.info", "Estado básico de la VM. Argumentos: {}."); },
      normalizeArgs() { return {}; },
      buildCommand() { return captureCommand("ba-sys-info", [], "uname -a; printf '\\n--- os-release ---\\n'; cat /etc/os-release 2>/dev/null || true; printf '\\n--- memory ---\\n'; free -m 2>/dev/null || true; printf '\\n--- disk ---\\n'; df -h 2>/dev/null || true; printf '\\n--- uptime ---\\n'; uptime 2>/dev/null || true"); },
      formatResult(result) { return standardFormat(this, result, {}, () => t("tools.summary.sysInfoOk", "Estado básico de la VM"), () => t("tools.summary.sysInfoFail", "No se pudo obtener estado básico")); },
    },

    "vm.console.status": {
      name: "vm.console.status", get label() { return t("tools.name.vm.console.status", "Estado de consolas xterm"); }, riskLevel: 1, category: "vm.system",
      requiresVm: true, requiresConsole: true, timeoutMs: 8000, maxOutputBytes: 16000,
      get description() { return t("tools.desc.vm.console.status", "Comprueba el daemon xterm/PTY y los dispositivos seriales dentro de la VM."); },
      get promptDescription() { return t("tools.prompt.vm.console.status", "Estado de consolas xterm. Argumentos: {}."); },
      normalizeArgs() { return {}; },
      buildCommand() { return captureCommand("ba-console-status", [], "printf '%s\\n' '--- serial devices ---'; ls -l /dev/ttyS0 /dev/ttyS1 /dev/ttyS2 2>&1 || true; printf '%s\\n' '--- xterm daemon ---'; ps | grep '[b]a-serial2-console-runner' || true; printf '%s\\n' '--- python ---'; python3 --version 2>&1 || true; printf '%s\\n' '--- runner log ---'; tail -40 /tmp/ba-serial2-console-runner.log 2>/dev/null || true"); },
      formatResult(result) { return standardFormat(this, result, {}, () => t("tools.summary.consoleStatusOk", "Estado de consolas xterm"), () => t("tools.summary.consoleStatusFail", "No se pudo obtener estado de consolas")); },
    },

    "vm.pkg.info": {
      name: "vm.pkg.info", get label() { return t("tools.name.vm.pkg.info", "Paquetes instalados en Alpine"); }, riskLevel: 1, category: "vm.system",
      requiresVm: true, requiresConsole: true, timeoutMs: 10000, maxOutputBytes: 24000,
      get description() { return t("tools.desc.vm.pkg.info", "Consulta paquetes instalados mediante apk info, con filtro opcional."); },
      get promptDescription() { return t("tools.prompt.vm.pkg.info", "Consultar paquetes instalados. Argumentos: {\"filter\":\"curl\"}."); },
      normalizeArgs(args = {}) { return { filter: String(args.filter || "").trim().slice(0, 80) }; },
      buildCommand(args) {
        const f = shellQuote(args.filter || "");
        return captureCommand("ba-pkg-info", ["apk"], `if [ -n ${f} ]; then apk info | grep -i -- ${f} | sed -n '1,120p'; else apk info | sed -n '1,160p'; fi`);
      },
      formatResult(result) { return standardFormat(this, result, {}, () => t("tools.summary.pkgInfoOk", "Paquetes instalados"), () => t("tools.summary.pkgInfoFail", "No se pudo consultar paquetes")); },
    },

    "web.curl.head": {
      name: "web.curl.head", get label() { return t("tools.name.web.curl.head", "HTTP HEAD con curl"); }, riskLevel: 2, category: "web.http",
      requiresVm: true, requiresConsole: true, timeoutMs: 15000, maxOutputBytes: 24000,
      get description() { return t("tools.desc.web.curl.head", "Obtiene cabeceras HTTP/HTTPS con curl y timeouts bajos."); },
      get promptDescription() { return t("tools.prompt.web.curl.head", "Probar cabeceras HTTP. Argumentos: {\"url\":\"https://example.com\",\"followRedirects\":true,\"insecure\":true,\"timeoutSec\":8}."); },
      normalizeArgs(args = {}) { return { url: normalizeUrl(args.url || args.target), followRedirects: normalizeBool(args.followRedirects, true), insecure: normalizeBool(args.insecure, true), timeoutSec: clampInt(args.timeoutSec, 3, 20, 8) }; },
      buildCommand(args) {
        const flags = ["-I", "-sS", "--connect-timeout", "4", "--max-time", String(args.timeoutSec)];
        if (args.followRedirects) flags.push("-L"); if (args.insecure) flags.push("-k");
        flags.push(args.url);
        return captureCommand("ba-curl-head", ["curl"], `curl ${flags.map(shellQuote).join(" ")}`);
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => t("tools.summary.curlHeadOk", "Cabeceras de {url}", { url: args.url }), () => t("tools.summary.curlHeadFail", "No se pudo consultar {url}", { url: args.url })); },
    },

    "web.curl.fetch_text": {
      name: "web.curl.fetch_text", get label() { return t("tools.name.web.curl.fetch_text", "Descargar texto con curl"); }, riskLevel: 2, category: "web.http",
      requiresVm: true, requiresConsole: true, timeoutMs: 18000, maxOutputBytes: 32768,
      get description() { return t("tools.desc.web.curl.fetch_text", "Descarga una URL con curl con límite estricto de bytes."); },
      get promptDescription() { return t("tools.prompt.web.curl.fetch_text", "Descargar texto HTTP limitado. Argumentos: {\"url\":\"https://example.com\",\"maxBytes\":8192}."); },
      normalizeArgs(args = {}) { return { url: normalizeUrl(args.url || args.target), followRedirects: normalizeBool(args.followRedirects, true), insecure: normalizeBool(args.insecure, true), timeoutSec: clampInt(args.timeoutSec, 3, 25, 10), maxBytes: clampInt(args.maxBytes, 512, 32768, 8192) }; },
      buildCommand(args) {
        const flags = ["-sS", "--connect-timeout", "4", "--max-time", String(args.timeoutSec)];
        if (args.followRedirects) flags.push("-L"); if (args.insecure) flags.push("-k");
        flags.push(args.url);
        return captureCommand("ba-curl-fetch", ["curl", "head"], `curl ${flags.map(shellQuote).join(" ")} | head -c ${args.maxBytes}`);
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => t("tools.summary.curlFetchOk", "Contenido de {url}", { url: args.url }), () => t("tools.summary.curlFetchFail", "No se pudo descargar {url}", { url: args.url })); },
    },

    "net.dns.lookup": {
      name: "net.dns.lookup", get label() { return t("tools.name.net.dns.lookup", "Consulta DNS"); }, riskLevel: 2, category: "net.dns",
      requiresVm: true, requiresConsole: true, timeoutMs: 10000, maxOutputBytes: 16000,
      get description() { return t("tools.desc.net.dns.lookup", "Consulta DNS con dig usando timeouts bajos."); },
      get promptDescription() { return t("tools.prompt.net.dns.lookup", "Resolver DNS. Argumentos: {\"host\":\"example.com\",\"type\":\"A\"}."); },
      normalizeArgs(args = {}) { return { host: normalizeHost(args.host || args.domain || args.target), type: normalizeDnsType(args.type) }; },
      buildCommand(args) { return captureCommand("ba-dns", ["dig"], `dig +time=3 +tries=1 ${shellQuote(args.type)} ${shellQuote(args.host)}; printf '\\n--- short ---\\n'; dig +short +time=3 +tries=1 ${shellQuote(args.type)} ${shellQuote(args.host)}`); },
      formatResult(result, args) { return standardFormat(this, result, args, () => t("tools.summary.dnsOk", "DNS {type} de {host}", { type: args.type, host: args.host }), () => t("tools.summary.dnsFail", "No se pudo resolver {host}", { host: args.host })); },
    },

    "net.ip.status": {
      name: "net.ip.status", get label() { return t("tools.name.net.ip.status", "Estado de red VM"); }, riskLevel: 1, category: "net.local",
      requiresVm: true, requiresConsole: true, timeoutMs: 10000, maxOutputBytes: 24000,
      get description() { return t("tools.desc.net.ip.status", "Muestra direcciones, rutas y sockets de la VM con ip/ss."); },
      get promptDescription() { return t("tools.prompt.net.ip.status", "Estado local de red. Argumentos: {}."); },
      normalizeArgs() { return {}; },
      buildCommand() { return captureCommand("ba-ip-status", ["ip"], "ip addr show; printf '\\n--- route ---\\n'; ip route show; printf '\\n--- sockets ---\\n'; ss -tuna 2>/dev/null | sed -n '1,80p' || true"); },
      formatResult(result) { return standardFormat(this, result, {}, () => t("tools.summary.ipStatusOk", "Estado de red VM"), () => t("tools.summary.ipStatusFail", "No se pudo obtener estado de red")); },
    },

    "net.nmap.quick": {
      name: "net.nmap.quick", get label() { return t("tools.name.net.nmap.quick", "Nmap rápido y prudente"); }, riskLevel: 3, category: "net.scan",
      requiresVm: true, requiresConsole: true, timeoutMs: 70000, maxOutputBytes: 32768,
      get description() { return t("tools.desc.net.nmap.quick", "Escaneo nmap acotado para objetivos autorizados. Baja concurrencia y host-timeout."); },
      get promptDescription() { return t("tools.prompt.net.nmap.quick", "Escaneo nmap ligero. Argumentos: {\"target\":\"192.168.1.10\",\"topPorts\":30}."); },
      normalizeArgs(args = {}) { return { target: normalizeHost(args.target || args.host), topPorts: clampInt(args.topPorts || args.ports, 10, 100, 30) }; },
      buildCommand(args) { return captureCommand("ba-nmap-quick", ["nmap"], `nmap -Pn -sT -T2 --max-retries 1 --host-timeout 55s --top-ports ${args.topPorts} ${shellQuote(args.target)}`); },
      formatResult(result, args) { return standardFormat(this, result, args, () => t("tools.summary.nmapOk", "Nmap rápido sobre {target}", { target: args.target }), () => t("tools.summary.nmapFail", "Nmap falló sobre {target}", { target: args.target })); },
    },

    "web.ffuf.dir_light": {
      name: "web.ffuf.dir_light", get label() { return t("tools.name.web.ffuf.dir_light", "FFUF directorios ligero"); }, riskLevel: 3, category: "web.fuzz",
      requiresVm: true, requiresConsole: true, timeoutMs: 70000, maxOutputBytes: 32768,
      get description() { return t("tools.desc.web.ffuf.dir_light", "Fuzzing web ligero con ffuf. Requiere autorización del objetivo."); },
      get promptDescription() { return t("tools.prompt.web.ffuf.dir_light", "Fuzzing ligero de rutas. Argumentos: {\"url\":\"http://host/FUZZ\",\"wordlist\":\"quickhits\",\"threads\":3,\"rate\":20,\"maxTimeSec\":45}."); },
      normalizeArgs(args = {}) {
        let url = normalizeUrl(args.url || args.target);
        if (!url.includes("FUZZ")) url = url.replace(/\/?$/, "/FUZZ");
        return { url, wordlist: normalizeWordlist(args.wordlist || "quickhits"), threads: clampInt(args.threads, 1, 8, 3), rate: clampInt(args.rate, 1, 50, 20), maxTimeSec: clampInt(args.maxTimeSec, 10, 60, 35) };
      },
      buildCommand(args) { return captureCommand("ba-ffuf-light", ["ffuf"], `ffuf -u ${shellQuote(args.url)} -w ${shellQuote(args.wordlist)} -t ${args.threads} -rate ${args.rate} -maxtime ${args.maxTimeSec} -ac -noninteractive 2>&1 | sed -n '1,160p'`); },
      formatResult(result, args) { return standardFormat(this, result, args, () => t("tools.summary.ffufOk", "FFUF ligero sobre {url}", { url: args.url }), () => t("tools.summary.ffufFail", "FFUF falló sobre {url}", { url: args.url })); },
    },

    "vm.python.exec": {
      name: "vm.python.exec", get label() { return t("tools.name.vm.python.exec", "Ejecutar Python acotado"); }, riskLevel: 3, category: "vm.exec",
      requiresVm: true, requiresConsole: true, timeoutMs: 25000, maxOutputBytes: 32768,
      get description() { return t("tools.desc.vm.python.exec", "Ejecuta un fragmento Python corto dentro de la VM. Confirmación recomendada."); },
      get promptDescription() { return t("tools.prompt.vm.python.exec", "Ejecutar Python corto. Argumentos: {\"code\":\"print('hi')\"}."); },
      normalizeArgs(args = {}) {
        const code = String(args.code || "").trim();
        if (!code) throw new Error(t("tools.error.pythonEmpty", "El código Python no puede estar vacío."));
        if (code.length > 2500) throw new Error(t("tools.error.pythonTooLong", "Código Python demasiado largo."));
        return { code };
      },
      buildCommand(args) { return captureCommand("ba-python", ["python3"], `python3 -c ${shellQuote(args.code)}`); },
      formatResult(result) { return standardFormat(this, result, {}, () => t("tools.summary.pythonOk", "Python ejecutado"), () => t("tools.summary.pythonFail", "Python falló")); },
    },

    "web.httpx.probe": {
      name: "web.httpx.probe", get label() { return t("tools.name.web.httpx.probe", "HTTPX fingerprint prudente"); }, riskLevel: 3, category: "web.http",
      requiresVm: true, requiresConsole: true, timeoutMs: 45000, maxOutputBytes: 24000,
      get description() { return t("tools.desc.web.httpx.probe", "Fingerprint HTTP con ProjectDiscovery httpx usando threads/rate bajos."); },
      get promptDescription() { return t("tools.prompt.web.httpx.probe", "Probar HTTPX. Argumentos: {\"url\":\"https://example.com\",\"rate\":10,\"threads\":2}."); },
      normalizeArgs(args = {}) { return { url: normalizeUrl(args.url || args.target), rate: clampInt(args.rate, 1, 30, 10), threads: clampInt(args.threads, 1, 5, 2), timeoutSec: clampInt(args.timeoutSec, 3, 12, 6) }; },
      buildCommand(args) { return captureCommand("ba-httpx", ["httpx"], `printf '%s\\n' ${shellQuote(args.url)} | httpx -silent -status-code -title -tech-detect -follow-redirects -threads ${args.threads} -rate-limit ${args.rate} -timeout ${args.timeoutSec} -retries 0 2>&1 | sed -n '1,120p'`); },
      formatResult(result, args) { return standardFormat(this, result, args, () => t("tools.summary.httpxOk", "HTTPX sobre {url}", { url: args.url }), () => t("tools.summary.httpxFail", "HTTPX falló sobre {url}", { url: args.url })); },
    },

    "web.nikto.quick": {
      name: "web.nikto.quick", get label() { return t("tools.name.web.nikto.quick", "Nikto rápido"); }, riskLevel: 3, category: "web.scan",
      requiresVm: true, requiresConsole: true, timeoutMs: 80000, maxOutputBytes: 32768,
      get description() { return t("tools.desc.web.nikto.quick", "Nikto acotado con maxtime para comprobaciones web autorizadas."); },
      get promptDescription() { return t("tools.prompt.web.nikto.quick", "Nikto rápido. Argumentos: {\"url\":\"https://example.com\",\"maxTimeSec\":45}."); },
      normalizeArgs(args = {}) { return { url: normalizeUrl(args.url || args.target), maxTimeSec: clampInt(args.maxTimeSec, 15, 70, 40) }; },
      buildCommand(args) { return captureCommand("ba-nikto", ["nikto"], `nikto -h ${shellQuote(args.url)} -nointeractive -maxtime ${args.maxTimeSec}s 2>&1 | sed -n '1,180p'`); },
      formatResult(result, args) { return standardFormat(this, result, args, () => t("tools.summary.niktoOk", "Nikto sobre {url}", { url: args.url }), () => t("tools.summary.niktoFail", "Nikto falló sobre {url}", { url: args.url })); },
    },

    "tls.openssl.cert": {
      name: "tls.openssl.cert", get label() { return t("tools.name.tls.openssl.cert", "Certificado TLS con OpenSSL"); }, riskLevel: 2, category: "tls",
      requiresVm: true, requiresConsole: true, timeoutMs: 18000, maxOutputBytes: 16000,
      get description() { return t("tools.desc.tls.openssl.cert", "Obtiene datos básicos del certificado TLS de un host."); },
      get promptDescription() { return t("tools.prompt.tls.openssl.cert", "Ver certificado TLS. Argumentos: {\"host\":\"example.com\",\"port\":443}."); },
      normalizeArgs(args = {}) { return { host: normalizeHost(args.host || args.target), port: clampInt(args.port, 1, 65535, 443) }; },
      buildCommand(args) { return captureCommand("ba-openssl-cert", ["openssl"], `echo | openssl s_client -servername ${shellQuote(args.host)} -connect ${shellQuote(`${args.host}:${args.port}`)} 2>/dev/null | openssl x509 -noout -subject -issuer -dates -fingerprint -sha256`); },
      formatResult(result, args) { return standardFormat(this, result, args, () => t("tools.summary.tlsOk", "Certificado TLS de {host}:{port}", { host: args.host, port: args.port }), () => t("tools.summary.tlsFail", "No se pudo obtener certificado TLS de {host}:{port}", { host: args.host, port: args.port })); },
    },

    "vm.sh.exec": {
      name: "vm.sh.exec", get label() { return t("tools.name.vm.sh.exec", "Ejecutar comando sh en la VM"); }, riskLevel: 3, category: "vm.exec",
      requiresVm: true, requiresConsole: true, timeoutMs: 30000, maxOutputBytes: 32768,
      get description() { return t("tools.desc.vm.sh.exec", "Ejecuta un comando /bin/sh -lc dentro de la VM con timeout y salida limitada. Confirmación recomendada siempre."); },
      get promptDescription() { return t("tools.prompt.vm.sh.exec", "Ejecutar comando sh arbitrario. Argumentos: {\"command\":\"uname -a\",\"timeoutMs\":10000,\"maxOutputBytes\":8192}. Usar solo si no existe una tool específica."); },
      normalizeArgs(args = {}) { return { command: normalizeShellCommand(args.command || args.cmd), timeoutMs: clampInt(args.timeoutMs, 1000, 30000, 10000), maxOutputBytes: clampInt(args.maxOutputBytes, 512, 32768, 8192) }; },
      buildCommand(args) { return captureCommand("ba-sh-exec", ["sh"], `sh -lc ${shellQuote(args.command)}`); },
      formatResult(result, args) {
        const oldMax = this.maxOutputBytes; this.maxOutputBytes = args.maxOutputBytes;
        const formatted = standardFormat(this, result, args, () => t("tools.summary.shExecOk", "Comando sh ejecutado"), () => t("tools.summary.shExecFail", "Comando sh fallido"));
        this.maxOutputBytes = oldMax;
        return formatted;
      },
    },
  };

  function getTool(name) { return TOOLS[String(name || "")]; }

  function listTools({ profileId = baseRuntimeContext().activeProfile, includeUnavailable = false } = {}) {
    return Object.values(TOOLS)
      .filter((tool) => includeUnavailable || isToolEnabledForProfile(tool, profileId))
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
      }));
  }

  function buildPromptToolCatalog() {
    return listTools().map((tool) => [
      `- ${tool.name}`,
      t("prompt.catalog.security", "  Nivel seguridad: {level}", { level: tool.riskLevel }),
      t("prompt.catalog.usage", "  Uso: {usage}", { usage: tool.promptDescription }),
      t("prompt.catalog.requirements", "  Requisitos: {vm}{console}", {
        vm: tool.requiresVm ? t("prompt.catalog.vmBooted", "VM arrancada") : t("prompt.catalog.noVm", "sin VM"),
        console: tool.requiresConsole ? t("prompt.catalog.serial1", ", serial1/ttyS1 activo") : "",
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
      : t("prompt.none", "ninguna");
    return [
      t("prompt.runtime.compact", "Runtime: VM={vm} serial1={serial1} perfil={profile} red={net}", {
        vm, serial1,
        profile: ctx.activeProfile || "manual",
        net: ctx.networkConfigured ? t("prompt.yes", "sí") : t("prompt.no", "no"),
      }),
      t("prompt.runtime.activeTools", "Herramientas activas ({count}): {tools}", { count: enabled.length, tools: toolsLine }),
    ].join("\n");
  }

  function buildPromptRuntimeContext() {
    const ctx = baseRuntimeContext();
    const yes = t("prompt.yes", "sí");
    const no = t("prompt.no", "no");
    return [
      t("prompt.runtime.title", "Contexto runtime actual:"),
      t("prompt.runtime.vmBooted", "- VM arrancada: {v}", { v: ctx.vmPresent ? yes : no }),
      t("prompt.runtime.shellReady", "- Shell VM lista: {v}", { v: ctx.vmReady ? yes : no }),
      t("prompt.runtime.consoleReady", "- consola xterm lista: {v}", { v: ctx.consoleReady ? yes : no }),
      t("prompt.runtime.toolsReady", "- serial1/ttyS1 herramientas listas: {v}", { v: ctx.toolsConsoleAvailable ? yes : no }),
      t("prompt.runtime.profile", "- Perfil activo/seleccionado: {profile}", { profile: ctx.activeProfile || "manual" }),
      t("prompt.runtime.network", "- Red VM configurada: {v}", { v: ctx.networkConfigured ? yes : no }),
      t("prompt.runtime.disk", "- Disco montado: {v}", { v: ctx.diskMounted ? yes : no }),
      t("prompt.runtime.serials", "- VM serial0: {s0} · serial1 herramientas: {s1}", {
        s0: ctx.pendingCommand || ctx.agentBusy ? t("prompt.busyF", "ocupada") : t("prompt.free", "libre"),
        s1: ctx.backgroundToolBusy ? t("prompt.busy", "ocupado") : t("prompt.free", "libre"),
      }),
      t("prompt.runtime.availableTools", "Herramientas disponibles para este perfil:"),
      buildPromptToolCatalog(),
    ].join("\n");
  }

  function normalizeToolCall(value) {
    if (!value || typeof value !== "object") throw new Error(t("tools.error.responseNotObject", "La respuesta de tool no es un objeto JSON."));
    const toolName = value.tool || value.name;
    if (value.type && value.type !== "tool_call") {
      throw new Error(t("tools.error.unsupportedInvocation", "Tipo de invocación no soportado: {type}", { type: value.type }));
    }
    const tool = getTool(toolName);
    if (!tool) throw new Error(t("tools.error.toolNotAvailable", "Herramienta no disponible: {name}", { name: toolName || "(vacía)" }));
    if (!isToolEnabledForProfile(tool)) {
      const ctx = baseRuntimeContext();
      throw new Error(t("tools.error.toolNotEnabled", "La tool {tool} no está habilitada para el perfil activo {profile}.", { tool: tool.name, profile: ctx.activeProfile }));
    }
    const args = tool.normalizeArgs ? tool.normalizeArgs(value.arguments || {}) : (value.arguments || {});
    return { type: "tool_call", tool: tool.name, arguments: args, reason: String(value.reason || t("tools.exec.reasonDefault", "El modelo solicita ejecutar una herramienta.")).slice(0, 400), riskLevel: tool.riskLevel };
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
