// @ts-nocheck
// Browser Agent v86 - 14a LLM chat UI helpers
// DOM/bubble helpers for the chat runtime agent loop.

(function initLLMChatUi() {
  function createAssistantMessageShell(extraClass = "") {
    const log = document.getElementById("chat-log");
    const msg = document.createElement("div");
    msg.className = `msg agent ba-llm-msg ${extraClass}`.trim();
    const bubble = document.createElement("div");
    bubble.className = "bubble ba-llm-bubble";
    msg.appendChild(bubble);
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  function removeAssistantMessage(bubble) {
    bubble?.closest?.(".msg")?.remove();
  }

  function hidePlanningShell(bubble) {
    const shell = bubble?.closest?.(".msg");
    if (shell) shell.style.display = "none";
  }

  function showAssistantMessage(bubble) {
    const shell = bubble?.closest?.(".msg");
    if (shell) shell.style.display = "";
  }

  function pickFinalAssistantText(streamText, lastToolUi) {
    const raw = String(streamText || "").trim();
    if (raw && !window.BA_LLM_ROUTING?.isLikelyToolPlanText?.(raw)) return raw;
    return String(lastToolUi?.answer || "").trim();
  }

  async function appendFinalAgentBubble(markdown) {
    const text = String(markdown || "").trim();
    if (!text) return null;
    const bubble = createAssistantMessageShell("ba-llm-final-after-tool");
    const mdHost = document.createElement("div");
    mdHost.className = "ba-llm-md-host";
    bubble.appendChild(mdHost);
    const renderer = await window.BA_createMarkdownStreamRenderer(mdHost);
    renderer.write(text);
    renderer.end();
    const log = document.getElementById("chat-log");
    if (log) log.scrollTop = log.scrollHeight;
    return bubble;
  }

  /** Si el stream no emitió deltas pero sí hay texto final, rellena la burbuja. */
  function flushAssistantBubbleText(bubble, mdHost, renderer, markdown) {
    const text = String(markdown || "").trim();
    if (!text) return;
    bubble?.classList?.remove("ba-llm-planning");
    mdHost.hidden = false;
    const visible = mdHost.querySelector(".ba-md-stream") || mdHost;
    if (!visible.textContent?.trim()) {
      renderer.write(text);
    }
    renderer.end();
  }

  function ensureThinkingBlock(bubble) {
    let details = bubble.querySelector("details.ba-llm-thinking");
    if (details) return details;

    details = document.createElement("details");
    details.className = "ba-llm-thinking";

    const summary = document.createElement("summary");
    summary.textContent = t("chat.ui.thinkingTitle", "Razonamiento del modelo");

    const body = document.createElement("div");
    body.className = "ba-llm-thinking-body";

    details.append(summary, body);
    bubble.insertBefore(details, bubble.firstChild);
    return details;
  }

  function appendThinkingChunk(bubble, chunk) {
    const details = ensureThinkingBlock(bubble);
    const body = details.querySelector(".ba-llm-thinking-body");
    if (body) body.append(document.createTextNode(chunk));
  }

  function createInferenceSpinner(label = t("chat.ui.spinner.default", "Generando respuesta…")) {
    const wrap = document.createElement("div");
    wrap.className = "ba-llm-inference-indicator";
    wrap.setAttribute("role", "status");
    wrap.setAttribute("aria-live", "polite");
    const spinner = document.createElement("span");
    spinner.className = "ba-llm-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "ba-llm-inference-label";
    text.textContent = label;
    wrap.append(spinner, text);
    return wrap;
  }

  function setChatTailIndicator(label = t("chat.ui.spinner.default", "Generando respuesta…")) {
    const log = document.getElementById("chat-log");
    if (!log) return null;
    let indicator = document.getElementById("ba-chat-tail-indicator");
    let created = false;
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.id = "ba-chat-tail-indicator";
      indicator.className = "msg agent ba-chat-tail-indicator";
      const bubble = document.createElement("div");
      bubble.className = "bubble ba-chat-tail-indicator-bubble";
      indicator.appendChild(bubble);
      created = true;
    }
    const bubble = indicator.querySelector(".ba-chat-tail-indicator-bubble");
    if (bubble) {
      let status = bubble.querySelector(".ba-llm-inference-indicator");
      if (!status) {
        status = createInferenceSpinner(label);
        bubble.replaceChildren(status);
      } else {
        const text = status.querySelector(".ba-llm-inference-label");
        if (text && text.textContent !== label) {
          text.textContent = label;
        }
      }
    }
    if (created || indicator.parentElement !== log || log.lastElementChild !== indicator) {
      log.appendChild(indicator);
    }
    log.scrollTop = log.scrollHeight;
    return indicator;
  }

  function clearChatTailIndicator() {
    document.getElementById("ba-chat-tail-indicator")?.remove();
  }

  function getToolDisclosure(bubble, { open = false } = {}) {
    let details = bubble.querySelector(":scope > details.ba-tool-disclosure");
    if (!details) {
      details = document.createElement("details");
      details.className = "ba-tool-disclosure";

      const summary = document.createElement("summary");
      summary.className = "ba-tool-disclosure-summary";

      const title = document.createElement("span");
      title.className = "ba-tool-disclosure-title";

      const state = document.createElement("span");
      state.className = "ba-tool-disclosure-state";

      summary.append(title, state);

      const body = document.createElement("div");
      body.className = "ba-tool-disclosure-body";

      details.append(summary, body);
      bubble.appendChild(details);
    }
    details.open = Boolean(open);
    return {
      details,
      titleEl: details.querySelector(".ba-tool-disclosure-title"),
      stateEl: details.querySelector(".ba-tool-disclosure-state"),
      body: details.querySelector(".ba-tool-disclosure-body"),
    };
  }

  function setToolDisclosureSummary(bubble, toolCall, { stateText = "", toolResult = null } = {}) {
    const toolDef = window.BA_LLM_TOOL_REGISTRY?.getTool?.(toolCall?.tool);
    const { details, titleEl, stateEl } = getToolDisclosure(bubble);
    titleEl.textContent = toolDef?.label || toolCall?.tool || t("chat.ui.tool.fallbackTitle", "Tool");

    if (toolResult) {
      if (toolResult.ok) {
        stateEl.textContent = toolResult.summary || t("chat.ui.tool.completed", "Completada");
        stateEl.className = "ba-tool-disclosure-state ok";
        details.open = true;
      } else {
        stateEl.textContent = toolResult.stderr || toolResult.summary || t("common.error", "Error");
        stateEl.className = "ba-tool-disclosure-state bad";
        details.open = true;
      }
      return;
    }

    stateEl.textContent = stateText || t("chat.ui.tool.preparing", "Preparando…");
    stateEl.className = "ba-tool-disclosure-state pending";
    details.open = false;
  }

  function renderToolCallBubble(bubble, toolCall, stateText = t("chat.ui.tool.preparingTool", "Preparando tool…")) {
    const toolDef = window.BA_LLM_TOOL_REGISTRY?.getTool?.(toolCall.tool);
    bubble.classList.add("ba-tool-card");
    bubble.innerHTML = "";

    bubble.dataset.toolName = toolCall.tool || "";

    const { body } = getToolDisclosure(bubble, { open: false });
    setToolDisclosureSummary(bubble, toolCall, { stateText });

    const meta = document.createElement("div");
    meta.className = "ba-tool-meta";
    meta.textContent = t("chat.ui.tool.level", "Nivel {level} · {tool}", { level: toolCall.riskLevel ?? toolDef?.riskLevel ?? "—", tool: toolCall.tool || "" });

    const reason = document.createElement("p");
    reason.className = "ba-tool-disclosure-reason";
    reason.textContent = toolCall.reason || t("chat.ui.tool.defaultReason", "El agente solicita ejecutar esta tool.");

    const argsWrap = document.createElement("details");
    argsWrap.className = "ba-tool-args-wrap";

    const argsSummary = document.createElement("summary");
    argsSummary.textContent = t("chat.ui.tool.argsJson", "Argumentos (JSON)");

    const code = document.createElement("pre");
    code.className = "ba-tool-args";
    code.textContent = JSON.stringify(toolCall.arguments || {}, null, 2);

    argsWrap.append(argsSummary, code);
    body.replaceChildren(meta, reason, argsWrap);
  }

  function appendToolResultToBubble(bubble, result, artifact = null) {
    const toolCall = result.toolCall || (artifact
      ? { tool: artifact.tool, arguments: artifact.args || {} }
      : { tool: bubble.dataset.toolName || "tool", arguments: {} });
    setToolDisclosureSummary(bubble, toolCall, { toolResult: result });

    const { body } = getToolDisclosure(bubble);
    const status = document.createElement("div");
    status.className = result.ok ? "ba-tool-result ok" : "ba-tool-result bad";
    status.textContent = result.ok
      ? t("chat.ui.tool.completedDetail", "Herramienta completada: {summary}", { summary: result.summary })
      : t("chat.ui.tool.failedDetail", "Herramienta fallida: {detail}", { detail: result.stderr || result.summary });
    body.appendChild(status);

    if (artifact) {
      const meta = document.createElement("div");
      meta.className = "ba-tool-meta";
      const truncated = artifact.truncated ? t("chat.ui.artifact.truncatedSuffix", " · salida truncada") : "";
      meta.textContent = t("chat.ui.artifact.meta", "Artefacto {id} · {kb} KB{truncated}", { id: artifact.id, kb: Math.ceil((artifact.sizeBytes || 0) / 1024), truncated });
      body.appendChild(meta);
    }
  }

  function buildDeterministicToolTitle(toolCall, toolResult) {
    const tool = String(toolCall?.tool || "");
    const args = toolCall?.arguments || {};
    const path = args.path || "";
    const registry = window.BA_LLM_TOOL_REGISTRY;
    const toolDef = registry?.getTool?.(tool);

    const summary = String(toolResult?.summary || "").trim();
    if (summary) return summary;

    if (tool === "vm.fs.read") return path ? t("chat.ui.title.fileReadPath", "Contenido leído de `{path}`", { path }) : t("chat.ui.title.fileRead", "Contenido leído");
    if (tool === "vm.fs.list") return path ? t("chat.ui.title.fileListPath", "Listado de `{path}`", { path }) : t("chat.ui.title.fileList", "Listado de archivos");
    return toolDef?.label || tool || t("chat.ui.title.toolResult", "Resultado de herramienta");
  }

  function buildDeterministicToolAnswer(toolCall, toolResult, artifact = null) {
    const tool = toolCall.tool;
    const path = toolCall.arguments?.path || "";
    if (!toolResult.ok) {
      const onPath = path ? t("chat.ui.answer.onPath", " sobre `{path}`", { path }) : "";
      return [
        t("chat.ui.answer.cannotRun", "No he podido ejecutar **{tool}**{onPath}.", { tool, onPath }),
        "",
        t("chat.ui.answer.errorLabel", "**Error:** {error}", { error: toolResult.stderr || toolResult.summary || t("chat.ui.answer.unknownError", "error desconocido") }),
      ].join("\n");
    }

    const title = buildDeterministicToolTitle(toolCall, toolResult);
    const output = artifact
      ? window.BA_LLM_ARTIFACTS.formatArtifactForDisplay(artifact)
      : (toolResult.stdout || t("chat.ui.answer.noOutput", "(sin salida)"));

    return [
      t("chat.ui.answer.titleHeading", "**{title}:**", { title }),
      "",
      "```txt",
      output || t("chat.ui.answer.noOutput", "(sin salida)"),
      "```",
      (toolResult.truncated || artifact?.displayPreviewTruncated) ? t("chat.ui.answer.truncatedNote", "\n_Salida truncada en pantalla por seguridad. El artefacto conserva la salida disponible._") : "",
    ].join("\n");
  }

  async function renderDeterministicToolAnswer(toolCall, toolResult, artifact = null, targetBubble = null) {
    const text = buildDeterministicToolAnswer(toolCall, toolResult, artifact);
    if (targetBubble) {
      const host = document.createElement("div");
      host.className = "ba-llm-md-host ba-tool-answer";
      const { body } = getToolDisclosure(targetBubble);
      body.appendChild(host);
      const renderer = await window.BA_createMarkdownStreamRenderer(host);
      renderer.write(text);
      renderer.end();
      return text;
    }
    const bubble = createAssistantMessageShell("ba-llm-final-after-tool");
    const renderer = await window.BA_createMarkdownStreamRenderer(bubble);
    renderer.write(text);
    renderer.end();
    return text;
  }

  window.BA_LLM_CHAT_UI = {
    createAssistantMessageShell,
    removeAssistantMessage,
    hidePlanningShell,
    showAssistantMessage,
    pickFinalAssistantText,
    appendFinalAgentBubble,
    flushAssistantBubbleText,
    ensureThinkingBlock,
    appendThinkingChunk,
    createInferenceSpinner,
    setChatTailIndicator,
    clearChatTailIndicator,
    getToolDisclosure,
    setToolDisclosureSummary,
    renderToolCallBubble,
    appendToolResultToBubble,
    buildDeterministicToolTitle,
    buildDeterministicToolAnswer,
    renderDeterministicToolAnswer,
  };
})();
