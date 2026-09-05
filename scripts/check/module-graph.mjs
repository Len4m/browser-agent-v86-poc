#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sourceRoot = join(root, "src", "browser");

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function resolveRelativeImport(importer, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(importer), specifier);
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const files = sourceFiles(sourceRoot);
const graph = new Map(files.map((file) => [file, []]));
for (const file of files) {
  const program = ts.createSourceFile(file, ts.sys.readFile(file) || "", ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  for (const statement of program.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const value = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : "";
    const dependency = resolveRelativeImport(file, value);
    if (dependency) graph.get(file).push(dependency);
  }
}

const visiting = new Set();
const visited = new Set();
const stack = [];
const cycles = [];

function visit(file) {
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    cycles.push([...stack.slice(start), file]);
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  stack.push(file);
  for (const dependency of graph.get(file) || []) visit(dependency);
  stack.pop();
  visiting.delete(file);
  visited.add(file);
}

for (const file of files) visit(file);
if (cycles.length) {
  console.error("Static TypeScript import cycles found:");
  for (const cycle of cycles) {
    console.error(`  - ${cycle.map((file) => relative(root, file)).join(" -> ")}`);
  }
  process.exit(1);
}

console.log(`OK module graph: ${files.length} TypeScript modules without static import cycles`);
