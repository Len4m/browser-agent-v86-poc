#!/usr/bin/env node
/**
 * Ratchet for the browser ESM migration.
 *
 * These limits capture the accepted browser runtime boundaries so regressions
 * are caught when code reintroduces removed globals, inline scripts or disabled
 * TypeScript checks.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

const limits = {
  tsNocheckFiles: 0,
  inlineScriptBlocks: 0,
  internalWindowAssignments: 2,
  removedCompatibilityNames: 0,
};

const tsNocheckPattern = /^\s*\/\/\s*@ts-nocheck\b/m;
const removedCompatibilityNamesPattern = /\b(?:[Ll]egacyWindow|install[Ll]egacyFacades)\b/g;

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

const browserTsFiles = walk("src/browser").filter((file) => file.endsWith(".ts"));
const sourceFiles = [
  ...browserTsFiles,
  ...walk("scripts/build").filter((file) => file.endsWith(".mjs")),
];
const indexHtml = read("src/web/index.html");

const metrics = {
  tsNocheckFiles: browserTsFiles.filter((file) => tsNocheckPattern.test(read(file))).length,
  inlineScriptBlocks: countMatches(indexHtml, /<script\b(?![^>]*\bsrc=)[^>]*>/g),
  internalWindowAssignments: sourceFiles.reduce(
    (sum, file) => sum + countMatches(read(file), /\bwindow\.BA_[A-Za-z0-9_$]+\s*=/g),
    0,
  ),
  removedCompatibilityNames: browserTsFiles.reduce(
    (sum, file) => sum + countMatches(read(file), removedCompatibilityNamesPattern),
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

if (failed) process.exit(1);

console.log([
  "OK browser modernity:",
  `@ts-nocheck ${metrics.tsNocheckFiles}/${limits.tsNocheckFiles}`,
  `inline scripts ${metrics.inlineScriptBlocks}/${limits.inlineScriptBlocks}`,
  `window.BA_* assignments ${metrics.internalWindowAssignments}/${limits.internalWindowAssignments}`,
  `removed compat names ${metrics.removedCompatibilityNames}/${limits.removedCompatibilityNames}`,
].join(" "));
