# Browser Agent v86 LLM model catalog

Compact reference generated from JSON Schema. Update the source schema before editing field semantics here.

Source schema for data/llm-models.json. This schema describes the author-edited catalog entries, not the fully enriched runtime model objects. chat-state.ts derives runtime agent defaults from engine/toolProfile and runtime contextPolicy defaults from engine/contextPreset.

## Authoring Guidance

- Use `toolProfile` for normal tool/agent behavior. It is expanded into the runtime `agent` object by `chat-state.ts`.
- Use `contextPreset` for normal context and token budgeting. It is expanded into the runtime `contextPolicy` object by `chat-state.ts`.
- Use `agent` only for tested per-model exceptions, such as a model that needs fewer tools but can still self-select tool use.
- Use `contextPolicy` only for per-model context budget exceptions that do not fit an existing preset.
- `contextWindowTokens` is the raw total model capacity; `contextPolicy` is how the app spends that capacity across system prompt, history, artifacts, tool results, and output.

## Source

- Schema: `data/llm-models.schema.json`
- Data: `data/llm-models.json`
- Root type: `array`
- Schema id: `https://github.com/Len4m/browser-agent-v86-poc/schemas/llm-models.schema.json`

## Required Fields

`id`, `engine`, `model`, `sizeLabel`, `requiresShaderF16`

## Properties

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `items[].id` | yes | string | Stable unique identifier used by selection, policies and local state. Do not rename without migrating references. | minLength: 1 |
| `items[].engine` | yes | string | Runtime used to execute the model. | enum: "ollama", "transformersjs" |
| `items[].model` | yes | string | Runtime model identifier. For Ollama this is the local tag; for Transformers.js it is usually a compatible Hugging Face repository. |  |
| `items[].device` | no | string | Optional Transformers.js execution device. Defaults to webgpu when omitted. | enum: "webgpu", "wasm" |
| `items[].dtype` | no | string | Optional Transformers.js numeric format or quantization. Defaults to auto when omitted. | enum: "auto", "fp32", "fp16", "q8", "q4", "q4f16" |
| `items[].sizeLabel` | yes | string | Approximate model size displayed in the UI. Informational only. | minLength: 1 |
| `items[].requiresShaderF16` | yes | boolean | true when a WebGPU model requires shader-f16 support. |  |
| `items[].toolProfile` | no | string | Preferred way to select predefined agent/tool defaults. chat-state.ts expands this into the runtime agent object unless the optional agent override below changes specific fields. | enum: "strong-json", "middle-tools", "reasoning-light", "tiny-fallback", "balanced" |
| `items[].temperature` | no | number | Optional sampling temperature. Lower values are more deterministic. Omit to use the default derived from toolProfile in chat-state.ts (0.1 for strong-json/middle-tools/balanced, 0.15 otherwise); set this only for per-model exceptions. | minimum: 0 |
| `items[].topP` | no | number | Optional nucleus sampling top_p value. Omit to use the default (0.85) applied in chat-state.ts; set this only for per-model exceptions. | minimum: 0; maximum: 1 |
| `items[].thinking` | no | object | Optional reasoning configuration. Omit entirely for models that do not reason. chat-state.ts derives the UI toggle, the default state, and the Ollama think request flag from mode; extract is only consumed by the Transformers.js tag-based reasoning middleware. | additionalProperties: false |
| `items[].contextWindowTokens` | no | integer | Raw model context window capacity. Usually omit for standard defaults/presets; set this only when a model has a different total context window than the runtime default. | minimum: 256 |
| `items[].maxNewTokens` | no | integer | Optional explicit output hard cap. Usually omit; if omitted, context-budget.ts derives output limits from the effective contextPolicy. | minimum: 1 |
| `items[].contextPreset` | no | string | Preferred way to select a predefined context budget. chat-state.ts expands this into runtime contextPolicy fields before applying the optional contextPolicy override below. | enum: "transformers-tiny-tools-plan", "transformers-tiny-tools", "transformers-edge-tools", "transformers-350m-tools", "transformers-fp16-tools", "transformers-micro-tools", "transformers-tiny-fallback" |
| `items[].contextPolicy` | no | object | Advanced per-model context budget override. Usually omit and use contextPreset instead. When present, these fields are merged after engine defaults and contextPreset, so they should only contain exceptions for a specific model. | additionalProperties: false |
| `items[].agent` | no | object | Advanced per-model agent/tool override. Usually omit and use toolProfile instead. Missing fields are filled from defaults derived from engine/toolProfile in chat-state.ts. | additionalProperties: false |
| `items[].experimental` | no | boolean | true for test, fallback, slow or less recommended models. |  |
| `items[].notes` | no | array&lt;string&gt; | Optional language-neutral note codes. The UI renders each code as localized text, so encode only facts that are not derivable from other fields (engine, dtype, requiresShaderF16, experimental, etc.). Possible codes: `tools-primary` (recommended for tool use), `tools-validated` (tool calling validated in this project), `chat-only` (chat only, tools disabled), `moe` (mixture-of-experts architecture). | uniqueItems |
| `items[].ramGB` | no | number | Optional recommended system RAM in GB. Informational only; shown in the LLM panel. | minimum: 0 |
| `items[].vramGB` | no | number | Optional recommended GPU VRAM in GB. Informational only; shown in the LLM panel. | minimum: 0 |
| `items[].description` | no | string | Optional free-text override shown in the LLM panel. Prefer notes + ramGB/vramGB so copy stays language-neutral; when present this replaces the composed text. | minLength: 1 |

