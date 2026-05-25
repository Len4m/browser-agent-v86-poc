// @ts-nocheck
// Browser Agent v86 - 08 checks
// Split from app.js in v9.35. Load order is defined in index.html.

function formatCheckBadgeText(ok, detail = "") {
  if (ok) return "OK";
  const clean = String(detail || "").trim();
  if (!clean) return "FAIL";
  if (clean.length > 28 || /[;$(){}|<>]/.test(clean)) return "FAIL";
  if (/%s|\\n|printf|IFACE=\$|PFX=/.test(clean)) return "FAIL";
  return clean;
}

function addCheck(container, name, ok, detail = "") {
  const row = document.createElement("div");
  row.className = "check";
  const label = document.createElement("span");
  label.textContent = name;
  const badge = document.createElement("span");
  badge.className = `badge ${ok ? "good" : "bad"}`;
  badge.textContent = formatCheckBadgeText(ok, detail);
  badge.title = detail;
  row.append(label, badge);
  container.appendChild(row);
  return ok;
}

function addSkippedCheck(container, name, detail = "") {
  const row = document.createElement("div");
  row.className = "check";
  const label = document.createElement("span");
  label.textContent = name;
  const badge = document.createElement("span");
  badge.className = "badge warn";
  badge.textContent = "omitido";
  badge.title = detail;
  row.append(label, badge);
  container.appendChild(row);
}

function updateChecksSummaryFromDom() {
  const container = $("checks");
  const summary = $("checks-summary");
  if (!container || !summary) return;

  const badges = Array.from(container.querySelectorAll(".check .badge"));
  const counted = badges.filter((badge) => !badge.classList.contains("warn"));
  const okCount = counted.filter((badge) => badge.classList.contains("good")).length;
  const total = counted.length;
  const hasBad = counted.some((badge) => badge.classList.contains("bad"));

  if (!total) {
    setBadge(summary, "—", "");
    return;
  }

  setBadge(summary, `${okCount}/${total}`, hasBad || okCount !== total ? "warn" : "good");
}

function cleanVmCheckLines(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[ba-s1\]\s+(start|end)\b/.test(line))
    .filter((line) => !/^BA_SERIAL1_/.test(line));
}

function firstMatchingVmCheckLine(text, predicate) {
  return cleanVmCheckLines(text).find(predicate) || "";
}

function getVmCommandCheckSkipReason() {
  if (!state.vm) return "VM no arrancada";
  if (!state.vmReady) return "esperando shell";
  if (state.snapshotRestoring) return "restaurando snapshot";
  if (state.vmStarting) return "VM arrancando";
  if (state.pending) return "hay una operación serial0 en ejecución";
  if (state.bgTools?.pending) return "hay una herramienta en segundo plano en ejecución";
  if (state.agentBusy) return "VM ocupada";
  const diag = window.BA_BG_TOOLS?.diagnostics?.();
  if (diag && !diag.serial1Available) return "serial1 no disponible";
  if (diag && !diag.runnerReady) return "runner serial1 no preparado";
  return "";
}

function getExpectedToolChecks(profile) {
  const packages = new Set(profile?.packages || []);
  const checks = [];

  const addTool = (label, test) => {
    if (!checks.some((item) => item.label === label)) checks.push({ label, test });
  };

  if (packages.has("curl")) addTool("curl", "command -v curl");
  if (packages.has("nano")) addTool("nano", "command -v nano");
  if (packages.has("nmap")) addTool("nmap", "command -v nmap");
  if (packages.has("ffuf")) addTool("ffuf", "command -v ffuf");
  if (packages.has("python3")) addTool("python3", "command -v python3");
  if (packages.has("py3-pip")) addTool("pip", "command -v pip3 || command -v pip");
  if (packages.has("bind-tools")) addTool("dig", "command -v dig");
  if (packages.has("iproute2")) addTool("ip", "command -v ip");
  if (packages.has("nikto")) addTool("nikto", "command -v nikto || command -v nikto.pl || [ -f /usr/share/nikto/program/nikto.pl ] || [ -f /usr/bin/nikto.pl ]");
  if (packages.has("httpx")) addTool("httpx", "command -v httpx || command -v httpx-pd || command -v httpx-toolkit || ls /usr/bin/httpx* /usr/local/bin/httpx* >/dev/null 2>&1");

  if (packages.has("perl-net-ssleay")) {
    addTool("Net::SSLeay", "perl -MNet::SSLeay -e 1");
  }
  if (packages.has("perl-io-socket-ssl")) {
    addTool("IO::Socket::SSL", "perl -MIO::Socket::SSL -e 1");
  }

  return checks;
}

