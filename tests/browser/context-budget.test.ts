import assert from "node:assert/strict";
import test from "node:test";

import esCatalog from "../../src/web/locales/es.json";
import { state } from "../../src/browser/app/state";
import { setLang } from "../../src/browser/app/i18n";
import { modelConfigFromProfile } from "../../src/browser/chat/state/chat-state";
import { defaultProfile } from "../../src/browser/chat/models/model-profiles";
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
  state.activeRuntime = { profile: webProfile } as unknown as typeof state.activeRuntime;

  const prompt = llmContextBudget.buildAgentTurnPrompt("usa httpx contra https://example.com", {
    nativeTools: true,
    activeToolNames: ["web_httpx_probe", "vm_sh_exec"],
  });
  const system = prompt.system || "";

  assert.match(system, /Herramientas activas \(2\): web_httpx_probe, vm_sh_exec/);
  assert.doesNotMatch(system, /Herramientas activas \(\d+\): vm_python_exec/);
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
  assert.equal(llmAgentRouting.userRequestLikelyNeedsVm("quiero usar web_httpx_probe"), true);

  const activeTool = llmAgentRouting.resolveToolNeedHeuristic("ejecuta vm_fs_read", {
    activeToolNames: ["vm_fs_read"],
  });
  assert.equal(activeTool.matched, true);
  assert.equal(activeTool.rule, "active-tool-name");
});

test("off, heuristic and model-first route tools as configured", () => {
  assert.deepEqual(llmAgentRouting.resolveToolRoute("off", true, true), {
    useToolLoop: false, modelMayChooseTools: false, heuristicFallback: false,
  });
  assert.deepEqual(llmAgentRouting.resolveToolRoute("heuristic", false, true), {
    useToolLoop: false, modelMayChooseTools: false, heuristicFallback: false,
  });
  assert.deepEqual(llmAgentRouting.resolveToolRoute("heuristic", true, true), {
    useToolLoop: true, modelMayChooseTools: false, heuristicFallback: true,
  });
  assert.deepEqual(llmAgentRouting.resolveToolRoute("model-first", false, true), {
    useToolLoop: true, modelMayChooseTools: true, heuristicFallback: false,
  });
});

test("generic user profiles drive agent and context policy without model IDs", () => {
  const transformers = defaultProfile("transformersjs", "any/repository");
  transformers.toolCalling = "weak";
  transformers.maxNativeTools = 2;
  transformers.safeInputTokens = 1200;
  transformers.maxNewTokensForPlan = 384;
  transformers.transformersThinking = { enabled: true, tagName: "reason", startWithReasoning: true };
  const config = modelConfigFromProfile(transformers);

  assert.equal(config.agent?.toolStrategy, "model-first");
  assert.equal(config.agent?.toolCalling, "weak");
  assert.equal(config.agent?.maxNativeTools, 2);
  assert.equal(config.thinking?.extract?.tagName, "reason");
  assert.equal(config.contextPolicy?.safeInputTokens, 1200);
  assert.equal(config.contextPolicy?.maxNewTokensForPlan, 384);

  const ollama = modelConfigFromProfile({ ...defaultProfile("ollama", "any:tag"), contextWindowTokens: 32768 });
  assert.equal(ollama.contextPolicy?.contextWindowTokens, 32768);
  assert.equal(ollama.contextPolicy?.maxArtifacts, 4);
});
