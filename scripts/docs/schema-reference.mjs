#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const outDir = join(root, "docs", "schema-reference");

const schemas = [
  {
    schemaPath: "data/llm-models.schema.json",
    dataPath: "data/llm-models.json",
    outputPath: "llm-models.md",
    spanishOutputPath: "llm-models.es.md",
    spanishTitle: "Catálogo de modelos LLM de Browser Agent v86",
    spanishDescription: "Schema fuente de `data/llm-models.json`. Entradas del catálogo editadas manualmente; `chat-state.ts` las enriquece en modelos runtime (runtime `agent` desde `agentProfile`, runtime `contextPolicy` desde engine/`contextPreset`/`contextOverride`, `thinking`, sampling). `context-budget.ts` aplica baselines por engine y la `contextPolicy` enriquecida en tiempo de prompt.",
    presetsDoc: true,
    guidance: [
      "Use `agentProfile` for Transformers.js agent/tool defaults; add `agentOverride` only for tested per-model exceptions.",
      "Transformers.js: set `contextPreset` for context budgeting; use `contextOverride` only when specific limits differ.",
      "Ollama: no `contextPreset`; use `contextOverride` or `contextWindowTokens` to change engine defaults.",
      "Expanded preset values are in **Catalog Presets** below (`src/browser/chat/state/chat-state.ts`).",
    ],
    spanishGuidance: [
      "Usa `agentProfile` para los defaults de agente/tools de Transformers.js; añade `agentOverride` solo para excepciones probadas por modelo.",
      "Transformers.js: configura `contextPreset` para el presupuesto de contexto; usa `contextOverride` solo cuando límites concretos difieran.",
      "Ollama: sin `contextPreset`; usa `contextOverride` o `contextWindowTokens` para cambiar los defaults del engine.",
      "Los valores expandidos de presets están en **Catálogo de presets** (`src/browser/chat/state/chat-state.ts`).",
    ],
  },
  {
    schemaPath: "vm/profiles/profile.schema.json",
    dataPath: "vm/profiles/*.json",
    outputPath: "vm-profile.md",
  },
];

function escapeMd(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\s+/g, " ")
    .trim();
}

function typeName(node) {
  if (!node) return "";
  if (node.type === "array") {
    const itemType = node.items?.type || "unknown";
    return `array<${itemType}>`;
  }
  return node.type || "";
}

