// Browser Agent v86 - shared text/shell helpers
// Modern modules import these helpers directly. Legacy ordered sources receive
// global aliases through compat/legacy-facades.ts.

import { CR, NL } from "./state";

const ANSI_ESCAPE_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function textValue(value: unknown): string {
  if (value == null) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "symbol":
      return value.description ? `Symbol(${value.description})` : "Symbol()";
    case "function":
      return value.name ? `[function ${value.name}]` : "[function]";
    case "object": {
      try {
        const json = JSON.stringify(value);
        if (typeof json === "string") return json;
      } catch {
        // Fall through to a stable object tag.
      }
      return Object.prototype.toString.call(value);
    }
  }
  return "";
}

export function stripAnsi(text: unknown): string {
  return textValue(text).replace(ANSI_ESCAPE_RE, "");
}

export function normalizeNewlines(text: unknown): string {
  return textValue(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function stripAnsiAndControls(text: unknown): string {
  return normalizeNewlines(text).replace(ANSI_ESCAPE_RE, "").replace(CONTROL_CHARS_RE, "");
}

export function trimLines(text: unknown): string {
  let value = stripAnsi(text).split(CR).join("");
  while (value.startsWith(NL)) value = value.slice(1);
  while (value.endsWith(NL)) value = value.slice(0, -1);
  return value;
}

export function trimLinesSimple(text: unknown): string {
  return textValue(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\s+|\s+$/g, "");
}

export function shellQuote(value: unknown): string {
  return `'${textValue(value).replaceAll("'", "'\\''")}'`;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function clampExecVmOutputBytes(value: unknown): number {
  return clampInt(value, 1024, 131072, 65536);
}

export function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export const BA_TEXT_UTILS = {
  stripAnsi,
  normalizeNewlines,
  stripAnsiAndControls,
  trimLines,
  trimLinesSimple,
  shellQuote,
  clampInt,
  clampExecVmOutputBytes,
  utf8ToBase64,
};

export type TextUtilsApi = typeof BA_TEXT_UTILS;
