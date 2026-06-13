#!/usr/bin/env node
/**
 * Ratchet for the browser ESM migration.
 *
 * These limits intentionally reflect the current transitional baseline. Every
 * migrated slice should lower one or more values here so regressions are caught
 * before the final "no legacy globals/scripts" state is reached.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

const limits = {
  tsNocheckFiles: 31,
  browserSourceOrderEntries: 26,
  inlineScriptBlocks: 2,
  internalWindowAssignments: 28,
};

const migratedModules = [
  "src/browser/app/state.ts",
  "src/browser/app/i18n.ts",
  "src/browser/app/text-utils.ts",
  "src/browser/app/origin-awareness.ts",
  "src/browser/app/lang-selector.ts",
  "src/browser/ui/modal.ts",
  "src/browser/ui/status-controls.ts",
  "src/browser/ui/tooltips.ts",
  "src/browser/vm/profile-config.ts",
  "src/browser/vm/runtime-assets.ts",
  "src/browser/chat/provider/ai-sdk/entry.ts",
  "src/browser/chat/provider/ai-sdk/llm-browser-ai.worker.ts",
];

function walk(dir, out = []) {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    const abs = join(root, rel);
    if (statSync(abs).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function browserSourceOrderEntries() {
  const text = read("scripts/build/frontend.mjs");
  const body = text.match(/const browserSourceOrder = \[([\s\S]*?)\];/)?.[1] || "";
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

const browserTsFiles = walk("src/browser").filter((file) => file.endsWith(".ts"));
const sourceFiles = [
  ...browserTsFiles,
  ...walk("scripts/build").filter((file) => file.endsWith(".mjs")),
];
const indexHtml = read("src/web/index.html");
const sourceOrder = browserSourceOrderEntries();

const metrics = {
  tsNocheckFiles: browserTsFiles.filter((file) => read(file).includes("@ts-nocheck")).length,
  browserSourceOrderEntries: sourceOrder.length,
  inlineScriptBlocks: countMatches(indexHtml, /<script\b(?![^>]*\bsrc=)[^>]*>/g),
  internalWindowAssignments: sourceFiles.reduce(
    (sum, file) => sum + countMatches(read(file), /\bwindow\.BA_[A-Za-z0-9_$]+\s*=/g),
    0,
  ),
};

let failed = false;

for (const [name, value] of Object.entries(metrics)) {
  const limit = limits[name];
  if (value > limit) {
    failed = true;
    console.error(`browser-modernity: ${name}=${value} excede el máximo ${limit}`);
  }
}

const migratedStillOrdered = migratedModules.filter((entry) => sourceOrder.includes(entry));
if (migratedStillOrdered.length) {
  failed = true;
  console.error("browser-modernity: módulos migrados siguen en browserSourceOrder:");
  migratedStillOrdered.forEach((entry) => console.error(`  - ${entry}`));
}

if (failed) process.exit(1);

console.log([
  "OK browser modernity:",
  `@ts-nocheck ${metrics.tsNocheckFiles}/${limits.tsNocheckFiles}`,
  `sourceOrder ${metrics.browserSourceOrderEntries}/${limits.browserSourceOrderEntries}`,
  `inline scripts ${metrics.inlineScriptBlocks}/${limits.inlineScriptBlocks}`,
  `window.BA_* assignments ${metrics.internalWindowAssignments}/${limits.internalWindowAssignments}`,
].join(" "));
