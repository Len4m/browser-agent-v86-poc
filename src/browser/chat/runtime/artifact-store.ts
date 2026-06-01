// @ts-nocheck
// Browser Agent v86 - 18 LLM artifact store
// v9.37.12: separates visible tool output from compact model context and
// keeps the model focused on payload, not tool metadata.
//
// Tool output can be large. Showing it in the chat must not imply sending it
// back to the model on every request. This store keeps raw tool results as
// artifacts and exposes compact, sanitized payloads for the ContextBudgetManager.

(function initLLMArtifactStore() {
  const MAX_ARTIFACTS = 10;
  const MAX_TOTAL_ARTIFACT_BYTES = 1024 * 1024;
  const MAX_STORED_RAW_CHARS = 64 * 1024;
  const DISPLAY_PREVIEW_CHARS = 12000;
  const COMPACT_PREVIEW_CHARS = 5000;

  function nowId(prefix = "art") {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function textBytesApprox(text) {
    return new Blob([String(text || "")]).size;
  }

  function collapseInterleavedBlankLines(text) {
    const value = normalizeNewlines(text);
    const lines = value.split("\n");
    if (lines.length < 8) return value;

    let blankOdd = 0;
    let blankEven = 0;
    let totalOdd = 0;
    let totalEven = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (i % 2) {
        totalOdd += 1;
        if (!lines[i].trim()) blankOdd += 1;
      } else {
        totalEven += 1;
        if (!lines[i].trim()) blankEven += 1;
      }
    }

    // Serial/consola output can sometimes arrive visually as line + blank + line + blank.
    // Only collapse that very specific pattern; real blank paragraphs are preserved.
    const oddRatio = totalOdd ? blankOdd / totalOdd : 0;
    const evenRatio = totalEven ? blankEven / totalEven : 0;
    const oddInterleaved = oddRatio > 0.75 && evenRatio < 0.35;
    const evenInterleaved = evenRatio > 0.75 && oddRatio < 0.35;
    if (!oddInterleaved && !evenInterleaved) return value;

    return lines.filter((line, index) => {
      if (oddInterleaved && index % 2 === 1 && !line.trim()) return false;
      if (evenInterleaved && index % 2 === 0 && !line.trim()) return false;
      return true;
    }).join("\n");
  }

  function sanitizeTerminalOutput(text) {
    const cleaned = collapseInterleavedBlankLines(stripAnsiAndControls(text));
    return cleaned
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (/^BA_(?:TOOL|FILE|FS)_[A-Z0-9_:-]+/.test(trimmed)) return false;
        if (/^__BAGENT_[A-Za-z0-9_]+___(?:START|END(?::\d+)?)$/.test(trimmed)) return false;
        if (/^browser-[^#%$>]*[#$>]\s*/.test(trimmed)) return false;
        if (/^>\s*(?:__ba_tty=|echo BA_|p=|tmp=|rc=|if \[|head -c|ls -la|printf|cat \"\$tmp\"|rm -f \"\$tmp\"|exit \$rc)/.test(trimmed)) return false;
        if (/^(?:__ba_tty=|echo BA_|p=|tmp=|rc=|if \[|head -c|ls -la|printf|cat \"\$tmp\"|rm -f \"\$tmp\"|exit \$rc|__rc=)/.test(trimmed)) return false;
        return true;
      })
      .join("\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .replace(/^\n+|\n+$/g, "");
  }

  function stripHtmlForModel(html) {
    const raw = String(html || "");
    if (!/<\s*html|<!doctype|<\s*(head|body|div|main|section|h1|p|script|style|meta|title)\b/i.test(raw)) {
      return raw;
    }

    const withoutScripts = raw
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n")
      .replace(/<!--([\s\S]*?)-->/g, "\n");

    const title = (withoutScripts.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
      .replace(/<[^>]+>/g, " ")
      .trim();
    const metaDescription = (withoutScripts.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i)?.[1] || "")
      .trim();

    const headings = [];
    withoutScripts.replace(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, content) => {
      const text = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (text) headings.push(`H${level}: ${text}`);
      return "";
    });

    const bodyMatch = withoutScripts.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    const bodySource = bodyMatch?.[1] || withoutScripts;
    const text = bodySource
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|main|header|footer|li|ul|ol|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return [
      title ? `TITLE: ${title}` : "",
      metaDescription ? `META_DESCRIPTION: ${metaDescription}` : "",
      headings.slice(0, 20).join("\n"),
      text ? `TEXT:\n${text}` : "",
    ].filter(Boolean).join("\n").trim() || raw;
  }

  function truncateMiddle(text, maxChars = COMPACT_PREVIEW_CHARS) {
    const value = normalizeNewlines(String(text || ""));
    const limit = Math.max(0, Math.trunc(Number(maxChars) || 0));
    if (value.length <= limit) {
      return { text: value, truncated: false, omittedChars: 0 };
    }
    if (limit <= 0) {
      return { text: "", truncated: value.length > 0, omittedChars: value.length };
    }
    if (limit < 80) {
      return { text: value.slice(0, limit), truncated: true, omittedChars: value.length - limit };
    }

    const markerFor = (omitted) => `\n\n...[contenido omitido: ${omitted} caracteres]...\n\n`;
    let marker = markerFor(value.length);
    let remaining = limit - marker.length;
    if (remaining <= 0) {
      return { text: value.slice(0, limit), truncated: true, omittedChars: value.length - limit };
    }
    let head = Math.max(1, Math.floor(remaining * 0.68));
    let tail = Math.max(0, remaining - head);
    let omitted = value.length - head - tail;
    marker = markerFor(omitted);
    remaining = limit - marker.length;
    if (remaining <= 0) {
      return { text: value.slice(0, limit), truncated: true, omittedChars: value.length - limit };
    }
    head = Math.max(1, Math.floor(remaining * 0.68));
    tail = Math.max(0, remaining - head);
    omitted = value.length - head - tail;
    return {
      text: [
        value.slice(0, head),
        markerFor(omitted),
        value.slice(-tail),
      ].join(""),
      truncated: true,
      omittedChars: omitted,
    };
  }

  function preview(text, maxChars = DISPLAY_PREVIEW_CHARS) {
    const value = normalizeNewlines(String(text || ""));
    if (value.length <= maxChars) return { text: value, truncated: false };
    return {
      text: `${value.slice(0, maxChars)}\n...${t("artifact.previewTruncated", { max: maxChars })}`,
      truncated: true,
    };
  }

  function inferTags(toolCall, result) {
    const tags = new Set(["tool", "vm"]);
    const tool = String(toolCall?.tool || "");
    if (tool) tags.add(tool);
    if (tool.startsWith("vm.fs.")) tags.add("file-system");
    if (tool === "vm.fs.read") tags.add("file-read");
    if (tool === "vm.fs.list") tags.add("file-list");
    const path = toolCall?.arguments?.path;
    if (path) tags.add(String(path));
    if (/\.html?$/i.test(String(path || ""))) tags.add("html");
    if (result?.ok) tags.add("ok");
    if (result?.truncated) tags.add("truncated");
    return Array.from(tags);
  }

  function ensureStore() {
    const llm = window.BA_LLM;
    if (!llm.artifacts) llm.artifacts = [];
    return llm.artifacts;
  }

  function artifactStoredBytes(artifact) {
    if (!artifact) return 0;
    const textValues = [
      artifact.stdout,
      artifact.stderr,
      artifact.displayPreview,
      artifact.modelText,
      artifact.compactText,
      artifact.summary,
      artifact.userText,
    ].map((value) => String(value || "")).filter(Boolean);
    const uniqueTextValues = Array.from(new Set(textValues));
    return uniqueTextValues.reduce((sum, value) => sum + textBytesApprox(value), 0);
  }

  function totalArtifactsStoredBytes(store = ensureStore()) {
    return store.reduce((sum, artifact) => sum + artifactStoredBytes(artifact), 0);
  }

  function clearContextIfRemoved(artifact) {
    if (!artifact || artifact.id !== window.BA_LLM?.contextArtifactId) return;
    window.BA_LLM.contextArtifactId = null;
    window.BA_LLM_EVENTS?.emit("artifact-context", { artifact: null, id: null });
  }

  function pruneStore(store) {
    while (store.length > MAX_ARTIFACTS) {
      clearContextIfRemoved(store.shift());
    }
    while (store.length > 1 && totalArtifactsStoredBytes(store) > MAX_TOTAL_ARTIFACT_BYTES) {
      clearContextIfRemoved(store.shift());
    }
  }

  function getUsage() {
    const store = ensureStore();
    return {
      artifacts: store.length,
      maxArtifacts: MAX_ARTIFACTS,
      storedBytes: totalArtifactsStoredBytes(store),
      maxStoredBytes: MAX_TOTAL_ARTIFACT_BYTES,
    };
  }

  function storeToolResult(toolCall, result, meta = {}) {
    const store = ensureStore();
    const rawStdout = sanitizeTerminalOutput(result?.stdout || "");
    const rawStderr = sanitizeTerminalOutput(result?.stderr || "");
    const stdoutStored = truncateMiddle(rawStdout, meta.maxStoredRawChars || MAX_STORED_RAW_CHARS);
    const stderrStored = truncateMiddle(rawStderr, meta.maxStoredRawChars || MAX_STORED_RAW_CHARS);
    const stdout = stdoutStored.text;
    const stderr = stderrStored.text;
    const display = preview(stdout || stderr, meta.displayMaxChars || DISPLAY_PREVIEW_CHARS);
    const rawForModel = rawStdout || rawStderr;
    const modelSource = /\.html?$/i.test(String(toolCall?.arguments?.path || "")) ? stripHtmlForModel(rawForModel) : rawForModel;
    const compact = truncateMiddle(modelSource, meta.compactMaxChars || COMPACT_PREVIEW_CHARS);
    const originalSizeBytes = textBytesApprox(rawStdout) + textBytesApprox(rawStderr);
    const storedSizeBytes = textBytesApprox(stdout) + textBytesApprox(stderr);

    const artifact = {
      id: result?.id || nowId("tool-artifact"),
      type: "tool_result",
      tool: toolCall?.tool || result?.toolCall?.tool || "unknown",
      args: { ...(toolCall?.arguments || result?.toolCall?.arguments || {}) },
      userText: String(meta.userText || ""),
      source: meta.source || "agent",
      ok: Boolean(result?.ok),
      code: result?.code ?? null,
      stdout,
      stderr,
      modelText: compact.text,
      summary: String(result?.summary || ""),
      truncated: Boolean(result?.truncated || stdoutStored.truncated || stderrStored.truncated || display.truncated || compact.truncated),
      sizeBytes: originalSizeBytes,
      storedSizeBytes,
      displayPreview: display.text,
      displayPreviewTruncated: display.truncated,
      compactText: compact.text,
      compactTruncated: compact.truncated,
      omittedChars: (stdoutStored.omittedChars || 0) + (stderrStored.omittedChars || 0) + (compact.omittedChars || 0),
      tags: inferTags(toolCall, result),
      createdAt: Date.now(),
      contextPolicy: {
        includeRawByDefault: false,
        includePreviewByDefault: true,
        allowRawOnDemand: true,
        localMaxChars: meta.localMaxChars || COMPACT_PREVIEW_CHARS,
        remoteMaxChars: meta.remoteMaxChars || 100000,
      },
    };

    store.push(artifact);
    pruneStore(store);
    window.BA_LLM.lastArtifactId = artifact.id;
    window.BA_LLM_EVENTS?.emit("artifact", { artifact: summarizeArtifact(artifact) });
    return artifact;
  }

  function summarizeArtifact(artifact) {
    if (!artifact) return null;
    return {
      id: artifact.id,
      type: artifact.type,
      tool: artifact.tool,
      args: artifact.args,
      ok: artifact.ok,
      code: artifact.code,
      summary: artifact.summary,
      sizeBytes: artifact.sizeBytes,
      storedSizeBytes: artifactStoredBytes(artifact),
      truncated: artifact.truncated,
      tags: artifact.tags,
      createdAt: artifact.createdAt,
      contextAttached: artifact.id === window.BA_LLM?.contextArtifactId,
    };
  }

  function last() {
    const store = ensureStore();
    return store.length ? store[store.length - 1] : null;
  }

  function listSummaries({ limit = MAX_ARTIFACTS } = {}) {
    const store = ensureStore();
    const max = Math.max(0, Number(limit) || MAX_ARTIFACTS);
    return store.slice(-max).map(summarizeArtifact);
  }

  function findById(id) {
    const target = String(id || "");
    if (!target) return null;
    return ensureStore().find((artifact) => artifact.id === target) || null;
  }

  function getContextArtifact() {
    const target = String(window.BA_LLM?.contextArtifactId || "");
    if (!target) return null;
    const artifact = findById(target);
    if (!artifact) {
      window.BA_LLM.contextArtifactId = null;
      window.BA_LLM_EVENTS?.emit("artifact-context", { artifact: null, id: null });
      return null;
    }
    return artifact;
  }

  function attachToContext(id) {
    const artifact = findById(id);
    if (!artifact) return null;
    window.BA_LLM.contextArtifactId = artifact.id;
    window.BA_LLM_EVENTS?.emit("artifact-context", { artifact: summarizeArtifact(artifact), id: artifact.id });
    return artifact;
  }

  function clearContextArtifact() {
    if (!window.BA_LLM?.contextArtifactId) return;
    window.BA_LLM.contextArtifactId = null;
    window.BA_LLM_EVENTS?.emit("artifact-context", { artifact: null, id: null });
  }

  function consumeContextArtifact() {
    const artifact = getContextArtifact();
    if (artifact) clearContextArtifact();
    return artifact;
  }

  function remove(id) {
    const target = String(id || "");
    if (!target) return null;
    const store = ensureStore();
    const index = store.findIndex((artifact) => artifact.id === target);
    if (index < 0) return null;
    const [removed] = store.splice(index, 1);
    if (window.BA_LLM.lastArtifactId === target) {
      window.BA_LLM.lastArtifactId = last()?.id || null;
    }
    clearContextIfRemoved(removed);
    window.BA_LLM_EVENTS?.emit("artifact-remove", { artifact: summarizeArtifact(removed), id: target });
    window.BA_LLM_EVENTS?.emit("resource", {});
    return removed;
  }

  function clear() {
    window.BA_LLM.artifacts = [];
    window.BA_LLM.lastArtifactId = null;
    window.BA_LLM.contextArtifactId = null;
    window.BA_LLM_EVENTS?.emit("artifact-clear", {});
  }

  function formatArtifactForModel(artifact, { maxChars = COMPACT_PREVIEW_CHARS } = {}) {
    if (!artifact) return "";
    const payload = artifact.modelText || artifact.compactText || artifact.stdout || artifact.stderr || "";
    const body = truncateMiddle(payload, maxChars);
    const path = artifact.args?.path ? String(artifact.args.path) : "resultado de tool";
    const label = artifact.tool === "vm.fs.read"
      ? `Contenido real leído de ${path}`
      : artifact.tool === "vm.fs.list"
        ? `Listado real de ${path}`
        : `Salida real de ${artifact.tool || "tool"}`;

    return [
      `${label}:`,
      "---BEGIN_TOOL_PAYLOAD---",
      body.text || t("common.noUsefulOutput"),
      "---END_TOOL_PAYLOAD---",
      body.truncated ? "Nota: la salida fue recortada; no asumas contenido no visible." : "",
    ].filter(Boolean).join("\n");
  }

  function formatArtifactForDisplay(artifact, { maxChars = DISPLAY_PREVIEW_CHARS } = {}) {
    if (!artifact) return "";
    const out = preview(artifact.stdout || artifact.stderr || "", maxChars);
    return out.text || t("common.noOutputParen");
  }

  window.BA_LLM_ARTIFACTS = {
    storeToolResult,
    summarizeArtifact,
    listSummaries,
    findById,
    getContextArtifact,
    attachToContext,
    clearContextArtifact,
    consumeContextArtifact,
    getUsage,
    last,
    remove,
    clear,
    formatArtifactForModel,
    formatArtifactForDisplay,
    truncateMiddle,
  };
})();
