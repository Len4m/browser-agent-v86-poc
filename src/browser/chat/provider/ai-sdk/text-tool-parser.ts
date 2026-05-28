// @ts-nocheck
/**
 * Parsea tool calls escritos como texto (weak local models).
 * Extiende los patrones de @browser-ai/transformers-js (```tool_call) con ```json y JSON suelto.
 */

function generateToolCallId() {
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeArgs(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

function finalizeArgs(toolName, args) {
  const out = { ...args };
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

function pushCall(calls, call) {
  const name = call?.name || call?.toolName;
  if (!name || typeof name !== "string") return;
  const args = finalizeArgs(name, normalizeArgs(call.arguments ?? call.parameters));
  if (!args) return;
  calls.push({
    toolCallId: call.id || call.toolCallId || generateToolCallId(),
    toolName: name,
    args,
  });
}

function findMatchingBrace(text, openIndex) {
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

function parseFencedBlocks(text, calls) {
  const fenceRe = /```(?:tool[_-]?call|json)\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenceRe)) {
    const inner = (match[1] || "").trim();
    if (!inner) continue;
    try {
      const parsed = JSON.parse(inner);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const call of arr) pushCall(calls, call);
    } catch {
      for (const line of inner.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          pushCall(calls, JSON.parse(trimmed));
        } catch {
          // ignore
        }
      }
    }
  }
}

function parseLooseToolObjects(text, calls) {
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
      const obj = JSON.parse(text.slice(open, close + 1));
      if (obj?.name && (obj.arguments !== undefined || obj.parameters !== undefined)) {
        pushCall(calls, obj);
      }
    } catch {
      // ignore
    }
    searchFrom = close + 1;
  }
}

/**
 * @param {string} text
 * @param {{ allowedToolNames?: string[] }} [options]
 * @returns {{ toolCalls: Array<{toolCallId:string,toolName:string,args:object}>, textContent: string }}
 */
export function parseTextToolCalls(text, options = {}) {
  const raw = String(text || "");
  const calls = [];
  parseFencedBlocks(raw, calls);
  parseLooseToolObjects(raw, calls);

  const seen = new Set();
  const deduped = [];
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
    ? deduped.filter((c) => allowed.has(c.toolName))
    : deduped;

  let textContent = raw.replace(/```(?:tool[_-]?call|json)\s*[\s\S]*?```/gi, "");
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
      const obj = JSON.parse(textContent.slice(open, close + 1));
      if (obj?.name && (obj.arguments !== undefined || obj.parameters !== undefined)) {
        textContent = textContent.slice(0, open) + textContent.slice(close + 1);
        searchFrom = open;
        continue;
      }
    } catch {
      // ignore
    }
    searchFrom = nameIdx + 6;
  }
  textContent = textContent.replace(/\n{2,}/g, "\n").trim();

  return {
    toolCalls: filtered.slice(0, 1),
    textContent,
  };
}

export function looksLikeTextToolPlan(text) {
  const s = String(text || "");
  return /```(?:tool[_-]?call|json)\b/i.test(s)
    || /^\s*\{\s*"name"\s*:\s*"(vm|web|net|tls)\./m.test(s)
    || /^\s*\{\s*"(?:name|tool)"\s*:\s*"(?:vm|web|net|tls)(?:\.|$)/m.test(s)
    || /"(?:name|tool)"\s*:\s*"(?:vm|web|net|tls)\.[^"]*/i.test(s)
    || /"(?:arguments|parameters)"\s*:\s*\{[^}]*$/i.test(s)
    || /\{\s*"name"\s*:\s*"(vm|web|net|tls)\.[^"]+"\s*,\s*"(?:arguments|parameters)"/.test(s);
}
