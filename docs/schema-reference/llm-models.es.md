# Catálogo de modelos LLM de Browser Agent v86

Referencia compacta generada desde JSON Schema. Actualiza el schema fuente antes de cambiar la semántica de los campos.

Schema fuente de `data/llm-models.json`. Entradas del catálogo editadas manualmente; `chat-state.ts` las enriquece en modelos runtime (runtime `agent` desde `agentProfile`, runtime `contextPolicy` desde engine/`contextPreset`/`contextOverride`, `thinking`, sampling). `context-budget.ts` aplica baselines por engine y la `contextPolicy` enriquecida en tiempo de prompt.

## Guía de edición

- Usa `agentProfile` para los defaults de agente/tools de Transformers.js; añade `agentOverride` solo para excepciones probadas por modelo.
- Transformers.js: configura `contextPreset` para el presupuesto de contexto; usa `contextOverride` solo cuando límites concretos difieran.
- Ollama: sin `contextPreset`; usa `contextOverride` o `contextWindowTokens` para cambiar los defaults del engine.
- Los valores expandidos de presets están en **Catálogo de presets** (`src/browser/chat/state/chat-state.ts`).

## Fuente

- Schema: `data/llm-models.schema.json`
- Datos: `data/llm-models.json`
- Tipo raíz: `array`
- Schema id: `https://github.com/Len4m/browser-agent-v86-poc/schemas/llm-models.schema.json`

## Campos obligatorios

`id`, `engine`, `model`, `sizeLabel`

## Propiedades

