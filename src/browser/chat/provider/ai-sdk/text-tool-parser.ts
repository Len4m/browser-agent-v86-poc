/**
 * Parsea tool calls escritos como texto (weak local models).
 * Extiende los patrones de @browser-ai/transformers-js (```tool_call) con ```json y JSON suelto.
 */

export type ToolArguments = Record<string, unknown>;

export interface ParsedTextToolCall {
  toolCallId: string;
  toolName: string;
  args: ToolArguments;
}

export interface ParseTextToolCallsOptions {
  allowedToolNames?: string[];
}

export interface ParseTextToolCallsResult {
  toolCalls: ParsedTextToolCall[];
  textContent: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function generateToolCallId(): string {
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeArgs(raw: unknown): ToolArguments {
  if (raw === undefined || raw === null) return {};
  if (isRecord(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function finalizeArgs(toolName: string, args: ToolArguments): ToolArguments | null {
  const out: ToolArguments = { ...args };
  if (toolName === "vm.fs.list") {
    if (!out.path || typeof out.path !== "string") return null;
    if (!out.maxEntries || Number(out.maxEntries) <= 0) out.maxEntries = 120;
  }
  if (toolName === "vm.fs.read") {
    if (!out.path || typeof out.path !== "string") return null;
    if (!out.maxBytes || Number(out.maxBytes) <= 0) out.maxBytes = 8192;
  }
  return out;
}

function pushCall(calls: ParsedTextToolCall[], call: unknown): void {
  if (!isRecord(call)) return;
  const rawName = call.name ?? call.toolName;
  if (!rawName || typeof rawName !== "string") return;
  const args = finalizeArgs(rawName, normalizeArgs(call.arguments ?? call.parameters));
  if (!args) return;
  const rawId = call.id ?? call.toolCallId;
  calls.push({
    toolCallId: typeof rawId === "string" && rawId ? rawId : generateToolCallId(),
    toolName: rawName,
    args,
  });
}

function parseScalarArg(raw: string): unknown {
  const value = raw.trim();
  if (!value) return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

function parseInlineArgs(text: string, separator: ":" | "="): ToolArguments {
  const args: ToolArguments = {};
  for (const pair of text.split(",")) {
    const idx = pair.indexOf(separator);
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    if (!key) continue;
    args[key] = parseScalarArg(pair.slice(idx + 1));
  }
  return args;
}

function pushNamedCall(calls: ParsedTextToolCall[], toolName: string, args: ToolArguments): void {
  const finalized = finalizeArgs(toolName, args);
  if (!finalized) return;
  calls.push({
    toolCallId: generateToolCallId(),
    toolName,
    args: finalized,
  });
}

function findMatchingBrace(text: string, openIndex: number): number {
  if (text[openIndex] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseJsonPayload(payload: string, calls: ParsedTextToolCall[]): void {
  const inner = payload.trim();
  if (!inner) return;
  try {
    const parsed: unknown = JSON.parse(inner);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const call of items) pushCall(calls, call);
  } catch {
    for (const line of inner.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsedLine: unknown = JSON.parse(trimmed);
        pushCall(calls, parsedLine);
      } catch {
        // Ignore malformed line-level JSON.
      }
    }
  }
}

function parseFencedBlocks(text: string, calls: ParsedTextToolCall[]): void {
  const fenceRe = /```(?:tool[_-]?call|json)\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenceRe)) {
    parseJsonPayload(match[1] || "", calls);
  }
}

function parseTaggedBlocks(text: string, calls: ParsedTextToolCall[]): void {
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>|<\|tool_call>\s*([\s\S]*?)\s*<tool_call\|>/gi;
  for (const match of text.matchAll(tagRe)) {
    parseJsonPayload(match[1] || match[2] || "", calls);
  }
}

function parseInlineCalls(text: string, calls: ParsedTextToolCall[]): void {
  const pythonRe = /\[([\w.-]+)\(([^)]*)\)\]/g;
  for (const match of text.matchAll(pythonRe)) {
    pushNamedCall(calls, match[1] || "", parseInlineArgs(match[2] || "", "="));
  }

  const callColonRe = /call:([\w.-]+)\{([^}]*)\}/g;
  for (const match of text.matchAll(callColonRe)) {
    pushNamedCall(calls, match[1] || "", parseInlineArgs(match[2] || "", ":"));
  }
}

function parseLooseToolObjects(text: string, calls: ParsedTextToolCall[]): void {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const nameIdx = text.indexOf('"name"', searchFrom);
    if (nameIdx === -1) break;
    const open = text.lastIndexOf("{", nameIdx);
    if (open === -1) {
      searchFrom = nameIdx + 6;
      continue;
    }
    const close = findMatchingBrace(text, open);
    if (close === -1) {
      searchFrom = nameIdx + 6;
      continue;
    }
    try {
      const obj: unknown = JSON.parse(text.slice(open, close + 1));
      if (isRecord(obj) && obj.name && (obj.arguments !== undefined || obj.parameters !== undefined)) {
        pushCall(calls, obj);
      }
    } catch {
      // Ignore malformed loose JSON.
    }
    searchFrom = close + 1;
  }
}

export function parseTextToolCalls(text: string, options: ParseTextToolCallsOptions = {}): ParseTextToolCallsResult {
  const raw = String(text || "");
  const calls: ParsedTextToolCall[] = [];
  parseFencedBlocks(raw, calls);
  parseTaggedBlocks(raw, calls);
  parseInlineCalls(raw, calls);
  parseLooseToolObjects(raw, calls);

  const seen = new Set<string>();
  const deduped: ParsedTextToolCall[] = [];
  for (const call of calls) {
    const key = `${call.toolName}:${JSON.stringify(call.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(call);
  }

  const allowed = options.allowedToolNames?.length
    ? new Set(options.allowedToolNames)
    : null;
  const filtered = allowed
    ? deduped.filter((call) => allowed.has(call.toolName))
    : deduped;

  let textContent = raw
    .replace(/```(?:tool[_-]?call|json)\s*[\s\S]*?```/gi, "")
    .replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, "")
    .replace(/<\|tool_call>\s*[\s\S]*?\s*<tool_call\|>/gi, "")
    .replace(/\[[\w.-]+\([^)]*\)\]/g, "")
    .replace(/call:[\w.-]+\{[^}]*\}/g, "");
  let searchFrom = 0;
  while (searchFrom < textContent.length) {
    const nameIdx = textContent.indexOf('"name"', searchFrom);
    if (nameIdx === -1) break;
    const open = textContent.lastIndexOf("{", nameIdx);
    if (open === -1) {
      searchFrom = nameIdx + 6;
      continue;
    }
    const close = findMatchingBrace(textContent, open);
    if (close === -1) {
      searchFrom = nameIdx + 6;
      continue;
    }
    try {
      const obj: unknown = JSON.parse(textContent.slice(open, close + 1));
      if (isRecord(obj) && obj.name && (obj.arguments !== undefined || obj.parameters !== undefined)) {
        textContent = textContent.slice(0, open) + textContent.slice(close + 1);
        searchFrom = open;
        continue;
      }
    } catch {
      // Ignore malformed loose JSON while cleaning display text.
    }
    searchFrom = nameIdx + 6;
  }
  textContent = textContent.replace(/\n{2,}/g, "\n").trim();

  return {
    toolCalls: filtered.slice(0, 1),
    textContent,
  };
}

export function looksLikeTextToolPlan(text: string): boolean {
  const s = String(text || "");
  return /```(?:tool[_-]?call|json)\b/i.test(s)
    || /<tool_call>/i.test(s)
    || /<\|tool_call>/i.test(s)
    || /\[[\w.-]+\([^)]*$/i.test(s)
    || /call:[\w.-]+\{[^}]*$/i.test(s)
    || /^\s*\{\s*"name"\s*:\s*"(vm|web|net|tls)\./m.test(s)
    || /^\s*\{\s*"(?:name|tool)"\s*:\s*"(?:vm|web|net|tls)(?:\.|$)/m.test(s)
    || /"(?:name|tool)"\s*:\s*"(?:vm|web|net|tls)\.[^"]*/i.test(s)
    || /"(?:arguments|parameters)"\s*:\s*\{[^}]*$/i.test(s)
    || /\{\s*"name"\s*:\s*"(vm|web|net|tls)\.[^"]+"\s*,\s*"(?:arguments|parameters)"/.test(s);
}
