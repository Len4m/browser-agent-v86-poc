import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWasmFallbackConfig,
  isGpuRuntimeFailure,
  resolveTransformersRuntimeConfig,
  selectWasmDtype,
} from "../../src/browser/chat/models/transformers-runtime";
import type { LlmModelConfig } from "../../src/browser/chat/state/chat-state";

function model(overrides: Partial<LlmModelConfig> = {}): LlmModelConfig {
  return {
    id: "transformersjs:org/model",
    engine: "transformersjs",
    model: "org/model",
    device: "auto",
    dtype: "q4",
    ...overrides,
  };
}

test("WASM fallback accepts auto and explicit WebGPU profiles", () => {
  assert.equal(buildWasmFallbackConfig(model({ device: "auto" }))?.device, "wasm");
  assert.equal(buildWasmFallbackConfig(model({ device: "webgpu" }))?.device, "wasm");
  assert.equal(buildWasmFallbackConfig(model({ device: "wasm" })), null);
  assert.equal(buildWasmFallbackConfig(model({ engine: "ollama", device: undefined })), null);
});

test("WASM fallback chooses a quantization that actually exists in the repository", () => {
  const config = model({
    device: "webgpu",
    dtype: "q4f16",
    inspection: {
      modelId: "org/model",
      availableDtypes: ["q4f16", "q4"],
      files: [],
      capabilities: { chat: true, tools: true, thinking: null, vision: false },
      warnings: [],
      inspected: true,
    },
  });
  assert.equal(selectWasmDtype(config), "q4");
  assert.equal(buildWasmFallbackConfig(config)?.dtype, "q4");
  assert.equal(selectWasmDtype(model({ dtype: "q4f16", inspection: null })), "q8");
});

test("Firefox-style WebGPU availability errors trigger fallback but network errors do not", () => {
  assert.equal(isGpuRuntimeFailure('Unsupported device: "webgpu". Should be one of: wasm.'), true);
  assert.equal(isGpuRuntimeFailure("WebGPU is not supported in this browser"), true);
  assert.equal(isGpuRuntimeFailure("navigator.gpu is undefined"), true);
  assert.equal(isGpuRuntimeFailure("Failed to fetch model.onnx"), false);
});

test("a saved WebGPU profile is resolved to WASM when Firefox has no WebGPU", () => {
  const selected = model({ device: "webgpu", dtype: "q4" });
  const resolved = resolveTransformersRuntimeConfig(selected, { webgpu: false });
  assert.equal(resolved.device, "wasm");
  assert.equal(resolved.dtype, "q4");
  assert.equal(resolved.fallbackFrom, selected.id);
  assert.equal(resolved.fallbackReason, "webgpu-unavailable");
  assert.equal(resolveTransformersRuntimeConfig(selected, { webgpu: true }), selected);
});
