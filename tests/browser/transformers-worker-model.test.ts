import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTransformersWorkerCallArgs,
  convertPromptToTransformersMessages,
  transformersWorker,
} from "../../src/browser/chat/provider/ai-sdk/transformers-worker-model";

class FakeWorker extends EventTarget {
  posts: unknown[] = [];
  completeOnInterrupt = false;
  autoCompleteText = "";
  autoLoadProgress = false;
  autoToolCalls: unknown[] | undefined;

  postMessage(message: unknown): void {
    this.posts.push(message);
    const record = typeof message === "object" && message !== null ? message as Record<string, unknown> : {};
    if (record.type === "load") {
      if (this.autoLoadProgress) {
        this.emit({ status: "progress", file: "model.onnx", loaded: 5, total: 10 });
      }
      this.emit({ status: "ready" });
    }
    if (record.type === "generate" && this.autoCompleteText) {
      this.emit({ status: "update", output: this.autoCompleteText });
      this.emit({
        status: "complete",
        output: this.autoCompleteText,
        inputLength: 3,
        numTokens: 2,
        toolCalls: this.autoToolCalls,
      });
    }
    if (record.type === "interrupt" && this.completeOnInterrupt) {
      this.emit({ status: "complete", output: "", inputLength: 0, numTokens: 0 });
    }
  }

  emit(data: unknown): void {
    queueMicrotask(() => {
      const event = new Event("message") as MessageEvent<unknown>;
      Object.defineProperty(event, "data", { value: data });
      this.dispatchEvent(event);
    });
  }

  generatePosts(): unknown[] {
    return this.posts.filter((post) => (
      typeof post === "object"
      && post !== null
      && (post as Record<string, unknown>).type === "generate"
    ));
  }

  interruptPosts(): unknown[] {
    return this.posts.filter((post) => (
      typeof post === "object"
      && post !== null
      && (post as Record<string, unknown>).type === "interrupt"
    ));
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

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

function textPrompt(text = "hola"): unknown {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

test("convertPromptToTransformersMessages converts user, assistant tool calls and tool results", () => {
  const messages = convertPromptToTransformersMessages([
    { role: "system", content: "system" },
    { role: "user", content: [{ type: "text", text: "list files" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "using tool" },
        { type: "tool-call", toolCallId: "call_1", toolName: "vm.fs.list", input: { path: "/tmp" } },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_1", toolName: "vm.fs.list", output: { type: "json", value: { files: [] } } },
      ],
    },
  ] as never);

  assert.deepEqual(messages, [
    { role: "system", content: "system" },
    { role: "user", content: "list files" },
    {
      role: "assistant",
      content: "using tool",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "vm.fs.list", arguments: "{\"path\":\"/tmp\"}" },
      }],
    },
    { role: "tool", tool_call_id: "call_1", name: "vm.fs.list", content: "{\"files\":[]}" },
  ]);
});

test("buildTransformersWorkerCallArgs converts function tools and thinking provider options", () => {
  const args = buildTransformersWorkerCallArgs({
    prompt: textPrompt(),
    tools: [{
      type: "function",
      name: "vm.fs.read",
      description: "Read a file",
      inputSchema: { type: "object" },
    }],
    maxOutputTokens: 24,
    providerOptions: { "transformers-js": { enableThinking: true } },
  } as never);

  assert.deepEqual(args.functionTools, [{
    name: "vm.fs.read",
    description: "Read a file",
    parameters: { type: "object" },
  }]);
  assert.equal(args.enableThinking, true);
  assert.equal(args.generationOptions.max_new_tokens, 24);
});

test("transformersWorker reports load progress and ready state", async () => {
  const worker = new FakeWorker();
  worker.autoLoadProgress = true;
  const model = transformersWorker("test-model", { worker: worker as unknown as Worker, device: "webgpu", dtype: "q4" });
  const progress: unknown[] = [];

  assert.equal(await model.availability(), "downloadable");
  await model.createSessionWithProgress((value) => progress.push(value));

  assert.deepEqual(progress, [0.5, 1]);
  assert.equal(await model.availability(), "available");
});