function constraints(node) {
  const parts = [];
  if (Array.isArray(node.enum)) parts.push(`enum: ${node.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  if (Object.prototype.hasOwnProperty.call(node, "const")) parts.push(`const: ${JSON.stringify(node.const)}`);
  if (Number.isFinite(node.minimum)) parts.push(`minimum: ${node.minimum}`);
  if (Number.isFinite(node.maximum)) parts.push(`maximum: ${node.maximum}`);
  if (Number.isFinite(node.minLength)) parts.push(`minLength: ${node.minLength}`);
  if (Number.isFinite(node.minItems)) parts.push(`minItems: ${node.minItems}`);
  if (node.pattern) parts.push(`pattern: ${node.pattern}`);
  if (node.uniqueItems) parts.push("uniqueItems");
  if (node.contains?.const) parts.push(`contains: ${JSON.stringify(node.contains.const)}`);
  if (node.items?.minLength) parts.push(`items minLength: ${node.items.minLength}`);
  if (node.items?.pattern) parts.push(`items pattern: ${node.items.pattern}`);
  if (node.additionalProperties === false) parts.push("additionalProperties: false");
  return parts.join("; ");
}

const DOC_TEXT = {
  en: {
    generatedNotice: "Compact reference generated from JSON Schema. Update the source schema before editing field semantics here.",
    guidanceTitle: "Authoring Guidance",
    catalogPresetsTitle: "Catalog Presets",
    catalogPresetsIntro: "Documentation mirror of preset expansion in `src/browser/chat/state/chat-state.ts`. Catalog override objects (`agentOverride`, `contextOverride`) replace only the fields you set; chat-state.ts expands them into runtime `agent` and `contextPolicy`.",
    agentProfilesTitle: "`agentProfile` presets",
    agentProfilesIntro: "Expanded into runtime `agent` plus default `temperature`/`topP` (unless set on the catalog entry). `defaultNativeTools` comes from the shared list below unless `agentOverride.defaultNativeTools` overrides it.",
    sharedDefaultTools: "Shared `defaultNativeTools`:",
    agentField: "Agent field",
    sampling: "Sampling",
    value: "Value",
    engineDefault: "Engine default",
    contextPresetsTitle: "`contextPreset` presets (Transformers.js)",
    contextPresetsIntro: "Each preset merges `contextPresetBase.transformersjs` then its policy fields. Override with catalog `contextOverride` afterward (merged into runtime `contextPolicy`).",
    contextPresetBase: "`contextPresetBase.transformersjs`:",
    effectiveContextField: "Effective runtime contextPolicy field",
    engineContextDefaults: "Engine context defaults (before `contextPreset` / `contextOverride`)",
    source: "Source",
    schema: "Schema",
    data: "Data",
    rootType: "Root type",
    schemaId: "Schema id",
    requiredFields: "Required Fields",
    none: "None",
    properties: "Properties",
    field: "Field",
    required: "Required",
    type: "Type",
    description: "Description",
    constraints: "Constraints",
    yes: "yes",
    no: "no",
  },
  es: {
    generatedNotice: "Referencia compacta generada desde JSON Schema. Actualiza el schema fuente antes de cambiar la semántica de los campos.",
    guidanceTitle: "Guía de edición",
    catalogPresetsTitle: "Catálogo de presets",
    catalogPresetsIntro: "Documentación espejo de la expansión de presets en `src/browser/chat/state/chat-state.ts`. Los objetos override del catálogo (`agentOverride`, `contextOverride`) reemplazan solo los campos configurados; `chat-state.ts` los expande a runtime `agent` y `contextPolicy`.",
    agentProfilesTitle: "Presets de `agentProfile`",
    agentProfilesIntro: "Se expanden al runtime `agent` más `temperature`/`topP` por defecto (salvo que estén en la entrada del catálogo). `defaultNativeTools` sale de la lista compartida salvo override en `agentOverride.defaultNativeTools`.",
    sharedDefaultTools: "`defaultNativeTools` compartida:",
    agentField: "Campo agente",
    sampling: "Sampling",
    value: "Valor",
    engineDefault: "Default de engine",
    contextPresetsTitle: "Presets de `contextPreset` (Transformers.js)",
    contextPresetsIntro: "Cada preset fusiona `contextPresetBase.transformersjs` y después sus campos de policy. El catálogo puede sobreescribir con `contextOverride` después (fusionado en runtime `contextPolicy`).",
    contextPresetBase: "`contextPresetBase.transformersjs`:",
    effectiveContextField: "Campo efectivo de contextPolicy runtime",
    engineContextDefaults: "Defaults de contexto por engine (antes de `contextPreset` / `contextOverride`)",
    source: "Fuente",
    schema: "Schema",
    data: "Datos",
    rootType: "Tipo raíz",
    schemaId: "Schema id",
    requiredFields: "Campos obligatorios",
    none: "Ninguno",
    properties: "Propiedades",
    field: "Campo",
    required: "Obligatorio",
    type: "Tipo",
    description: "Descripción",
    constraints: "Restricciones",
    yes: "sí",
    no: "no",
  },
};

const ES_FIELD_DESCRIPTIONS = {
  id: "Identificador estable usado por selección, políticas y estado local. No renombrar sin migrar referencias.",
  engine: "Runtime usado para ejecutar el modelo.",
  model: "Identificador runtime del modelo. En Ollama es el tag local; en Transformers.js suele ser un repositorio compatible de Hugging Face.",
  device: "Dispositivo opcional de ejecución de Transformers.js. Si se omite, el default es webgpu.",
  dtype: "Formato numérico o cuantización opcional de Transformers.js. Si se omite, el default es auto.",
  sizeLabel: "Tamaño aproximado mostrado en la UI. Solo informativo.",
  requiresShaderF16: "true cuando un modelo WebGPU requiere soporte shader-f16.",
  agentProfile: "Preset de defaults de agente/tools y temperatura de sampling. Úsalo en entradas Transformers.js; Ollama usa defaults de agente por engine, así que configura temperature directamente cuando haga falta. `chat-state.ts` lo expande al objeto runtime `agent`. Ver [Catálogo de presets](#catálogo-de-presets).",
  agentOverride: "Override opcional de `agentProfile`. Configura solo campos que difieran del preset expandido tras probar el modelo. Expandido en runtime al objeto `agent` por `chat-state.ts`.",
  temperature: "Temperatura de muestreo opcional. Valores bajos son más deterministas. Omítela para usar el default derivado de `agentProfile` (0.1 para tools-good/tools-fair, 0.15 en el resto).",
  topP: "Valor opcional nucleus top_p. Omítelo para usar el default 0.85 aplicado en `chat-state.ts`.",
  thinking: "Configuración opcional de razonamiento. Omítela en modelos que no razonan. `chat-state.ts` deriva el toggle de UI, el estado por defecto y el flag `think` de Ollama desde `mode`.",
  contextWindowTokens: "Presupuesto de contexto de la app en tokens. No configura el contexto nativo del runtime. Se usa para derivar `safeInputTokens` y límites de salida.",
  contextPreset: "Solo Transformers.js. Preset de campos de presupuesto de contexto. Expandido por `chat-state.ts` a runtime `contextPolicy`. Ver [Catálogo de presets](#catálogo-de-presets).",
  contextOverride: "Override opcional de `contextPreset` y defaults de contexto por engine. En Ollama, configura solo campos que difieran de los defaults de engine.",
  notes: "Códigos de notas neutrales al idioma. La UI los renderiza como texto localizado; codifica solo hechos no derivables de otros campos.",
  ramGB: "RAM de sistema recomendada en GB. Solo informativa; se muestra en el panel LLM.",
  vramGB: "VRAM de GPU recomendada en GB. Solo informativa; se muestra en el panel LLM.",
  "agentOverride.maxSteps": "Override del máximo de pasos de agente AI SDK por turno con tools.",
  "agentOverride.maxNativeTools": "Override del número máximo de tools nativas activas enviadas al modelo.",
  "agentOverride.toolCalling": "Override del nivel de fiabilidad de tool-calling del modelo.",
  "agentOverride.defaultNativeTools": "Override avanzado de nombres de tools por defecto. Normalmente omítelo para que mande el orden `allowedTools` del perfil VM activo.",
  "agentOverride.selfSelectTools": "Permite que un modelo probado decida uso de tools antes del fallback heurístico incluso si su nivel derivado es weak/fair.",
  "thinking.mode": "Política de razonamiento. off: capaz pero suprimido. optional: muestra el toggle, inicialmente apagado. on: razonamiento activado por defecto.",
  "thinking.extract": "Opciones de AI SDK `extractReasoningMiddleware` para extracción por tags. Solo Transformers.js.",
  "thinking.extract.tagName": "Tag XML que envuelve el razonamiento, por ejemplo think.",
  "thinking.extract.startWithReasoning": "Trata la salida como si empezara dentro del bloque de razonamiento.",
  "thinking.extract.separator": "Separador insertado entre razonamiento y texto. Por defecto nueva línea (\\n) si se omite.",
  "contextOverride.provider": "Override avanzado de la familia de provider de presupuesto. Normalmente omítelo; engine/contextPreset ya derivan el provider efectivo.",
  "contextOverride.contextWindowTokens": "Override avanzado del presupuesto de contexto de la app dentro de `contextOverride`. Prefiere el campo superior `contextWindowTokens` si solo cambia el total.",
  "contextOverride.safeInputTokens": "Presupuesto de tokens de entrada reservado para system, runtime, historial y resultados de tools antes de calcular la salida.",
  "contextOverride.reservedOutputTokens": "Reserva estática opcional de salida. Normalmente se omite porque `getPolicy()` deriva límites dinámicamente.",
  "contextOverride.maxSystemChars": "Límite de caracteres del bloque system prompt.",
  "contextOverride.maxRuntimeChars": "Límite de caracteres de runtime/context inyectado en system prompt.",
  "contextOverride.maxHistoryMessages": "Máximo de turnos previos retenidos en el prompt.",
  "contextOverride.maxHistoryChars": "Límite de caracteres del historial retenido.",
  "contextOverride.maxToolResultChars": "Límite de caracteres para resultados de tools incluidos en turnos de agente.",
  "contextOverride.maxToolResultCharsForSynthesis": "Límite de caracteres para resultados de tools durante pasos de síntesis/respuesta final.",
  "contextOverride.maxArtifacts": "Máximo de artefactos adjuntos al prompt. Rara vez se configura en el catálogo.",
  "contextOverride.maxOutputTokens": "Límite duro opcional de tokens generados para chat/síntesis antes de límites por tipo.",
  "contextOverride.maxNewTokensForPlan": "Límite opcional para pasos de generación de plan.",
  "contextOverride.maxNewTokensForSynthesis": "Límite opcional para salida de síntesis.",
};

function descriptionFor(field, node, locale = "en") {
  if (locale === "es" && ES_FIELD_DESCRIPTIONS[field]) return ES_FIELD_DESCRIPTIONS[field];
  return node.description;
}

function propertyRows(properties = {}, required = [], prefix = "", locale = "en") {
  const text = DOC_TEXT[locale];
  return Object.entries(properties).map(([name, node]) => {
    const field = `${prefix}${name}`;
    const isRequired = required.includes(name) ? text.yes : text.no;
    return `| \`${escapeMd(field)}\` | ${isRequired} | ${escapeMd(typeName(node))} | ${escapeMd(descriptionFor(field, node, locale))} | ${escapeMd(constraints(node))} |`;
  });
}

