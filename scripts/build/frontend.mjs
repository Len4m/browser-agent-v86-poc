#!/usr/bin/env node
/**
 * Builds the browser application shell.
 *
 * Some browser sources still use classic global lexical dependencies. This
 * build keeps that behavior by bundling the
 * TypeScript entry first and then appending the transitional domain sources in
 * the old runtime order. Those files now live under domain folders so they can
 * be typed/refactored incrementally without exposing load order in public/.
 */
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const publicRoot = join(root, "public");
const outFile = join(root, "public/assets/app.js");
const cssBundleFile = join(root, "public/assets/app.css");
const bridgeOutFile = join(root, "public/assets/ai-sdk-bridge.mjs");
const indexFile = join(root, "public/index.html");
const styleFile = join(root, "public/style.css");
const sourceIndexFile = join(root, "src/web/index.html");
const sourceStyleFile = join(root, "src/web/styles/style.css");
const sourceStylesDir = join(root, "src/web/styles");
const publicStylesDir = join(root, "public/styles");
const sourceLocalesDir = join(root, "src/web/locales");
const publicLocalesDir = join(root, "public/locales");
const tempFile = join(root, "build/browser/app-entry.js");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const appVersion = packageJson.version || "0.0.0";

const browserSourceOrder = [
  "src/browser/console/xterm-consoles.ts",
  "src/browser/vm/serial-vm.ts",
  "src/browser/vm/background-tools-serial1.ts",
  "src/browser/vm/console-control-serial2.ts",
  "src/browser/vm/operations.ts",
  "src/browser/ui/checks-panel.ts",
  "build/browser/generated/10a-llm-models-catalog.js",
  "src/browser/chat/state/chat-state.ts",
  "src/browser/chat/state/capabilities.ts",
  "src/browser/app/bootstrap.ts",
  "src/browser/chat/rendering/markdown-renderer.ts",
  "src/browser/chat/tools/tool-registry.ts",
  "src/browser/chat/tools/ai-tools.ts",
  "src/browser/chat/tools/tool-executor.ts",
  "src/browser/chat/tools/native-tools-policy.ts",
  "src/browser/chat/runtime/artifact-store.ts",
  "src/browser/chat/runtime/context-budget.ts",
  "src/browser/chat/runtime/tool-result-policy.ts",
  "src/browser/chat/runtime/resource-governor.ts",
  "src/browser/chat/runtime/agent-debug.ts",
  "src/browser/chat/runtime/agent-routing.ts",
  "src/browser/chat/runtime/chat-ui.ts",
  "src/browser/chat/runtime/agent-loop.ts",
  "src/browser/chat/panel/template.ts",
  "src/browser/chat/panel/capabilities-view.ts",
  "src/browser/chat/panel/panel.ts",
];

const minify = process.env.BA_MINIFY === "1" || process.argv.includes("--minify");
const sourcemap = process.env.BA_SOURCEMAP === "1" || process.argv.includes("--sourcemap");

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function sizeSummary(file) {
  const content = readFileSync(file);
  return `${formatBytes(statSync(file).size)} / gzip ${formatBytes(gzipSync(content).length)}`;
}

async function legacySourceForBundle(file) {
  const source = readFileSync(file, "utf8");
  if (!minify) return source;
  const result = await esbuild.transform(source, {
    loader: file.endsWith(".ts") ? "ts" : "js",
    target: ["es2022"],
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    sourcemap: false,
  });
  return result.code.trim();
}

function cacheKeyForContent(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function cacheKeyForPublicFile(relativePath) {
  return cacheKeyForContent(readFileSync(join(root, "public", relativePath)));
}

function versionedPublicPath(relativePath) {
  return `/${relativePath.replace(/^\/+/, "")}?v=${cacheKeyForPublicFile(relativePath)}`;
}

function publicHref(relativePath) {
  return `./${relativePath.replace(/^\/+/, "")}?v=${cacheKeyForPublicFile(relativePath)}`;
}

function normalizePublicSiteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`BA_PUBLIC_SITE_URL debe usar http o https: ${raw}`);
  }
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

const publicSiteUrl = normalizePublicSiteUrl(process.env.BA_PUBLIC_SITE_URL);
const canonicalUrl = publicSiteUrl || "/";

function publicAssetUrl(relativePath) {
  const clean = relativePath.replace(/^\/+/, "");
  return publicSiteUrl ? new URL(clean, publicSiteUrl).href : `/${clean}`;
}

