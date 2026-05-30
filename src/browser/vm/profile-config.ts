// @ts-nocheck
// Browser Agent v86 - 04 vm profile config
// Split from app.js in v9.35. Load order is defined in index.html.

function getSelectedProfile() {
  const id = $("vm-profile")?.value || "manual";
  if (id === "manual") return null;
  return state.profiles.find((profile) => profile.id === id) || null;
}

function getConfig() {
  const profile = getSelectedProfile();
  return {
    libv86: $("cfg-libv86").value.trim(),
    wasm: $("cfg-wasm").value.trim(),
    bios: $("cfg-bios").value.trim(),
    vgaBios: $("cfg-vga").value.trim(),
    bzimage: profile?.kernelOutput || $("cfg-bzimage").value.trim(),
    initrd: profile?.output || $("cfg-initrd")?.value?.trim() || "",
    profile,
  };
}

function formatProfileBytes(bytes) {
  const value = Number(bytes || 0);
  return value ? formatBytes(value) : t("vm.profile.sizePending", "tamaño pendiente");
}

function setSelectValueIfExists(id, value) {
  const select = $(id);
  if (!select || value == null) return;
  const text = String(value);
  if (Array.from(select.options).some((option) => option.value === text)) {
    select.value = text;
  }
}

function syncProfileControls({ applyDefaults = false } = {}) {
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
    setSelectValueIfExists("vm-ram-mb", profile.recommendedRamMb || profile.minRamMb || 512);
    setSelectValueIfExists("vm-vram-mb", profile.recommendedVramMb || 8);
    if (profile.defaultDisk) setSelectValueIfExists("vm-disk", profile.defaultDisk);
  }

  if (profileSelect) profileSelect.disabled = vmRunning;
  if (ram) ram.disabled = vmRunning || Boolean(profile);
  if (vram) vram.disabled = vmRunning || Boolean(profile);
  if (disk) disk.disabled = vmRunning;
}

function updateProfileHint({ applyDefaults = false } = {}) {
  const hint = $("vm-profile-hint");
  const profile = getSelectedProfile();
  if (!hint) return;

  if (!profile) {
    hint.textContent = t("vm.profile.hint.free", "Modo libre: RAM, VRAM y disco configurables.");
    hint.title = t("vm.profile.hint.free.title", "Usa el kernel e initramfs definidos en Config v86. Los campos RAM y VRAM solo se muestran en modo libre/manual.");
    syncProfileControls({ applyDefaults: false });
    return;
  }

  if (applyDefaults) syncProfileControls({ applyDefaults: true });
  const packageCount = Array.isArray(profile.packages) ? profile.packages.length : 0;
  const packageText = packageCount ? ` · ${tn("vm.profile.packages", packageCount, "{count} paquete", "{count} paquetes")}` : "";
  const diskText = profile.defaultDisk ? ` · ${t("vm.profile.disk", "Disco {disk}", { disk: profile.defaultDisk })}` : "";
  hint.textContent = `${profile.name || profile.id} · ${formatProfileBytes(profile.initramfsBytes)} · RAM ${profile.recommendedRamMb || "—"} MB · VRAM ${profile.recommendedVramMb || 8} MB${diskText}${packageText}`;
  hint.title = Array.isArray(profile.packages) && profile.packages.length ? t("vm.profile.packagesList", "Paquetes: {list}", { list: profile.packages.join(", ") }) : "";
  syncProfileControls({ applyDefaults: false });
}

async function loadProfiles() {
  const select = $("vm-profile");
  if (!select) return;

  try {
    const response = await fetch("/v86/images/profiles/index.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const profiles = await response.json();
    state.profiles = Array.isArray(profiles) ? profiles : [];
  } catch (error) {
    state.profiles = [];
    const hint = $("vm-profile-hint");
    if (hint) hint.textContent = t("vm.profile.none", "No hay perfiles generados todavía. Ejecuta npm run setup o npm run prepare:local.");
  }

  select.replaceChildren();
  const manual = document.createElement("option");
  manual.value = "manual";
  manual.textContent = t("common.freeManual", "Libre / manual");
  select.appendChild(manual);

  for (const profile of state.profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name || profile.id;
    select.appendChild(option);
  }

  select.value = "manual";
  updateProfileHint({ applyDefaults: false });
}

function getWsRelayUrl() {
  const value = $("ws-url")?.value?.trim();
  return value || "ws://127.0.0.1:8086/wsnic";
}

function getVmRuntimeConfig() {
  const ramMb = Number($("vm-ram-mb")?.value || "512");
  const vramMb = Number($("vm-vram-mb")?.value || "8");
  const diskValue = $("vm-disk")?.value || "initramfs";
  const config = {
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

function setVmOptionsLocked(locked) {
  if (locked) {
    for (const id of ["vm-profile", "vm-ram-mb", "vm-vram-mb", "vm-disk"]) {
      const el = $(id);
      if (el) el.disabled = true;
    }
    return;
  }
  syncProfileControls({ applyDefaults: false });
}

function updateDiskHint() {
  const hint = $("vm-disk-hint");
  if (!hint) return;
  const runtime = getVmRuntimeConfig();
  const profile = getSelectedProfile();
  if (runtime.hda) {
    hint.textContent = t("vm.disk.hint.hda", "Usará {url}. Créalo con npm run setup. En esta etapa es disco de datos ext2; el sistema sigue arrancando desde initramfs.", { url: runtime.hda.url });
  } else if (profile) {
    hint.textContent = t("vm.disk.hint.profile", "Perfil fijo en initramfs/RAM: los paquetes vienen dentro de la imagen, pero los cambios posteriores se pierden salvo snapshot.");
  } else {
    hint.textContent = t("vm.disk.hint.free", "Modo libre: Alpine en initramfs/RAM. Los paquetes instalados en sesión se pierden salvo snapshot.");
  }
}

window.addEventListener("ba:langchange", () => {
  updateProfileHint({ applyDefaults: false });
  updateDiskHint();
});
