#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const steps = [
  [process.execPath, ["scripts/setup/runtime-assets.mjs"]],
  ["bash", ["scripts/setup/vm-alpine-initramfs.sh"]],
  [process.execPath, ["scripts/setup/vm-profile-image.mjs", "vm/profiles/alpine-base.json"]],
  [process.execPath, ["scripts/setup/vm-profile-image.mjs", "vm/profiles/alpine-pentest-lite.json"]],
  [process.execPath, ["scripts/setup/vm-profile-image.mjs", "vm/profiles/alpine-pentest-web.json"]],
  ["bash", ["scripts/setup/vm-hda-data-disks.sh"]],
];

for (const [command, args] of steps) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
