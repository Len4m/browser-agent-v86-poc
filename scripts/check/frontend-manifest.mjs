#!/usr/bin/env node
/**
 * Verifica el shell frontend generado:
 * - public/index.html generado carga el bundle principal.
 * - public/assets/app.js importa dinámicamente el bridge ESM versionado.
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

function attributesFor(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/\s([^\s=]+)\s*=\s*"([^"]*)"/g)) {
    attributes[match[1].toLowerCase()] = match[2];
  }
  return attributes;
}

function findMetaContent(attribute, value) {
  for (const match of indexHtml.matchAll(/<meta\b[^>]*>/g)) {
    const attributes = attributesFor(match[0]);
    if (attributes[attribute] === value) return attributes.content || "";
  }
  return "";
}

function findLinkHref(rel) {
  for (const match of indexHtml.matchAll(/<link\b[^>]*>/g)) {
    const attributes = attributesFor(match[0]);
    const rels = (attributes.rel || "").split(/\s+/).filter(Boolean);
    if (rels.includes(rel)) return attributes.href || "";
  }
  return "";
}

function findScriptAttributes(expectedPath) {
  const clean = expectedPath.replace(/^\/+/, "");
  for (const match of indexHtml.matchAll(/<script\b[^>]*>/g)) {
    const attributes = attributesFor(match[0]);
    const src = attributes.src || "";
    if (src === `./${clean}` || src.startsWith(`./${clean}?`)) return attributes;
  }
  return null;
}

function isCanonicalUrl(value) {
  return value === "/" || /^https?:\/\/[^\s"]+$/.test(value);
}

function isPublicAssetUrl(value, expectedPath) {
  const path = `/${expectedPath.replace(/^\/+/, "")}`;
  if (value === path) return true;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.pathname === path;
  } catch {
    return false;
  }
}

const indexHtml = readFileSync(join(publicRoot, "index.html"), "utf8");
const styleCss = readFileSync(join(publicRoot, "style.css"), "utf8");
const appJs = readFileSync(join(publicRoot, "assets/app.js"), "utf8");

const loadedJs = extract(/src="\.\/(js\/[^"?]+\.(?:js|mjs))(?:\?[^"]*)?"/g, indexHtml);
const loadedAssets = extract(/src="\.\/(assets\/[^"?]+\.(?:js|mjs))(?:\?[^"]*)?"/g, indexHtml);
const indexCss = extract(/href="\.\/((?:style|assets\/app)\.css)(?:\?v=[^"]*)?"/g, indexHtml);
const loadedCss = extract(/@import url\("\.\/(styles\/[^"?]+\.css)(?:\?v=[^"]*)?"\)/g, styleCss);
const appScript = findScriptAttributes("assets/app.js");
const hashedRuntimeRefs = [
  ["vendor/xterm/xterm.js", /src="\.\/vendor\/xterm\/xterm\.js\?v=[a-f0-9]{12}"/],
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

if (appScript?.type !== "module") {
  failed = true;
  console.error("index.html debe cargar ./assets/app.js con type=\"module\"");
}

if (loadedAssets.includes("assets/ai-sdk-bridge.mjs")) {
  failed = true;
  console.error("index.html no debe cargar ./assets/ai-sdk-bridge.mjs; app.js debe importarlo dinámicamente");
}

if (!/"\.\/ai-sdk-bridge\.mjs\?v=[a-f0-9]{12}"/.test(appJs)) {
  failed = true;
  console.error("assets/app.js debe importar ./ai-sdk-bridge.mjs con hash de contenido ?v=");
}

if (!indexCss.includes("style.css") && !indexCss.includes("assets/app.css")) {
  failed = true;
  console.error("index.html debe cargar ./style.css o ./assets/app.css");
}

const metaDescription = findMetaContent("name", "description");
const canonicalUrl = findLinkHref("canonical");
const faviconHref = findLinkHref("icon");
const ogTitle = findMetaContent("property", "og:title");
const ogDescription = findMetaContent("property", "og:description");
const ogUrl = findMetaContent("property", "og:url");
const ogImage = findMetaContent("property", "og:image");
const ogLogo = findMetaContent("property", "og:logo");
const twitterCard = findMetaContent("name", "twitter:card");
const twitterTitle = findMetaContent("name", "twitter:title");
const twitterDescription = findMetaContent("name", "twitter:description");
const twitterImage = findMetaContent("name", "twitter:image");

const requiredTextMeta = [
  ["meta description", metaDescription],
  ["Open Graph title", ogTitle],
  ["Open Graph description", ogDescription],
  ["Twitter title", twitterTitle],
  ["Twitter description", twitterDescription],
];

for (const [label, content] of requiredTextMeta) {
  if (!content.trim()) {
    failed = true;
    console.error(`index.html debe incluir ${label} no vacío`);
  }
}

if (!isCanonicalUrl(canonicalUrl)) {
  failed = true;
  console.error("index.html debe incluir canonical con / o URL absoluta http(s)");
}

if (!isCanonicalUrl(ogUrl)) {
  failed = true;
  console.error("index.html debe incluir og:url con / o URL absoluta http(s)");
}

if (canonicalUrl && ogUrl && canonicalUrl !== ogUrl) {
  failed = true;
  console.error("index.html debe mantener canonical y og:url sincronizados");
}

if (faviconHref !== "/favicon.ico") {
  failed = true;
  console.error("index.html debe enlazar /favicon.ico como icono principal");
}

if (twitterCard !== "summary_large_image") {
  failed = true;
  console.error("index.html debe declarar twitter:card=summary_large_image");
}

if (!isPublicAssetUrl(ogImage, "assets/browser-agent-preview.png")) {
  failed = true;
  console.error("index.html debe incluir og:image apuntando a assets/browser-agent-preview.png");
}

if (!isPublicAssetUrl(twitterImage, "assets/browser-agent-preview.png")) {
  failed = true;
  console.error("index.html debe incluir twitter:image apuntando a assets/browser-agent-preview.png");
}

if (!isPublicAssetUrl(ogLogo, "assets/icons/browser-agent-header-64.webp")) {
  failed = true;
  console.error("index.html debe incluir og:logo apuntando a assets/icons/browser-agent-header-64.webp");
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
