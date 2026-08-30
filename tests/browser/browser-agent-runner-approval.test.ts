import assert from "node:assert/strict";
import test from "node:test";

import { tool } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

const globals = globalThis as unknown as {
  window: Window & typeof globalThis;
  document: Document;
  fetch: typeof fetch;
};

globals.window = {
  localStorage: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
} as unknown as Window & typeof globalThis;
globals.document = {
  readyState: "complete",
  documentElement: { lang: "" },
  querySelectorAll: () => [],
} as unknown as Document;
globals.fetch = (async () => new Response("{}", {
  status: 200,
  headers: { "content-type": "application/json" },
})) as typeof fetch;

const { runAgentStreamTurn } = await import(
  "../../src/browser/chat/provider/ai-sdk/browser-agent-runner"
);

const usage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: {
    total: 2,
    text: 2,
    reasoning: 0,
  },
};

function providerStream(chunks: unknown[]): { stream: ReadableStream<never> } {
  return {
    stream: simulateReadableStream({
      chunks: chunks as never[],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function toolCallStream({
  toolCallId = "call-danger-1",
  toolName = "danger",
  input = { target: "example.test" },
}: {
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
} = {}): { stream: ReadableStream<never> } {
  const inputJson = JSON.stringify(input);
  return providerStream([
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: toolCallId, toolName },
    { type: "tool-input-delta", id: toolCallId, delta: inputJson },
    { type: "tool-input-end", id: toolCallId },
    {
      type: "tool-call",
      toolCallId,
      toolName,
      input: inputJson,
      providerExecuted: false,
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      usage,
    },
  ]);
}

function multipleToolCallStream(): { stream: ReadableStream<never> } {
  const calls = [
    { toolCallId: "call-a", toolName: "dangerA", input: { target: "one.test" } },
    { toolCallId: "call-b", toolName: "dangerB", input: { target: "two.test" } },
  ];
  return providerStream([
    { type: "stream-start", warnings: [] },
    ...calls.flatMap(({ toolCallId, toolName, input }) => {
      const inputJson = JSON.stringify(input);
      return [
        { type: "tool-input-start", id: toolCallId, toolName },
        { type: "tool-input-delta", id: toolCallId, delta: inputJson },
        { type: "tool-input-end", id: toolCallId },
        {
          type: "tool-call",
          toolCallId,
          toolName,
          input: inputJson,
          providerExecuted: false,
        },
      ];
    }),
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      usage,
    },
  ]);
}

function textStream(text: string): { stream: ReadableStream<never> } {
  return providerStream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "text-final" },
    { type: "text-delta", id: "text-final", delta: text },
    { type: "text-end", id: "text-final" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage,
    },
  ]);
}

function contentParts(
  prompt: unknown,
  role: "assistant" | "tool",
): Array<Record<string, unknown>> {
  if (!Array.isArray(prompt)) return [];
  const message = prompt.find((item) => (
    typeof item === "object"
    && item !== null
    && (item as { role?: unknown }).role === role
  )) as { content?: unknown } | undefined;
  return Array.isArray(message?.content)
    ? message.content.filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
    : [];
}

function offeredToolNames(call: unknown): string[] {
  if (typeof call !== "object" || call === null) return [];
  const tools = (call as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((item) => (
      typeof item === "object" && item !== null
        ? (item as { name?: unknown }).name
        : undefined
    ))
    .filter((name): name is string => typeof name === "string");
}

async function runApprovalScenario(approved: boolean): Promise<{
  executeCount: number;
  executeInputs: unknown[];
  model: MockLanguageModelV4;
  approvalRequests: Array<Record<string, unknown>>;
  resultText: string;
}> {
  let providerCall = 0;
  let executeCount = 0;
  const executeInputs: unknown[] = [];
  const approvalRequests: Array<Record<string, unknown>> = [];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      providerCall += 1;
      return providerCall === 1
        ? toolCallStream()
        : textStream(approved ? "approved final" : "denied final");
    },
  });
  const tools = {
    danger: tool({
      description: "Potentially dangerous test operation",
      inputSchema: z.object({ target: z.string() }),
      execute: async (input) => {
        executeCount += 1;
        executeInputs.push(input);
        return { ok: true, target: input.target };
      },
    }),
  };

  const result = await runAgentStreamTurn({
    model,
    messages: [{ role: "user", content: "run the operation" }],
    tools,
    activeToolNames: ["danger"],
    needsVm: true,
    maxSteps: 2,
    toolCalling: "good",
    toolApproval: () => ({ type: "user-approval", reason: "confirmation required" }),
    onToolApprovalRequest: (request) => {
      approvalRequests.push(request as unknown as Record<string, unknown>);
      return {
        type: "tool-approval-response",
        approvalId: request.approvalId,
        approved,
        ...(!approved ? { reason: "user denied" } : {}),
      };
    },
  });

  return {
    executeCount,
    executeInputs,
    model,
    approvalRequests,
    resultText: result.text,
  };
}

