import assert from "node:assert/strict";
import test from "node:test";

import { transformersJS } from "@browser-ai/transformers-js";
import { wrapLanguageModel } from "ai";
import { transformersReasoningMiddleware } from "../../src/browser/chat/provider/ai-sdk/transformers-text-tool-middleware";

class FakeWorker extends EventTarget {
  readonly posts: unknown[] = [];
  generatedText = "";

  postMessage(message: unknown): void {
    this.posts.push(message);
    const value = typeof message === "object" && message !== null
      ? message as Record<string, unknown>
      : {};
    if (value.type === "load") {
      this.emit({ status: "progress", file: "model.onnx", loaded: 5, total: 10 });
      this.emit({ status: "ready" });
    }
    if (value.type === "generate" && this.generatedText) {
      this.emit({ status: "update", output: this.generatedText });
      this.emit({
        status: "complete",
        output: this.generatedText,
        inputLength: 3,
        numTokens: 2,
      });
    }
  }

  private emit(data: unknown): void {
    queueMicrotask(() => {
      const event = new Event("message") as MessageEvent<unknown>;
      Object.defineProperty(event, "data", { value: data });
      this.dispatchEvent(event);
    });
  }
}

async function collectStream(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

async function withBrowserEnvironment<T>(run: () => Promise<T>): Promise<T> {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  try {
    return await run();
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("native Browser AI provider exposes a V4 worker model and load progress", async () => {
  await withBrowserEnvironment(async () => {
    const worker = new FakeWorker();
    const model = transformersJS("test-model", {
      worker: worker as unknown as Worker,
      device: "webgpu",
      dtype: "q4",
    });
    const progress: number[] = [];

    assert.equal(model.specificationVersion, "v4");
    assert.equal(model.provider, "transformers-js");
    assert.equal(await model.availability(), "downloadable");

    await model.createSessionWithProgress((value) => progress.push(value));

    assert.deepEqual(progress, [0.5, 1]);
    assert.equal(await model.availability(), "available");
    assert.deepEqual(worker.posts, [{
      type: "load",
      data: {
        modelId: "test-model",
        dtype: "q4",
        device: "webgpu",
        use_external_data_format: undefined,
        isVisionModel: false,
      },
    }]);
  });
});

test("native Browser AI provider keeps the worker streaming, tools and thinking contract", async () => {
  await withBrowserEnvironment(async () => {
    const worker = new FakeWorker();
    worker.generatedText = "respuesta";
    const model = transformersJS("test-stream-model", {
      worker: worker as unknown as Worker,
      device: "wasm",
      dtype: "q8",
    });

    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hola" }] }],
      tools: [{
        type: "function",
        name: "vm_fs_read",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      }],
      providerOptions: {
        "transformers-js": { enableThinking: true },
      },
    } as never);
    const chunks = await collectStream(result.stream as ReadableStream<unknown>);
    const generatePost = worker.posts.find((post) => (
      typeof post === "object"
      && post !== null
      && (post as Record<string, unknown>).type === "generate"
    )) as Record<string, unknown> | undefined;

    assert.deepEqual(chunks.map((chunk) => (chunk as Record<string, unknown>).type), [
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    assert.equal((chunks[2] as Record<string, unknown>).delta, "respuesta");
    assert.equal(generatePost?.enableThinking, true);
    assert.deepEqual(generatePost?.tools, [{
      name: "vm_fs_read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    }]);
  });
});

test("Qwen-style streams can start inside reasoning without an opening tag", async () => {
  await withBrowserEnvironment(async () => {
    const worker = new FakeWorker();
    worker.generatedText = "razonamiento</think>respuesta";
    const baseModel = transformersJS("test-reasoning-model", {
      worker: worker as unknown as Worker,
    });
    const model = wrapLanguageModel({
      model: baseModel,
      middleware: transformersReasoningMiddleware({
        tagName: "think",
        startWithReasoning: true,
      }),
    });
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hola" }] }],
      providerOptions: {
        "transformers-js": { enableThinking: true },
      },
    } as never);
    const chunks = await collectStream(result.stream as ReadableStream<unknown>);
    const reasoning = chunks
      .filter((chunk) => (chunk as Record<string, unknown>).type === "reasoning-delta")
      .map((chunk) => String((chunk as Record<string, unknown>).delta || ""))
      .join("");
    const text = chunks
      .filter((chunk) => (chunk as Record<string, unknown>).type === "text-delta")
      .map((chunk) => String((chunk as Record<string, unknown>).delta || ""))
      .join("");

    assert.equal(reasoning, "razonamiento");
    assert.equal(text, "respuesta");
  });
});

test("startWithReasoning does not swallow normal text when thinking is disabled", async () => {
  await withBrowserEnvironment(async () => {
    const worker = new FakeWorker();
    worker.generatedText = "respuesta normal";
    const model = wrapLanguageModel({
      model: transformersJS("test-no-reasoning-model", {
        worker: worker as unknown as Worker,
      }),
      middleware: transformersReasoningMiddleware({
        tagName: "think",
        startWithReasoning: true,
      }),
    });
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hola" }] }],
    } as never);
    const chunks = await collectStream(result.stream as ReadableStream<unknown>);
    const reasoning = chunks.filter((chunk) => (
      (chunk as Record<string, unknown>).type === "reasoning-delta"
    ));
    const text = chunks
      .filter((chunk) => (chunk as Record<string, unknown>).type === "text-delta")
      .map((chunk) => String((chunk as Record<string, unknown>).delta || ""))
      .join("");

    assert.deepEqual(reasoning, []);
    assert.equal(text, "respuesta normal");
  });
});

test("native Browser AI provider converts its supported tool fences into V4 chunks", async () => {
  await withBrowserEnvironment(async () => {
    const payload = "{\"name\":\"vm_fs_read\",\"arguments\":{\"path\":\"/etc/os-release\"}}";
    const formats = [
      ["```tool_call", payload, "```"].join("\n"),
      `<tool_call>${payload}</tool_call>`,
      `<|tool_call>${payload}<tool_call|>`,
      "[vm_fs_read(path='/etc/os-release')]",
    ];

    for (const [index, generatedText] of formats.entries()) {
      const worker = new FakeWorker();
      worker.generatedText = generatedText;
      const model = transformersJS(`test-tool-model-${index}`, {
        worker: worker as unknown as Worker,
      });
      const result = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "read os release" }] }],
        tools: [{
          type: "function",
          name: "vm_fs_read",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        }],
      } as never);
      const chunks = await collectStream(result.stream as ReadableStream<unknown>);
      const toolCall = chunks.find((chunk) => (
        (chunk as Record<string, unknown>).type === "tool-call"
      )) as Record<string, unknown> | undefined;
      const finish = chunks.find((chunk) => (
        (chunk as Record<string, unknown>).type === "finish"
      )) as Record<string, unknown> | undefined;

      const chunkTypes = chunks.map((chunk) => (chunk as Record<string, unknown>).type);
      assert.ok(chunkTypes.includes("tool-input-start"), `format ${index}: ${JSON.stringify(chunkTypes)}`);
      assert.ok(chunkTypes.includes("tool-input-end"), `format ${index}: ${JSON.stringify(chunkTypes)}`);
      assert.equal(toolCall?.toolName, "vm_fs_read");
      assert.deepEqual(JSON.parse(String(toolCall?.input)), { path: "/etc/os-release" });
      assert.deepEqual(finish?.finishReason, { unified: "tool-calls", raw: "tool-calls" });
      assert.equal(chunks.some((chunk) => (chunk as Record<string, unknown>).type === "text-delta"), false);
    }
  });
});
