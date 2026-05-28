// @ts-nocheck
// Browser Agent v86 - 14b LLM agent routing heuristics
// Pure helpers extracted from chat runtime agent loop.

(function initLLMAgentRouting() {
  function flattenErrorMessage(error) {
    return [error?.message, error?.cause?.message, String(error)].filter(Boolean).join(" | ");
  }

  function isRecoverableGpuMemoryError(message) {
    return /out of device memory|VK_ERROR_OUT_OF_DEVICE_MEMORY|WebGPU validation failed|Invalid Buffer|Device lost|failed to call OrtRun|CreateBuffer|null function|function signature mismatch|unaligned accesses|Instance reference no longer exists|memoria GPU agotada|WebGPU inválido/i.test(String(message || ""));
  }

  function shouldEnableNativeTools({ referencedArtifact = null } = {}) {
    if (referencedArtifact) return false;
    const modelConfig = window.BA_LLM?.activeModel || window.BA_LLM_AGENT?.getSelectedModelConfig?.();
    const names = window.BA_LLM_NATIVE_TOOLS?.resolveActiveToolNames?.(modelConfig) || [];
    return names.length > 0;
  }

  function resolveNativeToolNames(modelConfig) {
    return window.BA_LLM_NATIVE_TOOLS?.resolveActiveToolNames?.(modelConfig) || [];
  }

  function isLikelyToolPlanText(text) {
    const sample = String(text || "");
    if (!sample) return false;
    if (/```(?:tool[_-]?call|json)/i.test(sample)) return true;
    return /"(?:name|tool)"\s*:\s*"(?:vm|web|net|tls)\.[A-Za-z0-9_.]+"/.test(sample);
  }

  function userRequestLikelyNeedsVm(userText) {
    const t = String(userText || "").toLowerCase();
    return /\b(vm|lista|listar|listado|archivos?|ficheros?|directorios?|carpetas?|\/etc|\/var|\/home|serial|curl|wget|ip\b|red\b|docker|alpine|kernel|ejecuta|comando|which|leer|lee\b|muestra|mostrar|contenido|ruta)\b/i.test(t)
      || /\bde\s+\/[\w./-]+/.test(t)
      || /\ben\s+\/[\w./-]+/.test(t);
  }

  window.BA_LLM_ROUTING = {
    flattenErrorMessage,
    isRecoverableGpuMemoryError,
    shouldEnableNativeTools,
    resolveNativeToolNames,
    isLikelyToolPlanText,
    userRequestLikelyNeedsVm,
  };
})();
