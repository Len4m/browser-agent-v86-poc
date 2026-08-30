/**
 * Parsea tool calls escritos como texto (weak local models).
 * Complementa @browser-ai/transformers-js con ```json, JSON suelto y el
 * formato plano call:name{...}, que Browser AI solo interpreta delimitado.
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
  if (toolName === "vm_fs_list") {
    if (!out.path || typeof out.path !== "string") return null;
    if (!out.maxEntries || Number(out.maxEntries) <= 0) out.maxEntries = 120;
  }
  if (toolName === "vm_fs_read") {
    if (!out.path || typeof out.path !== "string") return null;
    if (!out.maxBytes || Number(out.maxBytes) <= 0) out.maxBytes = 8192;
  }
  return out;
}

function toolCallFields(call: Record<string, unknown>): {
  name: unknown;
  args: unknown;
} {
  const functionCall = isRecord(call.function) ? call.function : null;
  return {
    name: call.name ?? call.toolName ?? call.tool ?? functionCall?.name,
    args: call.arguments
      ?? call.parameters
      ?? call.args
      ?? call.input
      ?? functionCall?.arguments,
  };
}

function nestedToolCalls(call: Record<string, unknown>): unknown[] {
  const many: unknown = call.tool_calls ?? call.toolCalls;
  const one: unknown = call.tool_call ?? call.toolCall;
  const nested: unknown[] = Array.isArray(many) ? many as unknown[] : [];
  if (one !== undefined) nested.push(one);
  return nested;
}

function looksLikeToolCallObject(call: unknown): call is Record<string, unknown> {
  if (!isRecord(call)) return false;
  const { name } = toolCallFields(call);
  return (typeof name === "string" && name.length > 0)
    || nestedToolCalls(call).some(looksLikeToolCallObject);
}

function pushCall(calls: ParsedTextToolCall[], call: unknown): void {
  if (!isRecord(call)) return;
  for (const nested of nestedToolCalls(call)) pushCall(calls, nested);
  const { name: rawName, args: rawArgs } = toolCallFields(call);
  if (!rawName || typeof rawName !== "string") return;
  const args = finalizeArgs(rawName, normalizeArgs(rawArgs));
  if (!args) return;
  const rawId = call.id ?? call.toolCallId;
  calls.push({
    toolCallId: typeof rawId === "string" && rawId ? rawId : generateToolCallId(),
    toolName: rawName,
    args,
  });
}

function parseCallColonArgs(text: string): ToolArguments {
  const args: ToolArguments = {};
  for (const pair of text.split(",")) {
    const separator = pair.indexOf(":");
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    const raw = pair.slice(separator + 1).trim();
    if (!key) continue;
    if (/^(?:true|false)$/i.test(raw)) args[key] = raw.toLowerCase() === "true";
    else if (raw === "null") args[key] = null;
    else if (raw && Number.isFinite(Number(raw))) args[key] = Number(raw);
    else args[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
  return args;
}

function parseCallColon(text: string, calls: ParsedTextToolCall[]): void {
  for (const match of text.matchAll(/call:([A-Za-z0-9_-]+)\{([^}]*)\}/g)) {
    pushCall(calls, { name: match[1], arguments: parseCallColonArgs(match[2] || "") });
  }
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
  const fenceRe = /```json\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenceRe)) {
    parseJsonPayload(match[1] || "", calls);
  }
}

function parseLooseToolObjects(text: string, calls: ParsedTextToolCall[]): void {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const open = text.indexOf("{", searchFrom);
    if (open === -1) break;
    const close = findMatchingBrace(text, open);
    if (close === -1) {
      searchFrom = open + 1;
      continue;
    }
    try {
      const obj: unknown = JSON.parse(text.slice(open, close + 1));
      if (looksLikeToolCallObject(obj)) pushCall(calls, obj);
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
  parseCallColon(raw, calls);
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
    .replace(/```json\s*[\s\S]*?```/gi, "")
    .replace(/call:[A-Za-z0-9_-]+\{[^}]*\}/g, "");
  let searchFrom = 0;
  while (searchFrom < textContent.length) {
    const open = textContent.indexOf("{", searchFrom);
    if (open === -1) break;
    const close = findMatchingBrace(textContent, open);
    if (close === -1) {
      searchFrom = open + 1;
      continue;
    }
    try {
      const obj: unknown = JSON.parse(textContent.slice(open, close + 1));
      if (looksLikeToolCallObject(obj)) {
        textContent = textContent.slice(0, open) + textContent.slice(close + 1);
        searchFrom = open;
        continue;
      }
    } catch {
      // Ignore malformed loose JSON while cleaning display text.
    }
    searchFrom = open + 1;
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
    || /^\s*\{\s*"name"\s*:\s*"(vm|web|net|tls)_/m.test(s)
    || /^\s*\{\s*"(?:name|tool)"\s*:\s*"(?:vm|web|net|tls)(?:_|$)/m.test(s)
    || /"(?:name|tool)"\s*:\s*"(?:vm|web|net|tls)_[^"]*/i.test(s)
    || /"(?:arguments|parameters)"\s*:\s*\{[^}]*$/i.test(s)
    || /\{\s*"name"\s*:\s*"(vm|web|net|tls)_[^"]+"\s*,\s*"(?:arguments|parameters)"/.test(s);
}
