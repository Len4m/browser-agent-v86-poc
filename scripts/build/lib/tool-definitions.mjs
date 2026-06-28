import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

export const TOOL_DEFINITIONS_MODULE = "virtual:ba-tools";
export const TOOL_DEFINITIONS_DIR = join("src", "browser", "chat", "tools", "definitions");

function projectRoot(root) {
  return root || process.cwd();
}

function isToolSourceFile(file) {
  return file.endsWith(".ts")
    && !file.endsWith(".d.ts")
    && file !== "index.ts"
    && !file.startsWith("_");
}

function toImportPath(path) {
  return path.replaceAll("\\", "/");
}

function variableNameForFile(file) {
  const base = basename(file, ".ts");
  return base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part, index) => {
      const clean = part.replace(/^[0-9]+/, "");
      if (!clean) return "";
      const lower = clean.toLowerCase();
      return index === 0 ? lower : lower[0].toUpperCase() + lower.slice(1);
    })
    .join("") || "toolDefinition";
}

function parseStringArray(raw) {
  if (!raw) return [];
  return Array.from(raw.matchAll(/"([^"]+)"/g), (match) => match[1]);
}

export function discoverToolDefinitions(root) {
  const baseRoot = projectRoot(root);
  const absDir = join(baseRoot, TOOL_DEFINITIONS_DIR);
  if (!existsSync(absDir)) return [];

  const seenNames = new Set();
  return readdirSync(absDir)
    .filter(isToolSourceFile)
    .sort()
    .map((file) => {
      const absPath = join(absDir, file);
      const source = readFileSync(absPath, "utf8");
      const exportMatch = /\bexport\s+const\s+toolDefinition\s*:/m.test(source);
      const nameMatch = source.match(/\bname:\s*"([^"]+)"/m);
      const requiredPackagesMatch = source.match(/\brequiredPackages:\s*\[([\s\S]*?)\]/m);

      if (!exportMatch) {
        throw new Error(`${relative(baseRoot, absPath)} must export const toolDefinition`);
      }
      if (!nameMatch) {
        throw new Error(`${relative(baseRoot, absPath)} must declare a literal tool name`);
      }

      const name = nameMatch[1];
      if (seenNames.has(name)) throw new Error(`Duplicate tool name ${name}`);
      seenNames.add(name);

      return {
        file,
        importPath: toImportPath(absPath),
        name,
        requiredPackages: parseStringArray(requiredPackagesMatch?.[1]),
        variableName: variableNameForFile(file),
      };
    });
}

export function generateToolDefinitionsModule(root) {
  const tools = discoverToolDefinitions(root);
  const imports = tools.map((tool) => `import { toolDefinition as ${tool.variableName} } from ${JSON.stringify(tool.importPath)};`);
  const entries = tools.map((tool) => `  ${tool.variableName},`);

  return [
    `// Virtual module ${TOOL_DEFINITIONS_MODULE}. Generated in memory by esbuild.`,
    ...imports,
    "",
    "export const TOOL_DEFINITIONS = [",
    ...entries,
    "];",
    "",
  ].join("\n");
}
