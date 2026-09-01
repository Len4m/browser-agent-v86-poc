import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultProfile,
  effectiveMaxSteps,
  LAST_PROFILE_STORAGE_KEY,
  loadLastProfile,
  resolveProfile,
  saveLastProfile,
  validateProfile,
  type StorageLike,
} from "../../src/browser/chat/models/model-profiles";

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test("engine defaults provide a complete agent without model recommendations", () => {
  const transformers = defaultProfile("transformersjs", "org/model");
  const ollama = defaultProfile("ollama", "model:tag");
  assert.deepEqual(
    [transformers.toolStrategy, transformers.toolCalling, transformers.maxSteps, transformers.maxNativeTools, transformers.contextWindowTokens, transformers.safeInputTokens],
    ["model-first", "good", 3, 4, 4096, 1800],
  );
  assert.deepEqual(
    [ollama.toolStrategy, ollama.toolCalling, ollama.maxSteps, ollama.maxNativeTools, ollama.contextWindowTokens],
    ["model-first", "good", 4, 10, 8192],
  );
});

test("profile precedence is defaults, inspection, saved profile, current selection", () => {
  const saved = { ...defaultProfile("transformersjs", "org/model"), contextWindowTokens: 8192, temperature: 0.4 };
  const resolved = resolveProfile(
    "transformersjs",
    "org/model",
    {
      modelId: "org/model",
      availableDtypes: ["q4"],
      files: [],
      contextWindowTokens: 32768,
      capabilities: { chat: true, tools: null, thinking: null, vision: false },
      warnings: [],
      inspected: true,
    },
    saved,
    { temperature: 0.2 },
  );
  assert.equal(resolved.contextWindowTokens, 8192);
  assert.equal(resolved.temperature, 0.2);
  assert.equal(resolveProfile("transformersjs", "org/model", null, { ...saved, device: "wasm", dtype: "q8" }).device, "wasm");
});

test("weak and fair cap effective tool steps", () => {
  assert.equal(effectiveMaxSteps({ toolCalling: "weak", maxSteps: 8 }), 1);
  assert.equal(effectiveMaxSteps({ toolCalling: "fair", maxSteps: 8 }), 2);
  assert.equal(effectiveMaxSteps({ toolCalling: "good", maxSteps: 8 }), 8);
});

test("only the last selected model configuration is persisted", () => {
  const storage = new MemoryStorage();
  const first = { ...defaultProfile("ollama", "qwen:4b"), activeToolNames: ["vm.shell.exec"] };
  const last = defaultProfile("transformersjs", "org/model");
  saveLastProfile(storage, first);
  assert.deepEqual(loadLastProfile(storage), first);
  saveLastProfile(storage, last);
  assert.deepEqual(loadLastProfile(storage), last);
  assert.equal(JSON.parse(storage.getItem(LAST_PROFILE_STORAGE_KEY) || "null").modelId, "org/model");
});

test("profile validation enforces enums and clamps numeric limits", () => {
  const profile = defaultProfile("transformersjs", "org/model");
  const valid = validateProfile({ ...profile, maxSteps: 99, maxNativeTools: 99, temperature: 9, topP: 9 });
  assert.equal(valid?.maxSteps, 8);
  assert.equal(valid?.maxNativeTools, 12);
  assert.equal(valid?.temperature, 2);
  assert.equal(valid?.topP, 1);
  assert.equal(validateProfile({ ...profile, toolStrategy: "magic" }), null);
});
