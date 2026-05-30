// @ts-nocheck
// Browser Agent v86 - 11 LLM capabilities
// v9.37.20: single shared capability detector for header, LLM panel and model selector.
//
// This module only requests a GPUAdapter to know whether WebGPU and optional
// features such as shader-f16 are exposed by the browser. It does not create a
// GPUDevice; Transformers.js/ONNX Runtime will create the execution device only
// when the user loads a model.

(function initLLMCapabilityService() {
  function baseResult() {
    return {
      secureContext: Boolean(window.isSecureContext),
      webgpu: false,
      adapter: null,
      features: [],
      limits: {},
      shaderF16: false,
      recommendedDtype: "q4",
      reason: "",
      checkedAt: 0,
    };
  }

  function capabilityBadgeFor(result, state = "ready") {
    if (state === "checking") return { text: t("caps.badge.checking", "GPU…"), tone: "warn", title: t("caps.badge.checkingTitle", "Comprobando capacidades de inferencia local.") };
    if (!result) return { text: t("caps.badge.pending", "GPU pendiente"), tone: "warn", title: t("common.inferencePending", "Pendiente de comprobar capacidades de inferencia local.") };
    if (result.webgpu) return {
      text: result.shaderF16 ? t("caps.badge.webgpuF16", "WebGPU f16") : t("caps.badge.webgpuReady", "WebGPU listo"),
      tone: "good",
      title: result.shaderF16
        ? t("caps.badge.webgpuF16Title", "WebGPU disponible con shader-f16. Los modelos q4f16 pueden ser compatibles.")
        : t("caps.badge.webgpuReadyTitle", "WebGPU disponible sin shader-f16. Usar modelos q4, no q4f16."),
    };
    return {
      text: t("common.wasm", "WASM"),
      tone: "warn",
      title: result.reason ? t("caps.badge.wasmReasonTitle", "WebGPU no disponible: {reason}", { reason: result.reason }) : t("caps.badge.wasmTitle", "WebGPU no disponible. Solo modelos WASM experimentales."),
    };
  }

  function syncLLMCapabilityBadges(result = window.BA_LLM?.capabilities || null, state = "ready") {
    const badgeInfo = capabilityBadgeFor(result, state);
    const targets = [
      document.getElementById("badge-gpu"),
      document.getElementById("ba-llm-summary-compat"),
    ].filter(Boolean);

    for (const target of targets) {
      if (typeof setBadge === "function") {
        setBadge(target, badgeInfo.text, badgeInfo.tone);
      } else {
        target.textContent = badgeInfo.text;
        target.className = `badge ${badgeInfo.tone}`.trim();
      }
      if (target.id === "ba-llm-summary-compat") {
        target.classList.add("ba-llm-summary-compat");
      }
      target.title = badgeInfo.title;
    }

    return badgeInfo;
  }

  async function detectLLMCapabilities() {
    const result = baseResult();

    if (!result.secureContext) {
      result.reason = t("caps.reason.secureContext", "WebGPU requiere HTTPS o localhost.");
      result.checkedAt = Date.now();
      return result;
    }

    if (!navigator.gpu) {
      result.reason = t("caps.reason.noGpu", "navigator.gpu no está disponible en este navegador.");
      result.checkedAt = Date.now();
      return result;
    }

    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) {
        result.reason = t("caps.reason.noAdapter", "No se ha podido obtener un GPUAdapter.");
        result.checkedAt = Date.now();
        return result;
      }

      result.webgpu = true;
      result.adapter = { info: adapter.info || null };
      result.features = Array.from(adapter.features || []);
      result.shaderF16 = adapter.features?.has?.("shader-f16") || false;
      result.recommendedDtype = result.shaderF16 ? "q4f16" : "q4";
      result.limits = {
        maxBufferSize: adapter.limits?.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits?.maxStorageBufferBindingSize,
        maxComputeWorkgroupStorageSize: adapter.limits?.maxComputeWorkgroupStorageSize,
        maxComputeInvocationsPerWorkgroup: adapter.limits?.maxComputeInvocationsPerWorkgroup,
      };
      result.reason = t("caps.reason.available", "WebGPU disponible.");
    } catch (error) {
      result.reason = error?.message ? t("caps.reason.browserError", "error del navegador: {message}", { message: error.message }) : String(error);
    }

    result.checkedAt = Date.now();
    return result;
  }

  function emitCapabilities(result, source = "unknown") {
    window.dispatchEvent(new CustomEvent("ba-llm:capabilities", {
      detail: { capabilities: result, source },
    }));
  }

  async function ensureLLMCapabilities(options = {}) {
    const { force = false, source = "unknown" } = options;

    if (window.BA_LLM?.capabilitiesChecked && window.BA_LLM.capabilities && !force) {
      syncLLMCapabilityBadges(window.BA_LLM.capabilities, "ready");
      return window.BA_LLM.capabilities;
    }

    if (window.BA_LLM?.capabilitiesChecking && !force) return window.BA_LLM.capabilitiesChecking;

    syncLLMCapabilityBadges(window.BA_LLM?.capabilities || null, "checking");

    const promise = (async () => {
      const result = await detectLLMCapabilities();
      if (window.BA_LLM) {
        window.BA_LLM.capabilities = result;
        window.BA_LLM.capabilitiesChecked = true;
      }
      syncLLMCapabilityBadges(result, "ready");
      emitCapabilities(result, source);
      return result;
    })();

    if (window.BA_LLM) window.BA_LLM.capabilitiesChecking = promise;

    try {
      return await promise;
    } finally {
      if (window.BA_LLM?.capabilitiesChecking === promise) {
        window.BA_LLM.capabilitiesChecking = null;
      }
    }
  }

  window.addEventListener("ba:langchange", () => syncLLMCapabilityBadges(window.BA_LLM?.capabilities || null, "ready"));

  window.BA_detectLLMCapabilities = detectLLMCapabilities;
  window.BA_ensureLLMCapabilities = ensureLLMCapabilities;
  window.BA_syncLLMCapabilityBadges = syncLLMCapabilityBadges;
})();
