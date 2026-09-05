#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const contract = readJson(join(root, "vm", "runtime-contract.json"));
const schema = readJson(join(root, "vm", "profiles", "profile.schema.json"));
const packageJson = readJson(join(root, "package.json"));
const errors = [];

function requirePositiveInteger(name) {
  if (!Number.isInteger(contract[name]) || contract[name] <= 0) errors.push(`${name} debe ser un entero positivo`);
}

requirePositiveInteger("runtimeFormatVersion");
requirePositiveInteger("snapshotFormatVersion");
requirePositiveInteger("diskBlockSize");
requirePositiveInteger("rootPartSize");
if (contract.diskBlockSize !== 65536) errors.push("diskBlockSize debe conservar la compatibilidad CoW de 65536 bytes");
if (typeof contract.cmdline !== "string" || !contract.cmdline.trim()) errors.push("cmdline debe ser un string no vacío");
if (contract.networkType !== "virtio") errors.push("networkType debe ser virtio");
if (JSON.stringify(contract.uarts) !== JSON.stringify(["serial0", "serial1", "serial2"])) errors.push("uarts no coincide con la topología serie soportada");
if (contract.filesystem9p?.enabled !== true || contract.filesystem9p?.root !== null) errors.push("filesystem9p no coincide con la topología soportada");

const schemaBlockSizes = schema.properties?.storage?.properties?.blockSize?.enum;
if (!Array.isArray(schemaBlockSizes) || schemaBlockSizes.length !== 1 || schemaBlockSizes[0] !== contract.diskBlockSize) {
  errors.push("profile.schema.json y runtime-contract.json discrepan en diskBlockSize");
}

const dependencyVersion = packageJson.dependencies?.v86;
const expectedDependencyVersion = String(contract.v86Version || "").split("+")[0];
if (dependencyVersion !== expectedDependencyVersion && dependencyVersion !== `^${expectedDependencyVersion}`) {
  errors.push(`package.json debe declarar v86 ${expectedDependencyVersion}; encontrado ${dependencyVersion || "ninguno"}`);
}
const installedPackagePath = join(root, "node_modules", "v86", "package.json");
if (!existsSync(installedPackagePath)) {
  errors.push("v86 no está instalado; ejecuta pnpm install");
} else {
  const installedVersion = readJson(installedPackagePath).version;
  if (installedVersion !== contract.v86Version) {
    errors.push(`el build v86 instalado (${installedVersion}) no coincide con el contrato (${contract.v86Version})`);
  }
}

if (errors.length) {
  console.error("Runtime contract validation failed:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`OK runtime contract: v86 ${contract.v86Version}, formatos runtime/snapshot ${contract.runtimeFormatVersion}/${contract.snapshotFormatVersion}`);