function objectSections(node, pathPrefix, locale = "en") {
  const text = DOC_TEXT[locale];
  const sections = [];
  for (const [name, child] of Object.entries(node.properties || {})) {
    if (child.type !== "object" || !child.properties) continue;
    const sectionName = `${pathPrefix}${name}`;
    sections.push([
      `## ${sectionName}`,
      "",
      escapeMd(descriptionFor(sectionName, child, locale)),
      "",
      `| ${text.field} | ${text.required} | ${text.type} | ${text.description} | ${text.constraints} |`,
      "| --- | --- | --- | --- | --- |",
      ...propertyRows(child.properties, child.required || [], `${sectionName}.`, locale),
      "",
    ].join("\n"));
    sections.push(...objectSections(child, `${sectionName}.`, locale));
  }
  return sections;
}

function conditionalRules(schema) {
  if (!Array.isArray(schema.allOf) || !schema.allOf.length) return "";
  const lines = schema.allOf.map((rule, index) => {
    const details = [
      rule.if ? `if ${JSON.stringify(rule.if)}` : "",
      rule.then ? `then ${JSON.stringify(rule.then)}` : "",
    ].filter(Boolean).join("; ");
    return `- Rule ${index + 1}: ${details}`;
  });
  return ["## Conditional Rules", "", ...lines, ""].join("\n");
}

