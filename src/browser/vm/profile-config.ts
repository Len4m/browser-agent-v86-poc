// Browser Agent v86 - VM profile config.

import { $, state } from "../app/state";
import { t, tn } from "../app/i18n";
import { appEvents } from "../core/events";
import { browserCowStore } from "./indexeddb-cow-disk";
import { formatBytes } from "./runtime-assets";
import { LOCAL_WS_URL } from "./ws-network-config";
import { persistentWorkspaceId, type ResolvedVmRuntime, type VmProfile, type WorkspaceMode } from "./runtime-config";

export type { VmProfile } from "./runtime-config";

interface VmConfig {
  libv86: string;
  wasm: string;
  bios: string;
  vgaBios: string;
  bzimage: string;
  initrd: string;
  profile: VmProfile;
}

export interface VmRuntimeConfig {
  ramMb: number;
  vramMb: number;
  workspaceMode: WorkspaceMode;
}

interface ProfileOptions {
  applyDefaults?: boolean;
}

let initialized = false;
let persistenceSyncRevision = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isVmProfile(value: unknown): value is VmProfile {
  return isRecord(value) && typeof value.id === "string";
}

function getProfiles(): VmProfile[] {
  return state.profiles.filter(isVmProfile);
}

type ProfilePersistenceMark = "empty" | "saved" | "unknown";

export function selectedProfileHasPersistedWorkspace(): boolean {
  const select = $<HTMLSelectElement>("vm-profile");
  return select?.selectedOptions[0]?.dataset.persistence === "saved";
}

function renderProfilePersistenceIndicators(): void {
  const select = $<HTMLSelectElement>("vm-profile");
  if (select) {
    for (const option of Array.from(select.options)) {
      const profile = getProfiles().find((candidate) => candidate.id === option.value);
      const baseName = profile?.name || profile?.id || option.value;
      option.textContent = option.dataset.persistence === "saved"
        ? `${baseName} 💾`
        : baseName;
    }
  }

  const badge = $("vm-profile-storage-status");
  const profile = getSelectedProfile();
  if (!badge || !profile || !select) {
    if (badge) badge.hidden = true;
    return;
  }
  const mark = (select.selectedOptions[0]?.dataset.persistence || "unknown") as ProfilePersistenceMark;
  const storedBytes = Number(select.selectedOptions[0]?.dataset.persistenceBytes || "");
  badge.hidden = mark !== "saved";
  badge.textContent = mark === "saved"
    ? `${t("vm.profile.persistence.saved")}${Number.isFinite(storedBytes) ? ` · ${formatBytes(storedBytes)}` : ""}`
    : "";
  badge.title = badge.textContent;
  badge.className = `badge ${mark === "saved" ? "good" : ""}`.trim();
}

export async function syncProfilePersistenceIndicators(): Promise<boolean> {
  const select = $<HTMLSelectElement>("vm-profile");
  if (!select) return false;
  const revision = ++persistenceSyncRevision;
  const selectedProfileId = select.value;
  const results = await Promise.all(getProfiles().map(async (profile) => {
    const option = Array.from(select.options).find((candidate) => candidate.value === profile.id);
    if (!option) return { option: null, metadata: null };
    try {
      const metadata = profile.profileHash
        ? await browserCowStore().getMetadata(persistentWorkspaceId(profile.profileHash))
        : null;
      return { option, metadata };
    } catch {
      return { option, metadata: undefined };
    }
  }));
  if (revision !== persistenceSyncRevision) return false;

  for (const { option, metadata } of results) {
    if (!option) continue;
    option.dataset.persistence = metadata === undefined
      ? "unknown"
      : metadata && metadata.checkpoint !== "empty" ? "saved" : "empty";
    delete option.dataset.persistenceBytes;
  }

  const selected = results.find(({ option }) => option?.value === selectedProfileId);
  if (selected?.option && selected.metadata && selected.metadata.checkpoint !== "empty") {
    try {
      const storedBytes = await browserCowStore().storedBytes(selected.metadata.id, selected.metadata.activeGeneration);
      if (revision !== persistenceSyncRevision || select.value !== selectedProfileId) return false;
      selected.option.dataset.persistenceBytes = String(storedBytes);
    } catch {
      if (revision !== persistenceSyncRevision) return false;
      selected.option.dataset.persistence = "unknown";
    }
  }
  if (revision !== persistenceSyncRevision || select.value !== selectedProfileId) return false;
  renderProfilePersistenceIndicators();
  return true;
}

