// Browser Agent v86 - VM profile config.

import { $, state } from "../app/state";
import { t, tn } from "../app/i18n";
import { appEvents } from "../core/events";
import { formatBytes } from "./runtime-assets";
import { LOCAL_WS_URL } from "./ws-network-config";

export interface VmProfile {
  id: string;
  name?: string;
  output?: string;
  kernelOutput?: string;
  initramfsBytes?: number;
  recommendedRamMb?: number;
  recommendedVramMb?: number;
  defaultDisk?: string;
  packages?: string[];
  allowedTools?: string[];
}

interface VmConfig {
  libv86: string;
  wasm: string;
  bios: string;
  vgaBios: string;
  bzimage: string;
  initrd: string;
  profile: VmProfile | null;
}

export interface VmRuntimeConfig {
  ramMb: number;
  vramMb: number;
  diskMode: string;
  hda: {
    sizeMb: number;
    url: string;
  } | null;
}

interface ProfileOptions {
  applyDefaults?: boolean;
}

let initialized = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isVmProfile(value: unknown): value is VmProfile {
  return isRecord(value) && typeof value.id === "string";
}

function getProfiles(): VmProfile[] {
  return state.profiles.filter(isVmProfile);
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
  const id = $<HTMLSelectElement>("vm-profile")?.value || "manual";
  if (id === "manual") return null;
  return getProfiles().find((profile) => profile.id === id) || null;
}

export function getConfig(): VmConfig {
  const profile = getSelectedProfile();
  return {
    libv86: inputValue("cfg-libv86"),
    wasm: inputValue("cfg-wasm"),
    bios: inputValue("cfg-bios"),
    vgaBios: inputValue("cfg-vga"),
    bzimage: profile?.kernelOutput || inputValue("cfg-bzimage"),
    initrd: profile?.output || inputValue("cfg-initrd"),
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

function syncProfileControls({ applyDefaults = false }: ProfileOptions = {}): void {
  const profile = getSelectedProfile();
  const isManual = !profile;
  const vmRunning = Boolean(state.vm || state.vmStarting);
  const profileSelect = $("vm-profile");
  const ram = $("vm-ram-mb");
  const vram = $("vm-vram-mb");
  const disk = $("vm-disk");

  document.body.classList.toggle("vm-profile-manual", isManual);
  document.body.classList.toggle("vm-profile-preset", Boolean(profile));

  if (profile && applyDefaults) {
    setSelectValueIfExists("vm-ram-mb", profile.recommendedRamMb || 512);
    setSelectValueIfExists("vm-vram-mb", profile.recommendedVramMb ?? 8);
    if (profile.defaultDisk) setSelectValueIfExists("vm-disk", profile.defaultDisk);
  }

  setDisabled(profileSelect, vmRunning);
  setDisabled(ram, vmRunning || Boolean(profile));
  setDisabled(vram, vmRunning || Boolean(profile));
  setDisabled(disk, vmRunning);
}

export function updateProfileHint({ applyDefaults = false }: ProfileOptions = {}): void {
  const hint = $("vm-profile-hint");
  const profile = getSelectedProfile();
  if (!hint) return;

  if (!profile) {
    hint.textContent = t("vm.profile.hint.free");
    hint.title = t("vm.profile.hint.free.title");
    syncProfileControls({ applyDefaults: false });
    return;
  }

  if (applyDefaults) syncProfileControls({ applyDefaults: true });
  const packageCount = Array.isArray(profile.packages) ? profile.packages.length : 0;
  const packageText = packageCount ? ` · ${tn("vm.profile.packages", packageCount)}` : "";
  const diskText = profile.defaultDisk ? ` · ${t("vm.profile.disk", { disk: profile.defaultDisk })}` : "";
  hint.textContent = `${profile.name || profile.id} · ${formatProfileBytes(profile.initramfsBytes)} · RAM ${profile.recommendedRamMb || "—"} MB · VRAM ${profile.recommendedVramMb ?? 8} MB${diskText}${packageText}`;
  hint.title = Array.isArray(profile.packages) && profile.packages.length ? t("vm.profile.packagesList", { list: profile.packages.join(", ") }) : "";
  syncProfileControls({ applyDefaults: false });
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
  const manual = document.createElement("option");
  manual.value = "manual";
  manual.textContent = t("common.freeManual");
  select.appendChild(manual);

  for (const profile of getProfiles()) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name || profile.id;
    select.appendChild(option);
  }

  select.value = "manual";
  updateProfileHint({ applyDefaults: false });
}

export function getWsRelayUrl(): string {
  const input = $<HTMLInputElement>("ws-url");
  return input ? input.value.trim() : LOCAL_WS_URL;
}

export function getVmRuntimeConfig(): VmRuntimeConfig {
  const ramMb = Number($<HTMLSelectElement>("vm-ram-mb")?.value || "512");
  const vramMb = Number($<HTMLSelectElement>("vm-vram-mb")?.value || "8");
  const diskValue = $<HTMLSelectElement>("vm-disk")?.value || "initramfs";
  const config: VmRuntimeConfig = {
    ramMb: Number.isFinite(ramMb) ? ramMb : 512,
    vramMb: Number.isFinite(vramMb) ? vramMb : 8,
    diskMode: diskValue,
    hda: null,
  };

  const match = diskValue.match(/^hda-(\d+)$/);
  if (match) {
    const sizeMb = Number(match[1]);
    const suffix = sizeMb >= 1024 ? `${sizeMb / 1024}g` : `${sizeMb}m`;
    config.hda = {
      sizeMb,
      url: `/v86/disks/alpine-hda-${suffix}.img`,
    };
  }

  return config;
}

export function setVmOptionsLocked(locked: boolean): void {
  if (locked) {
    for (const id of ["vm-profile", "vm-ram-mb", "vm-vram-mb", "vm-disk"]) {
      setDisabled($(id), true);
    }
    return;
  }
  syncProfileControls({ applyDefaults: false });
}

export function updateDiskHint(): void {
  const hint = $("vm-disk-hint");
  if (!hint) return;
  const runtime = getVmRuntimeConfig();
  const profile = getSelectedProfile();
  if (runtime.hda) {
    hint.textContent = t("vm.disk.hint.hda", { url: runtime.hda.url });
  } else if (profile) {
    hint.textContent = t("vm.disk.hint.profile");
  } else {
    hint.textContent = t("vm.disk.hint.free");
  }
}

export function initProfileConfig(): void {
  if (initialized) return;
  initialized = true;
  appEvents.on("app:language-changed", () => {
    updateProfileHint({ applyDefaults: false });
    updateDiskHint();
  });
}
