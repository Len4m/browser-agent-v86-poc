// Browser Agent v86 - checks panel
// Modern modules import runChecks directly. Legacy ordered sources receive a
// global alias through compat/legacy-facades.ts.

import { $, NL, state } from "../app/state";
import { t, tn } from "../app/i18n";
import { shellQuote } from "../app/text-utils";
import { getConfig, getSelectedProfile, getVmRuntimeConfig, getWsRelayUrl, type VmProfile } from "../vm/profile-config";
import { checkAsset, checkWsRelayEndpoint, loadScript } from "../vm/runtime-assets";
import {
  firstMatchingVmCheckLine,
  lastNonEmptyLine,
  normalizeTerminalStreamForMarkers,
} from "../vm/terminal-markers";
import { isWsConnected, logTool, setBadge, syncChecksButton } from "./status-controls";

interface RunChecksOptions {
  probeWsRelay?: boolean;
}

interface ExecVmOptions {
  lock?: boolean;
  label?: string;
  timeoutMs?: number;
  log?: boolean;
  targetTools?: boolean;
  maxOutputBytes?: number;
}

interface ExecVmResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface BackgroundToolsDiagnostics {
  serial1Available?: boolean;
  runnerReady?: boolean;
  lastError?: string;
}

interface BackgroundToolsApi {
  diagnostics?: () => BackgroundToolsDiagnostics | null;
  waitForRunnerReady?: (timeoutMs: number) => Promise<unknown>;
}

interface VmApi {
  serial0_send?: unknown;
  save_state?: unknown;
  restore_state?: unknown;
}

type LegacyWindow = Window & typeof globalThis & {
  execVm?: (command: string, options?: ExecVmOptions) => Promise<unknown>;
  BA_BG_TOOLS?: BackgroundToolsApi;
  V86Starter?: unknown;
  V86?: unknown;
};

interface ToolCheck {
  label: string;
  test: string;
}

