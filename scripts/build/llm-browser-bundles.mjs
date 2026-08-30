#!/usr/bin/env node
/**
 * Browser bundles for AI SDK + local LLM inference.
 *
 * Architecture note: the main-thread bundle must expose only the AI SDK API,
 * Ollama HTTP model, orchestration and tools. The Transformers.js/ONNX runtime
 * is owned by llm-browser-ai.worker.mjs so local inference parses one runtime
 * instance, in the worker realm, instead of duplicating it in main + worker.
 * Outputs:
 *   public/assets/chat/ai-sdk-browser.mjs
 *   public/assets/chat/workers/llm-browser-ai.worker.mjs
 */
import * as esbuild from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tsconfigPath = join(root, "tsconfig.json");
const minify = process.env.BA_MINIFY === "1" || process.argv.includes("--minify");
const sourcemap = process.env.BA_SOURCEMAP === "1" || process.argv.includes("--sourcemap");
const browserOutFile = join(root, "public/assets/chat/ai-sdk-browser.mjs");
const workerOutFile = join(root, "public/assets/chat/workers/llm-browser-ai.worker.mjs");
const transformersStubNamespace = "ba-transformers-main-thread-stub";

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
  tsconfig: tsconfigPath,
  bundle: true,
  platform: "browser",
  format: "esm",
  logLevel: "info",
  sourcemap,
  minify,
};

const transformersJsThinkingPatchPlugin = {
  name: "transformers-js-explicit-thinking-flag",
  setup(build) {
    build.onLoad({ filter: /node_modules[\\/]@browser-ai[\\/]transformers-js[\\/]dist[\\/]index\.mjs$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      const implicitThinkingFlag = "...enableThinking ? { enable_thinking: true } : {}";
      const thinkingFlagMatches = source.split(implicitThinkingFlag).length - 1;
      if (thinkingFlagMatches !== 1) {
        throw new Error(`@browser-ai/transformers-js thinking flag patch expected one match, found ${thinkingFlagMatches}.`);
      }
      const requiredGenerationCacheHooks = ["this.past_key_values_cache", "clearGenerationCache()"];
      const missingGenerationCacheHooks = requiredGenerationCacheHooks.filter((hook) => !source.includes(hook));
      if (missingGenerationCacheHooks.length > 0) {
        throw new Error(`@browser-ai/transformers-js no longer exposes the worker cache hooks used by llm-browser-ai.worker.ts: ${missingGenerationCacheHooks.join(", ")}`);
      }
      return {
        contents: source.replace(implicitThinkingFlag, "enable_thinking: Boolean(enableThinking)"),
        loader: "js",
      };
    });
  },
};

const transformersMainThreadStubPlugin = {
  name: "transformers-js-main-thread-runtime-stub",
  setup(build) {
    build.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({
      path: "@huggingface/transformers",
      namespace: transformersStubNamespace,
    }));
    build.onLoad({ filter: /.*/, namespace: transformersStubNamespace }, () => ({
      loader: "js",
      contents: `
const mainThreadInferenceError = (operation) => new Error(
  "Transformers.js main-thread inference is disabled in Browser Agent v86 (" + operation + "). Pass the dedicated LLM worker to transformersJS().",
);
const unavailableModel = (name) => Object.freeze({
  from_pretrained() {
    throw mainThreadInferenceError(name + ".from_pretrained");
  },
});

export const env = {};
export const AutoTokenizer = unavailableModel("AutoTokenizer");
export const AutoModelForCausalLM = unavailableModel("AutoModelForCausalLM");
export const AutoProcessor = unavailableModel("AutoProcessor");
export const AutoModelForImageTextToText = unavailableModel("AutoModelForImageTextToText");
export const WhisperForConditionalGeneration = unavailableModel("WhisperForConditionalGeneration");

export class StoppingCriteria {
  _call() {
    throw mainThreadInferenceError("StoppingCriteria");
  }
}
export class InterruptableStoppingCriteria extends StoppingCriteria {
  interrupt() {
    throw mainThreadInferenceError("InterruptableStoppingCriteria.interrupt");
  }
  reset() {
    throw mainThreadInferenceError("InterruptableStoppingCriteria.reset");
  }
}
export class StoppingCriteriaList {
  constructor() {
    throw mainThreadInferenceError("StoppingCriteriaList");
  }
}
export class TextStreamer {
  constructor() {
    throw mainThreadInferenceError("TextStreamer");
  }
}

export function pipeline() {
  throw mainThreadInferenceError("pipeline");
}
export function load_image() {
  throw mainThreadInferenceError("load_image");
}
export function full() {
  throw mainThreadInferenceError("full");
}
`,
    }));
  },
};

