#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const steps = [
  [process.execPath, ["scripts/check/runtime-contract.mjs"]],
  [process.execPath, ["scripts/check/vm-profiles.mjs"]],
  [process.execPath, ["scripts/check/frontend-manifest.mjs"]],
  [process.execPath, ["scripts/check/js-syntax.mjs"]],
  [process.execPath, ["scripts/check/i18n.mjs"]],
  [process.execPath, ["scripts/check/server.mjs"]],
];

for (const [command, args] of steps) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