test("approval resumes the turn and executes the requested tool exactly once", async () => {
  const scenario = await runApprovalScenario(true);

  assert.equal(scenario.approvalRequests.length, 1);
  assert.equal(scenario.executeCount, 1);
  assert.deepEqual(scenario.executeInputs, [{ target: "example.test" }]);
  assert.equal(scenario.resultText, "approved final");
  assert.equal(scenario.model.doStreamCalls.length, 2);
});

test("denial resumes the turn without invoking execute", async () => {
  const scenario = await runApprovalScenario(false);

  assert.equal(scenario.approvalRequests.length, 1);
  assert.equal(scenario.executeCount, 0);
  assert.deepEqual(scenario.executeInputs, []);
  assert.equal(scenario.resultText, "denied final");
  assert.equal(scenario.model.doStreamCalls.length, 2);
});

test("approval continuation reaches the provider as matching V4 tool call and result messages", async () => {
  const approved = await runApprovalScenario(true);
  const approvedPrompt = approved.model.doStreamCalls[1]?.prompt;
  const approvedAssistant = contentParts(approvedPrompt, "assistant");
  const approvedTool = contentParts(approvedPrompt, "tool");
  const toolCall = approvedAssistant.find((part) => part.type === "tool-call");
  const toolResult = approvedTool.find((part) => part.type === "tool-result");

  assert.equal(toolCall?.toolCallId, "call-danger-1");
  assert.equal(toolCall?.toolName, "danger");
  assert.deepEqual(toolCall?.input, { target: "example.test" });
  assert.equal(toolResult?.toolCallId, "call-danger-1");
  assert.equal(toolResult?.toolName, "danger");
  assert.deepEqual(toolResult?.output, {
    type: "json",
    value: { ok: true, target: "example.test" },
  });

  const denied = await runApprovalScenario(false);
  const deniedPrompt = denied.model.doStreamCalls[1]?.prompt;
  const deniedResult = contentParts(deniedPrompt, "tool")
    .find((part) => part.type === "tool-result");
  assert.equal(deniedResult?.toolCallId, "call-danger-1");
  assert.deepEqual(deniedResult?.output, {
    type: "execution-denied",
    reason: "user denied",
  });
});

test("not-applicable tools execute in the same turn without requesting user approval", async () => {
  let providerCall = 0;
  let executeCount = 0;
  let approvalHandlerCount = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      providerCall += 1;
      return providerCall === 1 ? toolCallStream() : textStream("automatic final");
    },
  });

  const result = await runAgentStreamTurn({
    model,
    messages: [{ role: "user", content: "run low-risk operation" }],
    tools: {
      danger: tool({
        description: "Low-risk test operation",
        inputSchema: z.object({ target: z.string() }),
        execute: async () => {
          executeCount += 1;
          return { ok: true };
        },
      }),
    },
    activeToolNames: ["danger"],
    maxSteps: 2,
    toolCalling: "good",
    toolApproval: () => "not-applicable",
    onToolApprovalRequest: (request) => {
      approvalHandlerCount += 1;
      return {
        type: "tool-approval-response",
        approvalId: request.approvalId,
        approved: true,
      };
    },
  });

  assert.equal(executeCount, 1);
  assert.equal(approvalHandlerCount, 0);
  assert.equal(model.doStreamCalls.length, 2);
  assert.equal(result.text, "automatic final");
});

test("fallback synthesis receives tool output collected from responseMessages", async () => {
  let providerCall = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      providerCall += 1;
      if (providerCall === 1) return toolCallStream();
      if (providerCall === 2) return textStream("");
      return textStream("synthesized final");
    },
  });

  const result = await runAgentStreamTurn({
    model,
    messages: [{ role: "user", content: "run and explain" }],
    tools: {
      danger: tool({
        description: "Low-risk test operation",
        inputSchema: z.object({ target: z.string() }),
        execute: async () => ({ marker: "RESULT_FROM_TOOL" }),
      }),
    },
    activeToolNames: ["danger"],
    maxSteps: 2,
    toolCalling: "good",
    toolApproval: () => "not-applicable",
  });

  assert.equal(result.text, "synthesized final");
  assert.equal(model.doStreamCalls.length, 3);
  assert.match(JSON.stringify(model.doStreamCalls[2]?.prompt), /RESULT_FROM_TOOL/);
});