function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderIndexHtml({ cssHref, bridgeHref, appHref }) {
  return readFileSync(sourceIndexFile, "utf8")
    .replaceAll("%BA_CANONICAL_URL%", escapeHtmlAttr(canonicalUrl))
    .replaceAll("%BA_SOCIAL_IMAGE_URL%", escapeHtmlAttr(publicAssetUrl("assets/browser-agent-preview.png")))
    .replaceAll("%BA_SOCIAL_LOGO_URL%", escapeHtmlAttr(publicAssetUrl("assets/icons/browser-agent-header-64.webp")))
    .replaceAll("%BA_APP_VERSION%", escapeHtmlAttr(appVersion))
    .replace(/href="\.\/vendor\/xterm\/xterm\.css(?:\?v=[^"]*)?"/g, `href="./vendor/xterm/xterm.css?v=${cacheKeyForPublicFile("vendor/xterm/xterm.css")}"`)
    .replace(/href="\.\/(?:style\.css|assets\/app\.css)(?:\?v=[^"]*)?"/g, `href="${cssHref}"`)
    .replace(/id="cfg-bzimage" type="hidden" value="[^"]*"/g, `id="cfg-bzimage" type="hidden" value="${versionedPublicPath("v86/images/alpine-vmlinuz-lts")}"`)
    .replace(/id="cfg-initrd" type="hidden" value="[^"]*"/g, `id="cfg-initrd" type="hidden" value="${versionedPublicPath("v86/images/profiles/alpine-base-initramfs.gz")}"`)
    .replace(/src="\.\/vendor\/xterm\/xterm\.js(?:\?v=[^"]*)?"/g, `src="${publicHref("vendor/xterm/xterm.js")}"`)
    .replace(/src="\.\/assets\/ai-sdk-bridge\.mjs(?:\?v=[^"]*)?"/g, `src="${bridgeHref}"`)
    .replace(/src="\.\/assets\/app\.js(?:\?v=[^"]*)?"/g, `src="${appHref}"`);
}

function copyCssSources() {
  rmSync(publicStylesDir, { recursive: true, force: true });
  mkdirSync(publicStylesDir, { recursive: true });
  for (const file of readdirSync(sourceStylesDir).filter((name) => name.endsWith(".css") && name !== "style.css").sort()) {
    copyFileSync(join(sourceStylesDir, file), join(publicStylesDir, file));
  }
}

function copyLocaleSources() {
  if (!existsSync(sourceLocalesDir)) return [];
  rmSync(publicLocalesDir, { recursive: true, force: true });
  mkdirSync(publicLocalesDir, { recursive: true });
  const files = readdirSync(sourceLocalesDir).filter((name) => name.endsWith(".json")).sort();
  for (const file of files) {
    copyFileSync(join(sourceLocalesDir, file), join(publicLocalesDir, file));
  }
  return files;
}

mkdirSync(dirname(tempFile), { recursive: true });
mkdirSync(dirname(outFile), { recursive: true });
copyCssSources();
const localeFiles = copyLocaleSources();

const styleCss = readFileSync(sourceStyleFile, "utf8")
  .replace(/@import url\("(\.\/styles\/[^"?]+\.css)(?:\?v=[^"]*)?"\);/g, (_match, url) => {
    const relativePath = url.replace(/^\.\//, "");
    return `@import url("${url}?v=${cacheKeyForPublicFile(relativePath)}");`;
  });
writeFileSync(styleFile, styleCss, "utf8");

let cssHref = `./style.css?v=${cacheKeyForContent(styleCss)}`;
if (minify) {
  await esbuild.build({
    stdin: {
      contents: styleCss.replace(/\?v=[^")]+/g, ""),
      resolveDir: publicRoot,
      sourcefile: "style.css",
      loader: "css",
    },
    outfile: cssBundleFile,
    bundle: true,
    platform: "browser",
    target: ["es2022"],
    external: ["/assets/*"],
    sourcemap,
    minify: true,
    logLevel: "silent",
  });
  cssHref = `./assets/app.css?v=${cacheKeyForPublicFile("assets/app.css")}`;
}

await esbuild.build({
  entryPoints: [join(root, "src/browser/main.ts")],
  outfile: tempFile,
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2022"],
  sourcemap,
  minify,
  define: {
    __BA_BROWSER_SOURCE_ORDER__: JSON.stringify(browserSourceOrder),
  },
  logLevel: "silent",
});

await esbuild.build({
  entryPoints: [join(root, "src/browser/chat/provider/ai-sdk-bridge.ts")],
  outfile: bridgeOutFile,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  sourcemap,
  minify,
  external: ["./chat/ai-sdk-browser.mjs*"],
  logLevel: "silent",
});

const chunks = [
  "/* AUTO-GENERATED by scripts/build/frontend.mjs. Do not edit directly. */",
  readFileSync(tempFile, "utf8"),
];

for (const script of browserSourceOrder) {
  const abs = join(root, script);
  chunks.push(`\n/* ---- ${script} ---- */\n`);
  chunks.push(await legacySourceForBundle(abs));
  chunks.push("\n");
}

writeFileSync(outFile, chunks.join("\n"), "utf8");
writeFileSync(indexFile, renderIndexHtml({
  cssHref,
  bridgeHref: publicHref("assets/ai-sdk-bridge.mjs"),
  appHref: publicHref("assets/app.js"),
}), "utf8");
console.log(`OK frontend bundle: public/assets/app.js (${browserSourceOrder.length} ordered sources, ${sizeSummary(outFile)})`);
console.log(`OK AI SDK bridge: public/assets/ai-sdk-bridge.mjs (${sizeSummary(bridgeOutFile)})`);
if (localeFiles.length) console.log(`OK i18n locales: public/locales/ (${localeFiles.join(", ")})`);
if (minify) console.log(`OK CSS bundle: public/assets/app.css (${sizeSummary(cssBundleFile)})`);
console.log(publicSiteUrl
  ? `OK SEO metadata: ${publicSiteUrl}`
  : "OK SEO metadata: origin-relative URLs (set BA_PUBLIC_SITE_URL for absolute canonical/social URLs)");
