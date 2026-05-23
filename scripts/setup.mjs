#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const steps = [
  [process.execPath, ["scripts/download-v86-assets.mjs"]],
  ["bash", ["scripts/build-alpine-initramfs.sh"]],
  [process.execPath, ["scripts/build-vm-profile.mjs", "vm/profiles/alpine-base.json"]],
  [process.execPath, ["scripts/build-vm-profile.mjs", "vm/profiles/alpine-pentest-lite.json"]],
  [process.execPath, ["scripts/build-vm-profile.mjs", "vm/profiles/alpine-pentest-web.json"]],
  ["bash", ["scripts/create-v86-disks.sh"]],
];

for (const [command, args] of steps) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