test("multiple approval requests are decided sequentially and resume in one tool message", async () => {
  let providerCall = 0;
  const decisionOrder: string[] = [];
  const executionOrder: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      providerCall += 1;
      return providerCall === 1 ? multipleToolCallStream() : textStream("both complete");
    },
  });
  const buildTool = (name: string) => tool({
    description: name,
    inputSchema: z.object({ target: z.string() }),
    execute: async () => {
      executionOrder.push(name);
      return { ok: true, name };
    },
  });

  const result = await runAgentStreamTurn({
    model,
    messages: [{ role: "user", content: "run both" }],
    tools: {
      dangerA: buildTool("dangerA"),
      dangerB: buildTool("dangerB"),
    },
    activeToolNames: ["dangerA", "dangerB"],
    maxSteps: 2,
    toolCalling: "good",
    toolApproval: () => "user-approval",
    onToolApprovalRequest: async (request) => {
      decisionOrder.push(request.toolCall.toolName);
      await Promise.resolve();
      return {
        type: "tool-approval-response",
        approvalId: request.approvalId,
        approved: true,
      };
    },
  });

  const resumedPrompt = model.doStreamCalls[1]?.prompt;
  const resumedResults = contentParts(resumedPrompt, "tool")
    .filter((part) => part.type === "tool-result");
  assert.deepEqual(decisionOrder, ["dangerA", "dangerB"]);
  assert.deepEqual([...executionOrder].sort(), ["dangerA", "dangerB"]);
  assert.equal(resumedResults.length, 2);
  assert.deepEqual(resumedResults.map((part) => String(part.toolCallId)).sort(), ["call-a", "call-b"]);
  assert.equal(model.doStreamCalls.length, 2);
  assert.equal(result.text, "both complete");
});

async function runBudgetScenario(toolCalling: "weak" | "fair"): Promise<{
  executeCount: number;
  offeredTools: string[][];
  text: string;
}> {
  let providerCall = 0;
  let executeCount = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      providerCall += 1;
      if (providerCall === 1) {
        return toolCallStream({ toolCallId: "call-first", input: { target: "first.test" } });
      }
      if (toolCalling === "fair" && providerCall === 2) {
        return toolCallStream({ toolCallId: "call-second", input: { target: "second.test" } });
      }
      return textStream(`${toolCalling} final`);
    },
  });

  const result = await runAgentStreamTurn({
    model,
    messages: [{ role: "user", content: "run within budget" }],
    tools: {
      danger: tool({
        description: "Budget test operation",
        inputSchema: z.object({ target: z.string() }),
        execute: async () => {
          executeCount += 1;
          return { ok: true };
        },
      }),
    },
    activeToolNames: ["danger"],
    maxSteps: 3,
    toolCalling,
    toolApproval: ({ toolCall }) => (
      (toolCall.input as { target?: unknown }).target === "first.test"
        ? "user-approval"
        : "not-applicable"
    ),
    onToolApprovalRequest: (request) => ({
      type: "tool-approval-response",
      approvalId: request.approvalId,
      approved: true,
    }),
  });

  return {
    executeCount,
    offeredTools: model.doStreamCalls.map(offeredToolNames),
    text: result.text,
  };
}

test("weak and fair tool budgets remain absolute after an approval resume", async () => {
  const weak = await runBudgetScenario("weak");
  assert.equal(weak.executeCount, 1);
  assert.deepEqual(weak.offeredTools, [["danger"], []]);
  assert.equal(weak.text, "weak final");

  const fair = await runBudgetScenario("fair");
  assert.equal(fair.executeCount, 2);
  assert.deepEqual(fair.offeredTools, [["danger"], ["danger"], []]);
  assert.equal(fair.text, "fair final");
});

test("abort after the approval prompt prevents resume and execution", async () => {
  const abortController = new AbortController();
  let executeCount = 0;
  let markApprovalStarted: (() => void) | undefined;
  const approvalStarted = new Promise<void>((resolve) => {
    markApprovalStarted = resolve;
  });
  const model = new MockLanguageModelV4({
    doStream: async () => toolCallStream(),
  });
  const turn = runAgentStreamTurn({
    model,
    messages: [{ role: "user", content: "run it" }],
    tools: {
      danger: tool({
        description: "Dangerous operation",
        inputSchema: z.object({ target: z.string() }),
        execute: async () => {
          executeCount += 1;
          return { ok: true };
        },
      }),
    },
    activeToolNames: ["danger"],
    maxSteps: 2,
    abortSignal: abortController.signal,
    toolApproval: () => "user-approval",
    onToolApprovalRequest: () => new Promise((_resolve, reject) => {
      const rejectAbort = () => {
        const error = new Error("stopped by test");
        error.name = "AbortError";
        reject(error);
      };
      abortController.signal.addEventListener("abort", rejectAbort, { once: true });
      markApprovalStarted?.();
      if (abortController.signal.aborted) rejectAbort();
    }),
  });

  await approvalStarted;
  abortController.abort("stopped by test");
  await assert.rejects(turn, (error: unknown) => (
    error instanceof Error && error.name === "AbortError"
  ));
  assert.equal(executeCount, 0);
  assert.equal(model.doStreamCalls.length, 1);
});
