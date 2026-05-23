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
    { level: 0, id: "none", label: "Pedir confirmación siempre", description: "El agente nunca ejecuta tools automáticamente." },
    { level: 1, id: "read", label: "Libre nivel 1 · lectura segura", description: "Permite tools de lectura acotada en la VM, como listar o leer archivos con límite." },
    { level: 2, id: "diagnostic", label: "Libre nivel 2 · diagnóstico", description: "Permite diagnóstico de bajo impacto, como HTTP HEAD, DNS o estado de red." },
    { level: 3, id: "active", label: "Libre nivel 3 · acciones activas", description: "Permite comandos activos/acotados, como nmap rápido, ffuf ligero o sh controlado." },
    { level: 99, id: "free", label: "Libre total", description: "Modo avanzado: el agente puede ejecutar cualquier tool disponible sin confirmar." },
  ];

  const PROFILE_TOOL_NAMES = {
    "alpine-base": [
      "vm.fs.list", "vm.fs.read", "vm.cmd.which", "vm.sys.info", "vm.tmux.status", "vm.pkg.info",
      "web.curl.head", "web.curl.fetch_text", "vm.sh.exec",
    ],
    "alpine-pentest-lite": [
      "vm.fs.list", "vm.fs.read", "vm.cmd.which", "vm.sys.info", "vm.tmux.status", "vm.pkg.info",
      "web.curl.head", "web.curl.fetch_text", "net.dns.lookup", "net.ip.status", "net.nmap.quick",
      "web.ffuf.dir_light", "vm.python.exec", "vm.sh.exec",
    ],
    "alpine-pentest-web": [
      "vm.fs.list", "vm.fs.read", "vm.cmd.which", "vm.sys.info", "vm.tmux.status", "vm.pkg.info",
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
      throw new Error("La ruta no puede contener saltos de línea ni bytes nulos.");
    }
    if (raw.length > 240) throw new Error("La ruta es demasiado larga para esta tool.");
    return raw;
  }

  function normalizeShellCommand(value) {
    const command = String(value || "").trim();
    if (!command) throw new Error("El comando sh no puede estar vacío.");
    if (command.includes("\0")) throw new Error("El comando no puede contener bytes nulos.");
    if (command.length > 2400) throw new Error("El comando es demasiado largo para vm.sh.exec.");
    // Guard rail for the most dangerous mistakes. This is not a sandbox; the
    // real protection is the confirmation policy and the fact that it runs only
    // inside the VM, but these patterns prevent accidental catastrophic wipes.
    if (/\brm\s+-[^\n;]*r[^\n;]*f[^\n;]*(?:\/\s*$|\/\s|\/\*|--no-preserve-root)/i.test(command)) {
      throw new Error("Comando bloqueado por seguridad: patrón rm -rf peligroso.");
    }
    if (/\b(?:mkfs|mkswap|fdisk|parted)\b/i.test(command)) {
      throw new Error("Comando bloqueado por seguridad: operación de disco no permitida en vm.sh.exec.");
    }
    if (/\bdd\b[^\n;]*\bof=\/dev\//i.test(command)) {
      throw new Error("Comando bloqueado por seguridad: escritura directa a dispositivo.");
    }
    return command;
  }

  function normalizeUrl(value) {
    let url = String(value || "").trim();
    if (!url) throw new Error("La URL no puede estar vacía.");
    if (url.includes("\0") || /[\r\n\s]/.test(url)) throw new Error("La URL no puede contener espacios ni saltos de línea.");
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    if (url.length > 500) throw new Error("La URL es demasiado larga.");
    return url;
  }

  function normalizeHost(value) {
    const host = String(value || "").trim();
    if (!host) throw new Error("El host/target no puede estar vacío.");
    if (host.includes("\0") || /[\r\n\s]/.test(host)) throw new Error("El host/target no puede contener espacios ni saltos de línea.");
    if (!/^[A-Za-z0-9._:\/[\]-]+$/.test(host)) throw new Error("Host/target con caracteres no permitidos.");
    if (host.length > 220) throw new Error("Host/target demasiado largo.");
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
      throw new Error("Wordlist no permitida. Usa common, quickhits, raft_dirs, raft_files o una ruta de /usr/share/seclists/ o /usr/share/wordlists/.");
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
      tmuxReady: Boolean(state.consoleTabs?.ready),
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
    if (!ctx.vmPresent) throw new Error("La VM no está arrancada. Arranca v86 antes de usar tools de VM.");
    if (!ctx.vmReady) throw new Error("La shell de la VM todavía no está lista.");
    if (!ctx.tmuxReady) throw new Error("La consola tmux del usuario todavía no está lista.");
    if (!ctx.toolsConsoleAvailable) throw new Error("Las tools necesitan serial1/ttyS1 activo. Reconstruye perfiles y espera a que el runner esté listo.");
    // Las tools del agente LLM van por serial1 (BA_BG_TOOLS), no por serial0/tmux visible.
    // state.agentBusy solo marca bloqueo de la consola principal (snapshot, comandos manuales, etc.)
    // y no debe impedir vm.fs.* mientras el modelo planifica en GPU.
    if (ctx.backgroundToolBusy) throw new Error("Hay otra tool en serial1/ttyS1. Espera a que termine.");
    if (ctx.pendingCommand) throw new Error("La consola principal de la VM tiene un comando pendiente. Espera a que termine.");
    return ctx;
  }

  function normalizeListArgs(args = {}) { return { path: normalizeVmPath(args.path || "."), maxEntries: clampInt(args.maxEntries, 1, 300, 120) }; }
  function normalizeReadArgs(args = {}) { return { path: normalizeVmPath(args.path || ""), maxBytes: clampInt(args.maxBytes, 256, 32768, 8192) }; }

  const TOOLS = {
    "vm.fs.list": {
      name: "vm.fs.list", label: "Listar archivos en la VM", riskLevel: 1, category: "vm.fs",
      requiresVm: true, requiresTmux: true, timeoutMs: 12000, maxOutputBytes: 32768,
      description: "Lista un directorio dentro de la VM Alpine usando serial1/ttyS1 en background.",
      promptDescription: "Listar un directorio de la VM. Argumentos: {\"path\":\"/ruta\",\"maxEntries\":120}.",
      normalizeArgs: normalizeListArgs,
      buildCommand(args) {
        const safePath = shellQuote(args.path); const limit = clampInt(args.maxEntries, 1, 300, 120);
        return [buildTempFileCommand("ba-fs-list"), `p=${safePath}`, "rc=0", `if [ ! -e "$p" ]; then printf 'ERROR: not found: %s\\n' "$p" > "$tmp"; rc=2; elif [ ! -d "$p" ]; then printf 'ERROR: not a directory: %s\\n' "$p" > "$tmp"; ls -ld "$p" >> "$tmp" 2>&1; rc=2; else ls -la "$p" 2>&1 | sed -n '1,${limit}p' > "$tmp"; rc=$?; fi`, `cat "$tmp"`, `rm -f "$tmp"`, "exit $rc"].join("; ");
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => `Listado de ${args.path}`, () => `No se pudo listar ${args.path}`); },
    },

    "vm.fs.read": {
      name: "vm.fs.read", label: "Leer archivo en la VM", riskLevel: 1, category: "vm.fs",
      requiresVm: true, requiresTmux: true, timeoutMs: 12000, maxOutputBytes: 32768,
      description: "Lee un archivo de texto dentro de la VM con límite de bytes para no saturar la consola serial.",
      promptDescription: "Leer un archivo de la VM. Argumentos: {\"path\":\"/ruta/archivo\",\"maxBytes\":8192}.",
      normalizeArgs: normalizeReadArgs,
      buildCommand(args) {
        const safePath = shellQuote(args.path); const bytes = clampInt(args.maxBytes, 256, 32768, 8192);
        return [buildTempFileCommand("ba-fs-read"), `p=${safePath}`, "rc=0", `if [ ! -e "$p" ]; then printf 'ERROR: not found: %s\\n' "$p" > "$tmp"; rc=2; elif [ ! -f "$p" ]; then printf 'ERROR: not a regular file: %s\\n' "$p" > "$tmp"; ls -ld "$p" >> "$tmp" 2>&1; rc=2; else head -c ${bytes} "$p" > "$tmp" 2>&1; rc=$?; printf '\\012' >> "$tmp"; fi`, `cat "$tmp"`, `rm -f "$tmp"`, "exit $rc"].join("; ");
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => `Lectura de ${args.path}`, () => `No se pudo leer ${args.path}`); },
    },

    "vm.cmd.which": {
      name: "vm.cmd.which", label: "Comprobar comandos instalados", riskLevel: 1, category: "vm.system",
      requiresVm: true, requiresTmux: true, timeoutMs: 8000, maxOutputBytes: 12000,
      description: "Comprueba si una o varias utilidades existen en la VM usando command -v.",
      promptDescription: "Comprobar comandos instalados. Argumentos: {\"commands\":[\"curl\",\"nmap\"]}.",
      normalizeArgs(args = {}) {
        const commands = Array.isArray(args.commands) ? args.commands : String(args.command || args.commands || "").split(/[\s,]+/);
        const clean = commands.map((c) => String(c || "").trim()).filter(Boolean).slice(0, 20);
        if (!clean.length) throw new Error("Indica al menos un comando.");
        if (clean.some((c) => !/^[A-Za-z0-9_.+-]+$/.test(c))) throw new Error("Nombre de comando no válido.");
        return { commands: clean };
      },
      buildCommand(args) {
        const checks = args.commands.map((cmd) => `if command -v ${shellQuote(cmd)} >/dev/null 2>&1; then printf '%s: ' ${shellQuote(cmd)}; command -v ${shellQuote(cmd)}; else printf '%s: missing\\n' ${shellQuote(cmd)}; fi`).join("; ");
        return captureCommand("ba-cmd-which", [], checks);
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => `Comprobación de ${args.commands.join(", ")}`, () => "No se pudo comprobar comandos"); },
    },

    "vm.sys.info": {
      name: "vm.sys.info", label: "Estado básico del sistema VM", riskLevel: 1, category: "vm.system",
      requiresVm: true, requiresTmux: true, timeoutMs: 10000, maxOutputBytes: 24000,
      description: "Muestra kernel, Alpine, memoria, disco y uptime de la VM.",
      promptDescription: "Estado básico de la VM. Argumentos: {}.",
      normalizeArgs() { return {}; },
      buildCommand() { return captureCommand("ba-sys-info", [], "uname -a; printf '\\n--- os-release ---\\n'; cat /etc/os-release 2>/dev/null || true; printf '\\n--- memory ---\\n'; free -m 2>/dev/null || true; printf '\\n--- disk ---\\n'; df -h 2>/dev/null || true; printf '\\n--- uptime ---\\n'; uptime 2>/dev/null || true"); },
      formatResult(result) { return standardFormat(this, result, {}, () => "Estado básico de la VM", () => "No se pudo obtener estado básico"); },
    },

    "vm.tmux.status": {
      name: "vm.tmux.status", label: "Estado tmux en la VM", riskLevel: 1, category: "vm.system",
      requiresVm: true, requiresTmux: true, timeoutMs: 8000, maxOutputBytes: 16000,
      description: "Comprueba versión y sesiones tmux dentro de la VM.",
      promptDescription: "Estado tmux. Argumentos: {}.",
      normalizeArgs() { return {}; },
      buildCommand() { return captureCommand("ba-tmux-status", ["tmux"], "tmux -V; printf '\\n--- sessions ---\\n'; tmux list-sessions 2>&1 || true; printf '\\n--- windows ---\\n'; tmux list-windows -a 2>&1 || true"); },
      formatResult(result) { return standardFormat(this, result, {}, () => "Estado tmux", () => "No se pudo obtener estado tmux"); },
    },

    "vm.pkg.info": {
      name: "vm.pkg.info", label: "Paquetes instalados en Alpine", riskLevel: 1, category: "vm.system",
      requiresVm: true, requiresTmux: true, timeoutMs: 10000, maxOutputBytes: 24000,
      description: "Consulta paquetes instalados mediante apk info, con filtro opcional.",
      promptDescription: "Consultar paquetes instalados. Argumentos: {\"filter\":\"curl\"}.",
      normalizeArgs(args = {}) { return { filter: String(args.filter || "").trim().slice(0, 80) }; },
      buildCommand(args) {
        const f = shellQuote(args.filter || "");
        return captureCommand("ba-pkg-info", ["apk"], `if [ -n ${f} ]; then apk info | grep -i -- ${f} | sed -n '1,120p'; else apk info | sed -n '1,160p'; fi`);
      },
      formatResult(result) { return standardFormat(this, result, {}, () => "Paquetes instalados", () => "No se pudo consultar paquetes"); },
    },

    "web.curl.head": {
      name: "web.curl.head", label: "HTTP HEAD con curl", riskLevel: 2, category: "web.http",
      requiresVm: true, requiresTmux: true, timeoutMs: 15000, maxOutputBytes: 24000,
      description: "Obtiene cabeceras HTTP/HTTPS con curl y timeouts bajos.",
      promptDescription: "Probar cabeceras HTTP. Argumentos: {\"url\":\"https://example.com\",\"followRedirects\":true,\"insecure\":true,\"timeoutSec\":8}.",
      normalizeArgs(args = {}) { return { url: normalizeUrl(args.url || args.target), followRedirects: normalizeBool(args.followRedirects, true), insecure: normalizeBool(args.insecure, true), timeoutSec: clampInt(args.timeoutSec, 3, 20, 8) }; },
      buildCommand(args) {
        const flags = ["-I", "-sS", "--connect-timeout", "4", "--max-time", String(args.timeoutSec)];
        if (args.followRedirects) flags.push("-L"); if (args.insecure) flags.push("-k");
        flags.push(args.url);
        return captureCommand("ba-curl-head", ["curl"], `curl ${flags.map(shellQuote).join(" ")}`);
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => `Cabeceras de ${args.url}`, () => `No se pudo consultar ${args.url}`); },
    },

    "web.curl.fetch_text": {
      name: "web.curl.fetch_text", label: "Descargar texto con curl", riskLevel: 2, category: "web.http",
      requiresVm: true, requiresTmux: true, timeoutMs: 18000, maxOutputBytes: 32768,
      description: "Descarga una URL con curl con límite estricto de bytes.",
      promptDescription: "Descargar texto HTTP limitado. Argumentos: {\"url\":\"https://example.com\",\"maxBytes\":8192}.",
      normalizeArgs(args = {}) { return { url: normalizeUrl(args.url || args.target), followRedirects: normalizeBool(args.followRedirects, true), insecure: normalizeBool(args.insecure, true), timeoutSec: clampInt(args.timeoutSec, 3, 25, 10), maxBytes: clampInt(args.maxBytes, 512, 32768, 8192) }; },
      buildCommand(args) {
        const flags = ["-sS", "--connect-timeout", "4", "--max-time", String(args.timeoutSec)];
        if (args.followRedirects) flags.push("-L"); if (args.insecure) flags.push("-k");
        flags.push(args.url);
        return captureCommand("ba-curl-fetch", ["curl", "head"], `curl ${flags.map(shellQuote).join(" ")} | head -c ${args.maxBytes}`);
      },
      formatResult(result, args) { return standardFormat(this, result, args, () => `Contenido de ${args.url}`, () => `No se pudo descargar ${args.url}`); },
    },

    "net.dns.lookup": {
      name: "net.dns.lookup", label: "Consulta DNS", riskLevel: 2, category: "net.dns",
      requiresVm: true, requiresTmux: true, timeoutMs: 10000, maxOutputBytes: 16000,
      description: "Consulta DNS con dig usando timeouts bajos.",
      promptDescription: "Resolver DNS. Argumentos: {\"host\":\"example.com\",\"type\":\"A\"}.",
      normalizeArgs(args = {}) { return { host: normalizeHost(args.host || args.domain || args.target), type: normalizeDnsType(args.type) }; },
      buildCommand(args) { return captureCommand("ba-dns", ["dig"], `dig +time=3 +tries=1 ${shellQuote(args.type)} ${shellQuote(args.host)}; printf '\\n--- short ---\\n'; dig +short +time=3 +tries=1 ${shellQuote(args.type)} ${shellQuote(args.host)}`); },
      formatResult(result, args) { return standardFormat(this, result, args, () => `DNS ${args.type} de ${args.host}`, () => `No se pudo resolver ${args.host}`); },
    },

    "net.ip.status": {
      name: "net.ip.status", label: "Estado de red VM", riskLevel: 1, category: "net.local",
      requiresVm: true, requiresTmux: true, timeoutMs: 10000, maxOutputBytes: 24000,
      description: "Muestra direcciones, rutas y sockets de la VM con ip/ss.",
      promptDescription: "Estado local de red. Argumentos: {}.",
      normalizeArgs() { return {}; },
      buildCommand() { return captureCommand("ba-ip-status", ["ip"], "ip addr show; printf '\\n--- route ---\\n'; ip route show; printf '\\n--- sockets ---\\n'; ss -tuna 2>/dev/null | sed -n '1,80p' || true"); },
      formatResult(result) { return standardFormat(this, result, {}, () => "Estado de red VM", () => "No se pudo obtener estado de red"); },
    },

    "net.nmap.quick": {
      name: "net.nmap.quick", label: "Nmap rápido y prudente", riskLevel: 3, category: "net.scan",
      requiresVm: true, requiresTmux: true, timeoutMs: 70000, maxOutputBytes: 32768,
      description: "Escaneo nmap acotado para objetivos autorizados. Baja concurrencia y host-timeout.",
      promptDescription: "Escaneo nmap ligero. Argumentos: {\"target\":\"192.168.1.10\",\"topPorts\":30}.",
      normalizeArgs(args = {}) { return { target: normalizeHost(args.target || args.host), topPorts: clampInt(args.topPorts || args.ports, 10, 100, 30) }; },
      buildCommand(args) { return captureCommand("ba-nmap-quick", ["nmap"], `nmap -Pn -sT -T2 --max-retries 1 --host-timeout 55s --top-ports ${args.topPorts} ${shellQuote(args.target)}`); },
      formatResult(result, args) { return standardFormat(this, result, args, () => `Nmap rápido sobre ${args.target}`, () => `Nmap falló sobre ${args.target}`); },
    },

    "web.ffuf.dir_light": {
      name: "web.ffuf.dir_light", label: "FFUF directorios ligero", riskLevel: 3, category: "web.fuzz",
      requiresVm: true, requiresTmux: true, timeoutMs: 70000, maxOutputBytes: 32768,
      description: "Fuzzing web ligero con ffuf. Requiere autorización del objetivo.",
      promptDescription: "Fuzzing ligero de rutas. Argumentos: {\"url\":\"http://host/FUZZ\",\"wordlist\":\"quickhits\",\"threads\":3,\"rate\":20,\"maxTimeSec\":45}.",
      normalizeArgs(args = {}) {
        let url = normalizeUrl(args.url || args.target);
        if (!url.includes("FUZZ")) url = url.replace(/\/?$/, "/FUZZ");
        return { url, wordlist: normalizeWordlist(args.wordlist || "quickhits"), threads: clampInt(args.threads, 1, 8, 3), rate: clampInt(args.rate, 1, 50, 20), maxTimeSec: clampInt(args.maxTimeSec, 10, 60, 35) };
      },
      buildCommand(args) { return captureCommand("ba-ffuf-light", ["ffuf"], `ffuf -u ${shellQuote(args.url)} -w ${shellQuote(args.wordlist)} -t ${args.threads} -rate ${args.rate} -maxtime ${args.maxTimeSec} -ac -noninteractive 2>&1 | sed -n '1,160p'`); },
      formatResult(result, args) { return standardFormat(this, result, args, () => `FFUF ligero sobre ${args.url}`, () => `FFUF falló sobre ${args.url}`); },
    },

    "vm.python.exec": {
      name: "vm.python.exec", label: "Ejecutar Python acotado", riskLevel: 3, category: "vm.exec",
      requiresVm: true, requiresTmux: true, timeoutMs: 25000, maxOutputBytes: 32768,
      description: "Ejecuta un fragmento Python corto dentro de la VM. Confirmación recomendada.",
      promptDescription: "Ejecutar Python corto. Argumentos: {\"code\":\"print('hi')\"}.",
      normalizeArgs(args = {}) {
        const code = String(args.code || "").trim();
        if (!code) throw new Error("El código Python no puede estar vacío.");
        if (code.length > 2500) throw new Error("Código Python demasiado largo.");
        return { code };
      },
      buildCommand(args) { return captureCommand("ba-python", ["python3"], `python3 -c ${shellQuote(args.code)}`); },
      formatResult(result) { return standardFormat(this, result, {}, () => "Python ejecutado", () => "Python falló"); },
    },

    "web.httpx.probe": {
      name: "web.httpx.probe", label: "HTTPX fingerprint prudente", riskLevel: 3, category: "web.http",
      requiresVm: true, requiresTmux: true, timeoutMs: 45000, maxOutputBytes: 24000,
      description: "Fingerprint HTTP con ProjectDiscovery httpx usando threads/rate bajos.",
      promptDescription: "Probar HTTPX. Argumentos: {\"url\":\"https://example.com\",\"rate\":10,\"threads\":2}.",
      normalizeArgs(args = {}) { return { url: normalizeUrl(args.url || args.target), rate: clampInt(args.rate, 1, 30, 10), threads: clampInt(args.threads, 1, 5, 2), timeoutSec: clampInt(args.timeoutSec, 3, 12, 6) }; },
      buildCommand(args) { return captureCommand("ba-httpx", ["httpx"], `printf '%s\\n' ${shellQuote(args.url)} | httpx -silent -status-code -title -tech-detect -follow-redirects -threads ${args.threads} -rate-limit ${args.rate} -timeout ${args.timeoutSec} -retries 0 2>&1 | sed -n '1,120p'`); },
      formatResult(result, args) { return standardFormat(this, result, args, () => `HTTPX sobre ${args.url}`, () => `HTTPX falló sobre ${args.url}`); },
    },

    "web.nikto.quick": {
      name: "web.nikto.quick", label: "Nikto rápido", riskLevel: 3, category: "web.scan",
      requiresVm: true, requiresTmux: true, timeoutMs: 80000, maxOutputBytes: 32768,
      description: "Nikto acotado con maxtime para comprobaciones web autorizadas.",
      promptDescription: "Nikto rápido. Argumentos: {\"url\":\"https://example.com\",\"maxTimeSec\":45}.",
      normalizeArgs(args = {}) { return { url: normalizeUrl(args.url || args.target), maxTimeSec: clampInt(args.maxTimeSec, 15, 70, 40) }; },
      buildCommand(args) { return captureCommand("ba-nikto", ["nikto"], `nikto -h ${shellQuote(args.url)} -nointeractive -maxtime ${args.maxTimeSec}s 2>&1 | sed -n '1,180p'`); },
      formatResult(result, args) { return standardFormat(this, result, args, () => `Nikto sobre ${args.url}`, () => `Nikto falló sobre ${args.url}`); },
    },

    "tls.openssl.cert": {
      name: "tls.openssl.cert", label: "Certificado TLS con OpenSSL", riskLevel: 2, category: "tls",
      requiresVm: true, requiresTmux: true, timeoutMs: 18000, maxOutputBytes: 16000,
      description: "Obtiene datos básicos del certificado TLS de un host.",
      promptDescription: "Ver certificado TLS. Argumentos: {\"host\":\"example.com\",\"port\":443}.",
      normalizeArgs(args = {}) { return { host: normalizeHost(args.host || args.target), port: clampInt(args.port, 1, 65535, 443) }; },
      buildCommand(args) { return captureCommand("ba-openssl-cert", ["openssl"], `echo | openssl s_client -servername ${shellQuote(args.host)} -connect ${shellQuote(`${args.host}:${args.port}`)} 2>/dev/null | openssl x509 -noout -subject -issuer -dates -fingerprint -sha256`); },
      formatResult(result, args) { return standardFormat(this, result, args, () => `Certificado TLS de ${args.host}:${args.port}`, () => `No se pudo obtener certificado TLS de ${args.host}:${args.port}`); },
    },

    "vm.sh.exec": {
      name: "vm.sh.exec", label: "Ejecutar comando sh en la VM", riskLevel: 3, category: "vm.exec",
      requiresVm: true, requiresTmux: true, timeoutMs: 30000, maxOutputBytes: 32768,
      description: "Ejecuta un comando /bin/sh -lc dentro de la VM con timeout y salida limitada. Confirmación recomendada siempre.",
      promptDescription: "Ejecutar comando sh arbitrario. Argumentos: {\"command\":\"uname -a\",\"timeoutMs\":10000,\"maxOutputBytes\":8192}. Usar solo si no existe una tool específica.",
      normalizeArgs(args = {}) { return { command: normalizeShellCommand(args.command || args.cmd), timeoutMs: clampInt(args.timeoutMs, 1000, 30000, 10000), maxOutputBytes: clampInt(args.maxOutputBytes, 512, 32768, 8192) }; },
      buildCommand(args) { return captureCommand("ba-sh-exec", ["sh"], `sh -lc ${shellQuote(args.command)}`); },
      formatResult(result, args) {
        const oldMax = this.maxOutputBytes; this.maxOutputBytes = args.maxOutputBytes;
        const formatted = standardFormat(this, result, args, () => `Comando sh ejecutado`, () => `Comando sh fallido`);
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
        requiresTmux: tool.requiresTmux,
        timeoutMs: tool.timeoutMs,
      }));
  }

  function buildPromptToolCatalog() {
    return listTools().map((tool) => [
      `- ${tool.name}`,
      `  Nivel seguridad: ${tool.riskLevel}`,
      `  Uso: ${tool.promptDescription}`,
      `  Requisitos: ${tool.requiresVm ? "VM arrancada" : "sin VM"}${tool.requiresTmux ? ", tmux usuario + serial1/ttyS1 activo" : ""}`,
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
      : "ninguna";
    return [
      `Runtime: VM=${vm} serial1=${serial1} perfil=${ctx.activeProfile || "manual"} red=${ctx.networkConfigured ? "sí" : "no"}`,
      `Herramientas activas (${enabled.length}): ${toolsLine}`,
    ].join("\n");
  }

  function buildPromptRuntimeContext() {
    const ctx = baseRuntimeContext();
    return [
      "Contexto runtime actual:",
      `- VM arrancada: ${ctx.vmPresent ? "sí" : "no"}`,
      `- Shell VM lista: ${ctx.vmReady ? "sí" : "no"}`,
      `- tmux usuario listo: ${ctx.tmuxReady ? "sí" : "no"}`,
      `- serial1/ttyS1 herramientas listas: ${ctx.toolsConsoleAvailable ? "sí" : "no"}`,
      `- Perfil activo/seleccionado: ${ctx.activeProfile || "manual"}`,
      `- Red VM configurada: ${ctx.networkConfigured ? "sí" : "no"}`,
      `- Disco montado: ${ctx.diskMounted ? "sí" : "no"}`,
      `- VM serial0: ${ctx.pendingCommand || ctx.agentBusy ? "ocupada" : "libre"} · serial1 herramientas: ${ctx.backgroundToolBusy ? "ocupado" : "libre"}`,
      "Herramientas disponibles para este perfil:",
      buildPromptToolCatalog(),
    ].join("\n");
  }

  function normalizeToolCall(value) {
    if (!value || typeof value !== "object") throw new Error("La respuesta de tool no es un objeto JSON.");
    const toolName = value.tool || value.name;
    if (value.type && value.type !== "tool_call") {
      throw new Error(`Tipo de invocación no soportado: ${value.type}`);
    }
    const tool = getTool(toolName);
    if (!tool) throw new Error(`Herramienta no disponible: ${toolName || "(vacía)"}`);
    if (!isToolEnabledForProfile(tool)) {
      const ctx = baseRuntimeContext();
      throw new Error(`La tool ${tool.name} no está habilitada para el perfil activo ${ctx.activeProfile}.`);
    }
    const args = tool.normalizeArgs ? tool.normalizeArgs(value.arguments || {}) : (value.arguments || {});
    return { type: "tool_call", tool: tool.name, arguments: args, reason: String(value.reason || "El modelo solicita ejecutar una herramienta.").slice(0, 400), riskLevel: tool.riskLevel };
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
