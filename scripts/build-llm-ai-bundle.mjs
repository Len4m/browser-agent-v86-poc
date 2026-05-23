#!/usr/bin/env node
/**
 * Browser bundles for AI SDK + @browser-ai/transformers-js.
 * Outputs:
 *   public/assets/chat/ai-sdk-browser.mjs
 *   public/assets/chat/workers/llm-browser-ai.worker.mjs
 */
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));

const shared = {
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  logLevel: "info",
  sourcemap: false,
  minify: false,
};

async function main() {
  await esbuild.build({
    ...shared,
    entryPoints: [join(root, "src/chat/provider/ai-sdk/entry.ts")],
    outfile: join(root, "public/assets/chat/ai-sdk-browser.mjs"),
    external: [],
  });

  await esbuild.build({
    ...shared,
    entryPoints: [join(root, "src/chat/provider/ai-sdk/llm-browser-ai.worker.ts")],
    outfile: join(root, "public/assets/chat/workers/llm-browser-ai.worker.mjs"),
  });

  console.log("LLM AI SDK bundles written.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
