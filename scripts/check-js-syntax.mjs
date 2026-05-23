#!/usr/bin/env node
/**
 * Syntax-checks project JavaScript. Browser source files are checked directly
 * while public/index.html now loads the generated app bundle.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function jsFilesIn(dir) {
  return readdirSync(join(root, dir))
    .filter((file) => /\.(?:mjs|js)$/.test(file))
    .map((file) => `${dir}/${file}`);
}

function existing(files) {
  return files.filter((file) => existsSync(join(root, file)));
}

const files = [
  "server.mjs",
  "public/assets/app.js",
  "public/assets/ai-sdk-bridge.mjs",
  ...jsFilesIn("scripts"),
];

const unique = existing([...new Set(files)]);
let failed = false;

for (const file of unique) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout || `node --check ${file} failed\n`);
  }
}

if (failed) process.exit(1);
console.log(`OK syntax: ${unique.length} js/mjs files`);
