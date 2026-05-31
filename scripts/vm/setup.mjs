#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const steps = [
  [process.execPath, ["scripts/vm/download-assets.mjs"]],
  ["bash", ["scripts/vm/build-alpine-initramfs.sh"]],
  [process.execPath, ["scripts/vm/build-profile.mjs", "vm/profiles/alpine-base.json"]],
  [process.execPath, ["scripts/vm/build-profile.mjs", "vm/profiles/alpine-pentest-lite.json"]],
  [process.execPath, ["scripts/vm/build-profile.mjs", "vm/profiles/alpine-pentest-web.json"]],
  ["bash", ["scripts/vm/create-disks.sh"]],
];

for (const [command, args] of steps) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