test("transformersWorker streams normal text from worker updates", async () => {
  const worker = new FakeWorker();
  worker.autoCompleteText = "respuesta";
  const model = transformersWorker("test-model", { worker: worker as unknown as Worker });
  const result = await model.doStream({ prompt: textPrompt() } as never);

  const chunks = await collectStream(result.stream as ReadableStream<unknown>);
  assert.deepEqual(chunks.map((chunk) => (chunk as Record<string, unknown>).type), [
    "stream-start",
    "text-start",
    "text-delta",
    "text-end",
    "finish",
  ]);
  assert.equal((chunks[2] as Record<string, unknown>).delta, "respuesta");
});

test("transformersWorker emits tool-call chunks for text tool plans", async () => {
  const worker = new FakeWorker();
  worker.autoCompleteText = [
    "```tool_call",
    "{\"name\":\"vm.fs.read\",\"arguments\":{\"path\":\"/etc/os-release\"}}",
    "```",
  ].join("\n");
  const model = transformersWorker("test-model", { worker: worker as unknown as Worker });
  const result = await model.doStream({
    prompt: textPrompt(),
    tools: [{
      type: "function",
      name: "vm.fs.read",
      description: "Read",
      inputSchema: { type: "object" },
    }],
  } as never);

  const chunks = await collectStream(result.stream as ReadableStream<unknown>);
  const types = chunks.map((chunk) => (chunk as Record<string, unknown>).type);
  assert.equal(types.includes("tool-input-start"), true);
  assert.equal(types.includes("tool-call"), true);
  const toolCall = chunks.find((chunk) => (chunk as Record<string, unknown>).type === "tool-call") as Record<string, unknown>;
  assert.equal(toolCall.toolName, "vm.fs.read");
});

test("transformersWorker strips tool plan text when worker also returns toolCalls", async () => {
  const worker = new FakeWorker();
  worker.autoCompleteText = [
    "```tool_call",
    "{\"name\":\"vm.fs.read\",\"arguments\":{\"path\":\"/etc/os-release\"}}",
    "```",
  ].join("\n");
  worker.autoToolCalls = [{
    toolCallId: "call_worker",
    toolName: "vm.fs.read",
    args: { path: "/etc/os-release" },
  }];
  const model = transformersWorker("test-model", { worker: worker as unknown as Worker });
  const result = await model.doGenerate({
    prompt: textPrompt(),
    tools: [{
      type: "function",
      name: "vm.fs.read",
      description: "Read",
      inputSchema: { type: "object" },
    }],
  } as never);

  assert.equal(result.content.some((part) => part.type === "text" && part.text.includes("tool_call")), false);
  assert.equal(result.content.some((part) => part.type === "tool-call" && part.toolCallId === "call_worker"), true);
});

test("transformersWorker posts interrupt on abort and surfaces an AbortError chunk", async () => {
  const worker = new FakeWorker();
  worker.completeOnInterrupt = true;
  const model = transformersWorker("test-model", { worker: worker as unknown as Worker });
  const abort = new AbortController();
  const result = await model.doStream({ prompt: textPrompt(), abortSignal: abort.signal } as never);
  const chunksPromise = collectStream(result.stream as ReadableStream<unknown>);

  await tick();
  abort.abort();
  const chunks = await chunksPromise;
  const errorChunk = chunks.find((chunk) => (chunk as Record<string, unknown>).type === "error") as Record<string, unknown>;

  assert.equal(worker.interruptPosts().length, 1);
  assert.equal((errorChunk.error as Error).name, "AbortError");
});

test("transformersWorker serializes generate calls on one worker", async () => {
  const worker = new FakeWorker();
  const model = transformersWorker("test-model", { worker: worker as unknown as Worker });

  const first = model.doGenerate({ prompt: textPrompt("one") } as never);
  await tick();
  const second = model.doGenerate({ prompt: textPrompt("two") } as never);
  await tick();

  assert.equal(worker.generatePosts().length, 1);
  worker.emit({ status: "update", output: "one" });
  worker.emit({ status: "complete", output: "one", inputLength: 1, numTokens: 1 });
  const firstResult = await first;
  assert.equal(firstResult.content[0]?.type, "text");

  await tick();
  assert.equal(worker.generatePosts().length, 2);
  worker.emit({ status: "update", output: "two" });
  worker.emit({ status: "complete", output: "two", inputLength: 1, numTokens: 1 });
  const secondResult = await second;
  assert.equal(secondResult.content[0]?.type, "text");
});
