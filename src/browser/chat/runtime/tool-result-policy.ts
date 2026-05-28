// @ts-nocheck
// Browser Agent v86 - 20 LLM tool result policy
// v9.37.7: decides if a tool result should be shown directly, synthesized by
// the local model, or kept as an artifact only.
//
// This is intentionally simple and conservative. It does not try to solve all
// languages. It combines tool metadata, explicit routes, recent artifact state
// and a small set of common intent words. The safety net is always: show/store
// the real result, do not hallucinate.

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

  const SYNTHESIS_PATTERNS = [
    /\bresume\b/, /\bresumir\b/, /\bresumen\b/, /\bsummar(?:y|ize|ise)\b/,
    /\bexplica\b/, /\bexplicar\b/, /\bexplain\b/, /\banaliza\b/, /\banalizar\b/, /\banaly[sz]e\b/,
    /\binterpreta\b/, /\binterpret\b/, /\bconclusion\b/, /\bconclusiones\b/,
    /\bque significa\b/, /\bwhat does.*mean\b/, /\bimportant\b/, /\bimportante\b/,
    /\bdame\s+un\s+resumen\b/, /\bhaz\s+un\s+resumen\b/,
  ];

  const REFERENCE_PREVIOUS_PATTERNS = [
    /\besto\b/, /\beso\b/, /\beste\b/, /\banterior\b/, /\blo\b/,
    /\bthat\b/, /\bit\b/, /\bthis\b/, /\bprevious\b/,
    /\baixo\b/, /\baixo\b/, /\banterior\b/,
    /\bceci\b/, /\bcela\b/, /\bquesto\b/, /\bquello\b/,
  ];

  function wantsSynthesis(userText) {
    const text = normalizeText(userText);
    return hasAny(text, SYNTHESIS_PATTERNS);
  }

  /** Solo salida cruda de la tool, sin segunda pasada del modelo. */
  function wantsDirectOnly(userText) {
    const text = normalizeText(userText);
    return hasAny(text, [
      /\bsolo muestra\b/, /\bsin resumen\b/, /\bsin sintesis\b/, /\bsin comentar\b/,
      /\btal cual\b/, /\braw\b/, /\bunicamente la salida\b/, /\bonly show\b/, /\bno (?:resumas|comentes)\b/,
    ]);
  }

  function referencesPreviousArtifact(userText) {
    const text = normalizeText(userText).trim();
    if (!window.BA_LLM_ARTIFACTS?.last?.()) return false;
    if (text.length <= 90 && hasAny(text, REFERENCE_PREVIOUS_PATTERNS)) return true;
    if (wantsSynthesis(text) && !/(\/|vm\.fs\.|archivo|fichero|file|path|ruta)/.test(text)) return true;
    return false;
  }

  function decideAfterTool({ userText, toolCall, result, artifact } = {}) {
    if (!result?.ok) return { mode: "direct", reason: "La tool falló; se muestra el error real." };
    if (result.cancelled) return { mode: "direct", reason: "La tool fue cancelada." };
    if (wantsDirectOnly(userText)) {
      return { mode: "direct", reason: "El usuario pidió solo la salida cruda de la tool." };
    }
    return {
      mode: "direct",
      reason: "La respuesta final la genera el loop AI (streamText + maxSteps) en el mismo turno.",
    };
  }

  function selectArtifactForUserText(userText) {
    if (!referencesPreviousArtifact(userText)) return null;
    return window.BA_LLM_ARTIFACTS?.last?.() || null;
  }

  window.BA_LLM_TOOL_RESULT_POLICY = {
    decideAfterTool,
    selectArtifactForUserText,
  };
})();
