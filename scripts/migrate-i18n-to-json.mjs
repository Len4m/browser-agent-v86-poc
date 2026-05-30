#!/usr/bin/env node
/**
 * One-shot helper: extract Spanish defaults from t()/tn() into es.json and strip
 * inline defaults from source. Safe to re-run only on sources that still carry defaults.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const browserDir = join(root, "src/browser");
const indexHtml = join(root, "src/web/index.html");
const enPath = join(root, "src/web/locales/en.json");
const esPath = join(root, "src/web/locales/es.json");

const ES_OVERRIDES = {
  "common.summaryCouldNot": "No se pudo {action} {target}",
  "common.summaryToolOn": "{tool} en {target}",
  "common.summaryToolFailedOn": "{tool} falló en {target}",
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (abs.endsWith(".ts") || abs.endsWith(".js")) out.push(abs);
  }
  return out;
}

function unescapeLiteral(raw, quote) {
  return raw.replace(/\\(.)/g, (_, ch) => {
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    if (ch === quote) return quote;
    return ch;
  });
}

function readStringLiteral(text, pos) {
  const quote = text[pos];
  if (quote !== '"' && quote !== "'") return null;
  let i = pos + 1;
  let raw = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      raw += ch + (text[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { value: unescapeLiteral(raw, quote), end: i + 1 };
    }
    raw += ch;
    i += 1;
  }
  return null;
}

function skipWs(text, pos) {
  while (pos < text.length && /\s/.test(text[pos])) pos += 1;
  return pos;
}

function isIdentStart(text, pos) {
  return pos > 0 && /[\w$.]/.test(text[pos - 1]);
}

function extractFromCall(text, fnName) {
  const entries = [];
  let search = 0;
  while (search < text.length) {
    const idx = text.indexOf(`${fnName}(`, search);
    if (idx === -1) break;
    if (isIdentStart(text, idx)) {
      search = idx + fnName.length + 1;
      continue;
    }
    let pos = idx + fnName.length + 1;
    pos = skipWs(text, pos);
    const keyLit = readStringLiteral(text, pos);
    if (!keyLit) {
      search = idx + fnName.length + 1;
      continue;
    }
    pos = skipWs(text, keyLit.end);
    if (text[pos] !== ",") {
      search = keyLit.end;
      continue;
    }
    pos = skipWs(text, pos + 1);

    if (fnName === "tn") {
      while (pos < text.length && /[\d.]/.test(text[pos])) pos += 1;
      pos = skipWs(text, pos);
      if (text[pos] !== ",") {
        search = idx + 1;
        continue;
      }
      pos = skipWs(text, pos + 1);
      const oneLit = readStringLiteral(text, pos);
      if (!oneLit) {
        search = idx + 1;
        continue;
      }
      entries.push({ key: `${keyLit.value}.one`, default: oneLit.value });
      pos = skipWs(text, oneLit.end);
      if (text[pos] !== ",") {
        search = idx + 1;
        continue;
      }
      pos = skipWs(text, pos + 1);
      const otherLit = readStringLiteral(text, pos);
      if (!otherLit) {
        search = idx + 1;
        continue;
      }
      entries.push({ key: `${keyLit.value}.other`, default: otherLit.value });
      search = otherLit.end;
      continue;
    }

    const defaultLit = readStringLiteral(text, pos);
    if (!defaultLit) {
      search = idx + 1;
      continue;
    }
    entries.push({ key: keyLit.value, default: defaultLit.value });
    search = defaultLit.end;
  }
  return entries;
}

function stripTDefaults(text) {
  let out = "";
  let pos = 0;
  while (pos < text.length) {
    const idx = text.indexOf("t(", pos);
    if (idx === -1) {
      out += text.slice(pos);
      break;
    }
    if (isIdentStart(text, idx)) {
      out += text.slice(pos, idx + 2);
      pos = idx + 2;
      continue;
    }
    out += text.slice(pos, idx);
    let cursor = idx + 2;
    cursor = skipWs(text, cursor);
    const keyLit = readStringLiteral(text, cursor);
    if (!keyLit) {
      out += "t(";
      pos = idx + 2;
      continue;
    }
    out += `t("${keyLit.value}"`;
    cursor = skipWs(text, keyLit.end);
    if (text[cursor] !== ",") {
      out += text.slice(keyLit.end, cursor);
      pos = cursor;
      continue;
    }
    cursor = skipWs(text, cursor + 1);
    const maybeDefault = readStringLiteral(text, cursor);
    if (!maybeDefault) {
      out += text.slice(keyLit.end, cursor);
      pos = cursor;
      continue;
    }
    cursor = skipWs(text, maybeDefault.end);
    if (text[cursor] === ",") {
      out += text.slice(keyLit.end, maybeDefault.end).replace(/,\s*"[^"]*"|,\s*'[^']*'/, "");
      out += text.slice(maybeDefault.end, cursor + 1);
      pos = cursor + 1;
      continue;
    }
    out += ")";
    pos = maybeDefault.end;
    if (text[pos] === ")") pos += 1;
  }
  return out;
}

function stripTDefaultsSimple(text) {
  let out = "";
  let pos = 0;
  while (pos < text.length) {
    const idx = text.indexOf("t(", pos);
    if (idx === -1) {
      out += text.slice(pos);
      break;
    }
    if (isIdentStart(text, idx)) {
      out += text.slice(pos, idx + 2);
      pos = idx + 2;
      continue;
    }
    let cursor = idx + 2;
    cursor = skipWs(text, cursor);
    const keyLit = readStringLiteral(text, cursor);
    if (!keyLit) {
      out += text.slice(pos, idx + 2);
      pos = idx + 2;
      continue;
    }
    cursor = skipWs(text, keyLit.end);
    if (text[cursor] !== ",") {
      out += text.slice(pos, cursor);
      pos = cursor;
      continue;
    }
    cursor = skipWs(text, cursor + 1);
    const defaultLit = readStringLiteral(text, cursor);
    if (!defaultLit) {
      out += text.slice(pos, cursor);
      pos = cursor;
      continue;
    }
    cursor = skipWs(text, defaultLit.end);
    out += text.slice(pos, idx);
    out += `t("${keyLit.value}"`;
    if (text[cursor] === ",") {
      cursor = skipWs(text, cursor + 1);
      const restStart = cursor;
      while (cursor < text.length && text[cursor] !== ")") cursor += 1;
      out += `, ${text.slice(restStart, cursor)}`;
    }
    out += ")";
    if (text[cursor] === ")") cursor += 1;
    pos = cursor;
  }
  return out;
}

function stripTnDefaults(text) {
  let out = "";
  let pos = 0;
  while (pos < text.length) {
    const idx = text.indexOf("tn(", pos);
    if (idx === -1) {
      out += text.slice(pos);
      break;
    }
    if (isIdentStart(text, idx)) {
      out += text.slice(pos, idx + 3);
      pos = idx + 3;
      continue;
    }
    let cursor = idx + 3;
    cursor = skipWs(text, cursor);
    const keyLit = readStringLiteral(text, cursor);
    if (!keyLit) {
      out += text.slice(pos, idx + 3);
      pos = idx + 3;
      continue;
    }
    cursor = skipWs(text, keyLit.end);
    if (text[cursor] !== ",") {
      out += text.slice(pos, idx + 3);
      pos = idx + 3;
      continue;
    }
    cursor = skipWs(text, cursor + 1);
    const countStart = cursor;
    while (cursor < text.length && text[cursor] !== ",") cursor += 1;
    const countExpr = text.slice(countStart, cursor).trim();
    cursor = skipWs(text, cursor + 1);
    const oneLit = readStringLiteral(text, cursor);
    if (!oneLit) {
      out += text.slice(pos, idx + 3);
      pos = idx + 3;
      continue;
    }
    cursor = skipWs(text, oneLit.end);
    if (text[cursor] !== ",") {
      out += text.slice(pos, idx + 3);
      pos = idx + 3;
      continue;
    }
    cursor = skipWs(text, cursor + 1);
    const otherLit = readStringLiteral(text, cursor);
    if (!otherLit) {
      out += text.slice(pos, idx + 3);
      pos = idx + 3;
      continue;
    }
    cursor = skipWs(text, otherLit.end);
    let varsPart = "";
    if (text[cursor] === ",") {
      cursor = skipWs(text, cursor + 1);
      if (text[cursor] === "{") {
        let depth = 0;
        const varsStart = cursor;
        while (cursor < text.length) {
          if (text[cursor] === "{") depth += 1;
          if (text[cursor] === "}") {
            depth -= 1;
            if (depth === 0) {
              cursor += 1;
              break;
            }
          }
          cursor += 1;
        }
        varsPart = `, ${text.slice(varsStart, cursor)}`;
      }
    }
    while (cursor < text.length && text[cursor] !== ")") cursor += 1;
    if (text[cursor] === ")") cursor += 1;
    out += text.slice(pos, idx);
    out += `tn("${keyLit.value}", ${countExpr}${varsPart})`;
    pos = cursor;
  }
  return out;
}

function collectHtmlDefaults(html) {
  const entries = [];
  for (const match of html.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]*)</g)) {
    const key = match[1];
    const text = match[2].trim();
    if (text) entries.push({ key, default: text });
  }
  for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of match[1].split(",")) {
      const [attr, key] = pair.split(":").map((p) => p.trim());
      if (!key) continue;
      const attrRe = new RegExp(`${key.replace(/\./g, "\\.")}[^>]*${attr}="([^"]*)"`, "i");
      // fallback: search nearby in same tag - simpler: skip, t() covers most
    }
  }
  return entries;
}

const catalog = {};
const en = JSON.parse(readFileSync(enPath, "utf8"));

for (const file of walk(browserDir)) {
  const text = readFileSync(file, "utf8");
  for (const entry of extractFromCall(text, "t")) {
    catalog[entry.key] = entry.default;
  }
  for (const entry of extractFromCall(text, "tn")) {
    catalog[entry.key] = entry.default;
  }
}

for (const entry of collectHtmlDefaults(readFileSync(indexHtml, "utf8"))) {
  if (!catalog[entry.key]) catalog[entry.key] = entry.default;
}

Object.assign(catalog, ES_OVERRIDES);

for (const key of Object.keys(en)) {
  if (!(key in catalog)) {
    console.warn(`WARN: no Spanish default for ${key}, copying English placeholder`);
    catalog[key] = en[key];
  }
}

const sorted = Object.fromEntries(
  Object.keys(catalog)
    .sort((a, b) => {
      const aCommon = a.startsWith("common.");
      const bCommon = b.startsWith("common.");
      if (aCommon && !bCommon) return -1;
      if (!aCommon && bCommon) return 1;
      return a.localeCompare(b);
    })
    .map((k) => [k, catalog[k]])
);

writeFileSync(esPath, `${JSON.stringify(sorted, null, 2)}\n`);

for (const file of walk(browserDir)) {
  if (file.endsWith("i18n.ts")) continue;
  let text = readFileSync(file, "utf8");
  const before = text;
  text = stripTnDefaults(text);
  text = stripTDefaultsSimple(text);
  if (text !== before) writeFileSync(file, text);
}

// tool-registry helpers: drop phraseEs / verbEs params
const toolRegistry = join(browserDir, "chat/tools/tool-registry.ts");
let tr = readFileSync(toolRegistry, "utf8");
tr = tr.replace(
  /function summaryHeadTarget\(phraseKey, phraseEs, target\) \{\s*return t\("common\.summaryHeadTarget", \{\s*head: t\(phraseKey\),\s*target,\s*\}\);\s*\}/,
  'function summaryHeadTarget(phraseKey, target) {\n    return t("common.summaryHeadTarget", {\n      head: t(phraseKey),\n      target,\n    });\n  }'
);
tr = tr.replace(
  /function summaryCouldNot\(verbKey, verbEs, target\) \{\s*return t\("common\.summaryCouldNot", \{\s*action: t\(verbKey\),\s*target,\s*\}\);\s*\}/,
  'function summaryCouldNot(verbKey, target) {\n    return t("common.summaryCouldNot", {\n      action: t(verbKey),\n      target,\n    });\n  }'
);
tr = tr.replace(/summaryHeadTarget\("([^"]+)", "[^"]*", /g, 'summaryHeadTarget("$1", ');
tr = tr.replace(/summaryCouldNot\("([^"]+)", "[^"]*", /g, 'summaryCouldNot("$1", ');
writeFileSync(toolRegistry, tr);

console.log(`Wrote ${Object.keys(sorted).length} keys to ${esPath}`);
