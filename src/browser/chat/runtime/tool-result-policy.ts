// @ts-nocheck
// Browser Agent v86 - 20 LLM tool result policy
// v9.37.7: decides if a tool result should be shown directly, synthesized by
// the local model, or kept as an artifact only.
//
// This is intentionally conservative: artifact contents enter context only
// through a structured UI attachment or an explicit artifact id in the user text.
// The safety net is always: show/store the real result, do not hallucinate.

(function initLLMToolResultPolicy() {
  function normalizeText(text) {
    return String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function hasAny(text, patterns) {
    return patterns.some((pattern) => pattern.test(text));
  }

  /** Solo salida cruda de la tool, sin segunda pasada del modelo. */
  function wantsDirectOnly(userText) {
    const text = normalizeText(userText);
    return hasAny(text, [
      /\bsolo muestra\b/, /\bsin resumen\b/, /\bsin sintesis\b/, /\bsin comentar\b/,
      /\btal cual\b/, /\braw\b/, /\bunicamente la salida\b/, /\bonly show\b/, /\bno (?:resumas|comentes)\b/,
    ]);
  }

  function findExplicitArtifact(userText) {
    const text = normalizeText(userText);
    const artifacts = window.BA_LLM_ARTIFACTS?.listSummaries?.({ limit: 100 }) || [];
    for (const summary of artifacts.slice().reverse()) {
      const id = normalizeText(summary?.id || "");
      if (id && text.includes(id)) {
        return window.BA_LLM_ARTIFACTS?.findById?.(summary.id) || null;
      }
    }
    return null;
  }

  function decideAfterTool({ userText, toolCall, result, artifact } = {}) {
    if (!result?.ok) return { mode: "direct", reason: t("panel.llm.toolPolicy.failedShowError") };
    if (result.cancelled) return { mode: "direct", reason: t("panel.llm.toolPolicy.toolCancelled") };
    if (wantsDirectOnly(userText)) {
      return { mode: "direct", reason: t("panel.llm.toolPolicy.rawOutputRequested") };
    }
    return {
      mode: "direct",
      reason: t("panel.llm.toolPolicy.aiLoopDirect"),
    };
  }

  function selectArtifactForUserText(userText) {
    return findExplicitArtifact(userText);
  }

  window.BA_LLM_TOOL_RESULT_POLICY = {
    decideAfterTool,
    selectArtifactForUserText,
  };
})();
