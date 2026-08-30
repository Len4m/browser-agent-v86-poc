import assert from "node:assert/strict";
import test from "node:test";

import {
  looksLikeTextToolPlan,
  parseTextToolCalls,
} from "../../src/browser/chat/provider/ai-sdk/text-tool-parser";

test("parseTextToolCalls extracts fallback JSON fences", () => {
  const result = parseTextToolCalls([
    "Before",
    "```json",
    "{\"id\":\"call_1\",\"name\":\"vm_fs_read\",\"arguments\":{\"path\":\"/etc/os-release\"}}",
    "```",
    "After",
  ].join("\n"));

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.toolCallId, "call_1");
  assert.equal(result.toolCalls[0]?.toolName, "vm_fs_read");
  assert.deepEqual(result.toolCalls[0]?.args, { path: "/etc/os-release", maxBytes: 8192 });
  assert.equal(result.textContent, "Before\nAfter");
});

test("parseTextToolCalls extracts loose JSON and honors allowed tool names", () => {
  const text = "Run this {\"name\":\"vm_fs_list\",\"arguments\":{\"path\":\"/tmp\",\"maxEntries\":0}} please";
  const denied = parseTextToolCalls(text, { allowedToolNames: ["web_fetch"] });
  assert.equal(denied.toolCalls.length, 0);

  const allowed = parseTextToolCalls(text, { allowedToolNames: ["vm_fs_list"] });
  assert.equal(allowed.toolCalls.length, 1);
  assert.deepEqual(allowed.toolCalls[0]?.args, { path: "/tmp", maxEntries: 120 });
  assert.equal(allowed.textContent, "Run this  please");
});

test("looksLikeTextToolPlan detects partial tool plans", () => {
  assert.equal(looksLikeTextToolPlan("```json\n{\"name\":\"vm_exec\"}"), true);
  assert.equal(looksLikeTextToolPlan("<tool_call>{\"name\":\"vm_exec\"}"), true);
  assert.equal(looksLikeTextToolPlan("call:vm_fs_read{path:"), true);
  assert.equal(looksLikeTextToolPlan("plain answer"), false);
});
