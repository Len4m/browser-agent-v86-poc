import { $, NL, state } from "../app/state";
import { t } from "../app/i18n";
import type { SnapshotConsoleUiState } from "../console/console-state";
import { showBaModal } from "../ui/modal";
import { logTool, setAgentBusy, setBadge, syncSnapshotButtons } from "../ui/status-controls";
import { execVm } from "./exec-vm";
import {
  assertSnapshotCompatible,
  createSnapshotContainer,
  decodeDiskBlocks,
  decodePortable,
  SNAPSHOT_MAGIC,
  type PortableSnapshotManifest,
} from "./portable-state";
import { getWsRelayUrl } from "./profile-config";
import {
  downloadArrayBuffer,
  formatBytes,
  nextPaint,
  setLoading,
  timestampForFilename,
  v86SaveState,
} from "./runtime-assets";
import {
  isResolvedVmRuntime,
  resolveVmRuntime,
  runtimeInputFromProfile,
  type ResolvedVmRuntime,
  type VmProfile,
} from "./runtime-config";
import { diskRootHash, sha256 } from "./storage-hash";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Error";
}

function snapshotConsoleUiState(): SnapshotConsoleUiState {
  const humanTabs = state.consoleTabs.tabs.filter((tab) => tab.owner === "human");
  const active = humanTabs.find((tab) => tab.id === state.consoleTabs.activeId);
  const serial = humanTabs.find((tab) => tab.transport === "serial0");
  return {
    activeSessionId: active?.transport === "serial2" && active.sessionId ? String(active.sessionId) : null,
    serialTitle: String(serial?.title || "1").replace(/\s+/g, " ").trim().slice(0, 32) || "1",
    sessions: humanTabs
      .filter((tab) => tab.transport === "serial2" && tab.sessionId)
      .map((tab) => ({
        sessionId: String(tab.sessionId),
        title: String(tab.title || tab.humanNumber || tab.sessionId).replace(/\s+/g, " ").trim().slice(0, 32),
      })),
  };
}

export async function saveSnapshot(): Promise<void> {
  if (!state.vm || state.vmStarting || state.agentBusy || state.pending || state.bgTools.pending) return;
  const runtime = isResolvedVmRuntime(state.activeRuntime) ? state.activeRuntime : null;
  if (!runtime) return;
  const filename = `browser-agent-v86-${runtime.profile.id}-${timestampForFilename()}.bav86snapshot`;
  setAgentBusy(true, t("vm.snapshot.saving"));
  setLoading(true, { title: t("vm.snapshot.savingTitle"), detail: t("vm.snapshot.savingDetail"), percent: null, indeterminate: true });
  await nextPaint();
  logTool(`${NL}[snapshot] ${t("vm.snapshot.savingLog")}${NL}`);
  let paused = false;
  try {
    const syncResult = await execVm("sync", { lock: false, log: false, timeoutMs: 30000 });
    if (syncResult.code !== 0) throw new Error(`sync guest falló: ${syncResult.stderr || syncResult.stdout}`);
    const vm = state.vm as { stop?: () => unknown; run?: () => unknown };
    if (typeof vm.stop === "function") {
      await vm.stop();
      paused = true;
    }
    await state.activeCowDisk?.flush();
    await state.activeCowDisk?.checkpoint();
    const blocks = state.activeCowDisk ? await state.activeCowDisk.exportBlocks() : [];
    const container = await createSnapshotContainer(runtime, await v86SaveState(), blocks, snapshotConsoleUiState());
    downloadArrayBuffer(container, filename);
    logTool(`[snapshot] ${t("vm.snapshot.downloaded", { filename, size: formatBytes(container.byteLength) })}${NL}`);
  } catch (error) {
    logTool(`[snapshot] ${t("vm.snapshot.saveError", { error: errorMessage(error) })}${NL}`);
    setBadge($("vm-detail"), t("common.snapshotError"), "bad");
  } finally {
    if (paused) {
      try { (state.vm as { run?: () => unknown } | null)?.run?.(); } catch { /* resume is best-effort */ }
    }
    setLoading(false);
    setAgentBusy(false);
    syncSnapshotButtons();
  }
}

export function openRestoreSnapshotPicker(): void {
  const input = $<HTMLInputElement>("restore-state-file");
  if (!input || state.vmStarting || state.agentBusy || state.pending || state.bgTools.pending) return;
  input.value = "";
  input.click();
}

