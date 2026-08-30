import assert from "node:assert/strict";
import test from "node:test";

import { ollamaBrowser } from "../../src/browser/chat/provider/ai-sdk/ollama-browser-model";
import { transformersTextToolMiddleware } from "../../src/browser/chat/provider/ai-sdk/transformers-text-tool-middleware";

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

const toolParams = {
  prompt: [{ role: "user", content: [{ type: "text", text: "read a file" }] }],
  tools: [{
    type: "function",
    name: "vm_fs_read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  }],
};

async function collectStream(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

function readableStreamOf(chunks: unknown[]): ReadableStream<never> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk as never);
      controller.close();
    },
  });
}

test("text-tool middleware is V4 and leaves native tool calls untouched", async () => {
  const middleware = transformersTextToolMiddleware();
  assert.equal(middleware.specificationVersion, "v4");
  assert.ok(middleware.wrapGenerate);

  const nativeResult = {
    content: [{
      type: "tool-call",
      toolCallId: "native-call",
      toolName: "vm_fs_read",
      input: "{\"path\":\"/etc/hosts\"}",
      providerExecuted: false,
    }],
    finishReason: { unified: "tool-calls", raw: "tool-calls" },
    usage,
    warnings: [],
  };
  const result = await middleware.wrapGenerate({
    doGenerate: async () => nativeResult as never,
    doStream: async () => { throw new Error("unexpected stream call"); },
    params: toolParams as never,
    model: {} as never,
  });

  assert.equal(result, nativeResult);
});

