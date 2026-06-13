#!/usr/bin/env node
import * as esbuild from "esbuild";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const testsDir = join(root, "tests");
const outDir = join(root, "build/test");

function walk(absDir, prefix = "") {
  if (!existsSync(absDir)) return [];
  return readdirSync(absDir).flatMap((entry) => {
    const abs = join(absDir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) return walk(abs, rel);
    return [rel];
  });
}

const testSources = walk(testsDir)
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => join(testsDir, file));

if (!testSources.length) {
  console.log("OK tests: no test files found");
  process.exit(0);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: testSources,
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node18"],
  outExtension: { ".js": ".mjs" },
  packages: "external",
  logLevel: "silent",
});

const builtTests = walk(outDir)
  .filter((file) => file.endsWith(".test.mjs"))
  .map((file) => join(outDir, file));

const result = spawnSync(process.execPath, ["--test", ...builtTests], {
  cwd: root,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
