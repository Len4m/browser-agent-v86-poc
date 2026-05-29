// @ts-nocheck
// Browser Agent v86 - 08 checks
// Split from app.js in v9.35. Load order is defined in index.html.

function formatCheckBadgeText(ok, detail = "") {
  if (ok) return t("checks.badge.ok", "OK");
  const clean = String(detail || "").trim();
  if (!clean) return t("checks.badge.fail", "FAIL");
  if (clean.length > 28 || /[;$(){}|<>]/.test(clean)) return t("checks.badge.fail", "FAIL");
  if (/%s|\\n|printf|IFACE=\$|PFX=/.test(clean)) return t("checks.badge.fail", "FAIL");
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
  badge.textContent = t("checks.badge.skipped", "omitido");
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
  if (!state.vm) return t("checks.skip.vmNotStarted", "VM no arrancada");
  if (!state.vmReady) return t("checks.skip.waitingShell", "esperando shell");
  if (state.snapshotRestoring) return t("checks.skip.restoringSnapshot", "restaurando snapshot");
  if (state.vmStarting) return t("checks.skip.vmStarting", "VM arrancando");
  if (state.pending) return t("checks.skip.serial0Busy", "hay una operación serial0 en ejecución");
  if (state.bgTools?.pending) return t("checks.skip.bgToolBusy", "hay una herramienta en segundo plano en ejecución");
  if (state.agentBusy) return t("checks.skip.vmBusy", "VM ocupada");
  const diag = window.BA_BG_TOOLS?.diagnostics?.();
  if (diag && !diag.serial1Available) return t("checks.skip.serial1Unavailable", "serial1 no disponible");
  if (diag && !diag.runnerReady) return t("checks.skip.runnerNotReady", "runner serial1 no preparado");
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

async function runVmCheck(command, { label = t("checks.label.vmCheck", "Check usando la VM…"), timeoutMs = 12000 } = {}) {
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
  setBadge($("checks-summary"), t("checks.badge.checking", "comprobando"), "warn");
  try {

    const container = $("checks");
    container.textContent = "";
    let okCount = 0;
    let total = 0;
    const add = (name, ok, detail = "") => {
      total += 1;
      if (addCheck(container, name, ok, detail)) okCount += 1;
    };

    add(t("checks.item.webgpu", "WebGPU"), Boolean(navigator.gpu), navigator.gpu ? t("checks.badge.ok", "OK") : t("checks.detail.notDetected", "No detectado"));
    add(t("checks.item.websocketApi", "WebSocket API"), Boolean(window.WebSocket), window.WebSocket ? t("checks.badge.ok", "OK") : t("checks.detail.notAvailable", "No disponible"));

    const wsRelayUrl = getWsRelayUrl();
    if (probeWsRelay) {
      const wsRelayCheck = await checkWsRelayEndpoint(wsRelayUrl);
      add(t("checks.item.wsnicRelay", "wsnic relay disponible"), wsRelayCheck.ok, `${wsRelayUrl} · ${wsRelayCheck.detail}`);
    } else {
      addSkippedCheck(container, t("checks.item.wsnicRelay", "wsnic relay disponible"), t("checks.detail.relaySkipped", "{url} · comprobación omitida hasta que pulses Conectar o Comprobaciones", { url: wsRelayUrl }));
    }

    const wsConnected = isWsConnected();
    const wsConfigured = Boolean(state.networkConfigured);
    add(
      t("checks.item.wsNetwork", "Red WS conectada"),
      wsConnected && wsConfigured,
      wsConnected
        ? (wsConfigured ? t("checks.detail.connectedConfigured", "conectada + VM configurada") : t("checks.detail.connectedUnconfigured", "conectada, VM sin configurar"))
        : t("checks.detail.notConnectedWeb", "no conectado desde la web")
    );

    add(t("checks.item.coopCoep", "COOP/COEP"), Boolean(window.crossOriginIsolated), window.crossOriginIsolated ? t("checks.badge.ok", "OK") : t("checks.detail.notIsolated", "No aislado"));

    const runtime = getVmRuntimeConfig();
    add(t("checks.item.ram", "RAM seleccionada"), runtime.ramMb >= 256, `${runtime.ramMb} MB`);

    if (runtime.hda) {
      const diskResult = await checkAsset(runtime.hda.url);
      add(t("checks.item.hdaFile", "Disco hda fichero"), diskResult.ok, diskResult.ok ? runtime.hda.url : `${runtime.hda.url} · ${diskResult.detail}`);
    } else {
      add(t("checks.item.vmDisk", "Disco VM"), true, "initramfs/RAM");
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
    add(t("checks.item.hdaDisks", "Discos hda disponibles"), diskOk === diskUrls.length, `${diskOk}/${diskUrls.length}`);

    const cfg = getConfig();
    const profile = getSelectedProfile();
    if (profile) add(t("checks.item.profileSelected", "Perfil seleccionado"), true, `${profile.name || profile.id} · ${profile.output}`);
    else add(t("checks.item.profileSelected", "Perfil seleccionado"), true, t("checks.detail.freeManual", "Libre / manual"));

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
      add(t("checks.item.v86starter", "V86Starter"), Boolean(window.V86Starter || window.V86), t("checks.detail.notLoaded", "No cargado"));
    } catch (error) {
      add(t("checks.item.v86starter", "V86Starter"), false, error.message);
    }

    add(t("checks.item.vmStarted", "VM arrancada"), Boolean(state.vm), state.vm ? t("checks.badge.ok", "OK") : t("checks.detail.pending", "Pendiente"));
    add(t("checks.item.serial0Api", "Serial0 API"), Boolean(state.vm?.serial0_send), state.vm?.serial0_send ? t("checks.badge.ok", "OK") : t("checks.detail.pending", "Pendiente"));
    const bgDiagBeforeWait = window.BA_BG_TOOLS?.diagnostics?.() || null;
    add(t("checks.item.serial1Api", "Serial1 API"), Boolean(bgDiagBeforeWait?.serial1Available), bgDiagBeforeWait?.serial1Available ? t("checks.badge.ok", "OK") : t("checks.detail.pending", "Pendiente"));
    if (state.vm && state.vmReady && bgDiagBeforeWait?.serial1Available && !bgDiagBeforeWait?.runnerReady) {
      await window.BA_BG_TOOLS?.waitForRunnerReady?.(1500);
    }
    const bgDiag = window.BA_BG_TOOLS?.diagnostics?.() || null;
    add(t("checks.item.runnerSerial1", "Runner serial1"), Boolean(bgDiag?.runnerReady), bgDiag?.runnerReady ? t("checks.detail.runnerReady", "ba-serial1-runner listo") : (bgDiag?.lastError || t("checks.detail.notReady", "no preparado")));
    add(t("checks.item.snapshotApi", "Snapshot API"), Boolean(state.vm?.save_state && state.vm?.restore_state), state.vm ? "save_state/restore_state" : t("checks.detail.pending", "Pendiente"));

    const vmSkipReason = getVmCommandCheckSkipReason();

    if (vmSkipReason) {
      addSkippedCheck(container, t("checks.item.vmChecks", "Checks dentro VM"), vmSkipReason);
    } else {
      const result = await runVmCheck("echo browser-agent-ok", { label: t("checks.label.vmBasic", "Check básico de VM…"), timeoutMs: 8000 });
      add(t("checks.item.vmCommand", "Comando VM real"), result.code === 0 && result.stdout.includes("browser-agent-ok"), result.stderr || t("checks.badge.ok", "OK"));

      const profileIdResult = await runVmCheck("cat /etc/browser-agent-profile-id 2>/dev/null || echo unknown", {
        label: t("checks.label.checkingProfile", "Comprobando perfil dentro de la VM…"),
        timeoutMs: 8000,
      });
      const vmProfileId = profile
        ? firstMatchingVmCheckLine(profileIdResult.stdout, (line) => line === profile.id) || lastNonEmptyLine(profileIdResult.stdout)
        : firstMatchingVmCheckLine(profileIdResult.stdout, (line) => line && line !== "unknown") || lastNonEmptyLine(profileIdResult.stdout);
      const profileOk = profile ? vmProfileId === profile.id : Boolean(vmProfileId && vmProfileId !== "unknown");
      add(t("checks.item.profileInVm", "Perfil dentro VM"), profileOk, profile ? t("checks.detail.profileExpected", "{id} / esperado: {expected}", { id: vmProfileId || t("checks.detail.noData", "sin dato"), expected: profile.id }) : vmProfileId || t("checks.detail.noData", "sin dato"));

      if (profile) {
        const pkgResult = await runVmCheck(makePackageCheckCommand(profile.packages || []), {
          label: t("checks.label.checkingPackages", "Comprobando paquetes del perfil…"),
          timeoutMs: 18000,
        });
        const clean = normalizeTerminalStreamForMarkers(pkgResult.stdout);
        const missingPackages = clean.match(/BA_PKG_MISSING:([^\n\r]*)/)?.[1]?.trim();
        add(t("checks.item.vmPackages", "Paquetes perfil VM"), pkgResult.code === 0, missingPackages ? t("checks.detail.missing", "faltan: {list}", { list: missingPackages }) : pkgResult.stderr || t("checks.badge.ok", "OK"));
      } else {
        add(t("checks.item.vmPackages", "Paquetes perfil VM"), true, t("checks.detail.manualMode", "modo manual"));
      }

      if (profile) {
        const toolChecks = getExpectedToolChecks(profile);
        const toolResult = await runVmCheck(makeToolCheckCommand(toolChecks), {
          label: t("checks.label.checkingTools", "Comprobando tools del perfil…"),
          timeoutMs: 18000,
        });
        const clean = normalizeTerminalStreamForMarkers(toolResult.stdout);
        const missingTools = clean.match(/BA_TOOLS_MISSING:([^\n\r]*)/)?.[1]?.trim();
        add(t("checks.item.vmTools", "Herramientas perfil VM"), toolResult.code === 0, missingTools ? t("checks.detail.missing", "faltan: {list}", { list: missingTools }) : toolResult.stderr || tn("checks.detail.checksCount", toolChecks.length, "{count} comprobación", "{count} comprobaciones"));
      } else {
        add(t("checks.item.vmTools", "Herramientas perfil VM"), true, t("checks.detail.manualMode", "modo manual"));
      }

      const netCommand = "PFX=BA_VM_NET; IFACE=$(ls /sys/class/net | grep -v '^lo$' | head -n1); if [ -z \"$IFACE\" ]; then echo ${PFX}_NO_IFACE; exit 1; fi; printf '%s_IFACE:%s\\n' \"$PFX\" \"$IFACE\"; if ! ip -4 addr show \"$IFACE\" | grep -q 'inet '; then echo ${PFX}_NO_IPV4; exit 2; fi; if wget -q -T 5 -O /tmp/ba-net-check http://www.google.com/generate_204; then echo ${PFX}_HTTP_OK; else ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1 && echo ${PFX}_PING_OK || { echo ${PFX}_FAIL; exit 3; }; fi";
      const netResult = await runVmCheck(netCommand, {
        label: t("checks.label.checkingNetwork", "Comprobando red dentro de la VM…"),
        timeoutMs: 15000,
      });
      const netClean = normalizeTerminalStreamForMarkers(netResult.stdout);
      const netOk = netResult.code === 0 && (netClean.includes("BA_VM_NET_HTTP_OK") || netClean.includes("BA_VM_NET_PING_OK"));
      const iface = netClean.match(/BA_VM_NET_IFACE:([^\s\r\n]+)/)?.[1] || "";
      let netDetail = iface ? `IFACE=${iface}` : "";
      if (!netDetail && netClean.includes("BA_VM_NET_NO_IFACE")) netDetail = t("checks.detail.noInterface", "sin interfaz");
      if (!netDetail && netClean.includes("BA_VM_NET_NO_IPV4")) netDetail = t("checks.detail.noIpv4", "sin IPv4");
      if (!netDetail && netClean.includes("BA_VM_NET_FAIL")) netDetail = t("checks.detail.noOutput", "sin salida");
      if (!netDetail) netDetail = netResult.stderr || (netOk ? t("checks.badge.ok", "OK") : t("checks.detail.noConnection", "sin conexión"));
      add(t("checks.item.vmNetwork", "Red dentro VM"), netOk, netDetail);

      if (runtime.hda && state.diskMounted) {
        const diskVmCommand = "if mountpoint -q /mnt/hda; then echo DISK_MOUNTED; echo browser-agent-disk-check > /mnt/hda/.ba-check && sync && rm -f /mnt/hda/.ba-check && echo DISK_RW_OK || { echo DISK_RW_FAIL; exit 1; }; else echo DISK_NOT_MOUNTED; exit 2; fi";
        const diskVmResult = await runVmCheck(diskVmCommand, {
          label: t("checks.label.checkingDisk", "Comprobando disco montado…"),
          timeoutMs: 12000,
        });
        const diskClean = normalizeTerminalStreamForMarkers(diskVmResult.stdout);
        add(t("checks.item.hdaRwInVm", "Disco hda RW en VM"), diskVmResult.code === 0 && diskClean.includes("DISK_RW_OK"), diskClean.match(/DISK_[A-Z_]+/)?.[0] || diskVmResult.stderr || t("checks.badge.ok", "OK"));
      } else if (runtime.hda) {
        add(t("checks.item.hdaRwInVm", "Disco hda RW en VM"), false, t("checks.detail.notMounted", "no montado"));
      }
    }

    updateChecksSummaryFromDom();

    // El retorno visual a la pestaña 1 se hace en finally, también si algún
    // check lanza una excepción.
  } catch (error) {
    const message = error?.message || String(error);
    logTool(`${NL}${t("checks.log.warnError", "[checks] aviso/error durante la comprobación: {message}", { message })}${NL}`);

    // No dejamos la cabecera en "error" sin una fila visible que lo explique.
    // Si una comprobación lanza una excepción, la convertimos en una fila roja
    // y el resumen se recalcula desde el DOM en el finally.
    const container = $("checks");
    if (container) addCheck(container, t("checks.item.checksError", "Error ejecución Checks"), false, message);
  } finally {
    updateChecksSummaryFromDom();

    const summary = $("checks-summary");
    if (summary?.textContent === t("checks.badge.checking", "comprobando")) {
      setBadge(summary, t("checks.badge.finished", "finalizado"), "warn");
    }

    state.checksRunning = false;
    syncChecksButton();
  }
}
