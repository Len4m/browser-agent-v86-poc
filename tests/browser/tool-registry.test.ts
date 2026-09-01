import assert from "node:assert/strict";
import test from "node:test";

import baseProfile from "../../vm/profiles/alpine-base.json";
import liteProfile from "../../vm/profiles/alpine-pentest-lite.json";
import webProfile from "../../vm/profiles/alpine-pentest-web.json";
import { state } from "../../src/browser/app/state";
import { llmNativeToolsPolicy } from "../../src/browser/chat/tools/native-tools-policy";
import { llmToolRegistry } from "../../src/browser/chat/tools/tool-registry";
import type { AiSdkObjectSchemaLike, AiSdkZodLike } from "../../src/browser/chat/provider/ai-sdk-runtime";
import { modelConfigFromProfile, type LlmModelConfig } from "../../src/browser/chat/state/chat-state";
import { defaultProfile } from "../../src/browser/chat/models/model-profiles";
import { TOOL_DEFINITIONS } from "virtual:ba-tools";

const manualTools = [
  "vm_python_exec",
  "vm_sh_exec",
  "vm_fs_list",
  "vm_fs_read",
  "vm_fs_write",
  "vm_cmd_which",
  "web_curl_head",
  "vm_sys_info",
  "vm_console_status",
  "vm_pkg_info",
  "web_curl_fetch_text",
];

function installProfiles(): void {
  state.profiles = [baseProfile, liteProfile, webProfile];
}

function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const fakeStorage = {
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key); },
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    get length() { return store.size; },
  } satisfies Storage;
  Object.defineProperty(globalThis, "localStorage", {
    value: fakeStorage,
    configurable: true,
  });
  return store;
}

test("manual profile exposes only the current base tool allowlist in priority order", () => {
  assert.deepEqual(llmToolRegistry.listToolNames({ profileId: "manual" }), manualTools);
});

test("VM profiles expose allowedTools order from source JSON", () => {
  installProfiles();

  assert.deepEqual(llmToolRegistry.listToolNames({ profileId: "alpine-base" }), baseProfile.allowedTools);
  assert.deepEqual(llmToolRegistry.listToolNames({ profileId: "alpine-pentest-lite" }), liteProfile.allowedTools);
  assert.deepEqual(llmToolRegistry.listToolNames({ profileId: "alpine-pentest-web" }), webProfile.allowedTools);
});

test("VM profile tool metadata preserves allowedTools priority order", () => {
  installProfiles();

  assert.deepEqual(
    llmToolRegistry.listTools({ profileId: "alpine-pentest-web" }).map((tool) => tool.name),
    webProfile.allowedTools,
  );
});

test("native tool defaults use profile priority and model quantity limit", () => {
  installProfiles();
  const model: LlmModelConfig = {
    id: "test-model",
    engine: "transformersjs",
    agent: {
      maxSteps: 2,
      maxNativeTools: 2,
      toolCalling: "fair",
    },
  };

  assert.deepEqual(llmNativeToolsPolicy.getDefaultToolNames(model, "alpine-base"), [
    "vm_python_exec",
    "vm_sh_exec",
  ]);
});

test("native active tools are resolved in profile priority order and capped", () => {
  installProfiles();
  installLocalStorage();
  const profile = defaultProfile("transformersjs", "org/ordered-model");
  profile.maxSteps = 2;
  profile.maxNativeTools = 3;
  profile.toolCalling = "fair";
  profile.activeToolNames = ["web_httpx_probe", "web_curl_head", "vm_sh_exec", "vm_python_exec"];
  const model = modelConfigFromProfile(profile);

  assert.deepEqual(llmNativeToolsPolicy.resolveActiveToolNames(model, "alpine-pentest-web"), [
    "vm_python_exec",
    "vm_sh_exec",
    "web_curl_head",
  ]);
  assert.deepEqual(
    llmNativeToolsPolicy.setActiveToolNames(model, [
      "web_httpx_probe",
      "vm_sh_exec",
      "web_curl_head",
    ], "alpine-pentest-web"),
    [
      "vm_sh_exec",
      "web_curl_head",
      "web_httpx_probe",
    ],
  );
});

test("legacy dotted tool names are normalized at profile and storage boundaries", () => {
  installLocalStorage();
  state.profiles = [{
    ...baseProfile,
    id: "legacy-names",
    allowedTools: ["vm.fs.read", "web.curl.head"],
  }];
  const profile = defaultProfile("transformersjs", "org/legacy-model");
  profile.maxSteps = 2;
  profile.maxNativeTools = 2;
  profile.toolCalling = "fair";
  profile.activeToolNames = ["web.curl.head", "vm.fs.read"];
  const model = modelConfigFromProfile(profile);

  assert.deepEqual(llmToolRegistry.listToolNames({ profileId: "legacy-names" }), [
    "vm_fs_read",
    "web_curl_head",
  ]);
  assert.deepEqual(llmNativeToolsPolicy.resolveActiveToolNames(model, "legacy-names"), [
    "vm_fs_read",
    "web_curl_head",
  ]);
  assert.equal(llmToolRegistry.getTool("vm.fs.read")?.name, "vm_fs_read");
});

