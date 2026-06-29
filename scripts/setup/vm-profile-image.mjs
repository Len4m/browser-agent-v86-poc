import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
}

function versionedPublicUrl(path) {
  const abs = join(root, path);
  const url = publicUrl(path);
  return `${url}?v=${contentHash(abs)}`;
}

if (!existsSync(profilePath)) fail(`no existe el perfil ${profilePath}`);
const profile = JSON.parse(readFileSync(profilePath, "utf8"));

const id = assertString(profile.id, "id");
const name = assertString(profile.name || profile.id, "name");
const packages = assertArray(profile.packages || [], "packages");
const allowedTools = assertArray(profile.allowedTools, "allowedTools");
const extraRepositories = assertArray(profile.extraRepositories || [], "extraRepositories");
const firstBootCommands = assertArray(profile.firstBootCommands || [], "firstBootCommands");
const buildCommands = assertArray(profile.buildCommands || [], "buildCommands");
const validationCommands = assertArray(profile.validationCommands || [], "validationCommands");
const output = profile.output ? assertString(profile.output, "output") : "v86/images/alpine-initramfs.gz";
const kernelOutput = profile.kernelOutput ? assertString(profile.kernelOutput, "kernelOutput") : "v86/images/alpine-vmlinuz-lts";
const outputFile = publicFilePath(output);
const kernelOutputFile = publicFilePath(kernelOutput);
const alpineVersion = profile.alpineVersion ? assertString(profile.alpineVersion, "alpineVersion") : "3.23.4";
const alpineBranch = profile.alpineBranch ? assertString(profile.alpineBranch, "alpineBranch") : `v${alpineVersion.split(".").slice(0, 2).join(".")}`;
const arch = profile.arch ? assertString(profile.arch, "arch") : "x86";
const bootMessage = profile.bootMessage ? String(profile.bootMessage) : `${name} ready.`;
const recommendedRamMb = Number(profile.recommendedRamMb || 512);
const recommendedVramMb = Number(profile.recommendedVramMb ?? 8);
const defaultDisk = typeof profile.defaultDisk === "string" ? profile.defaultDisk : "initramfs";
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
run("bash", ["scripts/setup/vm-alpine-initramfs.sh"], {
  env: {
    PROFILE_ID: id,
    PROFILE_NAME: name,
    PROFILE_PACKAGES: packages.join("\n"),
    PROFILE_EXTRA_REPOSITORIES: extraRepositories.join("\n"),
    PROFILE_FIRSTBOOT_FILE: firstBootFile,
    PROFILE_BUILD_COMMANDS_FILE: buildCommandsFile,
    PROFILE_BOOT_MESSAGE: bootMessage,
    PROFILE_VERIFY_PACKAGES: "1",
    PROFILE_OUTPUT: outputFile,
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

const manifest = {
  id,
  name,
  description: profile.description || "",
  type: "initramfs",
  alpineVersion,
  alpineBranch,
  arch,
  output: versionedPublicUrl(outputFile),
  kernelOutput: versionedPublicUrl(kernelOutputFile),
  initramfsBytes: bytes(outputAbs),
  kernelBytes: bytes(kernelAbs),
  packages,
  allowedTools,
  firstBootCommands,
  buildCommands,
  validationCommands,
  recommendedRamMb,
  recommendedVramMb,
  defaultDisk,
  extraRepositories,
  generatedAt: new Date().toISOString(),
  notes: [
    "RAM mínima real: validar arrancando el perfil con distintos tamaños de RAM y ejecutando validationCommands.",
    "No necesitas wsnic para construir esta imagen. Sí necesitas wsnic para validar red desde la VM.",
    "Esta imagen sigue siendo initramfs: los cambios hechos dentro de la VM no persisten salvo snapshot.",
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
  output: manifest.output,
  kernelOutput: manifest.kernelOutput,
  initramfsBytes: manifest.initramfsBytes,
  recommendedRamMb,
  recommendedVramMb,
  defaultDisk,
  packages,
  allowedTools,
  extraRepositories,
  generatedAt: manifest.generatedAt,
});
writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");

console.log("\n== Resultado ==");
console.log(`Kernel:    ${kernelOutputFile} (${human(manifest.kernelBytes)})`);
console.log(`Initramfs: ${outputFile} (${human(manifest.initramfsBytes)})`);
console.log(`Manifest:  public/v86/images/profiles/${id}.json`);
console.log(`RAM perfil: ${recommendedRamMb} MB`);
console.log("\nValidación sugerida dentro de la VM:");
for (const cmd of validationCommands) console.log(`  ${cmd}`);
console.log("\nPara probar con la UI actual, arranca la VM usando el initramfs generado por defecto.");