function makePackageCheckCommand(packages) {
  const list = (packages || []).map(shellQuote).join(" ");
  if (!list) return "P=BA_PKG; echo ${P}_OK";
  return `P=BA_PKG; missing=""; for p in ${list}; do apk info -e "$p" >/dev/null 2>&1 || missing="$missing $p"; done; if [ -n "$missing" ]; then echo "\${P}_MISSING:$missing"; exit 1; else echo "\${P}_OK"; fi`;
}

function makeToolCheckCommand(toolChecks) {
  if (!toolChecks.length) return "P=BA_TOOLS; echo ${P}_OK";
  const tests = toolChecks.map((item) => `(${item.test}) >/dev/null 2>&1 || missing="$missing ${item.label}"`).join("; ");
  return `P=BA_TOOLS; missing=""; ${tests}; if [ -n "$missing" ]; then echo "\${P}_MISSING:$missing"; exit 1; else echo "\${P}_OK"; fi`;
}

async function runVmCheck(command, { label = "Check usando la VM…", timeoutMs = 12000 } = {}) {
  return execVm(command, {
    lock: true,
    label,
    timeoutMs,
    log: false,
    targetTools: true,
  });
}

async function runChecks({ probeWsRelay = true } = {}) {
  if (state.checksRunning) return;
  state.checksRunning = true;
  syncChecksButton();
  setBadge($("checks-summary"), "comprobando", "warn");
  try {

    const container = $("checks");
    container.textContent = "";
    let okCount = 0;
    let total = 0;
    const add = (name, ok, detail = "") => {
      total += 1;
      if (addCheck(container, name, ok, detail)) okCount += 1;
    };

    add("WebGPU", Boolean(navigator.gpu), navigator.gpu ? "OK" : "No detectado");
    add("WebSocket API", Boolean(window.WebSocket), window.WebSocket ? "OK" : "No disponible");

    const wsRelayUrl = getWsRelayUrl();
    if (probeWsRelay) {
      const wsRelayCheck = await checkWsRelayEndpoint(wsRelayUrl);
      add("wsnic relay disponible", wsRelayCheck.ok, `${wsRelayUrl} · ${wsRelayCheck.detail}`);
    } else {
      addSkippedCheck(container, "wsnic relay disponible", `${wsRelayUrl} · comprobación omitida hasta que pulses Conectar o Comprobaciones`);
    }

    const wsConnected = isWsConnected();
    const wsConfigured = Boolean(state.networkConfigured);
    add(
      "Red WS conectada",
      wsConnected && wsConfigured,
      wsConnected
        ? (wsConfigured ? "conectada + VM configurada" : "conectada, VM sin configurar")
        : "no conectado desde la web"
    );

    add("COOP/COEP", Boolean(window.crossOriginIsolated), window.crossOriginIsolated ? "OK" : "No aislado");

    const runtime = getVmRuntimeConfig();
    add("RAM seleccionada", runtime.ramMb >= 256, `${runtime.ramMb} MB`);

    if (runtime.hda) {
      const diskResult = await checkAsset(runtime.hda.url);
      add("Disco hda fichero", diskResult.ok, diskResult.ok ? runtime.hda.url : `${runtime.hda.url} · ${diskResult.detail}`);
    } else {
      add("Disco VM", true, "initramfs/RAM");
    }

    const diskUrls = [
      "/v86/disks/alpine-hda-250m.img",
      "/v86/disks/alpine-hda-512m.img",
      "/v86/disks/alpine-hda-1g.img",
    ];
    let diskOk = 0;
    for (const url of diskUrls) {
      const result = await checkAsset(url);
      if (result.ok) diskOk += 1;
    }
    add("Discos hda disponibles", diskOk === diskUrls.length, `${diskOk}/${diskUrls.length}`);

    const cfg = getConfig();
    const profile = getSelectedProfile();
    if (profile) add("Perfil seleccionado", true, `${profile.name || profile.id} · ${profile.output}`);
    else add("Perfil seleccionado", true, "Libre / manual");

    const assets = [
      ["libv86.js", cfg.libv86],
      ["v86.wasm", cfg.wasm],
      ["BIOS", cfg.bios],
      ["VGA BIOS", cfg.vgaBios],
      ["Alpine vmlinuz", cfg.bzimage],
      ...(cfg.initrd ? [["Alpine initramfs", cfg.initrd]] : []),
    ];

    for (const [name, url] of assets) {
      const result = await checkAsset(url);
      add(name, result.ok, result.ok ? url : `${url} · ${result.detail}`);
    }

    try {
      if (!window.V86Starter && !window.V86) await loadScript(cfg.libv86);
      add("V86Starter", Boolean(window.V86Starter || window.V86), "No cargado");
    } catch (error) {
      add("V86Starter", false, error.message);
    }

    add("VM arrancada", Boolean(state.vm), state.vm ? "OK" : "Pendiente");
    add("Serial0 API", Boolean(state.vm?.serial0_send), state.vm?.serial0_send ? "OK" : "Pendiente");
    const bgDiagBeforeWait = window.BA_BG_TOOLS?.diagnostics?.() || null;
    add("Serial1 API", Boolean(bgDiagBeforeWait?.serial1Available), bgDiagBeforeWait?.serial1Available ? "OK" : "Pendiente");
    if (state.vm && state.vmReady && bgDiagBeforeWait?.serial1Available && !bgDiagBeforeWait?.runnerReady) {
      await window.BA_BG_TOOLS?.waitForRunnerReady?.(1500);
    }
    const bgDiag = window.BA_BG_TOOLS?.diagnostics?.() || null;
    add("Runner serial1", Boolean(bgDiag?.runnerReady), bgDiag?.runnerReady ? "ba-serial1-runner listo" : (bgDiag?.lastError || "no preparado"));
    add("Snapshot API", Boolean(state.vm?.save_state && state.vm?.restore_state), state.vm ? "save_state/restore_state" : "Pendiente");

    const vmSkipReason = getVmCommandCheckSkipReason();

    if (vmSkipReason) {
      addSkippedCheck(container, "Checks dentro VM", vmSkipReason);
    } else {
      const result = await runVmCheck("echo browser-agent-ok", { label: "Check básico de VM…", timeoutMs: 8000 });
      add("Comando VM real", result.code === 0 && result.stdout.includes("browser-agent-ok"), result.stderr || "OK");

      const profileIdResult = await runVmCheck("cat /etc/browser-agent-profile-id 2>/dev/null || echo unknown", {
        label: "Comprobando perfil dentro de la VM…",
        timeoutMs: 8000,
      });
      const vmProfileId = profile
        ? firstMatchingVmCheckLine(profileIdResult.stdout, (line) => line === profile.id) || lastNonEmptyLine(profileIdResult.stdout)
        : firstMatchingVmCheckLine(profileIdResult.stdout, (line) => line && line !== "unknown") || lastNonEmptyLine(profileIdResult.stdout);
      const profileOk = profile ? vmProfileId === profile.id : Boolean(vmProfileId && vmProfileId !== "unknown");
      add("Perfil dentro VM", profileOk, profile ? `${vmProfileId || "sin dato"} / esperado: ${profile.id}` : vmProfileId || "sin dato");

      if (profile) {
        const pkgResult = await runVmCheck(makePackageCheckCommand(profile.packages || []), {
          label: "Comprobando paquetes del perfil…",
          timeoutMs: 18000,
        });
        const clean = normalizeTerminalStreamForMarkers(pkgResult.stdout);
        const missingPackages = clean.match(/BA_PKG_MISSING:([^\n\r]*)/)?.[1]?.trim();
        add("Paquetes perfil VM", pkgResult.code === 0, missingPackages ? `faltan: ${missingPackages}` : pkgResult.stderr || "OK");
      } else {
        add("Paquetes perfil VM", true, "modo manual");
      }

      if (profile) {
        const toolChecks = getExpectedToolChecks(profile);
        const toolResult = await runVmCheck(makeToolCheckCommand(toolChecks), {
          label: "Comprobando tools del perfil…",
          timeoutMs: 18000,
        });
        const clean = normalizeTerminalStreamForMarkers(toolResult.stdout);
        const missingTools = clean.match(/BA_TOOLS_MISSING:([^\n\r]*)/)?.[1]?.trim();
        add("Herramientas perfil VM", toolResult.code === 0, missingTools ? `faltan: ${missingTools}` : toolResult.stderr || `${toolChecks.length} comprobaciones`);
      } else {
        add("Herramientas perfil VM", true, "modo manual");
      }

      const netCommand = "PFX=BA_VM_NET; IFACE=$(ls /sys/class/net | grep -v '^lo$' | head -n1); if [ -z \"$IFACE\" ]; then echo ${PFX}_NO_IFACE; exit 1; fi; printf '%s_IFACE:%s\\n' \"$PFX\" \"$IFACE\"; if ! ip -4 addr show \"$IFACE\" | grep -q 'inet '; then echo ${PFX}_NO_IPV4; exit 2; fi; if wget -q -T 5 -O /tmp/ba-net-check http://www.google.com/generate_204; then echo ${PFX}_HTTP_OK; else ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1 && echo ${PFX}_PING_OK || { echo ${PFX}_FAIL; exit 3; }; fi";
      const netResult = await runVmCheck(netCommand, {
        label: "Comprobando red dentro de la VM…",
        timeoutMs: 15000,
      });
      const netClean = normalizeTerminalStreamForMarkers(netResult.stdout);
      const netOk = netResult.code === 0 && (netClean.includes("BA_VM_NET_HTTP_OK") || netClean.includes("BA_VM_NET_PING_OK"));
      const iface = netClean.match(/BA_VM_NET_IFACE:([^\s\r\n]+)/)?.[1] || "";
      let netDetail = iface ? `IFACE=${iface}` : "";
      if (!netDetail && netClean.includes("BA_VM_NET_NO_IFACE")) netDetail = "sin interfaz";
      if (!netDetail && netClean.includes("BA_VM_NET_NO_IPV4")) netDetail = "sin IPv4";
      if (!netDetail && netClean.includes("BA_VM_NET_FAIL")) netDetail = "sin salida";
      if (!netDetail) netDetail = netResult.stderr || (netOk ? "OK" : "sin conexión");
      add("Red dentro VM", netOk, netDetail);

      if (runtime.hda && state.diskMounted) {
        const diskVmCommand = "if mountpoint -q /mnt/hda; then echo DISK_MOUNTED; echo browser-agent-disk-check > /mnt/hda/.ba-check && sync && rm -f /mnt/hda/.ba-check && echo DISK_RW_OK || { echo DISK_RW_FAIL; exit 1; }; else echo DISK_NOT_MOUNTED; exit 2; fi";
        const diskVmResult = await runVmCheck(diskVmCommand, {
          label: "Comprobando disco montado…",
          timeoutMs: 12000,
        });
        const diskClean = normalizeTerminalStreamForMarkers(diskVmResult.stdout);
        add("Disco hda RW en VM", diskVmResult.code === 0 && diskClean.includes("DISK_RW_OK"), diskClean.match(/DISK_[A-Z_]+/)?.[0] || diskVmResult.stderr || "OK");
      } else if (runtime.hda) {
        add("Disco hda RW en VM", false, "no montado");
      }
    }

    updateChecksSummaryFromDom();

    // El retorno visual a Consola 1 se hace en finally, también si algún
    // check lanza una excepción.
  } catch (error) {
    const message = error?.message || String(error);
    logTool(`${NL}[checks] aviso/error durante la comprobación: ${message}${NL}`);

    // No dejamos la cabecera en "error" sin una fila visible que lo explique.
    // Si una comprobación lanza una excepción, la convertimos en una fila roja
    // y el resumen se recalcula desde el DOM en el finally.
    const container = $("checks");
    if (container) addCheck(container, "Error ejecución Checks", false, message);
  } finally {
    updateChecksSummaryFromDom();

    const summary = $("checks-summary");
    if (summary?.textContent === "comprobando") {
      setBadge(summary, "finalizado", "warn");
    }

    state.checksRunning = false;
    syncChecksButton();
  }
}
