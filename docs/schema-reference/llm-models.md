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

`id`, `engine`, `model`, `device`, `dtype`, `sizeLabel`, `repoSizeLabel`, `minMemoryLabel`, `languageLabel`, `requiresShaderF16`, `compatibilityLabel`, `temperature`, `topP`, `description`

## Properties

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `items[].id` | yes | string | Stable unique identifier used by selection, policies and local state. Do not rename without migrating references. | minLength: 1 |
| `items[].engine` | yes | string | Runtime used to execute the model. | enum: "ollama", "transformersjs" |
| `items[].model` | yes | string | Runtime model identifier. For Ollama this is the local tag; for Transformers.js it is usually a compatible Hugging Face repository. |  |
| `items[].device` | yes | string | Execution device. Ollama uses remote; Transformers.js uses webgpu or wasm. | enum: "remote", "webgpu", "wasm" |
| `items[].dtype` | yes | string | Numeric format or quantization requested from the runtime. | enum: "host", "auto", "fp32", "fp16", "q8", "q4", "q4f16" |
| `items[].sizeLabel` | yes | string | Approximate model size displayed in the UI. Informational only. | minLength: 1 |
| `items[].repoSizeLabel` | yes | string | Repository, tag or quantization detail shown in the UI. Informational only. | minLength: 1 |
| `items[].minMemoryLabel` | yes | string | Approximate RAM/VRAM note shown in the UI. Informational only. | minLength: 1 |
| `items[].languageLabel` | yes | string | Short language/capability summary shown in the UI. | minLength: 1 |
| `items[].requiresShaderF16` | yes | boolean | true when a WebGPU model requires shader-f16 support. |  |
| `items[].requiresWebGPU` | no | boolean | false allows remote or WASM models; true means WebGPU is required. |  |
| `items[].compatibilityLabel` | yes | string | Human-readable compatibility or requirement summary. | minLength: 1 |
| `items[].toolProfile` | no | string | Preferred way to select predefined agent/tool defaults. chat-state.ts expands this into the runtime agent object unless the optional agent override below changes specific fields. | enum: "strong-json", "middle-tools", "reasoning-light", "tiny-fallback", "balanced" |
| `items[].temperature` | yes | number | Sampling temperature sent to the model. Lower values are more deterministic. | minimum: 0 |
| `items[].topP` | yes | number | Nucleus sampling top_p value sent to the model. | minimum: 0; maximum: 1 |
| `items[].ollamaThink` | no | boolean | Ollama-only thinking toggle when supported by the model and server. |  |
| `items[].thinking` | no | object | Reasoning extraction via AI SDK extractReasoningMiddleware (Transformers.js) or UI toggle. tagName must match the XML tags emitted by the model. | additionalProperties: false |
| `items[].contextWindowTokens` | no | integer | Raw model context window capacity. Usually omit for standard defaults/presets; set this only when a model has a different total context window than the runtime default. | minimum: 256 |
| `items[].maxNewTokens` | no | integer | Optional explicit output hard cap. Usually omit; if omitted, context-budget.ts derives output limits from the effective contextPolicy. | minimum: 1 |
| `items[].contextPreset` | no | string | Preferred way to select a predefined context budget. chat-state.ts expands this into runtime contextPolicy fields before applying the optional contextPolicy override below. | enum: "transformers-tiny-tools-plan", "transformers-tiny-tools", "transformers-edge-tools", "transformers-350m-tools", "transformers-fp16-tools", "transformers-micro-tools", "transformers-tiny-fallback" |
| `items[].contextPolicy` | no | object | Advanced per-model context budget override. Usually omit and use contextPreset instead. When present, these fields are merged after engine defaults and contextPreset, so they should only contain exceptions for a specific model. | additionalProperties: false |
| `items[].agent` | no | object | Advanced per-model agent/tool override. Usually omit and use toolProfile instead. Missing fields are filled from defaults derived from engine/toolProfile in chat-state.ts. | additionalProperties: false |
| `items[].experimental` | no | boolean | true for test, fallback, slow or less recommended models. |  |
| `items[].description` | yes | string | Human-readable description shown in the LLM panel. | minLength: 1 |

## items[].thinking

Reasoning extraction via AI SDK extractReasoningMiddleware (Transformers.js) or UI toggle. tagName must match the XML tags emitted by the model.

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `items[].thinking.enabled` | no | boolean | Show the thinking toggle and apply reasoning middleware when tag-based extraction applies. |  |
| `items[].thinking.tagName` | no | string | XML tag name for extractReasoningMiddleware, e.g. think or redacted_thinking. | minLength: 1 |
| `items[].thinking.startWithReasoning` | no | boolean | AI SDK extractReasoningMiddleware option for models that omit the opening tag. |  |

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
