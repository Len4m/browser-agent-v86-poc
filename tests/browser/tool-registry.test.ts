import assert from "node:assert/strict";
import test from "node:test";

import baseProfile from "../../vm/profiles/alpine-base.json";
import liteProfile from "../../vm/profiles/alpine-pentest-lite.json";
import webProfile from "../../vm/profiles/alpine-pentest-web.json";
import { state } from "../../src/browser/app/state";
import { llmNativeToolsPolicy } from "../../src/browser/chat/tools/native-tools-policy";
import { llmToolRegistry } from "../../src/browser/chat/tools/tool-registry";
import type { AiSdkSchemaLike, AiSdkZodLike } from "../../src/browser/chat/provider/ai-sdk-runtime";
import type { LlmModelConfig } from "../../src/browser/chat/state/chat-state";
import { TOOL_DEFINITIONS } from "virtual:ba-tools";

const manualTools = [
  "vm.python.exec",
  "vm.sh.exec",
  "vm.fs.list",
  "vm.fs.read",
  "vm.fs.write",
  "vm.cmd.which",
  "web.curl.head",
  "vm.sys.info",
  "vm.console.status",
  "vm.pkg.info",
  "web.curl.fetch_text",
];

function installProfiles(): void {
  state.profiles = [baseProfile, liteProfile, webProfile];
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

test("native tool defaults use profile priority and model quantity limit", () => {
  installProfiles();
  const model: LlmModelConfig = {
    id: "test-model",
    engine: "transformersjs",
    agent: {
      maxSteps: 2,
      maxNativeTools: 2,
      toolCalling: "fair",
      defaultNativeTools: ["vm.fs.read"],
    },
  };

  assert.deepEqual(llmNativeToolsPolicy.getDefaultToolNames(model, "alpine-base"), [
    "vm.python.exec",
    "vm.sh.exec",
  ]);
});

test("tools missing required profile packages are not exposed", () => {
  state.profiles = [{
    ...baseProfile,
    id: "missing-packages",
    packages: [],
    allowedTools: ["web.curl.head", "vm.sh.exec"],
  }];

  assert.deepEqual(llmToolRegistry.listToolNames({ profileId: "missing-packages" }), ["vm.sh.exec"]);
  assert.deepEqual(
    llmToolRegistry.listToolNames({ profileId: "missing-packages", includeUnavailable: true }),
    ["web.curl.head", "vm.sh.exec"],
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
  const tool = llmToolRegistry.getTool("web.nikto.quick");
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

test("HTTPX tool resolves fallback binary names", () => {
  const tool = llmToolRegistry.getTool("web.httpx.probe");
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

  assert.match(command, /command -v httpx \|\| command -v httpx-pd \|\| command -v httpx-toolkit/);
  assert.match(command, /"\$httpx_cmd" -u/);
  assert.doesNotMatch(command, /command -v 'httpx'/);
  assert.deepEqual(tool.runtimeChecks, [{
    label: "httpx",
    command: "command -v httpx || command -v httpx-pd || command -v httpx-toolkit || for p in /usr/bin/httpx* /usr/local/bin/httpx*; do [ -x \"$p\" ] && exit 0; done; exit 1",
  }]);
});

test("each tool definition owns its AI SDK input schema", () => {
  const fakeSchema: AiSdkSchemaLike = {
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