test("text-tool middleware only injects a tool call when the provider returned text", async () => {
  const middleware = transformersTextToolMiddleware();
  assert.ok(middleware.wrapGenerate);

  const textResult = {
    content: [{
      type: "text",
      text: "```json\n{\"name\":\"vm_fs_read\",\"arguments\":{\"path\":\"/etc/hosts\"}}\n```",
    }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  };
  const result = await middleware.wrapGenerate({
    doGenerate: async () => textResult as never,
    doStream: async () => { throw new Error("unexpected stream call"); },
    params: toolParams as never,
    model: {} as never,
  });
  const toolCall = result.content.find((part) => part.type === "tool-call");

  assert.equal(result.finishReason.unified, "tool-calls");
  assert.equal(toolCall?.type, "tool-call");
  if (toolCall?.type !== "tool-call") throw new Error("expected tool call");
  assert.equal(toolCall.toolName, "vm_fs_read");
  assert.deepEqual(JSON.parse(toolCall.input) as unknown, { path: "/etc/hosts", maxBytes: 8192 });
});

test("text-tool middleware retains the plain call-colon fallback missing from Browser AI", async () => {
  const middleware = transformersTextToolMiddleware();
  assert.ok(middleware.wrapGenerate);
  const result = await middleware.wrapGenerate({
    doGenerate: async () => ({
      content: [{ type: "text", text: "call:vm_fs_read{path:'/etc/hosts'}" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    }) as never,
    doStream: async () => { throw new Error("unexpected stream call"); },
    params: toolParams as never,
    model: {} as never,
  });
  const toolCall = result.content.find((part) => part.type === "tool-call");

  assert.equal(toolCall?.type, "tool-call");
  if (toolCall?.type !== "tool-call") throw new Error("expected tool call");
  assert.equal(toolCall.toolName, "vm_fs_read");
  assert.deepEqual(JSON.parse(toolCall.input) as unknown, { path: "/etc/hosts", maxBytes: 8192 });
});

test("text-tool middleware preserves a complete native V4 tool stream", async () => {
  const middleware = transformersTextToolMiddleware();
  assert.ok(middleware.wrapStream);
  const nativeChunks = [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "native-call", toolName: "vm_fs_read" },
    { type: "tool-input-delta", id: "native-call", delta: "{\"path\":\"/etc/hosts\"}" },
    { type: "tool-input-end", id: "native-call" },
    {
      type: "tool-call",
      toolCallId: "native-call",
      toolName: "vm_fs_read",
      input: "{\"path\":\"/etc/hosts\"}",
      providerExecuted: false,
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
  ];
  const result = await middleware.wrapStream({
    doGenerate: async () => { throw new Error("unexpected generate call"); },
    doStream: async () => ({ stream: readableStreamOf(nativeChunks) }),
    params: toolParams as never,
    model: {} as never,
  });
  const chunks = await collectStream(result.stream as ReadableStream<unknown>);

  assert.deepEqual(chunks, nativeChunks);
  assert.equal((chunks.at(-1) as { type?: string }).type, "finish");
});

test("text-tool middleware emits a valid synthetic V4 tool stream only after base finish", async () => {
  const middleware = transformersTextToolMiddleware();
  assert.ok(middleware.wrapStream);
  const result = await middleware.wrapStream({
    doGenerate: async () => { throw new Error("unexpected generate call"); },
    doStream: async () => ({
      stream: readableStreamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text-0" },
        {
          type: "text-delta",
          id: "text-0",
          delta: "```json\n{\"name\":\"vm_fs_read\",\"arguments\":{\"path\":\"/etc/hosts\"}}\n```",
        },
        { type: "text-end", id: "text-0" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ]),
    }),
    params: toolParams as never,
    model: {} as never,
  });
  const chunks = await collectStream(result.stream as ReadableStream<unknown>);
  const types = chunks.map((chunk) => (chunk as { type?: string }).type);

  assert.deepEqual(types, [
    "stream-start",
    "text-start",
    "text-end",
    "tool-input-start",
    "tool-input-delta",
    "tool-input-end",
    "tool-call",
    "finish",
  ]);
  assert.equal(types.at(-1), "finish");
});

test("text-tool middleware converts loose JSON without exposing it as text", async () => {
  const middleware = transformersTextToolMiddleware();
  assert.ok(middleware.wrapStream);
  const result = await middleware.wrapStream({
    doGenerate: async () => { throw new Error("unexpected generate call"); },
    doStream: async () => ({
      stream: readableStreamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text-0" },
        { type: "text-delta", id: "text-0", delta: "{\"na" },
        { type: "text-delta", id: "text-0", delta: "me\":\"vm_fs_read\"," },
        { type: "text-delta", id: "text-0", delta: "\"arguments\":{\"path\":\"/etc/hosts\"}}" },
        { type: "text-end", id: "text-0" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ]),
    }),
    params: toolParams as never,
    model: {} as never,
  });
  const chunks = await collectStream(result.stream as ReadableStream<unknown>);

  assert.equal(chunks.some((chunk) => (chunk as { type?: string }).type === "text-delta"), false);
  assert.equal(chunks.some((chunk) => (chunk as { type?: string }).type === "tool-call"), true);
});

test("text-tool middleware accepts common tool and input JSON aliases", async () => {
  const middleware = transformersTextToolMiddleware();
  assert.ok(middleware.wrapGenerate);
  const result = await middleware.wrapGenerate({
    doGenerate: async () => ({
      content: [{ type: "text", text: '{"tool":"vm_fs_read","input":{"path":"/etc/hosts"}}' }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    }) as never,
    doStream: async () => { throw new Error("unexpected stream call"); },
    params: toolParams as never,
    model: {} as never,
  });
  const toolCall = result.content.find((part) => part.type === "tool-call");

  assert.equal(toolCall?.type, "tool-call");
  if (toolCall?.type !== "tool-call") throw new Error("expected tool call");
  assert.equal(toolCall.toolName, "vm_fs_read");
  assert.deepEqual(JSON.parse(toolCall.input) as unknown, { path: "/etc/hosts", maxBytes: 8192 });
});

test("text-tool middleware accepts an OpenAI-style JSON tool_calls wrapper", async () => {
  const middleware = transformersTextToolMiddleware();
  assert.ok(middleware.wrapGenerate);
  const result = await middleware.wrapGenerate({
    doGenerate: async () => ({
      content: [{
        type: "text",
        text: '{"tool_calls":[{"function":{"name":"vm_fs_read","arguments":"{\\"path\\":\\"/etc/hosts\\"}"}}]}',
      }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    }) as never,
    doStream: async () => { throw new Error("unexpected stream call"); },
    params: toolParams as never,
    model: {} as never,
  });
  const toolCall = result.content.find((part) => part.type === "tool-call");

  assert.equal(toolCall?.type, "tool-call");
  if (toolCall?.type !== "tool-call") throw new Error("expected tool call");
  assert.equal(toolCall.toolName, "vm_fs_read");
  assert.deepEqual(JSON.parse(toolCall.input) as unknown, { path: "/etc/hosts", maxBytes: 8192 });
});

test("text-tool middleware restores buffered JSON that is not a tool call", async () => {
  const middleware = transformersTextToolMiddleware();
  assert.ok(middleware.wrapStream);
  const result = await middleware.wrapStream({
    doGenerate: async () => { throw new Error("unexpected generate call"); },
    doStream: async () => ({
      stream: readableStreamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text-0" },
        { type: "text-delta", id: "text-0", delta: "Resultado: {\"ok\":" },
        { type: "text-delta", id: "text-0", delta: "true}" },
        { type: "text-end", id: "text-0" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ]),
    }),
    params: toolParams as never,
    model: {} as never,
  });
  const chunks = await collectStream(result.stream as ReadableStream<unknown>);
  const text = chunks
    .filter((chunk) => (chunk as { type?: string }).type === "text-delta")
    .map((chunk) => String((chunk as { delta?: unknown }).delta || ""))
    .join("");

  assert.equal(text, 'Resultado: {"ok":true}');
  assert.equal(chunks.some((chunk) => (chunk as { type?: string }).type === "tool-call"), false);
});

test("Ollama browser model passes canonical tool names through unchanged", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      done: true,
      done_reason: "stop",
      prompt_eval_count: 3,
      eval_count: 2,
      message: {
        content: "",
        tool_calls: [{
          id: "ollama-call",
          type: "function",
          function: {
            name: "vm_fs_read",
            arguments: { path: "/etc/hosts" },
          },
        }, {
          id: "ollama-call-2",
          type: "function",
          function: {
            name: "vm_fs_read",
            arguments: { path: "/etc/os-release" },
          },
        }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const model = ollamaBrowser("test-model");
    assert.equal(model.specificationVersion, "v4");
    const result = await model.doGenerate(toolParams as never);
    const toolCall = result.content.find((part) => part.type === "tool-call");
    const toolCalls = result.content.filter((part) => part.type === "tool-call");
    const requestTools = requestBody?.tools as Array<{ function?: { name?: string } }> | undefined;

    assert.equal(requestTools?.[0]?.function?.name, "vm_fs_read");
    assert.equal(result.finishReason.unified, "tool-calls");
    assert.equal(toolCall?.type, "tool-call");
    if (toolCall?.type !== "tool-call") throw new Error("expected tool call");
    assert.equal(toolCall.toolName, "vm_fs_read");
    assert.deepEqual(JSON.parse(toolCall.input) as unknown, { path: "/etc/hosts" });
    assert.equal(toolCalls.length, 2);
    assert.equal(toolCalls[1]?.type, "tool-call");
    if (toolCalls[1]?.type !== "tool-call") throw new Error("expected second tool call");
    assert.equal(toolCalls[1].toolCallId, "ollama-call-2");
    assert.deepEqual(JSON.parse(toolCalls[1].input) as unknown, { path: "/etc/os-release" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
