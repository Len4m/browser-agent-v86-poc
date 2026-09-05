import { $, NL, state } from "../app/state";
import { t } from "../app/i18n";
import { errorMessage } from "../app/value-utils";
import { showBaModal } from "../ui/modal";
import { logTool, setAgentBusy } from "../ui/status-controls";
import { createRuntimeCowDisk, type CowDisk } from "./indexeddb-cow-disk";
import {
  getSelectedProfile,
  getVmRuntimeConfig,
  getWsRelayUrl,
  selectedProfileHasPersistedWorkspace,
  syncProfilePersistenceIndicators,
} from "./profile-config";
import { resolveVmRuntime, runtimeInputFromProfile, type ResolvedVmRuntime } from "./runtime-config";

async function selectedWorkspace(): Promise<{ runtime: ResolvedVmRuntime; disk: CowDisk }> {
  if (state.activeRuntime?.storage.mode === "persistent" && state.activeCowDisk) {
    return { runtime: state.activeRuntime, disk: state.activeCowDisk };
  }
  const profile = getSelectedProfile();
  if (!profile) throw new Error("Selecciona un perfil con workspace persistente.");
  const runtime = resolveVmRuntime(runtimeInputFromProfile(profile, getWsRelayUrl(), { mode: "persistent" }));
  const disk = createRuntimeCowDisk(runtime, (status) => { state.workspaceStatus = status; });
  if (!disk) throw new Error("El perfil no declara un disco OverlayFS.");
  await disk.load();
  return { runtime, disk };
}

export async function syncWorkspaceControls(): Promise<void> {
  if (!await syncProfilePersistenceIndicators()) return;
  const profile = getSelectedProfile();
  const hasPersistedWorkspace = Boolean(profile && selectedProfileHasPersistedWorkspace());
  const persistentModeSelected = getVmRuntimeConfig().workspaceMode === "persistent";
  const toolbar = $("workspace-toolbar");
  if (toolbar) toolbar.hidden = !(hasPersistedWorkspace && persistentModeSelected);
  if (!hasPersistedWorkspace) state.workspaceStatus = profile ? "temporary" : "none";
  const resetButton = $<HTMLButtonElement>("workspace-reset");
  if (resetButton) {
    resetButton.disabled = state.vmStarting || state.agentBusy || !hasPersistedWorkspace || !persistentModeSelected || Boolean(state.vm);
  }
}

export async function resetWorkspace(): Promise<void> {
  if (state.vm || state.vmStarting || state.agentBusy) return;
  const choice = await showBaModal({
    title: t("vm.workspace.reset"),
    message: t("vm.workspace.resetConfirm"),
    buttons: [
      { id: "cancel", label: t("common.cancel"), variant: "secondary", cancel: true },
      { id: "reset", label: t("vm.workspace.reset"), variant: "danger" },
    ],
  });
  if (choice !== "reset") return;
  setAgentBusy(true, t("vm.workspace.resetting"));
  try {
    const { disk } = await selectedWorkspace();
    await disk.reset();
    state.workspaceStatus = "none";
    logTool(`${NL}[workspace] reiniciado desde la semilla inmutable.${NL}`);
  } catch (error) {
    logTool(`${NL}[workspace] error reiniciando: ${errorMessage(error)}${NL}`);
  } finally {
    setAgentBusy(false);
    await syncWorkspaceControls();
  }
}
