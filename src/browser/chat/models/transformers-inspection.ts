import type { ModelCapabilitySignals, ModelInspection } from "./model-types";

export interface ModelRegistryLike {
  get_available_dtypes(modelId: string): Promise<string[]>;
  get_pipeline_files(task: string, modelId: string, options?: { dtype?: never }): Promise<string[]>;
  get_file_metadata(modelId: string, filename: string): Promise<{ exists: boolean; size?: number }>;
}

interface InspectOptions {
  dtype?: string;
  fetcher?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contextWindow(...values: unknown[]): number | undefined {
  const keys = ["max_position_embeddings", "n_positions", "max_sequence_length", "model_max_length", "seq_length"];
  for (const value of values) {
    if (!isRecord(value)) continue;
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 && candidate < 2_000_000) return candidate;
    }
    for (const nested of Object.values(value)) {
      if (!isRecord(nested)) continue;
      for (const key of keys) {
        const candidate = nested[key];
        if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 && candidate < 2_000_000) return candidate;
      }
    }
  }
  return undefined;
}

async function fetchOptional(fetcher: typeof fetch, modelId: string, filename: string): Promise<unknown> {
  const url = `https://huggingface.co/${modelId}/resolve/main/${filename}`;
  const response = await fetcher(url, { headers: { Accept: filename.endsWith(".json") ? "application/json" : "text/plain" } });
  if (!response.ok) return null;
  if (filename.endsWith(".json")) return await response.json();
  return await response.text();
}

function signals(config: unknown, tokenizer: unknown, chatTemplate: string): ModelCapabilitySignals {
  const configText = JSON.stringify(config || {}).toLowerCase();
  const tokenizerText = JSON.stringify(tokenizer || {}).toLowerCase();
  const templateText = chatTemplate.toLowerCase();
  const combined = `${configText}\n${tokenizerText}\n${templateText}`;
  return {
    chat: chatTemplate ? true : null,
    tools: /(?:tool_call|tool_calls|\.tools|<tool|tools\|)/.test(combined) ? true : null,
    thinking: /(?:<think|thinking|reasoning_content|enable_thinking)/.test(combined) ? true : null,
    vision: /(?:vision|image_token|image-text|image_text)/.test(configText) ? true : false,
  };
}

export async function inspectTransformersModel(
  registry: ModelRegistryLike,
  modelId: string,
  options: InspectOptions = {},
): Promise<ModelInspection> {
  const normalized = modelId.trim();
  if (!normalized || !normalized.includes("/")) throw new Error("A Hugging Face repository ID is required");
  const fetcher = options.fetcher || fetch;
  const availableDtypes = [...new Set(await registry.get_available_dtypes(normalized))];
  const selectedDtype = options.dtype && availableDtypes.includes(options.dtype)
    ? options.dtype
    : availableDtypes[0];
  const pipelineOptions = selectedDtype ? { dtype: selectedDtype as never } : undefined;
  const files = await registry.get_pipeline_files("text-generation", normalized, pipelineOptions);
  const metadata = await Promise.all(files.map((filename) => registry.get_file_metadata(normalized, filename)));
  const downloadSizeBytes = metadata.reduce((sum, item) => sum + (item.exists && item.size ? item.size : 0), 0) || undefined;
  const [config, tokenizer, jinja] = await Promise.all([
    fetchOptional(fetcher, normalized, "config.json"),
    fetchOptional(fetcher, normalized, "tokenizer_config.json"),
    fetchOptional(fetcher, normalized, "chat_template.jinja"),
  ]);
  const tokenizerRecord = isRecord(tokenizer) ? tokenizer : {};
  const chatTemplate = text(jinja) || text(tokenizerRecord.chat_template);
  const capabilities = signals(config, tokenizer, chatTemplate);
  const warnings: string[] = [];
  if (!files.some((file) => file.endsWith(".onnx") || file.includes(".onnx_"))) warnings.push("No ONNX model file was resolved.");
  if (!chatTemplate) warnings.push("No chat template was declared.");
  if (capabilities.tools !== true) warnings.push("Tool calling is not declared; the user profile will be used.");
  return {
    modelId: normalized,
    availableDtypes,
    selectedDtype,
    files,
    downloadSizeBytes,
    contextWindowTokens: contextWindow(config, tokenizer),
    chatTemplate: chatTemplate || undefined,
    capabilities,
    warnings,
    inspected: true,
  };
}

const F16_DTYPES = new Set(["fp16", "q4f16", "q2f16", "q1f16"]);

export function compatibleDtypes(dtypes: string[], shaderF16: boolean): string[] {
  return shaderF16 ? [...dtypes] : dtypes.filter((dtype) => !F16_DTYPES.has(dtype));
}

export function chooseTransformersRuntime(
  dtypes: string[],
  hardware: { webgpu: boolean; shaderF16: boolean },
): { device: "webgpu" | "wasm"; dtype: string; preferredAvailable: boolean } {
  const usable = compatibleDtypes(dtypes, hardware.shaderF16);
  const preferences = hardware.webgpu
    ? (hardware.shaderF16 ? ["q4f16", "q4", "q8", "fp16", "fp32"] : ["q4", "q8", "fp32"])
    : ["q8", "q4", "fp32"];
  const dtype = preferences.find((item) => usable.includes(item)) || usable[0] || "auto";
  return {
    device: hardware.webgpu ? "webgpu" : "wasm",
    dtype,
    preferredAvailable: dtype === preferences[0],
  };
}
