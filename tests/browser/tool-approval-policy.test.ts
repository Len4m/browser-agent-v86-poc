import assert from "node:assert/strict";
import test from "node:test";

import type { AiSdkToolCall } from "../../src/browser/chat/provider/ai-sdk-runtime";
import { llmToolExecutor } from "../../src/browser/chat/tools/tool-executor";

function toolCall(toolName: string, input: Record<string, unknown> = {}): AiSdkToolCall {
  return {
    type: "tool-call",
    toolCallId: `call-${toolName}`,
    toolName,
    input,
  };
}

test("native approval policy maps risk, allowlist and prior denials", () => {
  Object.defineProperty(globalThis, "document", {
    value: { getElementById: () => null },
    configurable: true,
  });
  Object.defineProperty(globalThis, "HTMLSelectElement", {
    value: class HTMLSelectElement {},
    configurable: true,
  });
  const previousLevel = llmToolExecutor.getAutonomyMaxLevel();
  try {
    const lowRisk = toolCall("vm_fs_list", { path: "/tmp" });
    const mediumRisk = toolCall("web_curl_head", { url: "https://example.com" });
    const highRisk = toolCall("vm_fs_write", { path: "/tmp/note", content: "ok" });

    llmToolExecutor.setAutonomyMaxLevel(0);
    assert.equal((llmToolExecutor.getToolApprovalStatus(lowRisk) as { type?: string }).type, "user-approval");

    llmToolExecutor.setAutonomyMaxLevel(1);
    assert.equal(llmToolExecutor.getToolApprovalStatus(lowRisk), "not-applicable");
    assert.deepEqual(llmToolExecutor.getToolApprovalStatus(mediumRisk), {
      type: "user-approval",
      reason: "tools.exec.reasonModelRequest",
    });
    assert.deepEqual(llmToolExecutor.getToolApprovalStatus(highRisk), {
      type: "user-approval",
      reason: "tools.exec.reasonModelRequest",
    });

    llmToolExecutor.setAutonomyMaxLevel(2);
    assert.equal(llmToolExecutor.getToolApprovalStatus(mediumRisk), "not-applicable");
    assert.equal((llmToolExecutor.getToolApprovalStatus(highRisk) as { type?: string }).type, "user-approval");

    llmToolExecutor.setAutonomyMaxLevel(3);
    assert.equal(llmToolExecutor.getToolApprovalStatus(highRisk), "not-applicable");

    assert.equal((llmToolExecutor.getToolApprovalStatus(lowRisk, {
      allowedToolNames: ["vm_fs_read"],
    }) as { type?: string }).type, "denied");
    assert.equal((llmToolExecutor.getToolApprovalStatus(toolCall("unknown.tool")) as { type?: string }).type, "denied");

    const deniedOperationKeys = new Set([llmToolExecutor.getToolOperationKey(highRisk)]);
    assert.equal((llmToolExecutor.getToolApprovalStatus(highRisk, {
      deniedOperationKeys,
    }) as { type?: string }).type, "denied");
  } finally {
    llmToolExecutor.setAutonomyMaxLevel(previousLevel);
  }
});