function formatObjectRows(obj) {
  return Object.entries(obj || {}).map(([key, value]) => `| \`${escapeMd(key)}\` | ${escapeMd(JSON.stringify(value))} |`);
}

// Preset tables for documentation only. Keep in sync with chat-state.ts.
const LLM_CATALOG_PRESETS_DOC = {
  defaultNativeTools: [
    "vm.python.exec",
    "vm.sh.exec",
    "vm.fs.list",
    "vm.fs.read",
    "vm.fs.write",
    "vm.cmd.which",
    "web.curl.head",
  ],
  agentProfiles: {
    "tools-good": {
      description: "Reliable native tool calls. Use for models validated for multi-tool agent turns.",
      descriptionEs: "Tool calling nativo fiable. Para modelos validados en turnos multi-tool.",
      agent: { maxSteps: 3, maxNativeTools: 6, toolCalling: "good" },
      sampling: { temperature: 0.1, topP: 0.85 },
    },
    "tools-fair": {
      description: "Mid-size models with fair native tool reliability.",
      descriptionEs: "Modelos medianos con fiabilidad fair en tool calling nativo.",
      agent: { maxSteps: 3, maxNativeTools: 5, toolCalling: "fair" },
      sampling: { temperature: 0.1, topP: 0.85 },
    },
    "tools-light-good": {
      description: "Reliable tool-calling models that need a smaller active tool set.",
      descriptionEs: "Modelos con tool calling fiable que necesitan un conjunto activo de tools más pequeño.",
      agent: { maxSteps: 3, maxNativeTools: 4, toolCalling: "good" },
      sampling: { temperature: 0.15, topP: 0.85 },
    },
    "tools-weak": {
      description: "Minimal fallback models; heavily capped tool loop.",
      descriptionEs: "Modelos fallback mínimos; loop de tools muy limitado.",
      agent: { maxSteps: 1, maxNativeTools: 1, toolCalling: "weak" },
      sampling: { temperature: 0.15, topP: 0.85 },
    },
  },
  engineAgentDefaults: {
    ollama: {
      description: "Ollama entries use these agent limits and should set temperature directly when they need a sampling exception.",
      descriptionEs: "Las entradas Ollama usan estos límites de agente y deben configurar `temperature` directamente si necesitan una excepción de sampling.",
      agent: { maxSteps: 4, maxNativeTools: 10, toolCalling: "good" },
    },
    transformersjs: {
      description: "Transformers.js fallback when agentProfile is omitted.",
      descriptionEs: "Fallback de Transformers.js cuando se omite `agentProfile`.",
      agent: { maxSteps: 3, maxNativeTools: 5, toolCalling: "fair" },
      sampling: { temperature: 0.15, topP: 0.85 },
    },
  },
  contextPresetBase: {
    transformersjs: {
      provider: "transformersjs",
      contextWindowTokens: 4096,
      maxHistoryMessages: 1,
    },
  },
  contextPresets: {
    "transformers-tiny-tools-plan": {
      description: "Sub-1B tool models that also run plan-generation steps (maxNewTokensForPlan = 384).",
      descriptionEs: "Modelos de tools sub-1B que también ejecutan pasos de generación de plan (maxNewTokensForPlan = 384).",
      contextPolicy: {
        safeInputTokens: 1100,
        maxSystemChars: 780,
        maxRuntimeChars: 300,
        maxHistoryChars: 350,
        maxToolResultChars: 1800,
        maxToolResultCharsForSynthesis: 1000,
        maxNewTokensForPlan: 384,
      },
    },
    "transformers-tiny-tools": {
      description: "Sub-1B tool models without a plan-specific output cap.",
      descriptionEs: "Modelos de tools sub-1B sin límite de salida específico para plan.",
      contextPolicy: {
        safeInputTokens: 1100,
        maxSystemChars: 780,
        maxRuntimeChars: 300,
        maxHistoryChars: 350,
        maxToolResultChars: 1800,
        maxToolResultCharsForSynthesis: 1000,
      },
    },
    "transformers-edge-tools": {
      description: "~1.2–1.5B edge models with moderate tool-result headroom.",
      descriptionEs: "Modelos edge de ~1.2–1.5B con margen moderado para resultados de tools.",
      contextPolicy: {
        safeInputTokens: 1250,
        maxSystemChars: 820,
        maxRuntimeChars: 320,
        maxHistoryChars: 550,
        maxToolResultChars: 2200,
        maxToolResultCharsForSynthesis: 1300,
      },
    },
    "transformers-350m-tools": {
      description: "~350M tool-tuned models with the tightest practical tool budgets.",
      descriptionEs: "Modelos ~350M ajustados para tools con el presupuesto práctico más ajustado.",
      contextPolicy: {
        safeInputTokens: 1050,
        maxSystemChars: 740,
        maxRuntimeChars: 280,
        maxHistoryChars: 320,
        maxToolResultChars: 1600,
        maxToolResultCharsForSynthesis: 900,
      },
    },
    "transformers-fp16-tools": {
      description: "FP16 WebGPU models with slightly larger prompt and tool-result limits.",
      descriptionEs: "Modelos FP16 WebGPU con límites algo mayores para prompt y resultados de tools.",
      contextPolicy: {
        safeInputTokens: 1350,
        maxSystemChars: 860,
        maxRuntimeChars: 340,
        maxHistoryChars: 650,
        maxToolResultChars: 2400,
        maxToolResultCharsForSynthesis: 1400,
      },
    },
    "transformers-micro-tools": {
      description: "~1.2B micro tool models with the largest local tool-result budget in this family.",
      descriptionEs: "Modelos micro tools de ~1.2B con el mayor presupuesto local para resultados de tools en esta familia.",
      contextPolicy: {
        safeInputTokens: 1400,
        maxSystemChars: 900,
        maxRuntimeChars: 360,
        maxHistoryChars: 700,
        maxToolResultChars: 2600,
        maxToolResultCharsForSynthesis: 1500,
      },
    },
    "transformers-tiny-fallback": {
      description: "WASM chat fallback; history and tool results disabled to minimize GPU/RAM spikes.",
      descriptionEs: "Fallback WASM de chat; historial y resultados de tools desactivados para minimizar picos de GPU/RAM.",
      contextPolicy: {
        safeInputTokens: 900,
        maxSystemChars: 560,
        maxRuntimeChars: 220,
        maxHistoryMessages: 0,
        maxHistoryChars: 0,
        maxToolResultChars: 0,
        maxToolResultCharsForSynthesis: 0,
      },
    },
  },
  engineContextDefaults: {
    ollama: {
      description: "Default Ollama context before catalog contextOverride merges. safeInputTokens = min(6000, max(2400, contextWindowTokens - 2200)).",
      descriptionEs: "Contexto default de Ollama antes de fusionar `contextOverride` del catálogo. safeInputTokens = min(6000, max(2400, contextWindowTokens - 2200)).",
      contextWindowTokens: 8192,
      contextPolicy: {
        provider: "ollama",
        reservedOutputTokens: 2048,
        maxSystemChars: 2600,
        maxRuntimeChars: 1200,
        maxHistoryMessages: 8,
        maxHistoryChars: 12000,
        maxToolResultChars: 20000,
        maxToolResultCharsForSynthesis: 8000,
        maxArtifacts: 4,
      },
    },
    transformersjs: {
      description: "Default Transformers.js context before contextPreset. Usually replaced by a preset on catalog entries.",
      descriptionEs: "Contexto default de Transformers.js antes de `contextPreset`. Normalmente lo reemplaza un preset en las entradas del catálogo.",
      contextWindowTokens: 4096,
      contextPolicy: { safeInputTokens: 1800 },
    },
  },
};

