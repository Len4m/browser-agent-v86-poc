import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultProfile,
  effectiveMaxSteps,
  exportProfiles,
  HF_RECENTS_STORAGE_KEY,
  importProfiles,
  loadHfRecents,
  loadProfiles,
  PROFILES_STORAGE_KEY,
  recordHfRecent,
  resolveProfile,
  saveProfile,
  validateProfile,
  type StorageLike,
} from "../../src/browser/chat/models/model-profiles";
import { modelKey } from "../../src/browser/chat/models/model-types";

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

test("profiles persist by stable engine:model key and include tool selection", () => {
  const storage = new MemoryStorage();
  const profile = { ...defaultProfile("ollama", "qwen:4b"), activeToolNames: ["vm.shell.exec"] };
  saveProfile(storage, profile);
  assert.deepEqual(loadProfiles(storage)[modelKey("ollama", "qwen:4b")], profile);
  assert.match(storage.getItem(PROFILES_STORAGE_KEY) || "", /vm\.shell\.exec/);
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

test("versioned import rejects invalid roots, reports invalid entries and protects conflicts", () => {
  const original = defaultProfile("ollama", "same:tag");
  const incoming = defaultProfile("transformersjs", "org/new");
  assert.throws(() => importProfiles({ schemaVersion: 2, profiles: [] }, {}), /root schema/);
  const result = importProfiles(
    { schemaVersion: 1, profiles: [incoming, { nope: true }, { ...original, temperature: 0.5 }] },
    { [modelKey(original.engine, original.modelId)]: original },
  );
  assert.equal(result.imported, 1);
  assert.equal(result.invalid, 1);
  assert.deepEqual(result.conflicts, [modelKey(original.engine, original.modelId)]);
  assert.deepEqual(exportProfiles(result.profiles), { schemaVersion: 1, profiles: [original, incoming] });
});

test("HF recents are saved only when explicitly recorded and capped to twenty", () => {
  const storage = new MemoryStorage();
  assert.deepEqual(loadHfRecents(storage), []);
  for (let index = 0; index < 22; index += 1) recordHfRecent(storage, `org/model-${index}`);
  recordHfRecent(storage, "org/model-10");
  const recents = loadHfRecents(storage);
  assert.equal(recents.length, 20);
  assert.equal(recents[0], "org/model-10");
  assert.ok(storage.getItem(HF_RECENTS_STORAGE_KEY));
});