function inputValue(id: string): string {
  return $<HTMLInputElement>(id)?.value.trim() || "";
}

function setDisabled(el: Element | null, disabled: boolean): void {
  if (
    el instanceof HTMLButtonElement
    || el instanceof HTMLInputElement
    || el instanceof HTMLSelectElement
    || el instanceof HTMLTextAreaElement
  ) {
    el.disabled = disabled;
  }
}

export function getSelectedProfile(): VmProfile | null {
  if (typeof document === "undefined") return null;
  const id = $<HTMLSelectElement>("vm-profile")?.value || "";
  return getProfiles().find((profile) => profile.id === id) || null;
}

export function getEffectiveVmProfile(): VmProfile | null {
  return state.activeRuntime?.profile || getSelectedProfile();
}

export function getEffectiveVmProfileId(): string {
  return getEffectiveVmProfile()?.id || "";
}

export function reflectRuntimeSelection(runtime: ResolvedVmRuntime): void {
  const profileSelect = $<HTMLSelectElement>("vm-profile");
  if (profileSelect && runtime.profile?.id && Array.from(profileSelect.options).some((option) => option.value === runtime.profile?.id)) {
    const changed = profileSelect.value !== runtime.profile.id;
    profileSelect.value = runtime.profile.id;
    if (changed) profileSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const modeSelect = $<HTMLSelectElement>("vm-storage-mode");
  if (modeSelect) modeSelect.value = runtime.storage.mode;
  setSelectValueIfExists("vm-ram-mb", runtime.ramMb);
  setSelectValueIfExists("vm-vram-mb", runtime.vramMb);
  updateProfileHint({ applyDefaults: false });
}

export function getConfig(): VmConfig {
  const profile = getSelectedProfile();
  if (!profile) throw new Error(t("vm.profile.none"));
  return {
    libv86: inputValue("cfg-libv86"),
    wasm: inputValue("cfg-wasm"),
    bios: inputValue("cfg-bios"),
    vgaBios: inputValue("cfg-vga"),
    bzimage: profile.kernelOutput || "",
    initrd: profile.output || "",
    profile,
  };
}

function formatProfileBytes(bytes: number | undefined): string {
  const value = Number(bytes || 0);
  return value ? formatBytes(value) : t("vm.profile.sizePending");
}

function setSelectValueIfExists(id: string, value: string | number | null | undefined): void {
  const select = $<HTMLSelectElement>(id);
  if (!select || value == null) return;
  const text = String(value);
  if (Array.from(select.options).some((option) => option.value === text)) {
    select.value = text;
  }
}

function constrainResourceSelect(id: string, minimum: number, selectMinimum: boolean): void {
  const select = $<HTMLSelectElement>(id);
  if (!select || !Number.isFinite(minimum)) return;

  let minimumOption = Array.from(select.options).find((option) => Number(option.value) === minimum);
  if (!minimumOption) {
    minimumOption = document.createElement("option");
    minimumOption.value = String(minimum);
    minimumOption.textContent = `${minimum} MB`;
    const nextOption = Array.from(select.options).find((option) => Number(option.value) > minimum);
    select.insertBefore(minimumOption, nextOption || null);
  }

  for (const option of Array.from(select.options)) {
    option.disabled = Number(option.value) < minimum;
  }
  if (selectMinimum || Number(select.value) < minimum) select.value = minimumOption.value;
}

function applyProfileResourceMinimums(profile: VmProfile, selectMinimum: boolean): void {
  constrainResourceSelect("vm-ram-mb", profile.minimumRamMb, selectMinimum);
  constrainResourceSelect("vm-vram-mb", profile.minimumVramMb, selectMinimum);
}

function syncProfileControls({ applyDefaults = false }: ProfileOptions = {}): void {
  const profile = getSelectedProfile();
  const vmRunning = Boolean(state.vm || state.vmStarting);
  const profileSelect = $("vm-profile");
  const ram = $("vm-ram-mb");
  const vram = $("vm-vram-mb");
  const storageMode = $("vm-storage-mode");

  if (profile) {
    applyProfileResourceMinimums(profile, applyDefaults);
    if (applyDefaults) setSelectValueIfExists("vm-storage-mode", "temporary");
  }

  setDisabled(profileSelect, vmRunning);
  setDisabled(ram, vmRunning || !profile);
  setDisabled(vram, vmRunning || !profile);
  setDisabled(storageMode, vmRunning || !profile);
}

export function updateProfileHint({ applyDefaults = false }: ProfileOptions = {}): void {
  const hint = $("vm-profile-hint");
  const profile = getSelectedProfile();
  if (!hint) return;

  if (!profile) {
    hint.textContent = t("vm.profile.none");
    hint.title = "";
    syncProfileControls({ applyDefaults: false });
    renderProfilePersistenceIndicators();
    return;
  }

  if (applyDefaults) syncProfileControls({ applyDefaults: true });
  const runtime = getVmRuntimeConfig();
  const packageCount = Array.isArray(profile.packages) ? profile.packages.length : 0;
  const packageText = packageCount ? ` · ${tn("vm.profile.packages", packageCount)}` : "";
  const resources = t("vm.profile.resourcesSummary", {
    ram: runtime.ramMb,
    minimumRam: profile.minimumRamMb,
    vram: runtime.vramMb,
    minimumVram: profile.minimumVramMb,
  });
  hint.textContent = `${profile.name || profile.id} · ${formatProfileBytes(profile.assets?.rootfs?.bytes)} rootfs · ${resources} · Overlay HDA/HDB${packageText}`;
  hint.title = Array.isArray(profile.packages) && profile.packages.length ? t("vm.profile.packagesList", { list: profile.packages.join(", ") }) : "";
  syncProfileControls({ applyDefaults: false });
  renderProfilePersistenceIndicators();
}

export async function loadProfiles(): Promise<void> {
  const select = $<HTMLSelectElement>("vm-profile");
  if (!select) return;

  try {
    const response = await fetch("/v86/images/profiles/index.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const profiles: unknown = await response.json();
    state.profiles = Array.isArray(profiles) ? profiles.filter(isVmProfile) : [];
  } catch {
    state.profiles = [];
    const hint = $("vm-profile-hint");
    if (hint) hint.textContent = t("vm.profile.none");
  }

  select.replaceChildren();
  for (const profile of getProfiles()) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.dataset.persistence = "unknown";
    option.textContent = profile.name || profile.id;
    select.appendChild(option);
  }

  select.value = getProfiles()[0]?.id || "";
  updateProfileHint({ applyDefaults: true });
  await syncProfilePersistenceIndicators();
}

export function getWsRelayUrl(): string {
  const input = $<HTMLInputElement>("ws-url");
  return input ? input.value.trim() : LOCAL_WS_URL;
}

export function getVmRuntimeConfig(): VmRuntimeConfig {
  const ramMb = Number($<HTMLSelectElement>("vm-ram-mb")?.value || "512");
  const vramMb = Number($<HTMLSelectElement>("vm-vram-mb")?.value || "8");
  const workspaceMode = ($<HTMLSelectElement>("vm-storage-mode")?.value || "temporary") as WorkspaceMode;
  const config: VmRuntimeConfig = {
    ramMb: Number.isFinite(ramMb) ? ramMb : 512,
    vramMb: Number.isFinite(vramMb) ? vramMb : 8,
    workspaceMode,
  };

  return config;
}

export function setVmOptionsLocked(locked: boolean): void {
  if (locked) {
    for (const id of ["vm-profile", "vm-ram-mb", "vm-vram-mb", "vm-storage-mode"]) {
      setDisabled($(id), true);
    }
    return;
  }
  syncProfileControls({ applyDefaults: false });
}

export function initProfileConfig(): void {
  if (initialized) return;
  initialized = true;
  appEvents.on("app:language-changed", () => {
    updateProfileHint({ applyDefaults: false });
    renderProfilePersistenceIndicators();
  });
}