function legacyWindow(): LegacyWindow {
  return window;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function vmApi(): VmApi | null {
  return typeof state.vm === "object" && state.vm !== null ? state.vm : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Error";
}

function hasWebGpu(): boolean {
  return Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
}

function formatCheckBadgeText(ok: boolean, detail = ""): string {
  if (ok) return t("checks.badge.ok");
  const clean = String(detail || "").trim();
  if (!clean) return t("checks.badge.fail");
  if (clean.length > 28 || /[;$(){}|<>]/.test(clean)) return t("checks.badge.fail");
  if (/%s|\\n|printf|IFACE=\$|PFX=/.test(clean)) return t("checks.badge.fail");
  return clean;
}

function addCheck(container: HTMLElement, name: string, ok: boolean, detail = ""): boolean {
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

function addSkippedCheck(container: HTMLElement, name: string, detail = ""): void {
  const row = document.createElement("div");
  row.className = "check";
  const label = document.createElement("span");
  label.textContent = name;
  const badge = document.createElement("span");
  badge.className = "badge warn";
  badge.textContent = t("common.skipped");
  badge.title = detail;
  row.append(label, badge);
  container.appendChild(row);
}

function updateChecksSummaryFromDom(): void {
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

function getVmCommandCheckSkipReason(): string {
  if (!state.vm) return t("common.v86NotStarted");
  if (!state.vmReady) return t("common.waitingShell");
  if (state.snapshotRestoring) return t("common.restoringSnapshot");
  if (state.vmStarting) return t("checks.skip.vmStarting");
  if (state.pending) return t("checks.skip.serial0Busy");
  if (state.bgTools.pending) return t("checks.skip.bgToolBusy");
  if (state.agentBusy) return t("checks.skip.vmBusy");
  const diag = legacyWindow().BA_BG_TOOLS?.diagnostics?.();
  if (diag && !diag.serial1Available) return t("common.serialUnavailable", { port: "1" });
  if (diag && !diag.runnerReady) return t("checks.skip.runnerNotReady");
  return "";
}

function getExpectedToolChecks(profile: VmProfile | null): ToolCheck[] {
  const packages = new Set(profile?.packages || []);
  const checks: ToolCheck[] = [];

  const addTool = (label: string, test: string): void => {
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

function makePackageCheckCommand(packages: string[] = []): string {
  const list = packages.map(shellQuote).join(" ");
  if (!list) return "P=BA_PKG; echo ${P}_OK";
  return `P=BA_PKG; missing=""; for p in ${list}; do apk info -e "$p" >/dev/null 2>&1 || missing="$missing $p"; done; if [ -n "$missing" ]; then echo "\${P}_MISSING:$missing"; exit 1; else echo "\${P}_OK"; fi`;
}

function makeToolCheckCommand(toolChecks: ToolCheck[]): string {
  if (!toolChecks.length) return "P=BA_TOOLS; echo ${P}_OK";
  const tests = toolChecks.map((item) => `(${item.test}) >/dev/null 2>&1 || missing="$missing ${item.label}"`).join("; ");
  return `P=BA_TOOLS; missing=""; ${tests}; if [ -n "$missing" ]; then echo "\${P}_MISSING:$missing"; exit 1; else echo "\${P}_OK"; fi`;
}

function normalizeExecVmResult(result: unknown): ExecVmResult {
  if (!isRecord(result)) return { code: 1, stdout: "", stderr: "invalid execVm result" };
  return {
    code: Number.isFinite(Number(result.code)) ? Number(result.code) : 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

async function runVmCheck(command: string, { label = t("checks.label.vmCheck"), timeoutMs = 12000 }: ExecVmOptions = {}): Promise<ExecVmResult> {
  const execVm = legacyWindow().execVm;
  if (!execVm) return { code: 1, stdout: "", stderr: "execVm unavailable" };
  const result: unknown = await execVm(command, {
    lock: true,
    label,
    timeoutMs,
    log: false,
    targetTools: true,
  });
  return normalizeExecVmResult(result);
}

export async function runChecks({ probeWsRelay = true }: RunChecksOptions = {}): Promise<void> {
  if (state.checksRunning) return;
  state.checksRunning = true;
  syncChecksButton();
  setBadge($("checks-summary"), t("common.checking"), "warn");
  try {
    const container = $("checks");
    if (!container) return;
    container.textContent = "";
    let okCount = 0;
    let total = 0;
    const add = (name: string, ok: boolean, detail = ""): void => {
      total += 1;
      if (addCheck(container, name, ok, detail)) okCount += 1;
    };

    add(t("checks.item.webgpu"), hasWebGpu(), hasWebGpu() ? t("checks.badge.ok") : t("common.notDetected"));
    add(t("checks.item.websocketApi"), Boolean(window.WebSocket), window.WebSocket ? t("checks.badge.ok") : t("common.notAvailable"));

    const wsRelayUrl = getWsRelayUrl();
    if (probeWsRelay) {
      const wsRelayCheck = await checkWsRelayEndpoint(wsRelayUrl);
      add(t("checks.item.wsnicRelay"), wsRelayCheck.ok, `${wsRelayUrl} · ${wsRelayCheck.detail}`);
    } else {
      addSkippedCheck(container, t("checks.item.wsnicRelay"), t("checks.detail.relaySkipped", { url: wsRelayUrl }));
    }

    const wsConnected = isWsConnected();
    const wsConfigured = Boolean(state.networkConfigured);
    add(
      t("checks.item.wsNetwork"),
      wsConnected && wsConfigured,
      wsConnected
        ? (wsConfigured ? t("checks.detail.connectedConfigured") : t("checks.detail.connectedUnconfigured"))
        : t("checks.detail.notConnectedWeb"),
    );

    add(t("checks.item.coopCoep"), Boolean(window.crossOriginIsolated), window.crossOriginIsolated ? t("checks.badge.ok") : t("checks.detail.notIsolated"));

    const runtime = getVmRuntimeConfig();
    add(t("checks.item.ram"), runtime.ramMb >= 256, `${runtime.ramMb} MB`);

    if (runtime.hda) {
      const diskResult = await checkAsset(runtime.hda.url);
      add(t("checks.item.hdaFile"), diskResult.ok, diskResult.ok ? runtime.hda.url : `${runtime.hda.url} · ${diskResult.detail}`);
    } else {
      add(t("checks.item.vmDisk"), true, "initramfs/RAM");
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
    add(t("checks.item.hdaDisks"), diskOk === diskUrls.length, `${diskOk}/${diskUrls.length}`);

    const cfg = getConfig();
    const profile = getSelectedProfile();
    if (profile) add(t("checks.item.profileSelected"), true, `${profile.name || profile.id} · ${profile.output || ""}`);
    else add(t("checks.item.profileSelected"), true, t("common.freeManual"));

    const assets: Array<[string, string]> = [
      ["libv86.js", cfg.libv86],
      ["v86.wasm", cfg.wasm],
      ["BIOS", cfg.bios],
      ["VGA BIOS", cfg.vgaBios],
      ["Alpine vmlinuz", cfg.bzimage],
      ...(cfg.initrd ? [["Alpine initramfs", cfg.initrd] as [string, string]] : []),
    ];

    for (const [name, url] of assets) {
      const result = await checkAsset(url);
      add(name, result.ok, result.ok ? url : `${url} · ${result.detail}`);
    }

    const legacy = legacyWindow();
    try {
      if (!legacy.V86Starter && !legacy.V86) await loadScript(cfg.libv86);
      add(t("checks.item.v86starter"), Boolean(legacy.V86Starter || legacy.V86), t("checks.detail.notLoaded"));
    } catch (error) {
      add(t("checks.item.v86starter"), false, errorMessage(error));
    }

    const vm = vmApi();
    add(t("checks.item.vmStarted"), Boolean(state.vm), state.vm ? t("checks.badge.ok") : t("common.pending"));
    add(t("checks.item.serial0Api"), typeof vm?.serial0_send === "function", typeof vm?.serial0_send === "function" ? t("checks.badge.ok") : t("common.pending"));
    const bgDiagBeforeWait = legacy.BA_BG_TOOLS?.diagnostics?.() || null;
    add(t("checks.item.serial1Api"), Boolean(bgDiagBeforeWait?.serial1Available), bgDiagBeforeWait?.serial1Available ? t("checks.badge.ok") : t("common.pending"));
    if (state.vm && state.vmReady && bgDiagBeforeWait?.serial1Available && !bgDiagBeforeWait?.runnerReady) {
      await legacy.BA_BG_TOOLS?.waitForRunnerReady?.(1500);
    }
    const bgDiag = legacy.BA_BG_TOOLS?.diagnostics?.() || null;
    add(t("checks.item.runnerSerial1"), Boolean(bgDiag?.runnerReady), bgDiag?.runnerReady ? t("checks.detail.runnerReady") : (bgDiag?.lastError || t("common.notReady")));
    add(t("checks.item.snapshotApi"), Boolean(typeof vm?.save_state === "function" && typeof vm?.restore_state === "function"), state.vm ? "save_state/restore_state" : t("common.pending"));

    const vmSkipReason = getVmCommandCheckSkipReason();

    if (vmSkipReason) {
      addSkippedCheck(container, t("checks.item.vmChecks"), vmSkipReason);
    } else {
      const result = await runVmCheck("echo browser-agent-ok", { label: t("checks.label.vmBasic"), timeoutMs: 8000 });
      add(t("checks.item.vmCommand"), result.code === 0 && result.stdout.includes("browser-agent-ok"), result.stderr || t("checks.badge.ok"));

      const profileIdResult = await runVmCheck("cat /etc/browser-agent-profile-id 2>/dev/null || echo unknown", {
        label: t("checks.label.checkingProfile"),
        timeoutMs: 8000,
      });
      const vmProfileId = profile
        ? firstMatchingVmCheckLine(profileIdResult.stdout, (line) => line === profile.id) || lastNonEmptyLine(profileIdResult.stdout)
        : firstMatchingVmCheckLine(profileIdResult.stdout, (line) => line !== "" && line !== "unknown") || lastNonEmptyLine(profileIdResult.stdout);
      const profileOk = profile ? vmProfileId === profile.id : Boolean(vmProfileId && vmProfileId !== "unknown");
      add(t("checks.item.profileInVm"), profileOk, profile ? t("checks.detail.profileExpected", { id: vmProfileId || t("common.noData"), expected: profile.id }) : vmProfileId || t("common.noData"));

      if (profile) {
        const pkgResult = await runVmCheck(makePackageCheckCommand(profile.packages || []), {
          label: t("checks.label.checkingPackages"),
          timeoutMs: 18000,
        });
        const clean = normalizeTerminalStreamForMarkers(pkgResult.stdout);
        const missingPackages = clean.match(/BA_PKG_MISSING:([^\n\r]*)/)?.[1]?.trim();
        add(t("checks.item.vmPackages"), pkgResult.code === 0, missingPackages ? t("checks.detail.missing", { list: missingPackages }) : pkgResult.stderr || t("checks.badge.ok"));
      } else {
        add(t("checks.item.vmPackages"), true, t("common.manualMode"));
      }

      if (profile) {
        const toolChecks = getExpectedToolChecks(profile);
        const toolResult = await runVmCheck(makeToolCheckCommand(toolChecks), {
          label: t("checks.label.checkingTools"),
          timeoutMs: 18000,
        });
        const clean = normalizeTerminalStreamForMarkers(toolResult.stdout);
        const missingTools = clean.match(/BA_TOOLS_MISSING:([^\n\r]*)/)?.[1]?.trim();
        add(t("checks.item.vmTools"), toolResult.code === 0, missingTools ? t("checks.detail.missing", { list: missingTools }) : toolResult.stderr || tn("checks.detail.checksCount", toolChecks.length));
      } else {
        add(t("checks.item.vmTools"), true, t("common.manualMode"));
      }

      const netCommand = "PFX=BA_VM_NET; IFACE=$(ls /sys/class/net | grep -v '^lo$' | head -n1); if [ -z \"$IFACE\" ]; then echo ${PFX}_NO_IFACE; exit 1; fi; printf '%s_IFACE:%s\\n' \"$PFX\" \"$IFACE\"; if ! ip -4 addr show \"$IFACE\" | grep -q 'inet '; then echo ${PFX}_NO_IPV4; exit 2; fi; if wget -q -T 5 -O /tmp/ba-net-check http://www.google.com/generate_204; then echo ${PFX}_HTTP_OK; else ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1 && echo ${PFX}_PING_OK || { echo ${PFX}_FAIL; exit 3; }; fi";
      const netResult = await runVmCheck(netCommand, {
        label: t("checks.label.checkingNetwork"),
        timeoutMs: 15000,
      });
      const netClean = normalizeTerminalStreamForMarkers(netResult.stdout);
      const netOk = netResult.code === 0 && (netClean.includes("BA_VM_NET_HTTP_OK") || netClean.includes("BA_VM_NET_PING_OK"));
      const iface = netClean.match(/BA_VM_NET_IFACE:([^\s\r\n]+)/)?.[1] || "";
      let netDetail = iface ? `IFACE=${iface}` : "";
      if (!netDetail && netClean.includes("BA_VM_NET_NO_IFACE")) netDetail = t("common.noInterface");
      if (!netDetail && netClean.includes("BA_VM_NET_NO_IPV4")) netDetail = t("common.noIpv4");
      if (!netDetail && netClean.includes("BA_VM_NET_FAIL")) netDetail = t("common.noOutput");
      if (!netDetail) netDetail = netResult.stderr || (netOk ? t("checks.badge.ok") : t("common.noConnection"));
      add(t("checks.item.vmNetwork"), netOk, netDetail);

      if (runtime.hda && state.diskMounted) {
        const diskVmCommand = "if mountpoint -q /mnt/hda; then echo DISK_MOUNTED; echo browser-agent-disk-check > /mnt/hda/.ba-check && sync && rm -f /mnt/hda/.ba-check && echo DISK_RW_OK || { echo DISK_RW_FAIL; exit 1; }; else echo DISK_NOT_MOUNTED; exit 2; fi";
        const diskVmResult = await runVmCheck(diskVmCommand, {
          label: t("checks.label.checkingDisk"),
          timeoutMs: 12000,
        });
        const diskClean = normalizeTerminalStreamForMarkers(diskVmResult.stdout);
        add(t("checks.item.hdaRwInVm"), diskVmResult.code === 0 && diskClean.includes("DISK_RW_OK"), diskClean.match(/DISK_[A-Z_]+/)?.[0] || diskVmResult.stderr || t("checks.badge.ok"));
      } else if (runtime.hda) {
        add(t("checks.item.hdaRwInVm"), false, t("common.notMounted"));
      }
    }

    updateChecksSummaryFromDom();

    // The visual return to tab 1 happens in finally, including thrown checks.
    void okCount;
    void total;
  } catch (error) {
    const message = errorMessage(error);
    logTool(`${NL}${t("checks.log.warnError", { message })}${NL}`);

    const container = $("checks");
    if (container) addCheck(container, t("checks.item.checksError"), false, message);
  } finally {
    updateChecksSummaryFromDom();

    const summary = $("checks-summary");
    if (summary?.textContent === t("common.checking")) {
      setBadge(summary, t("checks.badge.finished"), "warn");
    }

    state.checksRunning = false;
    syncChecksButton();
  }
}
