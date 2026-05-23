#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const steps = [
  [process.execPath, ["scripts/build-llm-models.mjs"]],
  [process.execPath, ["scripts/download-v86-assets.mjs"]],
  [process.execPath, ["scripts/build-llm-ai-bundle.mjs"]],
  [process.execPath, ["scripts/build-frontend.mjs"]],
];

for (const [command, args] of steps) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
