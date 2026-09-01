#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const forwardedArgs = process.argv.slice(2).filter((arg) => ["--minify", "--sourcemap", "--analyze"].includes(arg));
const root = fileURLToPath(new URL("..", import.meta.url));
const requiredSetupAssets = [
  "public/vendor/xterm/xterm.css",
  "public/vendor/xterm/xterm.js",
  "public/v86/images/kernels/alpine-v3.23-vmlinuz-lts",
  "public/v86/images/profiles/alpine-base-initramfs.gz",
];

const steps = [
  [process.execPath, ["scripts/build/llm-browser-bundles.mjs", ...forwardedArgs]],
  [process.execPath, ["scripts/build/frontend.mjs", ...forwardedArgs]],
];

const missingSetupAssets = requiredSetupAssets.filter((file) => {
  const abs = join(root, file);
  return !existsSync(abs) || statSync(abs).size <= 0;
});

if (missingSetupAssets.length) {
  console.error("Faltan assets de runtime generados por setup:");
  for (const file of missingSetupAssets) console.error(`  - ${file}`);
  console.error("Ejecuta primero: pnpm setup");
  process.exit(1);
}

for (const [command, args] of steps) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
