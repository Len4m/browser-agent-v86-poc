import runtimeContract from "../../../vm/runtime-contract.json";

export const VM_RUNTIME_FORMAT_VERSION = runtimeContract.runtimeFormatVersion as 1;
export const V86_BUILD_VERSION = runtimeContract.v86Version;
export const VM_DISK_BLOCK_SIZE = runtimeContract.diskBlockSize as 65536;
export const VM_ROOT_PART_SIZE = runtimeContract.rootPartSize;
export const VM_KERNEL_CMDLINE = runtimeContract.cmdline;

export interface AssetIdentity {
  url: string;
  bytes: number;
  sha256: string;
}

export interface ProfileStorage {
  layout: "overlay-hda";
  rootDiskMb: number;
  workspaceDiskMb: number;
  blockSize: typeof VM_DISK_BLOCK_SIZE;
  filesystem: "ext4";
}

export interface VmProfile {
  id: string;
  name?: string;
  description?: string;
  type?: "overlay-hda";
  profileHash?: string;
  output?: string;
  kernelOutput?: string;
  initramfsBytes?: number;
  minimumRamMb: number;
  minimumVramMb: number;
  packages?: string[];
  allowedTools?: string[];
  storage: ProfileStorage;
  assets?: {
    libv86?: AssetIdentity;
    wasm?: AssetIdentity;
    bios?: AssetIdentity;
    vgaBios?: AssetIdentity;
    kernel?: AssetIdentity;
    initramfs?: AssetIdentity;
    rootfs?: AssetIdentity;
    persistentSeed?: AssetIdentity;
  };
}

export interface ImmutableRootDisk {
  kind: "immutable-root";
  role: "hda";
  sizeBytes: number;
  asset: AssetIdentity;
  useParts: true;
  fixedChunkSize: number;
  readOnly: true;
}

export type WorkspaceMode = "temporary" | "persistent";

export interface OverlayCowDisk {
  kind: "overlay-cow";
  role: "hdb";
  sizeBytes: number;
  blockSize: number;
  filesystem: "ext4";
  seed: AssetIdentity;
  persistence: WorkspaceMode;
  workspaceId: string;
}

export interface ResolvedVmRuntime {
  readonly formatVersion: typeof VM_RUNTIME_FORMAT_VERSION;
  readonly profile: Readonly<VmProfile>;
  readonly profileHash: string;
  readonly ramMb: number;
  readonly vramMb: number;
  readonly cmdline: string;
  readonly assets: Readonly<{
    libv86: AssetIdentity;
    wasm: AssetIdentity;
    bios: AssetIdentity;
    vgaBios: AssetIdentity;
    kernel: AssetIdentity;
    initramfs: AssetIdentity;
  }>;
  readonly storage: Readonly<{
    layout: "overlay-hda";
    mode: WorkspaceMode;
    disks: readonly (ImmutableRootDisk | OverlayCowDisk)[];
  }>;
  readonly network: Readonly<{ type: "virtio"; relayUrl: string }>;
  readonly uarts: readonly ["serial0", "serial1", "serial2"];
  readonly filesystem9p: Readonly<{ enabled: true; root: null }>;
}

export interface ResolveRuntimeInput {
  profile: VmProfile;
  ramMb: number;
  vramMb: number;
  workspace: Readonly<{ mode: WorkspaceMode }>;
  wsRelayUrl: string;
  assets: ResolvedVmRuntime["assets"];
}

export function runtimeInputFromProfile(
  profile: VmProfile,
  wsRelayUrl: string,
  workspace: ResolveRuntimeInput["workspace"] = { mode: "temporary" },
): ResolveRuntimeInput {
  const assets = profile.assets;
  return {
    profile,
    ramMb: profile.minimumRamMb,
    vramMb: profile.minimumVramMb,
    workspace,
    wsRelayUrl,
    assets: {
      libv86: requireAsset(assets?.libv86, "libv86"),
      wasm: requireAsset(assets?.wasm, "wasm"),
      bios: requireAsset(assets?.bios, "bios"),
      vgaBios: requireAsset(assets?.vgaBios, "vgaBios"),
      kernel: requireAsset(assets?.kernel, "kernel"),
      initramfs: requireAsset(assets?.initramfs, "initramfs"),
    },
  };
}

