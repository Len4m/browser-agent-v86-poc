import assert from "node:assert/strict";
import test from "node:test";

import esCatalog from "../../src/web/locales/es.json";
import { state } from "../../src/browser/app/state";
import { setLang } from "../../src/browser/app/i18n";
import { llmModelOptions, llmModels } from "../../src/browser/chat/state/chat-state";
import { llmAgentRouting } from "../../src/browser/chat/runtime/agent-routing";
import { llmContextBudget } from "../../src/browser/chat/runtime/context-budget";
import webProfile from "../../vm/profiles/alpine-pentest-web.json";

let localeInstalled = false;

async function installSpanishCatalog(): Promise<void> {
  if (localeInstalled) return;
  const globals = globalThis as unknown as {
    fetch: typeof fetch;
    window: Window & typeof globalThis;
    document: Document;
  };
  globals.fetch = (async () => ({
    ok: true,
    json: async () => esCatalog,
  })) as unknown as typeof fetch;
  globals.window = {
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  } as unknown as Window & typeof globalThis;
  globals.document = {
    documentElement: { lang: "" },
  } as unknown as Document;
  await setLang("es", { persist: false, apply: false });
  localeInstalled = true;
}

test("native tool prompt lists selected active tools instead of profile prefix", async () => {
  await installSpanishCatalog();
  state.profiles = [webProfile];
  state.activeRuntime = { profile: webProfile };

  const prompt = llmContextBudget.buildAgentTurnPrompt("usa httpx contra https://example.com", {
    nativeTools: true,
    activeToolNames: ["web.httpx.probe", "vm.sh.exec"],
  });
  const system = prompt.system || "";

  assert.match(system, /Herramientas activas \(2\): web\.httpx\.probe, vm\.sh\.exec/);
  assert.doesNotMatch(system, /Herramientas activas \(\d+\): vm\.python\.exec/);
});

test("network tool names route fair models into the VM tool loop", () => {
  assert.equal(llmAgentRouting.userRequestLikelyNeedsVm("usa httpx contra https://example.com"), true);
  assert.equal(llmAgentRouting.userRequestLikelyNeedsVm("lanza nmap a 192.168.1.10"), true);
  assert.equal(llmAgentRouting.userRequestLikelyNeedsVm("pasa ffuf contra http://target/FUZZ"), true);
  assert.equal(llmAgentRouting.userRequestLikelyNeedsVm("revisa nikto en https://example.com"), true);
});

test("tool fallback heuristic is language-neutral and only matches objective tool signals", () => {
  assert.equal(llmAgentRouting.userRequestLikelyNeedsVm("show directory contents"), false);
  assert.equal(llmAgentRouting.userRequestLikelyNeedsVm("muestra los directorios"), false);
  assert.equal(llmAgentRouting.userRequestLikelyNeedsVm("explica que es Docker"), false);
  assert.equal(llmAgentRouting.userRequestLikelyNeedsVm("explain what a kernel is"), false);

  assert.equal(llmAgentRouting.userRequestLikelyNeedsVm("run httpx against https://example.com"), true);
  assert.equal(llmAgentRouting.userRequestLikelyNeedsVm("lee /etc/os-release"), true);
  assert.equal(llmAgentRouting.userRequestLikelyNeedsVm("check 192.168.1.10 con nmap"), true);
  assert.equal(llmAgentRouting.userRequestLikelyNeedsVm("quiero usar web.httpx.probe"), true);

  const activeTool = llmAgentRouting.resolveToolNeedHeuristic("ejecuta vm.fs.read", {
    activeToolNames: ["vm.fs.read"],
  });
  assert.equal(activeTool.matched, true);
  assert.equal(activeTool.rule, "active-tool-name");
});

test("verified small transformers models can self-select tools before heuristic fallback", () => {
  const qwen3 = llmModels.find((model) => model.id === "qwen3-tools-onnx-q4f16");
  const qwen25 = llmModels.find((model) => model.id === "qwen2.5-coder-0.5b-instruct-q4");
  const glm = llmModels.find((model) => model.id === "glm-edge-1.5b-chat-onnx-q4f16");
  const granite350 = llmModels.find((model) => model.id === "granite-4.0-350m-onnx-web-fp16");

  assert.equal(qwen3?.agent?.toolCalling, "good");
  assert.equal(qwen25?.agent?.toolCalling, "weak");
  assert.equal(qwen25?.agent?.selfSelectTools, true);
  assert.equal(qwen25?.agent?.maxNativeTools, 2);
  assert.equal(glm?.agent?.toolCalling, "fair");
  assert.equal(granite350?.agent?.toolCalling, "fair");
});

test("model context presets expand to the same runtime policy fields", () => {
  const qwen3 = llmModels.find((model) => model.id === "qwen3-tools-onnx-q4f16");
  const qwen25 = llmModels.find((model) => model.id === "qwen2.5-coder-0.5b-instruct-q4");
  const glm = llmModels.find((model) => model.id === "glm-edge-1.5b-chat-onnx-q4f16");
  const granite350 = llmModels.find((model) => model.id === "granite-4.0-350m-onnx-web-fp16");
  const lfm2 = llmModels.find((model) => model.id === "lfm2-tool-1.2b-onnx-fp16");
  const fallback = llmModels.find((model) => model.id === "gemma-3-270m-it-onnx-wasm-fallback");
  const custom = llmModelOptions.find((model) => model.id === "custom-transformersjs");

  assert.equal(qwen3?.contextWindowTokens, 4096);
  assert.equal(qwen3?.contextPreset, "browser-tools-sm");
  assert.equal(qwen3?.contextPolicy?.safeInputTokens, 1100);
  assert.equal(qwen3?.contextPolicy?.maxNewTokensForPlan, 384);
  assert.equal(qwen25?.contextPolicy?.safeInputTokens, 1100);
  assert.equal(qwen25?.contextPolicy?.maxNewTokensForPlan, undefined);
  assert.equal(glm?.contextPreset, "browser-tools-md");
  assert.equal(glm?.contextPolicy?.maxToolResultChars, 2200);
  assert.equal(granite350?.contextPolicy?.maxRuntimeChars, 280);
  assert.equal(lfm2?.contextPolicy?.maxToolResultCharsForSynthesis, 1400);
  assert.equal(fallback?.contextPolicy?.maxHistoryMessages, 0);
  assert.equal(custom?.contextPolicy?.safeInputTokens, 1800);
});
