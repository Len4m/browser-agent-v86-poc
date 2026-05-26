#!/usr/bin/env node
/**
 * Verifica el shell frontend generado:
 * - index.html carga el bundle principal y el bridge ESM externo.
 * - style.css sigue importando todas las hojas públicas.
 * - los bundles/assets mínimos existen.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicRoot = join(root, "public");

function extract(pattern, text) {
  return [...text.matchAll(pattern)].map((m) => m[1]);
}

const indexHtml = readFileSync(join(publicRoot, "index.html"), "utf8");
const styleCss = readFileSync(join(publicRoot, "style.css"), "utf8");

const loadedJs = extract(/src="\.\/(js\/[^"?]+\.(?:js|mjs))(?:\?[^"]*)?"/g, indexHtml);
const loadedAssets = extract(/src="\.\/(assets\/[^"?]+\.(?:js|mjs))(?:\?[^"]*)?"/g, indexHtml);
const loadedCss = extract(/@import url\("\.\/(styles\/[^"?]+\.css)(?:\?v=[^"]*)?"\)/g, styleCss);

const allCss = readdirSync(join(publicRoot, "styles")).filter((f) => f.endsWith(".css")).map((f) => `styles/${f}`);

const orphanCss = allCss.filter((f) => !loadedCss.includes(f));
const requiredFiles = [
  "assets/app.js",
  "assets/ai-sdk-bridge.mjs",
  "assets/chat/ai-sdk-browser.mjs",
  "assets/chat/workers/llm-browser-ai.worker.mjs",
];

let failed = false;

if (!loadedAssets.includes("assets/app.js")) {
  failed = true;
  console.error("index.html debe cargar ./assets/app.js");
}

if (!loadedAssets.includes("assets/ai-sdk-bridge.mjs")) {
  failed = true;
  console.error("index.html debe cargar ./assets/ai-sdk-bridge.mjs como bridge ESM");
}

for (const file of requiredFiles) {
  const abs = join(publicRoot, file);
  if (!existsSync(abs) || statSync(abs).size <= 0) {
    failed = true;
    console.error(`Falta asset requerido: public/${file}`);
  }
}

if (orphanCss.length) {
  failed = true;
  console.error("CSS no importados por style.css:");
  orphanCss.forEach((f) => console.error(`  - ${f}`));
}

if (failed) process.exit(1);
console.log(`OK manifest: ${loadedAssets.length} app bundle, ${loadedJs.length} external js, ${loadedCss.length} css`);