function normalizedInputPaths(result) {
  return Object.keys(result.metafile?.inputs || {}).map((input) => input.replaceAll("\\", "/"));
}

function isHuggingFaceRuntimeInput(input) {
  return input.includes("node_modules/@huggingface/transformers/")
    || input.includes("node_modules/.pnpm/@huggingface+transformers@");
}

function isOnnxRuntimeInput(input) {
  return input.includes("node_modules/onnxruntime-")
    || input.includes("node_modules/.pnpm/onnxruntime-");
}

function isRuntimeImportSpecifier(input) {
  return input === "@huggingface/transformers"
    || input.startsWith("@huggingface/transformers/")
    || input.startsWith("onnxruntime-");
}

function externalRuntimeImports(result) {
  return Object.values(result.metafile?.outputs || {})
    .flatMap((output) => output.imports || [])
    .filter((entry) => entry.external && isRuntimeImportSpecifier(entry.path));
}

function assertRuntimePlacement(browserBuild, workerBuild) {
  const browserInputs = normalizedInputPaths(browserBuild);
  const workerInputs = normalizedInputPaths(workerBuild);
  const browserStubInputs = browserInputs.filter((input) => input.startsWith(`${transformersStubNamespace}:`));
  const workerStubInputs = workerInputs.filter((input) => input.startsWith(`${transformersStubNamespace}:`));
  const unexpectedMainInputs = browserInputs.filter((input) => (
    isHuggingFaceRuntimeInput(input) || isOnnxRuntimeInput(input)
  ));
  if (unexpectedMainInputs.length > 0) {
    throw new Error(`The main AI SDK bundle contains Transformers/ONNX runtime inputs:\n${unexpectedMainInputs.join("\n")}`);
  }
  if (!workerInputs.some(isHuggingFaceRuntimeInput)) {
    throw new Error("The LLM worker bundle does not contain @huggingface/transformers.");
  }
  if (!workerInputs.some(isOnnxRuntimeInput)) {
    throw new Error("The LLM worker bundle does not contain the ONNX runtime.");
  }
  if (browserStubInputs.length !== 1) {
    throw new Error(`The main AI SDK bundle must contain exactly one Transformers runtime stub (found ${browserStubInputs.length}).`);
  }
  if (workerStubInputs.length > 0) {
    throw new Error("The Transformers runtime stub leaked into the LLM worker bundle.");
  }
  const externalImports = [
    ...externalRuntimeImports(browserBuild),
    ...externalRuntimeImports(workerBuild),
  ];
  if (externalImports.length > 0) {
    throw new Error(`Transformers/ONNX runtime imports must be bundled, not external:\n${externalImports.map((entry) => entry.path).join("\n")}`);
  }
}

async function main() {
  const browserBuild = await esbuild.build({
    ...shared,
    entryPoints: [join(root, "src/browser/chat/provider/ai-sdk/entry.ts")],
    outfile: browserOutFile,
    metafile: true,
    plugins: [transformersJsThinkingPatchPlugin, transformersMainThreadStubPlugin],
  });

  const workerBuild = await esbuild.build({
    ...shared,
    entryPoints: [join(root, "src/browser/chat/provider/ai-sdk/llm-browser-ai.worker.ts")],
    outfile: workerOutFile,
    metafile: true,
    plugins: [transformersJsThinkingPatchPlugin],
  });

  assertRuntimePlacement(browserBuild, workerBuild);

  console.log(`LLM AI SDK bundles written (${minify ? "minified" : "dev"}, sourcemap ${sourcemap ? "on" : "off"}).`);
  console.log(`  public/assets/chat/ai-sdk-browser.mjs ${sizeSummary(browserOutFile)}`);
  console.log(`  public/assets/chat/workers/llm-browser-ai.worker.mjs ${sizeSummary(workerOutFile)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
