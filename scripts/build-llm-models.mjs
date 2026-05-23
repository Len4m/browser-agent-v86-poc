#!/usr/bin/env node
/**
 * Genera el catálogo de modelos consumido por scripts/build-frontend.mjs.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const jsonPath = join(root, "data/llm-models.json");
const outPath = join(root, "build/browser/generated/10a-llm-models-catalog.js");

const REQUIRED = ["id", "label", "engine", "model"];

let models;
try {
  models = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch (error) {
  console.error(`No se pudo leer ${jsonPath}:`, error.message);
  process.exit(1);
}

if (!Array.isArray(models) || !models.length) {
  console.error("data/llm-models.json debe ser un array no vacío.");
  process.exit(1);
}

for (const [index, model] of models.entries()) {
  for (const key of REQUIRED) {
    if (key === "model" && model.custom) continue;
    if (model[key] == null || String(model[key]).trim() === "") {
      console.error(`Modelo índice ${index}: falta campo obligatorio "${key}".`);
      process.exit(1);
    }
  }
}

const banner = `// AUTO-GENERATED — no editar. Fuente: data/llm-models.json
// Regenerar: npm run build
`;

const body = `${banner}window.BA_LLM_MODELS_RAW = ${JSON.stringify(models, null, 2)};\n`;
mkdirSync(join(root, "build/browser/generated"), { recursive: true });
writeFileSync(outPath, body, "utf8");
console.log(`OK: ${models.length} modelos → ${outPath}`);