test("tools missing required profile packages are not exposed", () => {
  state.profiles = [{
    ...baseProfile,
    id: "missing-packages",
    packages: [],
    allowedTools: ["web_curl_head", "vm_sh_exec"],
  }];

  assert.deepEqual(llmToolRegistry.listToolNames({ profileId: "missing-packages" }), ["vm_sh_exec"]);
  assert.deepEqual(
    llmToolRegistry.listToolNames({ profileId: "missing-packages", includeUnavailable: true }),
    ["web_curl_head", "vm_sh_exec"],
  );
  assert.deepEqual(llmToolRegistry.listToolRuntimeChecks({ profileId: "missing-packages" }), []);
  assert.deepEqual(
    llmToolRegistry.listToolRuntimeChecks({ profileId: "missing-packages", includeUnavailable: true }),
    [{ label: "curl", command: "command -v curl" }],
  );
});

test("tool runtime checks are derived from allowed tool definitions", () => {
  installProfiles();

  assert.deepEqual(
    llmToolRegistry.listToolRuntimeChecks({ profileId: "alpine-base", includeUnavailable: true }),
    [
      { label: "python3", command: "command -v python3" },
      { label: "curl", command: "command -v curl" },
    ],
  );

  assert.deepEqual(
    llmToolRegistry.listToolRuntimeChecks({ profileId: "alpine-pentest-web", includeUnavailable: true }).map((check) => check.label),
    [
      "python3",
      "curl",
      "dig",
      "ip",
      "nmap",
      "ffuf",
      "httpx",
      "nikto.pl",
      "timeout",
      "Net::SSLeay",
      "IO::Socket::SSL",
      "openssl",
    ],
  );
});

test("Nikto tool uses the nikto.pl profile contract", () => {
  const tool = llmToolRegistry.getTool("web_nikto_quick");
  assert.ok(tool);
  const normalizeArgs = tool.normalizeArgs;
  if (typeof normalizeArgs !== "function") throw new Error("Nikto tool must normalize args");

  const args = normalizeArgs({
    url: "https://example.com",
    maxTimeSec: 60,
    timeoutSec: 5,
    tuning: "123b",
  });
  const command = tool.buildCommand(args);

  assert.match(command, /command -v 'nikto\.pl'/);
  assert.match(command, /command -v 'timeout'/);
  assert.match(command, /timeout 75s nikto\.pl/);
  assert.doesNotMatch(command, /nikto_cmd|nikto_run|\/usr\/share\/nikto|command -v 'nikto'/);
});

test("HTTPX tool uses the profile httpx command directly", () => {
  const tool = llmToolRegistry.getTool("web_httpx_probe");
  assert.ok(tool);
  const normalizeArgs = tool.normalizeArgs;
  if (typeof normalizeArgs !== "function") throw new Error("HTTPX tool must normalize args");

  const args = normalizeArgs({
    url: "https://example.com",
    rate: 10,
    threads: 2,
    techDetect: false,
  });
  const command = tool.buildCommand(args);

  assert.match(command, /command -v 'httpx'/);
  assert.match(command, /httpx -u/);
  assert.doesNotMatch(command, /httpx_cmd|httpx-pd|httpx-toolkit|\/usr\/local\/bin\/httpx/);
  assert.deepEqual(tool.runtimeChecks, [{
    label: "httpx",
    command: "command -v httpx",
  }]);
});

test("each tool definition owns its AI SDK input schema", () => {
  const fakeSchema: AiSdkObjectSchemaLike = {
    describe() { return fakeSchema; },
    optional() { return fakeSchema; },
    nullable() { return fakeSchema; },
    passthrough() { return fakeSchema; },
  };
  const fakeZ: AiSdkZodLike = {
    string() { return fakeSchema; },
    number() { return fakeSchema; },
    boolean() { return fakeSchema; },
    array(_schema) { return fakeSchema; },
    object(_shape) { return fakeSchema; },
  };

  for (const tool of TOOL_DEFINITIONS) {
    const buildInputSchema = tool.buildInputSchema;
    assert.equal(typeof buildInputSchema, "function", `${tool.name} must define buildInputSchema`);
    assert.equal(buildInputSchema?.(fakeZ), fakeSchema, `${tool.name} must return an input schema`);
  }
});