function knownProfile(id: string | undefined, profileHash: string): VmProfile | null {
  if (!id) return null;
  return state.profiles.find((value): value is VmProfile => isRecord(value) && value.id === id && value.profileHash === profileHash) || null;
}

async function confirmRestoreSnapshot(): Promise<boolean> {
  return await showBaModal({
    title: t("vm.snapshot.restore"),
    message: t("vm.snapshot.restoreConfirm"),
    buttons: [
      { id: "cancel", label: t("common.cancel"), variant: "secondary", cancel: true },
      { id: "restore", label: t("vm.snapshot.restore"), variant: "danger" },
    ],
  }) === "restore";
}

async function replaceVmWithSnapshot(
  buffer: ArrayBuffer,
  runtime: ResolvedVmRuntime,
  blocks: ReturnType<typeof decodeDiskBlocks>,
  checkpoint: string | null,
  consoleUi: SnapshotConsoleUiState | null,
): Promise<void> {
  const { startVm, stopVm } = await import("./serial-vm");
  if (state.vm) await stopVm({ confirmShutdown: false });
  await startVm({
    restoreStateBuffer: buffer,
    resolvedRuntime: runtime,
    restoreDiskBlocks: blocks,
    restoreDiskCheckpoint: checkpoint,
    restoreConsoleUi: consoleUi,
  });
}

export async function restoreSnapshotFromFile(event: Event): Promise<void> {
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  const file = input?.files?.[0] || null;
  if (!file) return;
  setAgentBusy(true, t("vm.snapshot.reading"));
  setLoading(true, { title: t("vm.snapshot.readingTitle"), detail: `${file.name} · ${formatBytes(file.size)}`, percent: null, indeterminate: true });
  await nextPaint();

  try {
    const buffer = await file.arrayBuffer();
    logTool(`${NL}[snapshot] ${t("common.loadedFile", { filename: file.name, size: formatBytes(buffer.byteLength) })}${NL}`);
    const decoded = await decodePortable<PortableSnapshotManifest>(buffer, SNAPSHOT_MAGIC);
    const v86State = decoded.sections.get("v86-state");
    if (!v86State || await sha256(v86State) !== decoded.manifest.stateSha256) throw new Error("El estado v86 no coincide con su manifiesto.");

    const profile = knownProfile(decoded.manifest.runtime.profile?.id, decoded.manifest.runtime.profileHash);
    let available: ResolvedVmRuntime;
    if (profile) {
      const snapshotDisk = decoded.manifest.runtime.storage.disks.find((disk) => disk.kind === "overlay-cow");
      available = resolveVmRuntime({
        ...runtimeInputFromProfile(profile, getWsRelayUrl(), snapshotDisk ? { mode: snapshotDisk.persistence } : { mode: "temporary" }),
        ramMb: decoded.manifest.runtime.ramMb,
        vramMb: decoded.manifest.runtime.vramMb,
      });
    } else if (state.activeRuntime?.profileHash === decoded.manifest.runtime.profileHash) {
      available = state.activeRuntime;
    } else {
      throw new Error("El perfil exacto del snapshot no está publicado en esta aplicación.");
    }
    assertSnapshotCompatible(decoded.manifest, available);
    const cow = available.storage.disks.find((disk) => disk.kind === "overlay-cow");
    const delta = decoded.sections.get("hdb-delta");
    const blocks = cow && delta ? decodeDiskBlocks(delta, cow.blockSize, cow.sizeBytes) : [];
    if (blocks.length !== decoded.manifest.blockCount) throw new Error("Número de bloques HDB incoherente.");
    if (cow && await diskRootHash(blocks) !== decoded.manifest.diskRootHash) throw new Error("Hash raíz HDB incompatible.");
    if (state.vm && !await confirmRestoreSnapshot()) return;
    setAgentBusy(false);
    await replaceVmWithSnapshot(v86State.slice().buffer, available, blocks, decoded.manifest.diskRootHash, decoded.manifest.consoleUi || null);
  } catch (error) {
    logTool(`[snapshot] ${t("vm.snapshot.restoreError", { error: errorMessage(error) })}${NL}`);
    syncSnapshotButtons();
  } finally {
    setLoading(false);
    setAgentBusy(false);
  }
}
