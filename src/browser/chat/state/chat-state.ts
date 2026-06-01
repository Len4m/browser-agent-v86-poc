// @ts-nocheck
// Browser Agent v86 - 10 LLM state
// v9.37.16: local LLM state with WebGPU check triggered by LLM panel opening.
//
// Important: this is not WebLLM/MLC. The current local engine is
// Transformers.js v4 running ONNX models in a Web Worker with WebGPU.
// q4 is the default because q4f16 requires the WebGPU "shader-f16" feature.
// All state is namespaced under window.BA_LLM so future providers
// (OpenAI/Anthropic/WebLLM/etc.) can be added without touching VM/console code.

(function initBrowserAgentLLMState() {
  if (window.BA_LLM) return;

  function defaultAgentMeta(model) {
    const id = model.id || "";
    const vmRead = ["vm.fs.list", "vm.fs.read", "vm.sys.info"];
    if (model.engine === "ollama") {
      return {
        maxSteps: 4,
        maxNativeTools: 10,
        toolCalling: "good",
        defaultNativeTools: [...vmRead, "vm.console.status", "vm.cmd.which", "net.ip.status", "web.curl.head"],
      };
    }
    if (model.toolProfile === "tiny-fallback" || id.includes("270m")) {
      return {
        maxSteps: 1,
        maxNativeTools: 1,
        toolCalling: "weak",
        defaultNativeTools: ["vm.fs.list"],
      };
    }
    if (id.includes("0.5b") || (id.includes("qwen3") && id.includes("0.6"))) {
      return {
        maxSteps: 2,
        maxNativeTools: 2,
        toolCalling: "weak",
        defaultNativeTools: vmRead.slice(0, 2),
      };
    }
    if (id.includes("3b")) {
      return {
        maxSteps: 3,
        maxNativeTools: 8,
        toolCalling: "fair",
        defaultNativeTools: [...vmRead, "vm.console.status", "vm.cmd.which", "net.ip.status", "web.curl.head"],
      };
    }
    if (id.includes("llama") && (id.includes("1b-instruct") || id.includes("1b-instruct-onnx"))) {
      return {
        maxSteps: 2,
        maxNativeTools: 2,
        toolCalling: "weak",
        defaultNativeTools: vmRead.slice(0, 2),
      };
    }
    if (id.includes("1.5b") || id.includes("1b") || id.includes("1.7b")) {
      return {
        maxSteps: 3,
        maxNativeTools: 5,
        toolCalling: "fair",
        defaultNativeTools: [...vmRead, "vm.console.status", "vm.cmd.which"],
      };
    }
    if (model.toolProfile === "reasoning-light" || id.includes("qwen3")) {
      return {
        maxSteps: 3,
        maxNativeTools: 4,
        toolCalling: "good",
        defaultNativeTools: [...vmRead, "vm.console.status"],
      };
    }
    if (model.toolProfile === "middle-tools" || model.toolProfile === "strong-json") {
      return {
        maxSteps: 3,
        maxNativeTools: 6,
        toolCalling: "good",
        defaultNativeTools: [...vmRead, "vm.console.status", "vm.cmd.which", "web.curl.head"],
      };
    }
    return {
      maxSteps: 3,
      maxNativeTools: 5,
      toolCalling: "fair",
      defaultNativeTools: [...vmRead, "vm.console.status"],
    };
  }

  function mergeThinkingMeta(model) {
    return {
      enabled: false,
      tagName: "think",
      startWithReasoning: false,
      ...(model.thinking || {}),
    };
  }

  function defaultContextMeta(model) {
    const id = model.id || "";
    const contextWindowTokens = Number(model.contextWindowTokens) || (model.engine === "ollama" ? 8192 : 4096);
    if (model.engine === "ollama") {
      return {
        contextWindowTokens,
        maxNewTokens: model.maxNewTokens,
        contextPolicy: {
          provider: "ollama",
          contextWindowTokens,
          safeInputTokens: Math.min(6000, Math.max(2400, contextWindowTokens - 2200)),
          reservedOutputTokens: 2048,
          maxSystemChars: 2600,
          maxRuntimeChars: 1200,
          maxHistoryMessages: 8,
          maxHistoryChars: 12000,
          maxToolResultChars: 20000,
          maxToolResultCharsForSynthesis: 8000,
          maxArtifacts: 4,
        },
      };
    }
    let safeInputTokens = 1800;
    if (id.includes("3b")) safeInputTokens = 1400;
    else if (id.includes("0.5b") || (id.includes("qwen3") && id.includes("0.6")) || id.includes("270m")) {
      safeInputTokens = 1100;
    }
    return {
      contextWindowTokens,
      contextPolicy: { contextWindowTokens, safeInputTokens },
    };
  }

  function withModelCapabilities(model) {
    const ctx = defaultContextMeta(model);
    return {
      ...model,
      contextWindowTokens: model.contextWindowTokens ?? ctx.contextWindowTokens,
      maxNewTokens: model.maxNewTokens ?? ctx.maxNewTokens,
      contextPolicy: { ...ctx.contextPolicy, ...(model.contextPolicy || {}) },
      agent: model.agent || defaultAgentMeta(model),
      thinking: mergeThinkingMeta(model),
    };
  }

  const models = (window.BA_LLM_MODELS_RAW || []).map(withModelCapabilities);

  window.BA_LLM_MODELS = models;
  window.BA_LLM = {
    version: "v9.38.0-ai-sdk-browser",
    providerName: "transformersjs",
    providerLabel: "AI SDK + Transformers.js",
    available: true,
    loaded: false,
    loading: false,
    generating: false,
    selectedModelId: models.find((model) => model.engine === "transformersjs")?.id || models[0].id,
    activeModel: null,
    capabilities: null,
    capabilitiesChecked: false,
    capabilitiesChecking: null,
    provider: null,
    aiModelReady: false,
    messages: [],
    artifacts: [],
    lastArtifactId: null,
    lastError: "",
    settings: {
      // Nivel máximo de seguridad que el agente puede ejecutar sin pedir
      // confirmación. 1 = lectura segura dentro de la VM; niveles superiores
      // quedan preparados para tools futuras más intrusivas.
      toolAutonomyMaxLevel: Number(localStorage.getItem("ba.llm.toolAutonomyMaxLevel") || "1"),
      maxToolStepsPerTurn: 4,
      nativeToolNames: [],
      showThinking: false,
      systemPrompt: [
        t("prompt.system.role"),
        t("prompt.system.realData"),
        t("prompt.system.toolFallback"),
        t("prompt.system.artifacts"),
        t("prompt.system.style"),
      ].join(" "),
    },
  };

  window.BA_LLM_EVENTS = {
    emit(type, detail = {}) {
      window.dispatchEvent(new CustomEvent(`ba-llm:${type}`, { detail }));
    },
  };
})();
