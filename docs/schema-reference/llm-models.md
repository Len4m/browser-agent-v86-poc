# Browser Agent v86 LLM model catalog

Compact reference generated from JSON Schema. Update the source schema before editing field semantics here.

`data/llm-models.json` is the hand-edited source catalog. `chat-state.ts` expands entries into runtime models; `context-budget.ts` applies context limits when building prompts.

## Authoring Guidance

- Use `agentProfile` for Transformers.js agent/tool defaults; add `agentOverride` only for tested per-model exceptions.
- Transformers.js: set `contextPreset` for context budgeting; use `contextOverride` only when specific limits differ.
- Ollama: no `contextPreset`; use `contextOverride` or `contextWindowTokens` to change engine defaults.
- Expanded preset values are in **Catalog Presets** below (`src/browser/chat/state/chat-state.ts`).

## Source

- Schema: `data/llm-models.schema.json`
- Data: `data/llm-models.json`
- Root type: `array`
- Schema id: `https://github.com/Len4m/browser-agent-v86-poc/schemas/llm-models.schema.json`

## Required Fields

`id`, `engine`, `model`, `sizeLabel`

## Properties

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `id` | yes | string | Stable unique identifier used by selection, policies and local state. Do not rename without migrating references. | minLength: 1 |
| `engine` | yes | string | Runtime used to execute the model. | enum: "ollama", "transformersjs" |
| `model` | yes | string | Runtime model identifier. For Ollama this is the local tag; for Transformers.js it is usually a compatible Hugging Face repository. |  |
| `device` | no | string | Optional Transformers.js execution device. Defaults to webgpu when omitted. | enum: "webgpu", "wasm" |
| `dtype` | no | string | Optional Transformers.js numeric format or quantization. Defaults to auto when omitted. | enum: "auto", "fp32", "fp16", "q8", "q4", "q4f16" |
| `sizeLabel` | yes | string | Approximate model size displayed in the UI. Informational only. | minLength: 1 |
| `requiresShaderF16` | no | boolean | Optional. Set true only for WebGPU Transformers.js models that require shader-f16 support. Defaults to false when omitted. |  |
| `agentProfile` | no | string | Preset for agent/tool defaults and sampling temperature. Use it for Transformers.js catalog entries; Ollama entries use engine agent defaults, so set temperature directly when needed. Expanded by chat-state.ts into the runtime agent object. See [Catalog Presets](#catalog-presets). | enum: "tools-good", "tools-fair", "tools-light-good", "tools-weak" |
| `agentOverride` | no | object | Optional per-model override for agentProfile (field above). Only set fields that differ from the expanded preset after a model has been tested. Expanded at runtime into the agent object by chat-state.ts. | additionalProperties: false |
| `temperature` | no | number | Optional sampling temperature. Lower values are more deterministic. Omit to use the default derived from agentProfile in chat-state.ts (0.1 for tools-good/tools-fair, 0.15 otherwise); set this only for per-model exceptions. | minimum: 0 |
| `topP` | no | number | Optional nucleus sampling top_p value. Omit to use the default (0.85) applied in chat-state.ts; set this only for per-model exceptions. | minimum: 0; maximum: 1 |
| `thinking` | no | object | Optional reasoning configuration. Omit entirely for models that do not reason. chat-state.ts derives the UI toggle, the default state, and the Ollama think request flag from mode; extract is only consumed by the Transformers.js tag-based reasoning middleware. | additionalProperties: false |
| `contextWindowTokens` | no | integer | Optional app-side context budget in tokens. Does not configure the model runtime native context (Ollama num_ctx, Transformers.js). chat-state.ts and context-budget.ts use it to derive safeInputTokens and max output limits. Omit for engine defaults (8192 Ollama, 4096 Transformers.js); set only when the effective budget should differ from those defaults. | minimum: 256 |
| `contextPreset` | no | string | Transformers.js only. Preset for context budget fields. Expanded by chat-state.ts into runtime contextPolicy. See [Catalog Presets](#catalog-presets). | enum: "browser-tools-xs", "browser-tools-sm", "browser-tools-md", "browser-tools-lg", "browser-tools-xl", "browser-chat-fallback" |
| `contextOverride` | no | object | Optional per-model override for contextPreset (field above) and engine context defaults. For Ollama, set only fields that differ from engine defaults. Merged in chat-state.ts into runtime contextPolicy, then consumed by context-budget.ts. | additionalProperties: false |
| `notes` | no | array&lt;string&gt; | Optional language-neutral note codes. The UI renders each code as localized text, so encode only facts that are not derivable from other fields (engine, dtype, requiresShaderF16, etc.). Possible codes: `tools-primary` (recommended for tool use), `tools-validated` (tool calling validated in this project), `chat-only` (chat only, tools disabled), `moe` (mixture-of-experts architecture). | uniqueItems |
| `ramGB` | no | number | Optional recommended system RAM in GB. Informational only; shown in the LLM panel. | minimum: 0 |
| `vramGB` | no | number | Optional recommended GPU VRAM in GB. Informational only; shown in the LLM panel. | minimum: 0 |

## agentOverride

Optional per-model override for agentProfile (field above). Only set fields that differ from the expanded preset after a model has been tested. Expanded at runtime into the agent object by chat-state.ts.

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `agentOverride.maxSteps` | no | integer | Override for maximum AI SDK agent steps for a tool turn before runtime caps are applied. | minimum: 1 |
| `agentOverride.maxNativeTools` | no | integer | Override for maximum number of active native tools sent to the model. | minimum: 0 |
| `agentOverride.toolCalling` | no | string | Override for the model tool-calling reliability tier. | enum: "weak", "fair", "good" |
| `agentOverride.selfSelectTools` | no | boolean | Override that allows a tested model to decide tool use before heuristic fallback even when its derived toolCalling tier is weak/fair. |  |

## thinking

Optional reasoning configuration. Omit entirely for models that do not reason. chat-state.ts derives the UI toggle, the default state, and the Ollama think request flag from mode; extract is only consumed by the Transformers.js tag-based reasoning middleware.

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `thinking.mode` | yes | string | Reasoning policy. off: capable but suppressed (no UI toggle; Ollama receives think:false). optional: show the UI toggle, starting off. on: reasoning enabled by default. | enum: "off", "optional", "on" |
| `thinking.extract` | no | object | AI SDK extractReasoningMiddleware options for tag-based reasoning extraction. Transformers.js only; omit for Ollama, which exposes reasoning natively. | additionalProperties: false |

## thinking.extract

AI SDK extractReasoningMiddleware options for tag-based reasoning extraction. Transformers.js only; omit for Ollama, which exposes reasoning natively.

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `thinking.extract.tagName` | yes | string | XML tag wrapping the reasoning, e.g. think. | minLength: 1 |
| `thinking.extract.startWithReasoning` | no | boolean | Treat the output as starting inside the reasoning block, for models that emit only the closing tag. |  |
| `thinking.extract.separator` | no | string | Separator inserted between reasoning and text sections. Defaults to newline (\n) when omitted. |  |

## contextOverride

Optional per-model override for contextPreset (field above) and engine context defaults. For Ollama, set only fields that differ from engine defaults. Merged in chat-state.ts into runtime contextPolicy, then consumed by context-budget.ts.

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `contextOverride.contextWindowTokens` | no | integer | Advanced override for the app context budget inside contextOverride. Same semantics as the top-level field; prefer the top-level contextWindowTokens when only the budget total differs. | minimum: 256 |
| `contextOverride.safeInputTokens` | no | integer | Input token budget reserved for system, runtime, history and tool results before output is computed. | minimum: 0 |
| `contextOverride.reservedOutputTokens` | no | integer | Optional static output reservation. Usually omitted; getPolicy() derives output limits dynamically. | minimum: 1 |
| `contextOverride.maxSystemChars` | no | integer | Character cap for the system prompt block. | minimum: 0 |
| `contextOverride.maxRuntimeChars` | no | integer | Character cap for runtime/context injected into the system prompt. | minimum: 0 |
| `contextOverride.maxHistoryMessages` | no | integer | Maximum prior chat turns kept in the prompt. | minimum: 0 |
| `contextOverride.maxHistoryChars` | no | integer | Character cap across retained history messages. | minimum: 0 |
| `contextOverride.maxToolResultChars` | no | integer | Character cap for tool results included in agent turns. | minimum: 0 |
| `contextOverride.maxToolResultCharsForSynthesis` | no | integer | Character cap for tool results during synthesis/final answer steps. | minimum: 0 |
| `contextOverride.maxArtifacts` | no | integer | Maximum artifacts attached to a prompt. Rarely set in the catalog; engine defaults in context-budget.ts apply when omitted. | minimum: 0 |
| `contextOverride.maxOutputTokens` | no | integer | Optional hard cap on generated output tokens for chat/synthesis before kind-specific limits apply. | minimum: 1 |
| `contextOverride.maxNewTokensForPlan` | no | integer | Optional cap for plan-generation steps. If omitted, resolveMaxOutputTokens() uses 768 for Ollama and 384 for local Transformers.js. | minimum: 1 |
| `contextOverride.maxNewTokensForSynthesis` | no | integer | Optional cap for synthesis output. Usually omitted because getPolicy() derives it from resolveMaxOutputTokens(). | minimum: 1 |

## Catalog Presets

Documentation mirror of preset expansion in `src/browser/chat/state/chat-state.ts`. Catalog override objects (`agentOverride`, `contextOverride`) replace only the fields you set; chat-state.ts expands them into runtime `agent` and `contextPolicy`.

### `agentProfile` presets

Expanded into runtime `agent` plus default `temperature`/`topP` (unless set on the catalog entry). The effective tool list still comes from the active VM profile and is capped by `maxNativeTools`.

#### `tools-good`

Reliable native tool calls. Use for models validated for multi-tool agent turns.

| Agent field | Value |
| --- | --- |
| `maxSteps` | 3 |
| `maxNativeTools` | 10 |
| `toolCalling` | "good" |

| Sampling | Value |
| --- | --- |
| `temperature` | 0.1 |
| `topP` | 0.85 |

#### `tools-fair`

Mid-size models with fair native tool reliability.

| Agent field | Value |
| --- | --- |
| `maxSteps` | 3 |
| `maxNativeTools` | 5 |
| `toolCalling` | "fair" |

| Sampling | Value |
| --- | --- |
| `temperature` | 0.1 |
| `topP` | 0.85 |

#### `tools-light-good`

Reliable tool-calling models that need a smaller active tool set.

| Agent field | Value |
| --- | --- |
| `maxSteps` | 3 |
| `maxNativeTools` | 4 |
| `toolCalling` | "good" |

| Sampling | Value |
| --- | --- |
| `temperature` | 0.15 |
| `topP` | 0.85 |

#### `tools-weak`

Minimal fallback models; heavily capped tool loop.

| Agent field | Value |
| --- | --- |
| `maxSteps` | 1 |
| `maxNativeTools` | 1 |
| `toolCalling` | "weak" |

| Sampling | Value |
| --- | --- |
| `temperature` | 0.15 |
| `topP` | 0.85 |

#### Engine default (`ollama`)

Ollama entries use these agent limits and should set temperature directly when they need a sampling exception.

| Agent field | Value |
| --- | --- |
| `maxSteps` | 4 |
| `maxNativeTools` | 10 |
| `toolCalling` | "good" |

#### Engine default (`transformersjs`)

Transformers.js fallback when agentProfile is omitted.

| Agent field | Value |
| --- | --- |
| `maxSteps` | 3 |
| `maxNativeTools` | 5 |
| `toolCalling` | "fair" |

| Sampling | Value |
| --- | --- |
| `temperature` | 0.15 |
| `topP` | 0.85 |

### `contextPreset` presets (Transformers.js)

Each preset merges `contextPresetBase.transformersjs` then its policy fields. Override with catalog `contextOverride` afterward (merged into runtime `contextPolicy`).

**`contextPresetBase.transformersjs`:**

| Field | Value |
| --- | --- |
| `contextWindowTokens` | 4096 |
| `maxHistoryMessages` | 1 |

#### `browser-tools-xs`

Tightest browser tool budget for very small local models.

| Effective runtime contextPolicy field | Value |
| --- | --- |
| `contextWindowTokens` | 4096 |
| `maxHistoryMessages` | 1 |
| `safeInputTokens` | 1050 |
| `maxSystemChars` | 740 |
| `maxRuntimeChars` | 280 |
| `maxHistoryChars` | 320 |
| `maxToolResultChars` | 1600 |
| `maxToolResultCharsForSynthesis` | 900 |

#### `browser-tools-sm`

Small browser tool budget for sub-1B local models.

| Effective runtime contextPolicy field | Value |
| --- | --- |
| `contextWindowTokens` | 4096 |
| `maxHistoryMessages` | 1 |
| `safeInputTokens` | 1100 |
| `maxSystemChars` | 780 |
| `maxRuntimeChars` | 300 |
| `maxHistoryChars` | 350 |
| `maxToolResultChars` | 1800 |
| `maxToolResultCharsForSynthesis` | 1000 |

#### `browser-tools-md`

Medium browser tool budget for 1B-1.5B local models.

| Effective runtime contextPolicy field | Value |
| --- | --- |
| `contextWindowTokens` | 4096 |
| `maxHistoryMessages` | 1 |
| `safeInputTokens` | 1250 |
| `maxSystemChars` | 820 |
| `maxRuntimeChars` | 320 |
| `maxHistoryChars` | 550 |
| `maxToolResultChars` | 2200 |
| `maxToolResultCharsForSynthesis` | 1300 |

#### `browser-tools-lg`

Large browser tool budget for stronger WebGPU local models.

| Effective runtime contextPolicy field | Value |
| --- | --- |
| `contextWindowTokens` | 4096 |
| `maxHistoryMessages` | 1 |
| `safeInputTokens` | 1350 |
| `maxSystemChars` | 860 |
| `maxRuntimeChars` | 340 |
| `maxHistoryChars` | 650 |
| `maxToolResultChars` | 2400 |
| `maxToolResultCharsForSynthesis` | 1400 |

#### `browser-tools-xl`

Largest browser tool budget for local models that tolerate more prompt/tool-result context.

| Effective runtime contextPolicy field | Value |
| --- | --- |
| `contextWindowTokens` | 4096 |
| `maxHistoryMessages` | 1 |
| `safeInputTokens` | 1400 |
| `maxSystemChars` | 900 |
| `maxRuntimeChars` | 360 |
| `maxHistoryChars` | 700 |
| `maxToolResultChars` | 2600 |
| `maxToolResultCharsForSynthesis` | 1500 |

#### `browser-chat-fallback`

WASM chat fallback; history and tool results disabled to minimize GPU/RAM spikes.

| Effective runtime contextPolicy field | Value |
| --- | --- |
| `contextWindowTokens` | 4096 |
| `maxHistoryMessages` | 0 |
| `safeInputTokens` | 900 |
| `maxSystemChars` | 560 |
| `maxRuntimeChars` | 220 |
| `maxHistoryChars` | 0 |
| `maxToolResultChars` | 0 |
| `maxToolResultCharsForSynthesis` | 0 |

### Engine context defaults (before `contextPreset` / `contextOverride`)

#### `ollama`

Default Ollama context before catalog contextOverride merges. safeInputTokens = min(6000, max(2400, contextWindowTokens - 2200)).

| Field | Value |
| --- | --- |
| `contextWindowTokens` | 8192 |
| `reservedOutputTokens` | 2048 |
| `maxSystemChars` | 2600 |
| `maxRuntimeChars` | 1200 |
| `maxHistoryMessages` | 8 |
| `maxHistoryChars` | 12000 |
| `maxToolResultChars` | 20000 |
| `maxToolResultCharsForSynthesis` | 8000 |
| `maxArtifacts` | 4 |

#### `transformersjs`

Default Transformers.js context before contextPreset. Usually replaced by a preset on catalog entries.

| Field | Value |
| --- | --- |
| `contextWindowTokens` | 4096 |
| `safeInputTokens` | 1800 |
