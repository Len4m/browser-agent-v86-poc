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
    guidance: [
      "Use `toolProfile` for normal tool/agent behavior. It is expanded into the runtime `agent` object by `chat-state.ts`.",
      "Use `contextPreset` for normal context and token budgeting. It is expanded into the runtime `contextPolicy` object by `chat-state.ts`.",
      "Use `agent` only for tested per-model exceptions, such as a model that needs fewer tools but can still self-select tool use.",
      "Use `contextPolicy` only for per-model context budget exceptions that do not fit an existing preset.",
      "`contextWindowTokens` is the raw total model capacity; `contextPolicy` is how the app spends that capacity across system prompt, history, artifacts, tool results, and output.",
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

function objectSections(node, pathPrefix) {
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

function writeSchemaDoc(config) {
  const schema = JSON.parse(readFileSync(join(root, config.schemaPath), "utf8"));
  const rootNode = schema.type === "array" ? schema.items : schema;
  const required = rootNode.required || [];
  const fieldPrefix = schema.type === "array" ? "items[]." : "";
  const title = schema.title || config.schemaPath;
  const lines = [
    `# ${title}`,
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
    ...propertyRows(rootNode.properties, required, fieldPrefix),
    "",
    ...objectSections(rootNode, fieldPrefix),
  );

  const rules = conditionalRules(schema);
  if (rules) lines.push(rules);

  writeFileSync(join(outDir, config.outputPath), `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`);
}

mkdirSync(outDir, { recursive: true });
for (const config of schemas) writeSchemaDoc(config);
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
