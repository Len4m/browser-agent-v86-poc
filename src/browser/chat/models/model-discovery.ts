import type { DiscoveredModel, ModelCapabilitySignals } from "./model-types";
import { modelKey } from "./model-types";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface DiscoveryPage {
  models: DiscoveredModel[];
  nextUrl: string | null;
}

export interface HfSearchOptions {
  query?: string;
  nextUrl?: string | null;
  signal?: AbortSignal;
}

export interface OllamaModelDetails {
  model: DiscoveredModel;
  capabilities: ModelCapabilitySignals;
  contextWindowTokens?: number;
  template?: string;
  parameters?: string;
  raw: Record<string, unknown>;
}

const HF_API = "https://huggingface.co/api/models";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function linkNext(header: string | null): string | null {
  if (!header) return null;
  for (const item of header.split(",")) {
    const match = item.match(/<([^>]+)>\s*;\s*rel=(?:"next"|next)/i);
    if (match) return match[1];
  }
  return null;
}

function responseError(response: Response, service: string): Error {
  const retryAfter = response.headers.get("retry-after");
  const suffix = retryAfter ? `; retry after ${retryAfter}` : "";
  return new Error(`${service} request failed (${response.status})${suffix}`);
}

export function buildHfSearchUrl(query = ""): string {
  const url = new URL(HF_API);
  url.searchParams.set("filter", "transformers.js");
  url.searchParams.set("pipeline_tag", "text-generation");
  url.searchParams.set("sort", "downloads");
  url.searchParams.set("direction", "-1");
  url.searchParams.set("limit", "30");
  if (query.trim()) url.searchParams.set("search", query.trim());
  return url.href;
}

function hfModel(value: unknown): DiscoveredModel | null {
  if (!isRecord(value)) return null;
  const modelId = text(value.id) || text(value.modelId);
  if (!modelId || value.private === true || value.gated === true || value.gated === "auto" || value.gated === "manual") return null;
  if (text(value.pipeline_tag) !== "text-generation") return null;
  const tags = Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [];
  if (!tags.includes("transformers.js")) return null;
  return {
    key: modelKey("transformersjs", modelId),
    engine: "transformersjs",
    modelId,
    label: modelId,
    downloads: number(value.downloads),
    modifiedAt: text(value.lastModified) || undefined,
    private: false,
    gated: false,
    metadata: { tags, likes: number(value.likes), pipelineTag: value.pipeline_tag },
  };
}

export async function searchHfModels(fetcher: FetchLike, options: HfSearchOptions = {}): Promise<DiscoveryPage> {
  const url = options.nextUrl || buildHfSearchUrl(options.query);
  const response = await fetcher(url, { signal: options.signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw responseError(response, "Hugging Face");
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error("Hugging Face returned an invalid model list");
  return {
    models: body.flatMap((value) => {
      const model = hfModel(value);
      return model ? [model] : [];
    }),
    nextUrl: linkNext(response.headers.get("link")),
  };
}

export class HfModelSearchService {
  private readonly cache = new Map<string, { expires: number; page: DiscoveryPage }>();
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rejectPending: ((reason?: unknown) => void) | null = null;

  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly now: () => number = Date.now,
    private readonly debounceMs = 300,
  ) {}

  search(query = "", nextUrl: string | null = null): Promise<DiscoveryPage> {
    const cacheKey = nextUrl || buildHfSearchUrl(query);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > this.now()) return Promise.resolve(cached.page);
    this.cancel();
    this.controller = new AbortController();
    const controller = this.controller;
    return new Promise((resolve, reject) => {
      this.rejectPending = reject;
      this.timer = setTimeout(async () => {
        this.timer = null;
        try {
          const page = await searchHfModels(this.fetcher, { query, nextUrl, signal: controller.signal });
          if (this.cache.size >= 20) this.cache.delete(this.cache.keys().next().value as string);
          this.cache.set(cacheKey, { expires: this.now() + 5 * 60_000, page });
          this.rejectPending = null;
          resolve(page);
        } catch (error) {
          this.rejectPending = null;
          reject(error);
        }
      }, nextUrl ? 0 : this.debounceMs);
    });
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.rejectPending?.(new DOMException("Aborted", "AbortError"));
    }
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.rejectPending = null;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/g, "");
}

function ollamaModel(value: unknown): DiscoveredModel | null {
  if (!isRecord(value)) return null;
  const modelId = text(value.name) || text(value.model);
  if (!modelId) return null;
  return {
    key: modelKey("ollama", modelId),
    engine: "ollama",
    modelId,
    label: modelId,
    sizeBytes: number(value.size),
    modifiedAt: text(value.modified_at) || undefined,
    metadata: {
      digest: text(value.digest) || undefined,
      details: isRecord(value.details) ? value.details : {},
    },
  };
}

export async function discoverOllamaModels(fetcher: FetchLike, endpoint: string, signal?: AbortSignal): Promise<DiscoveredModel[]> {
  const response = await fetcher(`${normalizeEndpoint(endpoint)}/api/tags`, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw responseError(response, "Ollama");
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.models)) throw new Error("Ollama returned an invalid model list");
  return body.models.flatMap((value) => {
    const model = ollamaModel(value);
    return model ? [model] : [];
  });
}

function findContextWindow(modelInfo: Record<string, unknown>): number | undefined {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (/(?:^|\.)context_length$/.test(key) && typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export async function inspectOllamaModel(
  fetcher: FetchLike,
  endpoint: string,
  model: DiscoveredModel,
  signal?: AbortSignal,
): Promise<OllamaModelDetails> {
  const response = await fetcher(`${normalizeEndpoint(endpoint)}/api/show`, {
    method: "POST",
    signal,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ model: model.modelId }),
  });
  if (!response.ok) throw responseError(response, "Ollama");
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Ollama returned invalid model details");
  const capabilities = Array.isArray(body.capabilities)
    ? body.capabilities.filter((item): item is string => typeof item === "string")
    : [];
  const template = text(body.template);
  const modelInfo = isRecord(body.model_info) ? body.model_info : {};
  const templateText = template.toLowerCase();
  return {
    model,
    capabilities: {
      chat: capabilities.includes("completion") || Boolean(template),
      tools: capabilities.includes("tools") || /(?:tool_call|\.tools|<tool)/.test(templateText),
      thinking: capabilities.includes("thinking") || /(?:thinking|reasoning)/.test(templateText),
      vision: capabilities.includes("vision"),
    },
    contextWindowTokens: findContextWindow(modelInfo),
    template: template || undefined,
    parameters: text(body.parameters) || undefined,
    raw: body,
  };
}