function catalogPresetsSection(locale = "en") {
  const text = DOC_TEXT[locale];
  const presets = LLM_CATALOG_PRESETS_DOC;
  const lines = [
    `## ${text.catalogPresetsTitle}`,
    "",
    text.catalogPresetsIntro,
    "",
    `### ${text.agentProfilesTitle}`,
    "",
    text.agentProfilesIntro,
    "",
    `**${text.sharedDefaultTools}**`,
    "",
    presets.defaultNativeTools.map((tool) => `- \`${tool}\``).join("\n"),
    "",
  ];

  for (const [name, profile] of Object.entries(presets.agentProfiles)) {
    lines.push(
      `#### \`${name}\``,
      "",
      escapeMd(locale === "es" ? profile.descriptionEs || profile.description : profile.description),
      "",
      `| ${text.agentField} | ${text.value} |`,
      "| --- | --- |",
      ...formatObjectRows(profile.agent),
      "",
      `| ${text.sampling} | ${text.value} |`,
      "| --- | --- |",
      ...formatObjectRows(profile.sampling),
      "",
    );
  }

  for (const [engine, defaults] of Object.entries(presets.engineAgentDefaults)) {
    lines.push(
      `#### ${text.engineDefault} (\`${engine}\`)`,
      "",
      escapeMd(locale === "es" ? defaults.descriptionEs || defaults.description : defaults.description),
      "",
      `| ${text.agentField} | ${text.value} |`,
      "| --- | --- |",
      ...formatObjectRows(defaults.agent),
      "",
    );
    if (defaults.sampling) {
      lines.push(
        `| ${text.sampling} | ${text.value} |`,
        "| --- | --- |",
        ...formatObjectRows(defaults.sampling),
        "",
      );
    }
  }

  lines.push(
    `### ${text.contextPresetsTitle}`,
    "",
    text.contextPresetsIntro,
    "",
    `**${text.contextPresetBase}**`,
    "",
    `| ${text.field} | ${text.value} |`,
    "| --- | --- |",
    ...formatObjectRows(presets.contextPresetBase.transformersjs),
    "",
  );

  for (const [name, preset] of Object.entries(presets.contextPresets)) {
    const merged = { ...presets.contextPresetBase.transformersjs, ...preset.contextPolicy };
    lines.push(
      `#### \`${name}\``,
      "",
      escapeMd(locale === "es" ? preset.descriptionEs || preset.description : preset.description),
      "",
      `| ${text.effectiveContextField} | ${text.value} |`,
      "| --- | --- |",
      ...formatObjectRows(merged),
      "",
    );
  }

  lines.push(
    `### ${text.engineContextDefaults}`,
    "",
  );

  for (const [engine, defaults] of Object.entries(presets.engineContextDefaults)) {
    lines.push(
      `#### \`${engine}\``,
      "",
      escapeMd(locale === "es" ? defaults.descriptionEs || defaults.description : defaults.description),
      "",
      `| ${text.field} | ${text.value} |`,
      "| --- | --- |",
      `| \`contextWindowTokens\` | ${defaults.contextWindowTokens} |`,
      ...formatObjectRows(defaults.contextPolicy),
      "",
    );
  }

  return lines.join("\n");
}