| Campo | Obligatorio | Tipo | Descripción | Restricciones |
| --- | --- | --- | --- | --- |
| `id` | sí | string | Identificador estable usado por selección, políticas y estado local. No renombrar sin migrar referencias. | minLength: 1 |
| `engine` | sí | string | Runtime usado para ejecutar el modelo. | enum: "ollama", "transformersjs" |
| `model` | sí | string | Identificador runtime del modelo. En Ollama es el tag local; en Transformers.js suele ser un repositorio compatible de Hugging Face. |  |
| `device` | no | string | Dispositivo opcional de ejecución de Transformers.js. Si se omite, el default es webgpu. | enum: "webgpu", "wasm" |
| `dtype` | no | string | Formato numérico o cuantización opcional de Transformers.js. Si se omite, el default es auto. | enum: "auto", "fp32", "fp16", "q8", "q4", "q4f16" |
| `sizeLabel` | sí | string | Tamaño aproximado mostrado en la UI. Solo informativo. | minLength: 1 |
| `requiresShaderF16` | no | boolean | Opcional. Configúralo en true solo para modelos Transformers.js WebGPU que requieran shader-f16. Por defecto es false si se omite. |  |
| `agentProfile` | no | string | Preset de defaults de agente/tools y temperatura de sampling. Úsalo en entradas Transformers.js; Ollama usa defaults de agente por engine, así que configura temperature directamente cuando haga falta. `chat-state.ts` lo expande al objeto runtime `agent`. Ver [Catálogo de presets](#catálogo-de-presets). | enum: "tools-good", "tools-fair", "tools-light-good", "tools-weak" |
| `agentOverride` | no | object | Override opcional de `agentProfile`. Configura solo campos que difieran del preset expandido tras probar el modelo. Expandido en runtime al objeto `agent` por `chat-state.ts`. | additionalProperties: false |
| `temperature` | no | number | Temperatura de muestreo opcional. Valores bajos son más deterministas. Omítela para usar el default derivado de `agentProfile` (0.1 para tools-good/tools-fair, 0.15 en el resto). | minimum: 0 |
| `topP` | no | number | Valor opcional nucleus top_p. Omítelo para usar el default 0.85 aplicado en `chat-state.ts`. | minimum: 0; maximum: 1 |
| `thinking` | no | object | Configuración opcional de razonamiento. Omítela en modelos que no razonan. `chat-state.ts` deriva el toggle de UI, el estado por defecto y el flag `think` de Ollama desde `mode`. | additionalProperties: false |
| `contextWindowTokens` | no | integer | Presupuesto de contexto de la app en tokens. No configura el contexto nativo del runtime. Se usa para derivar `safeInputTokens` y límites de salida. | minimum: 256 |
| `contextPreset` | no | string | Solo Transformers.js. Preset de campos de presupuesto de contexto. Expandido por `chat-state.ts` a runtime `contextPolicy`. Ver [Catálogo de presets](#catálogo-de-presets). | enum: "browser-tools-xs", "browser-tools-sm", "browser-tools-md", "browser-tools-lg", "browser-tools-xl", "browser-chat-fallback" |
| `contextOverride` | no | object | Override opcional de `contextPreset` y defaults de contexto por engine. En Ollama, configura solo campos que difieran de los defaults de engine. | additionalProperties: false |
| `notes` | no | array&lt;string&gt; | Códigos de notas neutrales al idioma. La UI los renderiza como texto localizado; codifica solo hechos no derivables de otros campos. | uniqueItems |
| `ramGB` | no | number | RAM de sistema recomendada en GB. Solo informativa; se muestra en el panel LLM. | minimum: 0 |
| `vramGB` | no | number | VRAM de GPU recomendada en GB. Solo informativa; se muestra en el panel LLM. | minimum: 0 |

## agentOverride

Override opcional de `agentProfile`. Configura solo campos que difieran del preset expandido tras probar el modelo. Expandido en runtime al objeto `agent` por `chat-state.ts`.

| Campo | Obligatorio | Tipo | Descripción | Restricciones |
| --- | --- | --- | --- | --- |
| `agentOverride.maxSteps` | no | integer | Override del máximo de pasos de agente AI SDK por turno con tools. | minimum: 1 |
| `agentOverride.maxNativeTools` | no | integer | Override del número máximo de tools nativas activas enviadas al modelo. | minimum: 0 |
| `agentOverride.toolCalling` | no | string | Override del nivel de fiabilidad de tool-calling del modelo. | enum: "weak", "fair", "good" |
| `agentOverride.selfSelectTools` | no | boolean | Permite que un modelo probado decida uso de tools antes del fallback heurístico incluso si su nivel derivado es weak/fair. |  |

## thinking

Configuración opcional de razonamiento. Omítela en modelos que no razonan. `chat-state.ts` deriva el toggle de UI, el estado por defecto y el flag `think` de Ollama desde `mode`.

| Campo | Obligatorio | Tipo | Descripción | Restricciones |
| --- | --- | --- | --- | --- |
| `thinking.mode` | sí | string | Política de razonamiento. off: capaz pero suprimido. optional: muestra el toggle, inicialmente apagado. on: razonamiento activado por defecto. | enum: "off", "optional", "on" |
| `thinking.extract` | no | object | Opciones de AI SDK `extractReasoningMiddleware` para extracción por tags. Solo Transformers.js. | additionalProperties: false |

## thinking.extract

Opciones de AI SDK `extractReasoningMiddleware` para extracción por tags. Solo Transformers.js.

| Campo | Obligatorio | Tipo | Descripción | Restricciones |
| --- | --- | --- | --- | --- |
| `thinking.extract.tagName` | sí | string | Tag XML que envuelve el razonamiento, por ejemplo think. | minLength: 1 |
| `thinking.extract.startWithReasoning` | no | boolean | Trata la salida como si empezara dentro del bloque de razonamiento. |  |
| `thinking.extract.separator` | no | string | Separador insertado entre razonamiento y texto. Por defecto nueva línea (\n) si se omite. |  |

## contextOverride

Override opcional de `contextPreset` y defaults de contexto por engine. En Ollama, configura solo campos que difieran de los defaults de engine.

| Campo | Obligatorio | Tipo | Descripción | Restricciones |
| --- | --- | --- | --- | --- |
| `contextOverride.contextWindowTokens` | no | integer | Override avanzado del presupuesto de contexto de la app dentro de `contextOverride`. Prefiere el campo superior `contextWindowTokens` si solo cambia el total. | minimum: 256 |
| `contextOverride.safeInputTokens` | no | integer | Presupuesto de tokens de entrada reservado para system, runtime, historial y resultados de tools antes de calcular la salida. | minimum: 0 |
| `contextOverride.reservedOutputTokens` | no | integer | Reserva estática opcional de salida. Normalmente se omite porque `getPolicy()` deriva límites dinámicamente. | minimum: 1 |
| `contextOverride.maxSystemChars` | no | integer | Límite de caracteres del bloque system prompt. | minimum: 0 |
| `contextOverride.maxRuntimeChars` | no | integer | Límite de caracteres de runtime/context inyectado en system prompt. | minimum: 0 |
| `contextOverride.maxHistoryMessages` | no | integer | Máximo de turnos previos retenidos en el prompt. | minimum: 0 |
| `contextOverride.maxHistoryChars` | no | integer | Límite de caracteres del historial retenido. | minimum: 0 |
| `contextOverride.maxToolResultChars` | no | integer | Límite de caracteres para resultados de tools incluidos en turnos de agente. | minimum: 0 |
| `contextOverride.maxToolResultCharsForSynthesis` | no | integer | Límite de caracteres para resultados de tools durante pasos de síntesis/respuesta final. | minimum: 0 |
| `contextOverride.maxArtifacts` | no | integer | Máximo de artefactos adjuntos al prompt. Rara vez se configura en el catálogo. | minimum: 0 |
| `contextOverride.maxOutputTokens` | no | integer | Límite duro opcional de tokens generados para chat/síntesis antes de límites por tipo. | minimum: 1 |
| `contextOverride.maxNewTokensForPlan` | no | integer | Límite opcional para pasos de generación de plan. | minimum: 1 |
| `contextOverride.maxNewTokensForSynthesis` | no | integer | Límite opcional para salida de síntesis. | minimum: 1 |

## Catálogo de presets

Documentación espejo de la expansión de presets en `src/browser/chat/state/chat-state.ts`. Los objetos override del catálogo (`agentOverride`, `contextOverride`) reemplazan solo los campos configurados; `chat-state.ts` los expande a runtime `agent` y `contextPolicy`.

### Presets de `agentProfile`

Se expanden al runtime `agent` más `temperature`/`topP` por defecto (salvo que estén en la entrada del catálogo). La lista efectiva de tools sale del perfil VM activo y se limita con `maxNativeTools`.

#### `tools-good`

Tool calling nativo fiable. Para modelos validados en turnos multi-tool.

| Campo agente | Valor |
| --- | --- |
| `maxSteps` | 3 |
| `maxNativeTools` | 10 |
| `toolCalling` | "good" |

| Sampling | Valor |
| --- | --- |
| `temperature` | 0.1 |
| `topP` | 0.85 |

#### `tools-fair`

Modelos medianos con fiabilidad fair en tool calling nativo.

| Campo agente | Valor |
| --- | --- |
| `maxSteps` | 3 |
| `maxNativeTools` | 5 |
| `toolCalling` | "fair" |

| Sampling | Valor |
| --- | --- |
| `temperature` | 0.1 |
| `topP` | 0.85 |

#### `tools-light-good`

Modelos con tool calling fiable que necesitan un conjunto activo de tools más pequeño.

| Campo agente | Valor |
| --- | --- |
| `maxSteps` | 3 |
| `maxNativeTools` | 4 |
| `toolCalling` | "good" |

| Sampling | Valor |
| --- | --- |
| `temperature` | 0.15 |
| `topP` | 0.85 |

#### `tools-weak`

Modelos fallback mínimos; loop de tools muy limitado.

| Campo agente | Valor |
| --- | --- |
| `maxSteps` | 1 |
| `maxNativeTools` | 1 |
| `toolCalling` | "weak" |

| Sampling | Valor |
| --- | --- |
| `temperature` | 0.15 |
| `topP` | 0.85 |

#### Default de engine (`ollama`)

Las entradas Ollama usan estos límites de agente y deben configurar `temperature` directamente si necesitan una excepción de sampling.

| Campo agente | Valor |
| --- | --- |
| `maxSteps` | 4 |
| `maxNativeTools` | 10 |
| `toolCalling` | "good" |

#### Default de engine (`transformersjs`)

Fallback de Transformers.js cuando se omite `agentProfile`.

| Campo agente | Valor |
| --- | --- |
| `maxSteps` | 3 |
| `maxNativeTools` | 5 |
| `toolCalling` | "fair" |

| Sampling | Valor |
| --- | --- |
| `temperature` | 0.15 |
| `topP` | 0.85 |

### Presets de `contextPreset` (Transformers.js)

Cada preset fusiona `contextPresetBase.transformersjs` y después sus campos de policy. El catálogo puede sobreescribir con `contextOverride` después (fusionado en runtime `contextPolicy`).

**`contextPresetBase.transformersjs`:**

| Campo | Valor |
| --- | --- |
| `contextWindowTokens` | 4096 |
| `maxHistoryMessages` | 1 |

#### `browser-tools-xs`

Presupuesto browser de tools más ajustado para modelos locales muy pequeños.

| Campo efectivo de contextPolicy runtime | Valor |
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

Presupuesto browser pequeño para modelos locales sub-1B.

| Campo efectivo de contextPolicy runtime | Valor |
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

Presupuesto browser medio para modelos locales de 1B-1.5B.

| Campo efectivo de contextPolicy runtime | Valor |
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

Presupuesto browser grande para modelos locales WebGPU más capaces.

| Campo efectivo de contextPolicy runtime | Valor |
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

Mayor presupuesto browser para modelos locales que toleran más contexto de prompt/resultados de tools.

| Campo efectivo de contextPolicy runtime | Valor |
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

Fallback WASM de chat; historial y resultados de tools desactivados para minimizar picos de GPU/RAM.

| Campo efectivo de contextPolicy runtime | Valor |
| --- | --- |
| `contextWindowTokens` | 4096 |
| `maxHistoryMessages` | 0 |
| `safeInputTokens` | 900 |
| `maxSystemChars` | 560 |
| `maxRuntimeChars` | 220 |
| `maxHistoryChars` | 0 |
| `maxToolResultChars` | 0 |
| `maxToolResultCharsForSynthesis` | 0 |

### Defaults de contexto por engine (antes de `contextPreset` / `contextOverride`)

#### `ollama`

Contexto default de Ollama antes de fusionar `contextOverride` del catálogo. safeInputTokens = min(6000, max(2400, contextWindowTokens - 2200)).

| Campo | Valor |
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

Contexto default de Transformers.js antes de `contextPreset`. Normalmente lo reemplaza un preset en las entradas del catálogo.

| Campo | Valor |
| --- | --- |
| `contextWindowTokens` | 4096 |
| `safeInputTokens` | 1800 |
