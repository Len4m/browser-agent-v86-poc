#!/usr/bin/env node
/**
 * Verifica la paridad de claves i18n:
 * - Recolecta claves usadas en t("clave", ...) dentro de src/browser/**.
 * - Recolecta claves usadas en data-i18n / data-i18n-attr de src/web/index.html.
 * - Comprueba que cada idioma no-base (src/web/locales/*.json) cubre todas las
 *   claves usadas y avisa de claves huerfanas (presentes en el catalogo pero sin uso).
 *
 * El idioma base (es) vive inline en el codigo, por eso no existe es.json.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const browserDir = join(root, "src/browser");
const indexHtmlFile = join(root, "src/web/index.html");
const localesDir = join(root, "src/web/locales");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (abs.endsWith(".ts") || abs.endsWith(".js")) out.push(abs);
  }
  return out;
}

const usedKeys = new Map(); // key -> example source

function addKey(key, source) {
  if (!usedKeys.has(key)) usedKeys.set(key, source);
}

// t("key", ...) / t('key', ...) not preceded by a word char, dot or $.
const T_CALL = /(?<![\w$.])t\(\s*["']([^"']+)["']/g;
// tn("key", count, ...) -> registers `${key}.one` and `${key}.other`.
const TN_CALL = /(?<![\w$.])tn\(\s*["']([^"']+)["']/g;

function collectDomKeys(text, source) {
  for (const match of text.matchAll(/data-i18n="([^"]+)"/g)) addKey(match[1], source);
  for (const match of text.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of match[1].split(",")) {
      const key = pair.split(":")[1]?.trim();
      if (key) addKey(key, source);
    }
  }
}

for (const file of walk(browserDir)) {
  const text = readFileSync(file, "utf8");
  const rel = file.slice(root.length + 1);
  for (const match of text.matchAll(T_CALL)) addKey(match[1], rel);
  for (const match of text.matchAll(TN_CALL)) {
    addKey(`${match[1]}.one`, rel);
    addKey(`${match[1]}.other`, rel);
  }
  // Some source files (e.g. panel templates) emit data-i18n markup as strings.
  collectDomKeys(text, rel);
}

collectDomKeys(readFileSync(indexHtmlFile, "utf8"), "src/web/index.html");

const localeFiles = existsSync(localesDir)
  ? readdirSync(localesDir).filter((name) => name.endsWith(".json"))
  : [];

let errors = 0;
let warnings = 0;

for (const localeFile of localeFiles) {
  const catalog = JSON.parse(readFileSync(join(localesDir, localeFile), "utf8"));
  const catalogKeys = new Set(Object.keys(catalog));

  const missing = [...usedKeys.keys()].filter((key) => !catalogKeys.has(key)).sort();
  const orphan = [...catalogKeys].filter((key) => !usedKeys.has(key)).sort();

  if (missing.length) {
    errors += missing.length;
    console.error(`FAIL ${localeFile}: faltan ${missing.length} claves usadas pero no traducidas:`);
    for (const key of missing) console.error(`  - ${key}  (p.ej. ${usedKeys.get(key)})`);
  }
  if (orphan.length) {
    warnings += orphan.length;
    console.warn(`WARN ${localeFile}: ${orphan.length} claves huerfanas (en el catalogo pero sin uso):`);
    for (const key of orphan) console.warn(`  - ${key}`);
  }
}

if (errors) {
  console.error(`check-i18n: ${errors} error(es), ${warnings} aviso(s)`);
  process.exit(1);
}

console.log(`OK i18n: ${usedKeys.size} claves usadas, ${localeFiles.length} catalogo(s)${warnings ? `, ${warnings} aviso(s)` : ""}`);
