#!/usr/bin/env node
/**
 * Validates vm/profiles/*.json against vm/profiles/profile.schema.json.
 *
 * This keeps profile checks dependency-free, matching the lightweight approach
 * used by scripts/check/llm-models.mjs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverToolDefinitions } from "../build/lib/tool-definitions.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profilesDir = join(root, "vm", "profiles");
const schema = JSON.parse(readFileSync(join(profilesDir, "profile.schema.json"), "utf8"));
const profileFiles = readdirSync(profilesDir)
  .filter((file) => file.endsWith(".json") && !file.endsWith(".schema.json"))
  .sort();
const requiredProfilePackages = ["python3"];
const toolDefinitions = discoverToolDefinitions(root);
const knownToolNames = new Set(toolDefinitions.map((tool) => tool.name));
const toolPackageRequirements = Object.fromEntries(
  toolDefinitions.map((tool) => [tool.name, tool.requiredPackages]),
);
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

function validate(value, node, path = "$") {
  if (!node || typeof node !== "object") return;

  if (Object.prototype.hasOwnProperty.call(node, "const") && value !== node.const) {
    errors.push(`${path}: expected ${JSON.stringify(node.const)}, got ${JSON.stringify(value)}`);
  }

  if (node.type && !matchesType(value, node.type)) {
    errors.push(`${path}: expected ${node.type}, got ${typeOf(value)}`);
    return;
  }

  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    errors.push(`${path}: expected one of ${node.enum.map((item) => JSON.stringify(item)).join(", ")}, got ${JSON.stringify(value)}`);
  }

  if (typeof value === "string") {
    if (Number.isFinite(node.minLength) && value.length < node.minLength) {
      errors.push(`${path}: expected at least ${node.minLength} characters`);
    }
    if (node.pattern && !(new RegExp(node.pattern).test(value))) {
      errors.push(`${path}: expected to match ${node.pattern}, got ${JSON.stringify(value)}`);
    }
  }

  if (typeof value === "number") {
    if (Number.isFinite(node.minimum) && value < node.minimum) {
      errors.push(`${path}: expected >= ${node.minimum}, got ${value}`);
    }
    if (Number.isFinite(node.maximum) && value > node.maximum) {
      errors.push(`${path}: expected <= ${node.maximum}, got ${value}`);
    }
  }

  if (Array.isArray(value)) {
    if (Number.isFinite(node.minItems) && value.length < node.minItems) {
      errors.push(`${path}: expected at least ${node.minItems} items`);
    }
    if (node.uniqueItems) {
      const seen = new Set();
      for (const [index, item] of value.entries()) {
        const key = JSON.stringify(item);
        if (seen.has(key)) errors.push(`${path}[${index}]: duplicate array item ${key}`);
        seen.add(key);
      }
    }
    if (node.items) value.forEach((item, index) => validate(item, node.items, pathJoin(path, index)));
    if (node.contains) {
      const before = errors.length;
      const matches = value.filter((item) => {
        const snapshot = errors.length;
        validate(item, node.contains, path);
        const matched = errors.length === snapshot;
        errors.length = snapshot;
        return matched;
      });
      errors.length = before;
      const minContains = Number.isFinite(node.minContains) ? node.minContains : 1;
      if (matches.length < minContains) {
        errors.push(`${path}: expected at least ${minContains} item matching contains`);
      }
    }
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
}

const ids = new Set();
for (const file of profileFiles) {
  const profile = JSON.parse(readFileSync(join(profilesDir, file), "utf8"));
  const path = `vm/profiles/${file}`;
  validate(profile, schema, path);

  if (profile.id) {
    if (ids.has(profile.id)) errors.push(`${path}.id: duplicate id ${profile.id}`);
    ids.add(profile.id);
    const expectedFile = `${profile.id}.json`;
    if (file !== expectedFile) errors.push(`${path}.id: expected filename ${expectedFile}`);
  }

  const packages = Array.isArray(profile.packages) ? profile.packages : [];
  for (const packageName of requiredProfilePackages) {
    if (!packages.includes(packageName)) {
      errors.push(`${path}.packages: missing required package ${packageName} (guest runners depend on it)`);
    }
  }

  const allowedTools = Array.isArray(profile.allowedTools) ? profile.allowedTools : [];
  for (const [index, toolName] of allowedTools.entries()) {
    if (!knownToolNames.has(toolName)) {
      errors.push(`${path}.allowedTools[${index}]: unknown tool ${toolName}`);
      continue;
    }
    for (const packageName of toolPackageRequirements[toolName] || []) {
      if (!packages.includes(packageName)) {
        errors.push(`${path}.allowedTools[${index}]: ${toolName} requires package ${packageName}`);
      }
    }
  }
}

if (errors.length) {
  console.error("VM profile validation failed:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`OK VM profiles: ${profileFiles.length} entries match schema`);
