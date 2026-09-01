import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseTransformersRuntime,
  compatibleDtypes,
  inspectTransformersModel,
  type ModelRegistryLike,
} from "../../src/browser/chat/models/transformers-inspection";

function response(value: unknown, status = 200): Response {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), { status });
}

test("inspection resolves dtype files, download size, context and chat signals", async () => {
  const registry: ModelRegistryLike = {
    async get_available_dtypes() { return ["q4", "q8"]; },
    async get_pipeline_files(_task, _model, options) {
      assert.deepEqual(options, { dtype: "q4" });
      return ["config.json", "tokenizer.json", "onnx/model_q4.onnx"];
    },
    async get_file_metadata(_model, filename) {
      return { exists: true, size: filename.endsWith(".onnx") ? 1000 : 100 };
    },
  };
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("tokenizer_config.json")) return response({ chat_template: "{% if tools %}<tool_call>{% endif %}" });
    if (url.endsWith("config.json")) return response({ max_position_embeddings: 32768 });
    return response("<think>{{ messages }}");
  };
  const result = await inspectTransformersModel(registry, "org/model", { dtype: "q4", fetcher });
  assert.equal(result.downloadSizeBytes, 1200);
  assert.equal(result.contextWindowTokens, 32768);
  assert.equal(result.capabilities.tools, true);
  assert.equal(result.capabilities.thinking, true);
  assert.equal(result.selectedDtype, "q4");
});

test("inspection warns but remains usable when optional declarations are absent", async () => {
  const registry: ModelRegistryLike = {
    async get_available_dtypes() { return ["q8"]; },
    async get_pipeline_files() { return ["config.json", "onnx/model_q8.onnx"]; },
    async get_file_metadata() { return { exists: true, size: 10 }; },
  };
  const result = await inspectTransformersModel(registry, "org/model", {
    fetcher: async () => response("missing", 404),
  });
  assert.equal(result.inspected, true);
  assert.equal(result.capabilities.tools, null);
  assert.match(result.warnings.join(" "), /chat template.*Tool calling/i);
});

test("runtime selection removes f16 dtypes without shader-f16 and stays on the same repository", () => {
  assert.deepEqual(compatibleDtypes(["q4f16", "fp16", "q4", "q8"], false), ["q4", "q8"]);
  assert.deepEqual(chooseTransformersRuntime(["q4f16", "q4"], { webgpu: true, shaderF16: true }), {
    device: "webgpu", dtype: "q4f16", preferredAvailable: true,
  });
  assert.deepEqual(chooseTransformersRuntime(["q4"], { webgpu: false, shaderF16: false }), {
    device: "wasm", dtype: "q4", preferredAvailable: false,
  });
});
