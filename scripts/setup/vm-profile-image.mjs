import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));
const publicRoot = join(root, "public");
const profilePath = resolve(root, process.argv[2] || "vm/profiles/alpine-pentest-lite.json");

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...(options.env || {}) },
    shell: false,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} ha fallado con código ${result.status}`);
  }
}

function assertString(value, name) {
  if (typeof value !== "string" || !value.trim()) fail(`${name} debe ser un string no vacío`);
  return value.trim();
}

function assertArray(value, name) {
  if (!Array.isArray(value)) fail(`${name} debe ser un array`);
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function bytes(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function human(size) {
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function publicFilePath(path) {
  const clean = String(path || "").replace(/^\/+/, "");
  return clean.startsWith("public/") ? clean : `public/${clean}`;
}

function publicUrl(path) {
  return `/${String(path || "").replace(/^\/?public\//, "").replace(/^\/+/, "")}`;
}

function contentHash(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(isAbsolute(path) ? path : join(root, path), "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count = 0;
    while ((count = readSync(descriptor, buffer, 0, buffer.byteLength, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function versionedPublicUrl(path) {
  const abs = join(root, path);
  const url = publicUrl(path);
  return `${url}?v=${contentHash(abs).slice(0, 12)}`;
}

function assetIdentity(path, url = versionedPublicUrl(path), logicalBytes = null) {
  const abs = join(root, path);
  return { url, bytes: logicalBytes ?? bytes(abs), sha256: contentHash(abs) };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

if (!existsSync(profilePath)) fail(`no existe el perfil ${profilePath}`);
const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const sourceHash = createHash("sha256").update(canonicalJson(Object.fromEntries(Object.entries(profile).filter(([key]) => key !== "$schema")))).digest("hex");

const id = assertString(profile.id, "id");
const name = assertString(profile.name || profile.id, "name");
const packages = assertArray(profile.packages || [], "packages");
const allowedTools = assertArray(profile.allowedTools, "allowedTools");
const extraRepositories = assertArray(profile.extraRepositories || [], "extraRepositories");
const firstBootCommands = assertArray(profile.firstBootCommands || [], "firstBootCommands");
const buildCommands = assertArray(profile.buildCommands || [], "buildCommands");
const alpineVersion = profile.alpineVersion ? assertString(profile.alpineVersion, "alpineVersion") : "3.23.4";
const alpineBranch = profile.alpineBranch ? assertString(profile.alpineBranch, "alpineBranch") : `v${alpineVersion.split(".").slice(0, 2).join(".")}`;
const storage = profile.storage;
const layout = "overlay-hda";
const output = `v86/images/profiles/${id}-initramfs.gz`;
const rootfsOutput = `v86/images/profiles/${id}-rootfs.img`;
const persistentSeedOutput = `v86/images/profiles/${id}-persistent-seed.img`;
const kernelOutput = profile.kernelOutput ? assertString(profile.kernelOutput, "kernelOutput") : `v86/images/kernels/alpine-${alpineBranch}-vmlinuz-lts`;
const outputFile = publicFilePath(output);
const rootfsOutputFile = publicFilePath(rootfsOutput);
const persistentSeedOutputFile = publicFilePath(persistentSeedOutput);
const kernelOutputFile = publicFilePath(kernelOutput);
const arch = profile.arch ? assertString(profile.arch, "arch") : "x86";
const bootMessage = profile.bootMessage ? String(profile.bootMessage) : `${name} ready.`;
const minimumRamMb = Number(profile.minimumRamMb);
const minimumVramMb = Number(profile.minimumVramMb);
if (!Number.isInteger(minimumRamMb) || minimumRamMb < 64) fail(`minimumRamMb inválido en ${id}`);
if (!Number.isInteger(minimumVramMb) || minimumVramMb < 0) fail(`minimumVramMb inválido en ${id}`);
const requiredProfilePackages = ["python3"];

for (const packageName of requiredProfilePackages) {
  if (!packages.includes(packageName)) {
    fail(`el perfil ${id} debe incluir ${packageName}; los runners guest dependen de Python 3`);
  }
}

console.log(`Perfil: ${name} (${id})`);
console.log(`Paquetes: ${packages.length ? packages.join(", ") : "ninguno extra"}`);
if (extraRepositories.length) console.log(`Repos extra: ${extraRepositories.join(", ")}`);
console.log(`Salida: ${output}`);

console.log("\n== Descargando assets base ==");
run(process.execPath, ["scripts/setup/runtime-assets.mjs"]);

const profileBuildDir = join(root, "build", "profiles", id);
mkdirSync(profileBuildDir, { recursive: true });
const firstBootFile = join(profileBuildDir, "firstboot.sh");
const buildCommandsFile = join(profileBuildDir, "build-commands.sh");

writeFileSync(firstBootFile, [
  "#!/bin/sh",
  "set +e",
  ...firstBootCommands,
  "exit 0",
  "",
].join("\n"));

writeFileSync(buildCommandsFile, [
  "#!/bin/sh",
  "set -eu",
  ...buildCommands,
  "",
].join("\n"));

console.log("\n== Generando imagen del perfil ==");
run("bash", ["scripts/setup/vm-alpine-overlay-hda.sh"], {
  env: {
    PROFILE_ID: id,
    PROFILE_BUILD_ID: `${id}-${sourceHash.slice(0, 12)}`,
    PROFILE_NAME: name,
    PROFILE_PACKAGES: packages.join("\n"),
    PROFILE_EXTRA_REPOSITORIES: extraRepositories.join("\n"),
    PROFILE_FIRSTBOOT_FILE: firstBootFile,
    PROFILE_BUILD_COMMANDS_FILE: buildCommandsFile,
    PROFILE_BOOT_MESSAGE: bootMessage,
    PROFILE_VERIFY_PACKAGES: "1",
    PROFILE_OUTPUT: outputFile,
    PROFILE_ROOTFS_OUTPUT: rootfsOutputFile,
    PROFILE_PERSISTENT_SEED_OUTPUT: persistentSeedOutputFile,
    PROFILE_ROOT_DISK_MB: String(storage.rootDiskMb || 512),
    PROFILE_WORKSPACE_DISK_MB: String(storage.workspaceDiskMb || 512),
    PROFILE_KERNEL_OUTPUT: kernelOutputFile,
    ALPINE_VERSION: alpineVersion,
    ALPINE_BRANCH: alpineBranch,
    ALPINE_ARCH: arch,
  },
});

const outputAbs = join(root, outputFile);
const kernelAbs = join(root, kernelOutputFile);
if (!existsSync(outputAbs)) fail(`no se ha generado ${outputFile}`);
if (!existsSync(kernelAbs)) fail(`no se ha generado ${kernelOutputFile}`);

const rootfsAbs = join(root, rootfsOutputFile);
const persistentSeedAbs = join(root, persistentSeedOutputFile);
if (!existsSync(rootfsAbs)) fail(`no se ha generado ${rootfsOutputFile}`);
if (!existsSync(persistentSeedAbs)) fail(`no se ha generado ${persistentSeedOutputFile}`);

const rootfsPartsUrl = (() => {
  const rootfsVersion = contentHash(rootfsOutputFile).slice(0, 12);
  const directory = dirname(rootfsAbs);
  const base = basename(rootfsAbs, ".img");
  const sourcePattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)-(\\d+)\\.img\\.zst$`);
  const targetPrefix = `${base}.${rootfsVersion}-`;
  for (const file of readdirSync(directory)) {
    if (file.startsWith(`${base}.`) && file.endsWith(".img.zst") && !file.startsWith(targetPrefix)) {
      unlinkSync(join(directory, file));
    }
  }
  for (const file of readdirSync(directory)) {
    const match = file.match(sourcePattern);
    if (match) renameSync(join(directory, file), join(directory, `${targetPrefix}${match[1]}-${match[2]}.img.zst`));
  }
  return publicUrl(rootfsOutputFile).replace(/\.img$/, `.${rootfsVersion}.img.zst`);
})();

const assets = {
  libv86: assetIdentity("public/v86/build/libv86.js"),
  wasm: assetIdentity("public/v86/build/v86.wasm"),
  bios: assetIdentity("public/v86/bios/seabios.bin"),
  vgaBios: assetIdentity("public/v86/bios/vgabios.bin"),
  kernel: assetIdentity(kernelOutputFile),
  initramfs: assetIdentity(outputFile),
  rootfs: assetIdentity(rootfsOutputFile, rootfsPartsUrl, Number(storage.rootDiskMb) * 1024 * 1024),
  persistentSeed: assetIdentity(persistentSeedOutputFile, versionedPublicUrl(persistentSeedOutputFile), Number(storage.workspaceDiskMb) * 1024 * 1024),
};

const profileIdentity = {
  source: Object.fromEntries(Object.entries(profile).filter(([key]) => key !== "$schema")),
  assets: Object.fromEntries(Object.entries(assets).map(([key, asset]) => [key, { bytes: asset.bytes, sha256: asset.sha256 }])),
  topology: { hda: "immutable-root", hdb: "overlay-cow", blockSize: 65536, partSize: 4 * 1024 * 1024 },
};
const profileHash = createHash("sha256").update(canonicalJson(profileIdentity)).digest("hex");

const manifest = {
  id,
  name,
  description: profile.description || "",
  type: layout,
  profileHash,
  alpineVersion,
  alpineBranch,
  arch,
  output: assets.initramfs.url,
  kernelOutput: assets.kernel.url,
  initramfsBytes: bytes(outputAbs),
  kernelBytes: bytes(kernelAbs),
  packages,
  allowedTools,
  firstBootCommands,
  buildCommands,
  minimumRamMb,
  minimumVramMb,
  storage: {
    layout,
    rootDiskMb: Number(storage.rootDiskMb),
    workspaceDiskMb: Number(storage.workspaceDiskMb),
    blockSize: 65536,
    filesystem: "ext4",
    topology: [
      { role: "hda", kind: "immutable-root", readOnly: true, useParts: true, fixedChunkSize: 4 * 1024 * 1024 },
      { role: "hdb", kind: "overlay-cow", readOnly: false, blockSize: 65536, persistence: "user-selected" },
    ],
  },
  assets,
  cmdline: "rw rdinit=/init console=ttyS0,115200 console=tty0 edd=off nowatchdog tsc=reliable mitigations=off random.trust_cpu=on",
  network: { type: "virtio" },
  uarts: ["serial0", "serial1", "serial2"],
  filesystem9p: { enabled: true, root: null },
  extraRepositories,
  generatedAt: new Date().toISOString(),
  notes: [
    "RAM/VRAM mínimas: validar arrancando el perfil con esos valores.",
    "No necesitas wsnic para construir esta imagen. Sí necesitas wsnic para validar red desde la VM.",
    "Rootfs HDA inmutable + HDB CoW temporal o persistente, según la selección explícita del usuario.",
  ],
};

const profileManifestDir = join(publicRoot, "v86", "images", "profiles");
mkdirSync(profileManifestDir, { recursive: true });
writeFileSync(join(profileManifestDir, `${id}.json`), JSON.stringify(manifest, null, 2) + "\n");

const indexPath = join(profileManifestDir, "index.json");
let index = [];
if (existsSync(indexPath)) {
  try { index = JSON.parse(readFileSync(indexPath, "utf8")); } catch { index = []; }
}
index = index.filter((item) => item.id !== id);
index.push({
  id,
  name,
  description: manifest.description,
  type: manifest.type,
  profileHash,
  output: manifest.output,
  kernelOutput: manifest.kernelOutput,
  initramfsBytes: manifest.initramfsBytes,
  minimumRamMb,
  minimumVramMb,
  packages,
  allowedTools,
  storage: manifest.storage,
  assets,
  extraRepositories,
  generatedAt: manifest.generatedAt,
});
writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");

console.log("\n== Resultado ==");
console.log(`Kernel:    ${kernelOutputFile} (${human(manifest.kernelBytes)})`);
console.log(`Initramfs: ${outputFile} (${human(manifest.initramfsBytes)})`);
console.log(`Rootfs HDA: ${rootfsOutputFile} (${human(manifest.assets.rootfs.bytes)} lógicos)`);
console.log(`Semilla HDB: ${persistentSeedOutputFile} (${human(manifest.assets.persistentSeed.bytes)} lógicos)`);
console.log(`Manifest:  public/v86/images/profiles/${id}.json`);
console.log(`RAM mínima del perfil: ${minimumRamMb} MB`);
console.log("\nEl perfil puede arrancar como sesión temporal o con su workspace persistente.");