export function persistentWorkspaceId(profileHash: string): string {
  return `profile:${profileHash}`;
}

function immutable<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function requireAsset(asset: AssetIdentity | undefined, name: string): AssetIdentity {
  if (!asset || !asset.url || !Number.isFinite(asset.bytes) || !/^[a-f0-9]{64}$/i.test(asset.sha256)) {
    throw new Error(`El perfil persistente no contiene una identidad válida para ${name}. Ejecuta pnpm setup.`);
  }
  return asset;
}

export function resolveVmRuntime(input: ResolveRuntimeInput): ResolvedVmRuntime {
  const profile = input.profile;
  const profileHash = profile.profileHash || "";
  if (!profileHash) throw new Error("El perfil no contiene profileHash. Ejecuta pnpm setup.");
  if (!Number.isInteger(profile.minimumRamMb) || profile.minimumRamMb < 64) {
    throw new Error("El perfil no contiene un mínimo de RAM válido.");
  }
  if (!Number.isInteger(profile.minimumVramMb) || profile.minimumVramMb < 0) {
    throw new Error("El perfil no contiene un mínimo de VRAM válido.");
  }
  if (!Number.isInteger(input.ramMb) || input.ramMb < profile.minimumRamMb) {
    throw new Error(`El perfil ${profile.id} requiere al menos ${profile.minimumRamMb} MB de RAM.`);
  }
  if (!Number.isInteger(input.vramMb) || input.vramMb < profile.minimumVramMb) {
    throw new Error(`El perfil ${profile.id} requiere al menos ${profile.minimumVramMb} MB de VRAM.`);
  }
  const disks: (ImmutableRootDisk | OverlayCowDisk)[] = [];
  const mode = input.workspace.mode;
  const rootMb = Number(profile.storage.rootDiskMb);
  const workspaceMb = Number(profile.storage.workspaceDiskMb);
  const blockSize = Number(profile.storage.blockSize);
  if (!Number.isInteger(rootMb) || !Number.isInteger(workspaceMb) || blockSize !== VM_DISK_BLOCK_SIZE) {
    throw new Error("Topología overlay-hda incompleta o incompatible.");
  }
  disks.push({
    kind: "immutable-root", role: "hda", sizeBytes: rootMb * 1024 * 1024,
    asset: requireAsset(profile.assets?.rootfs, "rootfs"), useParts: true,
    fixedChunkSize: VM_ROOT_PART_SIZE, readOnly: true,
  });
  disks.push({
    kind: "overlay-cow", role: "hdb", sizeBytes: workspaceMb * 1024 * 1024,
    blockSize, filesystem: "ext4", seed: requireAsset(profile.assets?.persistentSeed, "persistentSeed"),
    persistence: mode,
    workspaceId: mode === "persistent" ? persistentWorkspaceId(profileHash) : `temporary:${profileHash}`,
  });

  const runtime: ResolvedVmRuntime = {
    formatVersion: VM_RUNTIME_FORMAT_VERSION,
    profile,
    profileHash,
    ramMb: input.ramMb,
    vramMb: input.vramMb,
    cmdline: VM_KERNEL_CMDLINE,
    assets: input.assets,
    storage: { layout: "overlay-hda", mode, disks },
    network: { type: runtimeContract.networkType as "virtio", relayUrl: input.wsRelayUrl },
    uarts: runtimeContract.uarts as ["serial0", "serial1", "serial2"],
    filesystem9p: runtimeContract.filesystem9p as { enabled: true; root: null },
  };
  return immutable(runtime);
}

export function isResolvedVmRuntime(value: unknown): value is ResolvedVmRuntime {
  if (!value || typeof value !== "object") return false;
  const runtime = value as Partial<ResolvedVmRuntime>;
  return runtime.formatVersion === VM_RUNTIME_FORMAT_VERSION
    && typeof runtime.profileHash === "string"
    && typeof runtime.ramMb === "number"
    && typeof runtime.vramMb === "number"
    && Boolean(runtime.storage && Array.isArray(runtime.storage.disks));
}