function writeSchemaDoc(config, locale = "en") {
  const text = DOC_TEXT[locale];
  const schema = JSON.parse(readFileSync(join(root, config.schemaPath), "utf8"));
  const rootNode = schema.type === "array" ? schema.items : schema;
  const required = rootNode.required || [];
  const fieldPrefix = "";
  const title = locale === "es" && config.spanishTitle ? config.spanishTitle : (schema.title || config.schemaPath);
  const outputPath = locale === "es" ? config.spanishOutputPath : config.outputPath;
  const lines = [
    `# ${title}`,
    "",
    text.generatedNotice,
    "",
    escapeMd(locale === "es" && config.spanishDescription ? config.spanishDescription : schema.description),
    "",
  ];

  const guidance = locale === "es" ? config.spanishGuidance || config.guidance : config.guidance;
  if (guidance?.length) {
    lines.push(`## ${text.guidanceTitle}`, "", ...guidance.map((item) => `- ${item}`), "");
  }

  lines.push(
    `## ${text.source}`,
    "",
    `- ${text.schema}: \`${config.schemaPath}\``,
    `- ${text.data}: \`${config.dataPath}\``,
    `- ${text.rootType}: \`${schema.type}\``,
    `- ${text.schemaId}: \`${schema.$id || ""}\``,
    "",
    `## ${text.requiredFields}`,
    "",
    required.length ? required.map((item) => `\`${item}\``).join(", ") : text.none,
    "",
    `## ${text.properties}`,
    "",
    `| ${text.field} | ${text.required} | ${text.type} | ${text.description} | ${text.constraints} |`,
    "| --- | --- | --- | --- | --- |",
    ...propertyRows(rootNode.properties, required, fieldPrefix, locale),
    "",
    ...objectSections(rootNode, fieldPrefix, locale),
  );

  const rules = conditionalRules(schema);
  if (rules) lines.push(rules);

  if (config.presetsDoc) {
    lines.push(catalogPresetsSection(locale), "");
  }

  writeFileSync(join(outDir, outputPath), `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`);
}

mkdirSync(outDir, { recursive: true });
for (const config of schemas) {
  writeSchemaDoc(config);
  if (config.spanishOutputPath) writeSchemaDoc(config, "es");
}
writeFileSync(join(outDir, "README.md"), [
  "# Schema Reference",
  "",
  "Compact markdown references generated from repository JSON Schemas.",
  "",
  "- [LLM model catalog](llm-models.md)",
  "- [Catálogo LLM (ES)](llm-models.es.md)",
  "- [VM profile](vm-profile.md)",
  "",
  "Regenerate with `npm run docs:schemas`.",
  "",
].join("\n"));

console.log(`Wrote schema reference docs to ${outDir}`);