## items[].thinking

Optional reasoning configuration. Omit entirely for models that do not reason. chat-state.ts derives the UI toggle, the default state, and the Ollama think request flag from mode; extract is only consumed by the Transformers.js tag-based reasoning middleware.

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `items[].thinking.mode` | yes | string | Reasoning policy. off: capable but suppressed (no UI toggle; Ollama receives think:false). optional: show the UI toggle, starting off. on: reasoning enabled by default. | enum: "off", "optional", "on" |
| `items[].thinking.extract` | no | object | AI SDK extractReasoningMiddleware options for tag-based reasoning extraction. Transformers.js only; omit for Ollama, which exposes reasoning natively. | additionalProperties: false |

## items[].thinking.extract

AI SDK extractReasoningMiddleware options for tag-based reasoning extraction. Transformers.js only; omit for Ollama, which exposes reasoning natively.

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `items[].thinking.extract.tagName` | yes | string | XML tag wrapping the reasoning, e.g. think. | minLength: 1 |
| `items[].thinking.extract.startWithReasoning` | no | boolean | Treat the output as starting inside the reasoning block, for models that emit only the closing tag. |  |
| `items[].thinking.extract.separator` | no | string | Separator inserted between reasoning and text sections. Defaults to newline (\n) when omitted. |  |

## items[].contextPolicy

Advanced per-model context budget override. Usually omit and use contextPreset instead. When present, these fields are merged after engine defaults and contextPreset, so they should only contain exceptions for a specific model.

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `items[].contextPolicy.provider` | no | string | Advanced override for the budget provider family. Usually omit; engine/contextPreset already derive the effective provider at runtime. | enum: "ollama", "transformersjs" |
| `items[].contextPolicy.contextWindowTokens` | no | integer | Advanced override for the total context window used inside contextPolicy. Prefer the top-level contextWindowTokens field when only the model capacity differs. | minimum: 256 |
| `items[].contextPolicy.safeInputTokens` | no | integer | Input token budget reserved for system, runtime, history and tool results before output is computed. | minimum: 0 |
| `items[].contextPolicy.reservedOutputTokens` | no | integer | Optional static output reservation. Usually omitted; getPolicy() derives output limits dynamically. | minimum: 1 |
| `items[].contextPolicy.maxSystemChars` | no | integer | Character cap for the system prompt block. | minimum: 0 |
| `items[].contextPolicy.maxRuntimeChars` | no | integer | Character cap for runtime/context injected into the system prompt. | minimum: 0 |
| `items[].contextPolicy.maxHistoryMessages` | no | integer | Maximum prior chat turns kept in the prompt. | minimum: 0 |
| `items[].contextPolicy.maxHistoryChars` | no | integer | Character cap across retained history messages. | minimum: 0 |
| `items[].contextPolicy.maxToolResultChars` | no | integer | Character cap for tool results included in agent turns. | minimum: 0 |
| `items[].contextPolicy.maxToolResultCharsForSynthesis` | no | integer | Character cap for tool results during synthesis/final answer steps. | minimum: 0 |
| `items[].contextPolicy.maxArtifacts` | no | integer | Maximum artifacts attached to a prompt. Rarely set in the catalog; defaults come from provider policy. | minimum: 0 |
| `items[].contextPolicy.maxOutputTokens` | no | integer | Optional hard cap on generated output tokens for chat/synthesis before kind-specific limits apply. | minimum: 1 |
| `items[].contextPolicy.maxNewTokensForPlan` | no | integer | Optional cap for plan-generation steps. If omitted, resolveMaxOutputTokens() uses 768 for Ollama and 384 for local Transformers.js. | minimum: 1 |
| `items[].contextPolicy.maxNewTokensForSynthesis` | no | integer | Optional cap for synthesis output. Usually omitted because getPolicy() derives it from resolveMaxOutputTokens(). | minimum: 1 |

## items[].agent

Advanced per-model agent/tool override. Usually omit and use toolProfile instead. Missing fields are filled from defaults derived from engine/toolProfile in chat-state.ts.

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `items[].agent.maxSteps` | no | integer | Override for maximum AI SDK agent steps for a tool turn before runtime caps are applied. | minimum: 1 |
| `items[].agent.maxNativeTools` | no | integer | Override for maximum number of active native tools sent to the model. | minimum: 0 |
| `items[].agent.toolCalling` | no | string | Override for the model tool-calling reliability tier. Derived from toolProfile by default. | enum: "weak", "fair", "good" |
| `items[].agent.defaultNativeTools` | no | array&lt;string&gt; | Advanced override for default tool names. Usually omit so the active VM profile allowedTools order decides. | items minLength: 1 |
| `items[].agent.selfSelectTools` | no | boolean | Override that allows a tested model to decide tool use before heuristic fallback even when its derived toolCalling tier is weak/fair. |  |
