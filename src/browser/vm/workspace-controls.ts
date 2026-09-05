import { $, NL, state } from "../app/state";
import { t } from "../app/i18n";
import { errorMessage } from "../app/value-utils";
import { showBaModal } from "../ui/modal";
import { logTool, setAgentBusy } from "../ui/status-controls";
import { browserCowStore } from "./indexeddb-cow-disk";
import {
  getSelectedProfile,
  getVmRuntimeConfig,
  selectedProfileHasPersistedWorkspace,
  syncProfilePersistenceIndicators,
} from "./profile-config";
import { persistentWorkspaceId } from "./runtime-config";

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
    const profile = getSelectedProfile();
    if (!profile?.profileHash) throw new Error(t("vm.workspace.resetMissingProfile"));
    const workspaceId = persistentWorkspaceId(profile.profileHash);
    const store = browserCowStore();
    // Recovery must not mount or validate the disk first: incompatible data is
    // one of the reasons a user needs this action in the first place.
    await store.reset(workspaceId);
    if (await store.getMetadata(workspaceId)) throw new Error(t("vm.workspace.resetVerificationFailed"));
    state.workspaceStatus = "none";
    logTool(`${NL}[workspace] reiniciado desde la semilla inmutable.${NL}`);
  } catch (error) {
    logTool(`${NL}[workspace] error reiniciando: ${errorMessage(error)}${NL}`);
    await showBaModal({
      title: t("vm.workspace.resetFailed"),
      message: t("vm.workspace.resetFailedDetail"),
      detail: errorMessage(error),
      buttons: [{ id: "ok", label: t("common.accept"), variant: "primary" }],
    });
  } finally {
    setAgentBusy(false);
    await syncWorkspaceControls();
  }
}
