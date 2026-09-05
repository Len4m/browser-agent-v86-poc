#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const profilesDir = join(root, "vm", "profiles");
const profileFiles = readdirSync(profilesDir)
  .filter((file) => file.endsWith(".json") && !file.endsWith(".schema.json"))
  .sort()
  .map((file) => `vm/profiles/${file}`);

if (!profileFiles.length) {
  console.error("No VM profiles found in vm/profiles/*.json");
  process.exit(1);
}

const generatedProfilesDir = join(root, "public", "v86", "images", "profiles");
mkdirSync(generatedProfilesDir, { recursive: true });
writeFileSync(join(generatedProfilesDir, "index.json"), "[]\n");

const steps = [
  [process.execPath, ["scripts/check/vm-profiles.mjs"]],
  [process.execPath, ["scripts/setup/runtime-assets.mjs"]],
  ...profileFiles.map((profilePath) => [
    process.execPath,
    ["scripts/setup/vm-profile-image.mjs", profilePath],
  ]),
];

for (const [command, args] of steps) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
