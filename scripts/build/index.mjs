#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const forwardedArgs = process.argv.slice(2).filter((arg) => ["--minify", "--sourcemap"].includes(arg));

const steps = [
  [process.execPath, ["scripts/llm/build-models.mjs"]],
  [process.execPath, ["scripts/vm/download-assets.mjs"]],
  [process.execPath, ["scripts/llm/build-ai-bundle.mjs", ...forwardedArgs]],
  [process.execPath, ["scripts/build/frontend.mjs", ...forwardedArgs]],
];

for (const [command, args] of steps) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
