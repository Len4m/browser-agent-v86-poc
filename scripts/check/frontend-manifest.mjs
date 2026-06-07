#!/usr/bin/env node
/**
 * Verifica el shell frontend generado:
 * - public/index.html generado carga el bundle principal y el bridge ESM externo.
 * - public/style.css generado sigue importando todas las hojas públicas.
 * - los bundles/assets mínimos existen.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const publicRoot = join(root, "public");

function extract(pattern, text) {
  return [...text.matchAll(pattern)].map((m) => m[1]);
}

const indexHtml = readFileSync(join(publicRoot, "index.html"), "utf8");
const styleCss = readFileSync(join(publicRoot, "style.css"), "utf8");

const loadedJs = extract(/src="\.\/(js\/[^"?]+\.(?:js|mjs))(?:\?[^"]*)?"/g, indexHtml);
const loadedAssets = extract(/src="\.\/(assets\/[^"?]+\.(?:js|mjs))(?:\?[^"]*)?"/g, indexHtml);
const indexCss = extract(/href="\.\/((?:style|assets\/app)\.css)(?:\?v=[^"]*)?"/g, indexHtml);
const loadedCss = extract(/@import url\("\.\/(styles\/[^"?]+\.css)(?:\?v=[^"]*)?"\)/g, styleCss);
const hashedRuntimeRefs = [
  ["vendor/xterm/xterm.js", /src="\.\/vendor\/xterm\/xterm\.js\?v=[a-f0-9]{12}"/],
  ["assets/ai-sdk-bridge.mjs", /src="\.\/assets\/ai-sdk-bridge\.mjs\?v=[a-f0-9]{12}"/],
  ["assets/app.js", /src="\.\/assets\/app\.js\?v=[a-f0-9]{12}"/],
];

const allCss = readdirSync(join(publicRoot, "styles")).filter((f) => f.endsWith(".css")).map((f) => `styles/${f}`);
const expectedVendorFiles = [
  "vendor/llm/dompurify/LICENSE",
  "vendor/llm/dompurify/purify.es.mjs",
  "vendor/llm/streaming-markdown/LICENSE",
  "vendor/llm/streaming-markdown/smd.js",
  "vendor/xterm/xterm.css",
  "vendor/xterm/xterm.js",
];

const orphanCss = allCss.filter((f) => !loadedCss.includes(f));
const requiredFiles = [
  "favicon.ico",
  "apple-touch-icon.png",
  "site.webmanifest",
  "robots.txt",
  "assets/browser-agent-preview.png",
  "assets/icons/browser-agent.png",
  "assets/icons/browser-agent-header-64.webp",
  "assets/icons/browser-agent-header-96.webp",
  "assets/app.js",
  "assets/ai-sdk-bridge.mjs",
  "assets/chat/ai-sdk-browser.mjs",
  "assets/chat/workers/llm-browser-ai.worker.mjs",
  ...expectedVendorFiles,
];
if (indexCss.includes("assets/app.css")) requiredFiles.push("assets/app.css");

let failed = false;

function walkFiles(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(abs, name);
    return [name];
  });
}

if (!loadedAssets.includes("assets/app.js")) {
  failed = true;
  console.error("index.html debe cargar ./assets/app.js");
}

if (!loadedAssets.includes("assets/ai-sdk-bridge.mjs")) {
  failed = true;
  console.error("index.html debe cargar ./assets/ai-sdk-bridge.mjs como bridge ESM");
}

if (!indexCss.includes("style.css") && !indexCss.includes("assets/app.css")) {
  failed = true;
  console.error("index.html debe cargar ./style.css o ./assets/app.css");
}

const requiredSeoSnippets = [
  ["meta description", /<meta name="description" content="[^"]{40,180}" \/>/],
  ["canonical", /<link rel="canonical" href="(?:\/|https?:\/\/[^"]+)" \/>/],
  ["favicon ico", /<link rel="icon" href="\/favicon\.ico" sizes="any" \/>/],
  ["header brand icon", /<img\s+class="header-brand-icon"\s+src="\/assets\/icons\/browser-agent-header-64\.webp"\s+srcset="\/assets\/icons\/browser-agent-header-64\.webp 1x, \/assets\/icons\/browser-agent-header-96\.webp 2x"\s+width="54"\s+height="54"\s+alt=""\s+decoding="async"\s+\/>/],
  ["Open Graph title", /<meta property="og:title" content="Browser Agent v86 - Linux VM and AI Agent in Your Browser" \/>/],
  ["Open Graph image", /<meta property="og:image" content="(?:\/assets\/browser-agent-preview\.png|https?:\/\/[^"]+\/assets\/browser-agent-preview\.png)" \/>/],
  ["Open Graph logo", /<meta property="og:logo" content="(?:\/assets\/icons\/browser-agent-header-64\.webp|https?:\/\/[^"]+\/assets\/icons\/browser-agent-header-64\.webp)" \/>/],
  ["Twitter Card", /<meta name="twitter:card" content="summary_large_image" \/>/],
  ["Twitter image", /<meta name="twitter:image" content="(?:\/assets\/browser-agent-preview\.png|https?:\/\/[^"]+\/assets\/browser-agent-preview\.png)" \/>/],
];

for (const [label, pattern] of requiredSeoSnippets) {
  if (!pattern.test(indexHtml)) {
    failed = true;
    console.error(`index.html debe incluir SEO/meta válido: ${label}`);
  }
}

for (const [file, pattern] of hashedRuntimeRefs) {
  if (!pattern.test(indexHtml)) {
    failed = true;
    console.error(`index.html debe cargar ./${file} con hash de contenido ?v=`);
  }
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

const vendorRoot = join(publicRoot, "vendor");
const actualVendorFiles = existsSync(vendorRoot)
  ? walkFiles(vendorRoot).map((file) => `vendor/${file}`).sort()
  : [];
const unexpectedVendorFiles = actualVendorFiles.filter((file) => !expectedVendorFiles.includes(file));
const missingVendorFiles = expectedVendorFiles.filter((file) => !actualVendorFiles.includes(file));
if (unexpectedVendorFiles.length) {
  failed = true;
  console.error("Assets vendor inesperados en public/vendor:");
  unexpectedVendorFiles.forEach((f) => console.error(`  - ${f}`));
}
if (missingVendorFiles.length) {
  failed = true;
  console.error("Assets vendor requeridos no encontrados:");
  missingVendorFiles.forEach((f) => console.error(`  - ${f}`));
}

const publicSourceMaps = walkFiles(publicRoot)
  .filter((file) => file.endsWith(".map"));
if (publicSourceMaps.length && process.env.BA_ALLOW_SOURCEMAPS !== "1") {
  failed = true;
  console.error("Sourcemaps públicos encontrados; usa BA_ALLOW_SOURCEMAPS=1 si son intencionados:");
  publicSourceMaps.forEach((f) => console.error(`  - ${f}`));
}

if (failed) process.exit(1);
console.log(`OK manifest: ${loadedAssets.length} app bundle, ${loadedJs.length} external js, ${loadedCss.length} css imports, ${indexCss.length} css entry, ${actualVendorFiles.length} vendor`);
