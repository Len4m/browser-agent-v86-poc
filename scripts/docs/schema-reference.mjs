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
    presetsDoc: true,
    guidance: [
      "Use `agentProfile` for Transformers.js agent/tool defaults; add `agentOverride` only for tested per-model exceptions.",
      "Transformers.js: set `contextPreset` for context budgeting; use `contextOverride` only when specific limits differ.",
      "Ollama: no `contextPreset`; use `contextOverride` or `contextWindowTokens` to change engine defaults.",
      "Expanded preset values are in **Catalog Presets** below (`src/browser/chat/state/chat-state.ts`).",
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

function propertyRows(properties = {}, required = [], prefix = "") {
  return Object.entries(properties).map(([name, node]) => {
    const field = `${prefix}${name}`;
    const isRequired = required.includes(name) ? "yes" : "no";
    return `| \`${escapeMd(field)}\` | ${isRequired} | ${escapeMd(typeName(node))} | ${escapeMd(node.description)} | ${escapeMd(constraints(node))} |`;
  });
}

function objectSections(node, pathPrefix = "") {
  const sections = [];
  for (const [name, child] of Object.entries(node.properties || {})) {
    if (child.type !== "object" || !child.properties) continue;
    const sectionName = `${pathPrefix}${name}`;
    sections.push([
      `## ${sectionName}`,
      "",
      escapeMd(child.description),
      "",
      "| Field | Required | Type | Description | Constraints |",
      "| --- | --- | --- | --- | --- |",
      ...propertyRows(child.properties, child.required || [], `${sectionName}.`),
      "",
    ].join("\n"));
    sections.push(...objectSections(child, `${sectionName}.`));
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
  agentProfiles: {
    "tools-good": {
      description: "Reliable native tool calls. Use for models validated for multi-tool agent turns.",
      agent: { maxSteps: 3, maxNativeTools: 10, toolCalling: "good" },
      sampling: { temperature: 0.1, topP: 0.85 },
    },
    "tools-fair": {
      description: "Mid-size models with fair native tool reliability.",
      agent: { maxSteps: 3, maxNativeTools: 5, toolCalling: "fair" },
      sampling: { temperature: 0.1, topP: 0.85 },
    },
    "tools-light-good": {
      description: "Reliable tool-calling models that need a smaller active tool set.",
      agent: { maxSteps: 3, maxNativeTools: 4, toolCalling: "good" },
      sampling: { temperature: 0.15, topP: 0.85 },
    },
    "tools-weak": {
      description: "Minimal fallback models; heavily capped tool loop.",
      agent: { maxSteps: 1, maxNativeTools: 1, toolCalling: "weak" },
      sampling: { temperature: 0.15, topP: 0.85 },
    },
  },
  engineAgentDefaults: {
    ollama: {
      description: "Ollama entries use these agent limits and should set temperature directly when they need a sampling exception.",
      agent: { maxSteps: 4, maxNativeTools: 10, toolCalling: "good" },
    },
    transformersjs: {
      description: "Transformers.js fallback when agentProfile is omitted.",
      agent: { maxSteps: 3, maxNativeTools: 5, toolCalling: "fair" },
      sampling: { temperature: 0.15, topP: 0.85 },
    },
  },
  contextPresetBase: {
    transformersjs: {
      contextWindowTokens: 4096,
      maxHistoryMessages: 1,
    },
  },
  contextPresets: {
    "browser-tools-xs": {
      description: "Tightest browser tool budget for very small local models.",
      contextPolicy: {
        safeInputTokens: 1050,
        maxSystemChars: 740,
        maxRuntimeChars: 280,
        maxHistoryChars: 320,
        maxToolResultChars: 1600,
        maxToolResultCharsForSynthesis: 900,
      },
    },
    "browser-tools-sm": {
      description: "Small browser tool budget for sub-1B local models.",
      contextPolicy: {
        safeInputTokens: 1100,
        maxSystemChars: 780,
        maxRuntimeChars: 300,
        maxHistoryChars: 350,
        maxToolResultChars: 1800,
        maxToolResultCharsForSynthesis: 1000,
      },
    },
    "browser-tools-md": {
      description: "Medium browser tool budget for 1B-1.5B local models.",
      contextPolicy: {
        safeInputTokens: 1250,
        maxSystemChars: 820,
        maxRuntimeChars: 320,
        maxHistoryChars: 550,
        maxToolResultChars: 2200,
        maxToolResultCharsForSynthesis: 1300,
      },
    },
    "browser-tools-lg": {
      description: "Large browser tool budget for stronger WebGPU local models.",
      contextPolicy: {
        safeInputTokens: 1350,
        maxSystemChars: 860,
        maxRuntimeChars: 340,
        maxHistoryChars: 650,
        maxToolResultChars: 2400,
        maxToolResultCharsForSynthesis: 1400,
      },
    },
    "browser-tools-xl": {
      description: "Largest browser tool budget for local models that tolerate more prompt/tool-result context.",
      contextPolicy: {
        safeInputTokens: 1400,
        maxSystemChars: 900,
        maxRuntimeChars: 360,
        maxHistoryChars: 700,
        maxToolResultChars: 2600,
        maxToolResultCharsForSynthesis: 1500,
      },
    },
    "browser-chat-fallback": {
      description: "WASM chat fallback; history and tool results disabled to minimize GPU/RAM spikes.",
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
      contextWindowTokens: 8192,
      contextPolicy: {
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
      contextWindowTokens: 4096,
      contextPolicy: { safeInputTokens: 1800 },
    },
  },
};

function catalogPresetsSection() {
  const presets = LLM_CATALOG_PRESETS_DOC;
  const lines = [
    "## Catalog Presets",
    "",
    "Documentation mirror of preset expansion in `src/browser/chat/state/chat-state.ts`. Catalog override objects (`agentOverride`, `contextOverride`) replace only the fields you set; chat-state.ts expands them into runtime `agent` and `contextPolicy`.",
    "",
    "### `agentProfile` presets",
    "",
    "Expanded into runtime `agent` plus default `temperature`/`topP` (unless set on the catalog entry). The effective tool list still comes from the active VM profile and is capped by `maxNativeTools`.",
    "",
  ];

  for (const [name, profile] of Object.entries(presets.agentProfiles)) {
    lines.push(
      `#### \`${name}\``,
      "",
      escapeMd(profile.description),
      "",
      "| Agent field | Value |",
      "| --- | --- |",
      ...formatObjectRows(profile.agent),
      "",
      "| Sampling | Value |",
      "| --- | --- |",
      ...formatObjectRows(profile.sampling),
      "",
    );
  }

  for (const [engine, defaults] of Object.entries(presets.engineAgentDefaults)) {
    lines.push(
      `#### Engine default (\`${engine}\`)`,
      "",
      escapeMd(defaults.description),
      "",
      "| Agent field | Value |",
      "| --- | --- |",
      ...formatObjectRows(defaults.agent),
      "",
    );
    if (defaults.sampling) {
      lines.push(
        "| Sampling | Value |",
        "| --- | --- |",
        ...formatObjectRows(defaults.sampling),
        "",
      );
    }
  }

  lines.push(
    "### `contextPreset` presets (Transformers.js)",
    "",
    "Each preset merges `contextPresetBase.transformersjs` then its policy fields. Override with catalog `contextOverride` afterward (merged into runtime `contextPolicy`).",
    "",
    "**`contextPresetBase.transformersjs`:**",
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...formatObjectRows(presets.contextPresetBase.transformersjs),
    "",
  );

  for (const [name, preset] of Object.entries(presets.contextPresets)) {
    const merged = { ...presets.contextPresetBase.transformersjs, ...preset.contextPolicy };
    lines.push(
      `#### \`${name}\``,
      "",
      escapeMd(preset.description),
      "",
      "| Effective runtime contextPolicy field | Value |",
      "| --- | --- |",
      ...formatObjectRows(merged),
      "",
    );
  }

  lines.push(
    "### Engine context defaults (before `contextPreset` / `contextOverride`)",
    "",
  );

  for (const [engine, defaults] of Object.entries(presets.engineContextDefaults)) {
    lines.push(
      `#### \`${engine}\``,
      "",
      escapeMd(defaults.description),
      "",
      "| Field | Value |",
      "| --- | --- |",
      `| \`contextWindowTokens\` | ${defaults.contextWindowTokens} |`,
      ...formatObjectRows(defaults.contextPolicy),
      "",
    );
  }

  return lines.join("\n");
}

function writeSchemaDoc(config) {
  const schema = JSON.parse(readFileSync(join(root, config.schemaPath), "utf8"));
  const rootNode = schema.type === "array" ? schema.items : schema;
  const required = rootNode.required || [];
  const lines = [
    `# ${schema.title || config.schemaPath}`,
    "",
    "Compact reference generated from JSON Schema. Update the source schema before editing field semantics here.",
    "",
    escapeMd(schema.description),
    "",
  ];

  if (config.guidance?.length) {
    lines.push("## Authoring Guidance", "", ...config.guidance.map((item) => `- ${item}`), "");
  }

  lines.push(
    "## Source",
    "",
    `- Schema: \`${config.schemaPath}\``,
    `- Data: \`${config.dataPath}\``,
    `- Root type: \`${schema.type}\``,
    `- Schema id: \`${schema.$id || ""}\``,
    "",
    "## Required Fields",
    "",
    required.length ? required.map((item) => `\`${item}\``).join(", ") : "None",
    "",
    "## Properties",
    "",
    "| Field | Required | Type | Description | Constraints |",
    "| --- | --- | --- | --- | --- |",
    ...propertyRows(rootNode.properties, required),
    "",
    ...objectSections(rootNode),
  );

  const rules = conditionalRules(schema);
  if (rules) lines.push(rules);

  if (config.presetsDoc) {
    lines.push(catalogPresetsSection(), "");
  }

  writeFileSync(join(outDir, config.outputPath), `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`);
}

mkdirSync(outDir, { recursive: true });
for (const config of schemas) {
  writeSchemaDoc(config);
}
writeFileSync(join(outDir, "README.md"), [
  "# Schema Reference",
  "",
  "Compact markdown references generated from repository JSON Schemas.",
  "",
  "- [LLM model catalog](llm-models.md)",
  "- [VM profile](vm-profile.md)",
  "",
  "Regenerate with `npm run docs:schemas`.",
  "",
].join("\n"));

console.log(`Wrote schema reference docs to ${outDir}`);
