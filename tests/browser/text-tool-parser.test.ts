import assert from "node:assert/strict";
import test from "node:test";

import {
  looksLikeTextToolPlan,
  parseTextToolCalls,
} from "../../src/browser/chat/provider/ai-sdk/text-tool-parser";

test("parseTextToolCalls extracts fenced tool calls", () => {
  const result = parseTextToolCalls([
    "Before",
    "```tool_call",
    "{\"id\":\"call_1\",\"name\":\"vm.fs.read\",\"arguments\":{\"path\":\"/etc/os-release\"}}",
    "```",
    "After",
  ].join("\n"));

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.toolCallId, "call_1");
  assert.equal(result.toolCalls[0]?.toolName, "vm.fs.read");
  assert.deepEqual(result.toolCalls[0]?.args, { path: "/etc/os-release", maxBytes: 8192 });
  assert.equal(result.textContent, "Before\nAfter");
});

test("parseTextToolCalls extracts loose JSON and honors allowed tool names", () => {
  const text = "Run this {\"name\":\"vm.fs.list\",\"arguments\":{\"path\":\"/tmp\",\"maxEntries\":0}} please";
  const denied = parseTextToolCalls(text, { allowedToolNames: ["web.fetch"] });
  assert.equal(denied.toolCalls.length, 0);

  const allowed = parseTextToolCalls(text, { allowedToolNames: ["vm.fs.list"] });
  assert.equal(allowed.toolCalls.length, 1);
  assert.deepEqual(allowed.toolCalls[0]?.args, { path: "/tmp", maxEntries: 120 });
  assert.equal(allowed.textContent, "Run this  please");
});

test("parseTextToolCalls extracts XML-style tool calls", () => {
  const text = "<tool_call>{\"name\":\"vm.fs.read\",\"arguments\":{\"path\":\"/etc/hosts\"}}</tool_call>";
  const result = parseTextToolCalls(text);

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.toolName, "vm.fs.read");
  assert.deepEqual(result.toolCalls[0]?.args, { path: "/etc/hosts", maxBytes: 8192 });
  assert.equal(result.textContent, "");
});

test("parseTextToolCalls extracts special-token and inline call styles", () => {
  const special = parseTextToolCalls("<|tool_call>{\"name\":\"vm.fs.list\",\"arguments\":{\"path\":\"/var\"}}<tool_call|>");
  assert.equal(special.toolCalls[0]?.toolName, "vm.fs.list");
  assert.deepEqual(special.toolCalls[0]?.args, { path: "/var", maxEntries: 120 });

  const python = parseTextToolCalls("[vm.fs.read(path=\"/tmp/a.txt\", maxBytes=256)]");
  assert.equal(python.toolCalls[0]?.toolName, "vm.fs.read");
  assert.deepEqual(python.toolCalls[0]?.args, { path: "/tmp/a.txt", maxBytes: 256 });

  const callColon = parseTextToolCalls("call:vm.fs.list{path:\"/tmp\",maxEntries:3}");
  assert.equal(callColon.toolCalls[0]?.toolName, "vm.fs.list");
  assert.deepEqual(callColon.toolCalls[0]?.args, { path: "/tmp", maxEntries: 3 });
});

test("looksLikeTextToolPlan detects partial tool plans", () => {
  assert.equal(looksLikeTextToolPlan("```json\n{\"name\":\"vm.exec\"}"), true);
  assert.equal(looksLikeTextToolPlan("<tool_call>{\"name\":\"vm.exec\"}"), true);
  assert.equal(looksLikeTextToolPlan("call:vm.fs.read{path:"), true);
  assert.equal(looksLikeTextToolPlan("plain answer"), false);
});
