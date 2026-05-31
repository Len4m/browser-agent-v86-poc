#!/usr/bin/env node
/**
 * Validates data/llm-models.json against data/llm-models.schema.json.
 *
 * This avoids adding a JSON Schema validator dependency for a small static
 * catalog. It implements the subset used by the local schema: type, required,
 * additionalProperties, enum, const, min/max numeric bounds, minLength and
 * if/then conditions.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const catalog = JSON.parse(readFileSync(join(root, "data", "llm-models.json"), "utf8"));
const schema = JSON.parse(readFileSync(join(root, "data", "llm-models.schema.json"), "utf8"));
const errors = [];

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  if (typeof value === "number") return "number";
  return typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

function pathJoin(base, key) {
  if (typeof key === "number") return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

function matchesSchema(value, node) {
  const before = errors.length;
  validate(value, node, "$");
  const ok = errors.length === before;
  errors.length = before;
  return ok;
}

function validate(value, node, path = "$") {
  if (!node || typeof node !== "object") return;

  if (node.type && !matchesType(value, node.type)) {
    errors.push(`${path}: expected ${node.type}, got ${typeOf(value)}`);
    return;
  }

  if (node.const !== undefined && value !== node.const) {
    errors.push(`${path}: expected constant ${JSON.stringify(node.const)}, got ${JSON.stringify(value)}`);
  }

  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    errors.push(`${path}: expected one of ${node.enum.map((item) => JSON.stringify(item)).join(", ")}, got ${JSON.stringify(value)}`);
  }

  if (typeof value === "string" && Number.isFinite(node.minLength) && value.length < node.minLength) {
    errors.push(`${path}: expected at least ${node.minLength} characters`);
  }

  if (typeof value === "number") {
    if (Number.isFinite(node.minimum) && value < node.minimum) {
      errors.push(`${path}: expected >= ${node.minimum}, got ${value}`);
    }
    if (Number.isFinite(node.maximum) && value > node.maximum) {
      errors.push(`${path}: expected <= ${node.maximum}, got ${value}`);
    }
  }

  if (Array.isArray(value) && node.items) {
    value.forEach((item, index) => validate(item, node.items, pathJoin(path, index)));
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const props = node.properties || {};
    for (const required of node.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        errors.push(`${path}: missing required property ${required}`);
      }
    }

    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          errors.push(`${path}: unknown property ${key}`);
        }
      }
    }

    for (const [key, childSchema] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validate(value[key], childSchema, pathJoin(path, key));
      }
    }
  }

  for (const branch of node.allOf || []) {
    if (!branch.if || matchesSchema(value, branch.if)) {
      if (branch.then) validate(value, branch.then, path);
    }
  }
}

validate(catalog, schema);

const ids = new Set();
for (const [index, model] of catalog.entries()) {
  if (!model?.id) continue;
  if (ids.has(model.id)) errors.push(`$[${index}].id: duplicate id ${model.id}`);
  ids.add(model.id);
}

if (errors.length) {
  console.error("LLM model catalog validation failed:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`OK LLM models: ${catalog.length} entries match schema`);
