// @ts-nocheck
// Browser Agent v86 - shared text/shell helpers
// Load after app/state.ts (NL, CR).

const ANSI_ESCAPE_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_ESCAPE_RE, "");
}

function normalizeNewlines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripAnsiAndControls(text) {
  return normalizeNewlines(text).replace(ANSI_ESCAPE_RE, "").replace(CONTROL_CHARS_RE, "");
}

function trimLines(text) {
  let value = stripAnsi(text).split(CR).join("");
  while (value.startsWith(NL)) value = value.slice(1);
  while (value.endsWith(NL)) value = value.slice(0, -1);
  return value;
}

function trimLinesSimple(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\s+|\s+$/g, "");
}

function shellQuote(value) {
  return `'${String(value ?? "").replaceAll("'", "'\\''")}'`;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function clampExecVmOutputBytes(value) {
  return clampInt(value, 1024, 131072, 65536);
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

window.BA_TEXT_UTILS = {
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
