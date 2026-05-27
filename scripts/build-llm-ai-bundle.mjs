#!/usr/bin/env node
/**
 * Browser bundles for AI SDK + @browser-ai/transformers-js.
 * Outputs:
 *   public/assets/chat/ai-sdk-browser.mjs
 *   public/assets/chat/workers/llm-browser-ai.worker.mjs
 */
import * as esbuild from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const minify = process.env.BA_MINIFY === "1" || process.argv.includes("--minify");
const sourcemap = process.env.BA_SOURCEMAP === "1" || process.argv.includes("--sourcemap");
const browserOutFile = join(root, "public/assets/chat/ai-sdk-browser.mjs");
const workerOutFile = join(root, "public/assets/chat/workers/llm-browser-ai.worker.mjs");

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

const shared = {
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  logLevel: "info",
  sourcemap,
  minify,
};

async function main() {
  await esbuild.build({
    ...shared,
    entryPoints: [join(root, "src/chat/provider/ai-sdk/entry.ts")],
    outfile: browserOutFile,
    external: [],
  });

  await esbuild.build({
    ...shared,
    entryPoints: [join(root, "src/chat/provider/ai-sdk/llm-browser-ai.worker.ts")],
    outfile: workerOutFile,
  });

  console.log(`LLM AI SDK bundles written (${minify ? "minified" : "dev"}, sourcemap ${sourcemap ? "on" : "off"}).`);
  console.log(`  public/assets/chat/ai-sdk-browser.mjs ${sizeSummary(browserOutFile)}`);
  console.log(`  public/assets/chat/workers/llm-browser-ai.worker.mjs ${sizeSummary(workerOutFile)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
