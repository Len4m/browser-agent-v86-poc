import assert from "node:assert/strict";
import test from "node:test";

import {
  requiresLlmRuntimeReload,
  resolveTurnModelConfig,
} from "../../src/browser/chat/models/model-config";
import { defaultProfile } from "../../src/browser/chat/models/model-profiles";
import type { LlmModelConfig } from "../../src/browser/chat/state/chat-state";

function transformersConfig(overrides: Partial<LlmModelConfig> = {}): LlmModelConfig {
  const profile = defaultProfile("transformersjs", "org/model");
  return {
    id: "transformersjs:org/model",
    engine: "transformersjs",
    model: "org/model",
    device: profile.device,
    dtype: profile.dtype,
    temperature: profile.temperature,
    topP: profile.topP,
    contextWindowTokens: profile.contextWindowTokens,
    contextPolicy: {
      contextWindowTokens: profile.contextWindowTokens,
      safeInputTokens: profile.safeInputTokens,
      maxOutputTokens: profile.maxOutputTokens,
      maxNewTokensForPlan: profile.maxNewTokensForPlan,
    },
    agent: {
      maxSteps: profile.maxSteps,
      maxNativeTools: profile.maxNativeTools,
      toolCalling: profile.toolCalling,
      toolStrategy: profile.toolStrategy,
      activeToolNames: profile.activeToolNames,
    },
    thinking: {
      enabled: profile.transformersThinking?.enabled,
      generate: profile.transformersThinking?.enabled,
      extract: profile.transformersThinking,
    },
    profile,
    ...overrides,
  };
}

test("turn settings do not require recreating a loaded Transformers runtime", () => {
  const active = transformersConfig();
  const profile = {
    ...active.profile!,
    toolStrategy: "off" as const,
    maxSteps: 7,
    maxNativeTools: 2,
    temperature: 0.6,
    topP: 0.7,
    contextWindowTokens: 8192,
    safeInputTokens: 3000,
    maxOutputTokens: 700,
    maxNewTokensForPlan: 300,
    showThinking: true,
  };
  const selected = transformersConfig({
    temperature: profile.temperature,
    topP: profile.topP,
    contextWindowTokens: profile.contextWindowTokens,
    contextPolicy: {
      contextWindowTokens: profile.contextWindowTokens,
      safeInputTokens: profile.safeInputTokens,
      maxOutputTokens: profile.maxOutputTokens,
      maxNewTokensForPlan: profile.maxNewTokensForPlan,
    },
    agent: {
      ...active.agent!,
      maxSteps: profile.maxSteps,
      maxNativeTools: profile.maxNativeTools,
      toolStrategy: profile.toolStrategy,
    },
    profile,
  });

  assert.equal(requiresLlmRuntimeReload(active, selected), false);
  const turn = resolveTurnModelConfig(active, selected);
  assert.equal(turn.temperature, 0.6);
  assert.equal(turn.agent?.maxSteps, 7);
  assert.equal(turn.contextPolicy?.safeInputTokens, 3000);
  assert.notEqual(turn, active);
  assert.notEqual(turn.agent, selected.agent);
});

test("worker-bound Transformers settings require a runtime reload", () => {
  const active = transformersConfig();
  const changes = [
    { ...active.profile!, device: "wasm" },
    { ...active.profile!, dtype: "q8" },
    { ...active.profile!, reuseGenerationCache: false },
    { ...active.profile!, transformersThinking: { enabled: true, tagName: "think", startWithReasoning: false } },
    { ...active.profile!, transformersThinking: { enabled: true, tagName: "reasoning", startWithReasoning: false } },
    { ...active.profile!, transformersThinking: { enabled: true, tagName: "think", startWithReasoning: true } },
  ];
  for (const profile of changes) {
    assert.equal(requiresLlmRuntimeReload(active, transformersConfig({ profile })), true);
  }
});

test("inactive reasoning parser details can change without reloading", () => {
  const active = transformersConfig();
  const profile = {
    ...active.profile!,
    transformersThinking: { enabled: false, tagName: "reasoning", startWithReasoning: true },
  };
  assert.equal(requiresLlmRuntimeReload(active, transformersConfig({ profile })), false);
});

test("a WASM fallback compares the requested profile rather than its fallback device", () => {
  const selected = transformersConfig();
  const fallback = transformersConfig({
    id: `${selected.id}-wasm-fallback`,
    device: "wasm",
    dtype: "q8",
    fallbackFrom: selected.id,
    fallbackReason: "webgpu-runtime-failure",
  });
  assert.equal(requiresLlmRuntimeReload(fallback, selected), false);
});

test("Ollama turn settings are hot but its captured thinking mode is not", () => {
  const profile = defaultProfile("ollama", "qwen:4b");
  const active: LlmModelConfig = {
    id: "ollama:qwen:4b",
    engine: "ollama",
    model: "qwen:4b",
    temperature: profile.temperature,
    profile,
    thinking: { enabled: true, generate: undefined },
  };
  assert.equal(requiresLlmRuntimeReload(active, {
    ...active,
    temperature: 0.8,
    profile: { ...profile, temperature: 0.8, showThinking: true },
  }), false);
  assert.equal(requiresLlmRuntimeReload(active, {
    ...active,
    profile: { ...profile, ollamaThink: "high" },
  }), true);
});
