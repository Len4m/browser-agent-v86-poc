import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHfSearchUrl,
  discoverOllamaModels,
  HfModelSearchService,
  inspectOllamaModel,
  searchHfModels,
  type FetchLike,
} from "../../src/browser/chat/models/model-discovery";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
    ...init,
  });
}

test("HF search applies fixed runtime filters and parses Link pagination", async () => {
  let requested = "";
  const fetcher: FetchLike = async (input) => {
    requested = String(input);
    return jsonResponse([
      { id: "org/valid", pipeline_tag: "text-generation", tags: ["transformers.js"], downloads: 12, gated: false },
      { id: "org/gated", pipeline_tag: "text-generation", tags: ["transformers.js"], gated: "manual" },
      { id: "org/wrong-task", pipeline_tag: "fill-mask", tags: ["transformers.js"] },
    ], { headers: { link: '<https://huggingface.co/api/models?cursor=abc>; rel="next"' } });
  };
  const page = await searchHfModels(fetcher, { query: "qwen" });
  const url = new URL(requested);
  assert.equal(url.searchParams.get("filter"), "transformers.js");
  assert.equal(url.searchParams.get("pipeline_tag"), "text-generation");
  assert.equal(url.searchParams.get("sort"), "downloads");
  assert.equal(url.searchParams.get("limit"), "30");
  assert.equal(url.searchParams.get("search"), "qwen");
  assert.deepEqual(page.models.map((model) => model.modelId), ["org/valid"]);
  assert.equal(page.nextUrl, "https://huggingface.co/api/models?cursor=abc");
});

test("HF service debounces, cancels stale requests and caches pages", async () => {
  let calls = 0;
  const fetcher: FetchLike = async (input, init) => {
    calls += 1;
    if (String(input).includes("search=first")) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }
    return jsonResponse([{ id: "org/second", pipeline_tag: "text-generation", tags: ["transformers.js"] }]);
  };
  const service = new HfModelSearchService(fetcher, () => 100, 0);
  const first = service.search("first");
  const firstRejected = assert.rejects(first, { name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await service.search("second");
  await firstRejected;
  assert.equal(second.models[0]?.modelId, "org/second");
  await service.search("second");
  assert.equal(calls, 2);
});

test("HF errors include rate-limit retry information", async () => {
  const fetcher: FetchLike = async () => new Response("limited", {
    status: 429,
    headers: { "retry-after": "42" },
  });
  await assert.rejects(searchHfModels(fetcher), /429.*retry after 42/);
});

test("Ollama discovery exposes every installed model and objective details", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: FetchLike = async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input).endsWith("/api/tags")) {
      return jsonResponse({ models: [
        { name: "qwen:latest", size: 1234, details: { family: "qwen", parameter_size: "4B", quantization_level: "Q4_K_M" } },
        { name: "plain:1b", size: 456 },
      ] });
    }
    return jsonResponse({
      capabilities: ["completion", "tools", "thinking"],
      template: "{{ .Tools }}",
      parameters: "temperature 0.2",
      model_info: { "qwen.context_length": 32768 },
    });
  };
  const models = await discoverOllamaModels(fetcher, "http://localhost:11434/");
  assert.deepEqual(models.map((model) => model.modelId), ["qwen:latest", "plain:1b"]);
  const details = await inspectOllamaModel(fetcher, "http://localhost:11434/", models[0]);
  assert.deepEqual(details.capabilities, { chat: true, tools: true, thinking: true, vision: false });
  assert.equal(details.contextWindowTokens, 32768);
  assert.equal(requests[1].init?.method, "POST");
  assert.equal(requests[1].init?.body, JSON.stringify({ model: "qwen:latest" }));
});

test("manual HF URL construction never requires a build-time inventory", () => {
  assert.match(buildHfSearchUrl("my model"), /^https:\/\/huggingface\.co\/api\/models\?/);
  assert.match(buildHfSearchUrl("my model"), /search=my\+model/);
});
