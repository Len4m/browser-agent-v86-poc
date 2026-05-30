// @ts-nocheck
// Browser Agent v86 - 19 LLM context budget
// v9.52: single source of truth for prompt/output budgets.
//
// contextWindowTokens comes from the model catalog. This module reserves part
// of that window for input (safeInputTokens) and derives max output from the
// remaining room. Keep extra caps explicit and rare.

(function initLLMContextBudget() {
  const DEFAULT_LOCAL_POLICY = {
    provider: "transformersjs",
    contextWindowTokens: 4096,
    // Local browser inference runs beside v86, so these values are deliberately
    // below the theoretical model context. They reduce GPU memory spikes at the
    // beginning of generation in ONNX Runtime/WebGPU.
    safeInputTokens: 1800,
    reservedOutputTokens: 2048,
    maxSystemChars: 900,
    maxRuntimeChars: 420,
    maxHistoryMessages: 2,
    maxHistoryChars: 1000,
    maxToolResultChars: 2400,
    maxToolResultCharsForSynthesis: 1400,
    maxArtifacts: 1,
  };

  const DEFAULT_OLLAMA_POLICY = {
    provider: "ollama",
    contextWindowTokens: 8192,
    safeInputTokens: 5200,
    reservedOutputTokens: 2048,
    maxSystemChars: 2400,
    maxRuntimeChars: 1100,
    maxHistoryMessages: 6,
    maxHistoryChars: 10000,
    maxToolResultChars: 18000,
    maxToolResultCharsForSynthesis: 7000,
    maxArtifacts: 4,
  };

  const MODEL_POLICIES = {
    "gemma-3-270m-it-onnx-wasm-fp32": {
      ...DEFAULT_LOCAL_POLICY,
      safeInputTokens: 900,
      maxSystemChars: 560,
      maxRuntimeChars: 220,
      maxHistoryMessages: 0,
      maxHistoryChars: 0,
      maxToolResultChars: 900,
      maxToolResultCharsForSynthesis: 700,
    },
    "llama-3.2-1b-instruct-onnx-q4": {
      ...DEFAULT_LOCAL_POLICY,
      safeInputTokens: 1200,
      maxSystemChars: 720,
      maxRuntimeChars: 280,
      maxHistoryMessages: 1,
      maxHistoryChars: 400,
      maxToolResultChars: 2200,
      maxToolResultCharsForSynthesis: 1400,
    },
    "llama-3.2-1b-instruct-onnx-q4f16": {
      ...DEFAULT_LOCAL_POLICY,
      safeInputTokens: 1200,
      maxSystemChars: 720,
      maxRuntimeChars: 280,
      maxHistoryMessages: 1,
      maxHistoryChars: 400,
      maxToolResultChars: 2200,
      maxToolResultCharsForSynthesis: 1400,
    },
    "llama-3.2-3b-instruct-onnx-q4": {
      ...DEFAULT_LOCAL_POLICY,
      safeInputTokens: 1400,
      maxToolResultChars: 2200,
      maxToolResultCharsForSynthesis: 1200,
      maxHistoryMessages: 1,
      maxHistoryChars: 600,
    },
    "llama-3.2-3b-instruct-onnx-q4f16": {
      ...DEFAULT_LOCAL_POLICY,
      safeInputTokens: 1400,
      maxToolResultChars: 2200,
      maxToolResultCharsForSynthesis: 1200,
      maxHistoryMessages: 1,
      maxHistoryChars: 600,
    },
    "qwen2.5-coder-0.5b-instruct-q4": {
      ...DEFAULT_LOCAL_POLICY,
      safeInputTokens: 1100,
      maxSystemChars: 780,
      maxRuntimeChars: 300,
      maxHistoryMessages: 1,
      maxHistoryChars: 350,
      maxToolResultChars: 1800,
      maxToolResultCharsForSynthesis: 1000,
    },
    "qwen3-0.6b-onnx-q4f16": {
      ...DEFAULT_LOCAL_POLICY,
      safeInputTokens: 1100,
      maxSystemChars: 780,
      maxRuntimeChars: 300,
      maxHistoryMessages: 1,
      maxHistoryChars: 350,
      maxToolResultChars: 1800,
      maxToolResultCharsForSynthesis: 1000,
    },
    "qwen2.5-1.5b-instruct-q4": {
      ...DEFAULT_LOCAL_POLICY,
      safeInputTokens: 1350,
      maxSystemChars: 900,
      maxRuntimeChars: 360,
      maxHistoryMessages: 1,
      maxHistoryChars: 700,
      maxToolResultChars: 2600,
      maxToolResultCharsForSynthesis: 1600,
    },
    "smollm2-1.7b-instruct-q4f16": {
      ...DEFAULT_LOCAL_POLICY,
      safeInputTokens: 1300,
      maxSystemChars: 820,
      maxRuntimeChars: 320,
      maxHistoryMessages: 1,
      maxHistoryChars: 600,
      maxToolResultChars: 2200,
      maxToolResultCharsForSynthesis: 1400,
    },
    "custom-transformersjs": {
      ...DEFAULT_LOCAL_POLICY,
    },
    "ollama-qwen3-4b": {
      ...DEFAULT_OLLAMA_POLICY,
      safeInputTokens: 5600,
      maxSystemChars: 2600,
      maxRuntimeChars: 1200,
      maxHistoryMessages: 8,
      maxHistoryChars: 12000,
      maxToolResultChars: 20000,
      maxToolResultCharsForSynthesis: 8000,
    },
    "ollama-qwen3-1.7b": {
      ...DEFAULT_OLLAMA_POLICY,
      safeInputTokens: 5000,
      maxSystemChars: 2200,
      maxRuntimeChars: 1000,
      maxHistoryMessages: 6,
      maxHistoryChars: 9000,
      maxToolResultChars: 16000,
      maxToolResultCharsForSynthesis: 6000,
    },
    "ollama-llama3.2-latest": {
      ...DEFAULT_OLLAMA_POLICY,
      safeInputTokens: 5600,
      maxSystemChars: 2600,
      maxRuntimeChars: 1200,
      maxHistoryMessages: 8,
      maxHistoryChars: 12000,
      maxToolResultChars: 20000,
      maxToolResultCharsForSynthesis: 8000,
    },
    "custom-ollama": {
      ...DEFAULT_OLLAMA_POLICY,
    },
  };

  function getModelConfig() {
    return window.BA_LLM?.activeModel
      || window.BA_LLM_MODELS?.find((item) => item.id === window.BA_LLM?.selectedModelId)
      || window.BA_LLM_MODELS?.[0]
      || { id: "custom-transformersjs" };
  }

  function getRawPolicy(modelConfig = getModelConfig()) {
    return {
      ...DEFAULT_LOCAL_POLICY,
      ...(modelConfig?.contextPolicy || {}),
      ...(MODEL_POLICIES[modelConfig?.id] || {}),
    };
  }

  function localOutputCeiling(policy, safeInput) {
    if (policy.provider !== "transformersjs") return Infinity;
    if (safeInput <= 1000) return 512;
    if (safeInput <= 1200) return 1024;
    return 1536;
  }

  /**
   * Máximo de tokens de salida:
   *   contextWindowTokens (catálogo) - safeInputTokens (presupuesto de prompt) - margen.
   *
   * `model.maxNewTokens` o `policy.maxOutputTokens` son hard caps opcionales.
   * Solo `plan` tiene un cap bajo fijo porque debe emitir tool calls, no prosa.
   * @param {"chat"|"synthesis"|"plan"} kind
   */
  function resolveMaxOutputTokens(modelConfig = getModelConfig(), kind = "chat") {
    const policy = getRawPolicy(modelConfig);
    const contextWindow = Number(
      modelConfig?.contextWindowTokens
      ?? policy.contextWindowTokens
      ?? DEFAULT_LOCAL_POLICY.contextWindowTokens,
    );
    const safeInput = Number(policy.safeInputTokens ?? DEFAULT_LOCAL_POLICY.safeInputTokens);
    const fromWindow = Math.max(128, contextWindow - safeInput - 48);

    let target = fromWindow;
    const runtimeCap = localOutputCeiling(policy, safeInput);
    if (Number.isFinite(runtimeCap) && runtimeCap > 0) {
      target = Math.min(target, runtimeCap);
    }

    const policyCap = Number(policy.maxOutputTokens);
    if (Number.isFinite(policyCap) && policyCap > 0) {
      target = Math.min(target, policyCap);
    }

    const catalogCap = Number(modelConfig?.maxNewTokens);
    if (Number.isFinite(catalogCap) && catalogCap > 0) {
      target = Math.min(target, catalogCap);
    }

    if (kind === "plan") {
      return Math.min(target, policy.provider === "ollama" ? 768 : 192);
    }
    return target;
  }

  /** Llama 1B en Transformers.js a veces no genera con `system` separado; fusionar en user. */
  function mergeSystemIntoUserMessages(messages = []) {
    const list = (messages || []).map((msg) => ({ ...msg }));
    const systemIdx = list.findIndex((msg) => msg.role === "system");
    if (systemIdx < 0) return list;
    const systemText = String(list[systemIdx].content || "").trim();
    list.splice(systemIdx, 1);
    if (!systemText) return list.filter((msg) => msg.role !== "system");
    const userIdx = list.findIndex((msg) => msg.role === "user");
    if (userIdx >= 0) {
      list[userIdx] = {
        ...list[userIdx],
        content: `${systemText}\n\n${list[userIdx].content}`,
      };
    } else {
      list.unshift({ role: "user", content: systemText });
    }
    return list;
  }

  function adaptPromptForLocalWeak(prompt, modelConfig = getModelConfig()) {
    if (modelConfig?.agent?.toolCalling !== "weak") return prompt;
    const system = String(prompt?.system || "").trim();
    const baseMessages = prompt?.messages || [];
    if (!system) {
      return { ...prompt, messages: mergeSystemIntoUserMessages(baseMessages) };
    }
    const withUser = baseMessages.length
      ? baseMessages
      : [{ role: "user", content: t("prompt.respondLang", "Responde en español.") }];
    return {
      ...prompt,
      system: undefined,
      messages: mergeSystemIntoUserMessages([
        { role: "system", content: system },
        ...withUser,
      ]),
    };
  }

  function getPolicy(modelConfig = getModelConfig()) {
    const base = getRawPolicy(modelConfig);
    const maxChat = resolveMaxOutputTokens(modelConfig, "chat");
    const maxSynth = resolveMaxOutputTokens(modelConfig, "synthesis");
    return {
      ...base,
      maxNewTokensDefault: maxChat,
      maxNewTokensForSynthesis: maxSynth,
      maxNewTokensForPlan: resolveMaxOutputTokens(modelConfig, "plan"),
      reservedOutputTokens: maxChat,
    };
  }

  function estimateTokens(text) {
    // Conservative browser-side approximation. Tokenizers vary by model and
    // language; using chars/3 biases toward safety for multilingual text.
    const value = String(text || "");
    if (!value) return 0;
    return Math.ceil(value.length / 3);
  }

  function truncateChars(text, maxChars, suffix = t("prompt.contextTrimmed", "\n...[contexto recortado]...")) {
    const value = String(text || "");
    if (value.length <= maxChars) return { text: value, truncated: false };
    return { text: `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`, truncated: true };
  }

  function compactHistory(messages = [], policy = getPolicy()) {
    const selected = [];
    let chars = 0;
    const maxMessages = Math.max(0, policy.maxHistoryMessages || 0);
    const maxChars = Math.max(0, policy.maxHistoryChars || 0);
    if (!maxMessages || !maxChars) return selected;

    const candidates = messages.slice(-maxMessages * 2).filter((msg) => msg?.role && msg?.content);
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const msg = candidates[i];
      const content = String(msg.content || "");
      if (content.length > maxChars) continue;
      if (chars + content.length > maxChars) break;
      selected.unshift({ role: msg.role, content });
      chars += content.length;
    }
    return selected.slice(-maxMessages);
  }

  function buildRuntimeContext({ nativeTools = false, activeToolNames = null } = {}) {
    const notReady = t("prompt.toolsNotReady", "Herramientas: no listas.");
    const registryCtx = nativeTools
      ? (window.BA_LLM_TOOL_REGISTRY?.buildPromptRuntimeContextCompact?.({ toolNames: activeToolNames }) || notReady)
      : (window.BA_LLM_TOOL_REGISTRY?.buildPromptRuntimeContext?.() || notReady);
    if (nativeTools) return registryCtx;
    const budget = window.BA_LLM_RESOURCE_GOVERNOR?.getSnapshot?.();
    if (!budget) return registryCtx;
    return [
      registryCtx,
      t("prompt.resources", "Recursos: LLM {llm} · herramienta {tool} · último artefacto {artifact}", {
        llm: budget.llmBusy ? t("common.busy", "ocupado") : t("prompt.free", "libre"),
        tool: budget.toolBusy ? t("common.busy", "ocupada") : t("prompt.free", "libre"),
        artifact: window.BA_LLM?.lastArtifactId || "—",
      }),
    ].join("\n");
  }

  function buildAppToolFormatRule(activeToolNames = []) {
    const list = (activeToolNames || []).filter(Boolean).join(", ") || t("prompt.none", "ninguna");
    return [
      t("prompt.appTool.general", "Preguntas generales (sin datos de la VM): responde en español normal, sin bloque tool_call."),
      t("prompt.appTool.onlyIf", "Solo si necesitas datos reales de la VM/red: responde ÚNICAMENTE con este bloque (sin texto antes ni después):"),
      "```tool_call",
      "{\"name\":\"vm.fs.list\",\"arguments\":{\"path\":\"/\",\"maxEntries\":120}}",
      "```",
      t("prompt.appTool.replaceName", "Sustituye el name por uno de: {list}. Claves JSON: \"name\" y \"arguments\" (no uses \"tool\").", { list }),
      t("prompt.appTool.noOutside", "No uses nombres de tools fuera de esa lista; pueden no existir en el perfil VM actual."),
    ].join("\n");
  }

  function buildSystemMessage({ mode = "chat", nativeTools = false, appToolTurn = false, activeToolNames = [] } = {}) {
    const policy = getPolicy();
    const baseRaw = String(window.BA_LLM?.settings?.systemPrompt || "").trim();
    const runtimeRaw = buildRuntimeContext({
      nativeTools,
      activeToolNames: appToolTurn ? activeToolNames : null,
    });

    if (appToolTurn && mode === "chat") {
      const format = buildAppToolFormatRule(activeToolNames);
      const budget = Math.max(180, policy.maxSystemChars - format.length - 4);
      const base = truncateChars(baseRaw, Math.floor(budget * 0.55)).text;
      const runtime = truncateChars(runtimeRaw, Math.min(policy.maxRuntimeChars, Math.floor(budget * 0.45))).text;
      const tail = [base, runtime].filter(Boolean).join("\n\n");
      const tailTrim = truncateChars(tail, budget).text;
      return format + (tailTrim ? `\n\n${tailTrim}` : "");
    }

    const toolRules = [];
    if (nativeTools) {
      toolRules.push(
        t("prompt.native.invokeOne", "Si necesitas datos reales de la VM o red, invoca exactamente una herramienta activa del runtime."),
        t("prompt.native.onlyActive", "No llames herramientas que no aparezcan en 'Herramientas activas'; los perfiles de VM no tienen el mismo catálogo."),
        t("prompt.native.preferSpecific", "Prefiere herramientas específicas (vm.fs.*, vm.sys.info, net.*, web.*) antes de vm.sh.exec. Usa vm.sh.exec solo si no existe alternativa activa."),
        t("prompt.native.explainFail", "Si la VM/serial1 no está lista o la herramienta falla, explica el fallo; no inventes stdout ni archivos."),
        t("prompt.native.fallbackFormat", "Formato si el runtime no acepta tool-call nativo:"),
        "```tool_call",
        "{\"name\":\"vm.fs.list\",\"arguments\":{\"path\":\"/\",\"maxEntries\":120}}",
        "```",
        t("prompt.native.keys", "Usa claves \"name\" y \"arguments\". No inventes salidas."),
      );
    }
    if (mode === "synthesis") {
      toolRules.push(t("prompt.synthesis.rule", "Resume solo el artefacto; si está truncado, dilo. Máx. 6 frases."));
    }

    const maxBase = Math.floor(policy.maxSystemChars * 0.5);
    const parts = [truncateChars(baseRaw, maxBase).text];
    if (toolRules.length) parts.push(toolRules.join("\n"));
    if (runtimeRaw) {
      parts.push(truncateChars(runtimeRaw, policy.maxRuntimeChars).text);
    }
    return truncateChars(parts.join("\n\n"), policy.maxSystemChars).text;
  }

  function minSystemCharsForBudget(policy, systemContent = "") {
    if (/```tool_call/i.test(systemContent)) {
      return Math.max(420, Math.floor(policy.maxSystemChars * 0.95));
    }
    return Math.floor(policy.maxSystemChars * 0.75);
  }

  function buildChatMessages(userText, { artifact = null, nativeTools = false, appToolTurn = false, activeToolNames = [] } = {}) {
    const policy = getPolicy();
    const history = compactHistory(window.BA_LLM?.messages || [], policy);
    const messages = [
      {
        role: "system",
        content: buildSystemMessage({
          mode: artifact ? "synthesis" : "chat",
          nativeTools,
          appToolTurn,
          activeToolNames,
        }),
      },
      ...history,
    ];

    if (artifact) {
      const artifactText = window.BA_LLM_ARTIFACTS?.formatArtifactForModel?.(artifact, {
        maxChars: policy.maxToolResultChars,
      }) || "";
      messages.push({
        role: "user",
        content: [
          t("prompt.artifact.refers", "El usuario se refiere a un resultado real de herramienta guardado como artefacto."),
          t("prompt.artifact.onlyArtifact", "No uses conocimiento inventado; usa solamente el artefacto y la petición actual."),
          "",
          artifactText,
          "",
          t("prompt.artifact.currentRequest", "Petición actual del usuario: {user}", { user: userText }),
        ].join("\n"),
      });
    } else if (appToolTurn) {
      messages.push({
        role: "user",
        content: [
          userText,
          "",
          t("prompt.appTool.turnHint", "Si necesitas datos de la VM, responde solo con ```tool_call. Si no, responde en texto normal (sin JSON de tool)."),
        ].join("\n"),
      });
    } else {
      messages.push({ role: "user", content: userText });
    }

    return enforceBudget(messages, policy);
  }

  function buildMinimalChatSystem() {
    return t("prompt.minimalChat", "Asistente local en español. Responde en prosa breve. No uses JSON ni bloques de código salvo que pidan datos reales de la VM.");
  }

  /** Prompt for streamText({ system, messages }). nativeTools = catálogo compacto (schemas en runtime). */
  function buildAgentTurnPrompt(userText, {
    artifact = null,
    chatOnly = false,
    nativeTools = false,
    appToolTurn = false,
    activeToolNames = [],
  } = {}) {
    if (chatOnly && !artifact) {
      const policy = getPolicy();
      const history = compactHistory(window.BA_LLM?.messages || [], {
        ...policy,
        maxHistoryMessages: 0,
        maxHistoryChars: 0,
      });
      const messages = [
        ...history,
        { role: "user", content: userText },
      ];
      return {
        system: buildMinimalChatSystem(),
        messages: enforceBudget(messages, {
          ...policy,
          safeInputTokens: 500,
          maxSystemChars: 280,
          maxHistoryMessages: 1,
          maxHistoryChars: 400,
        }),
        chatOnly: true,
      };
    }

    if (nativeTools && !artifact) {
      const wrapped = buildChatMessages(userText, { nativeTools: true, appToolTurn: false, activeToolNames });
      const system = wrapped.find((msg) => msg.role === "system")?.content
        || buildSystemMessage({ mode: "chat", nativeTools: true, appToolTurn: false, activeToolNames });
      const messages = wrapped.filter((msg) => msg.role !== "system");
      return { system, messages, chatOnly: false, nativeTools: true };
    }

    const wrapped = buildChatMessages(userText, { artifact, nativeTools: true });
    const system = wrapped.find((msg) => msg.role === "system")?.content
      || buildSystemMessage({ mode: artifact ? "synthesis" : "chat", nativeTools: true });
    const messages = wrapped.filter((msg) => msg.role !== "system");
    return { system, messages, chatOnly: false };
  }

  function enforceBudget(messages, policy = getPolicy()) {
    const maxTokens = Math.max(256, policy.safeInputTokens || DEFAULT_LOCAL_POLICY.safeInputTokens);
    let total = estimateTokens(messages.map((msg) => msg.content).join("\n"));
    if (total <= maxTokens) return messages;

    const out = messages.map((msg) => ({ ...msg }));
    // First compact system/runtime if needed.
    const systemIndex = out.findIndex((msg) => msg.role === "system");
    if (systemIndex >= 0) {
      const systemContent = out[systemIndex].content || "";
      out[systemIndex].content = truncateChars(
        systemContent,
        minSystemCharsForBudget(policy, systemContent),
      ).text;
    }
    total = estimateTokens(out.map((msg) => msg.content).join("\n"));
    if (total <= maxTokens) return out;

    // Remove oldest non-system/non-last messages.
    while (out.length > 2 && estimateTokens(out.map((msg) => msg.content).join("\n")) > maxTokens) {
      out.splice(1, 1);
    }
    total = estimateTokens(out.map((msg) => msg.content).join("\n"));
    if (total <= maxTokens) return out;

    // Last resort: truncate final user message head/tail.
    const last = out[out.length - 1];
    const availableChars = Math.max(1000, (maxTokens - estimateTokens(out.slice(0, -1).map((msg) => msg.content).join("\n"))) * 3);
    const compact = window.BA_LLM_ARTIFACTS?.truncateMiddle?.(last.content, availableChars) || truncateChars(last.content, availableChars);
    last.content = `${compact.text}\n\n${t("prompt.contextTrimmedNote", "Nota del sistema: el contexto fue recortado para respetar la memoria del modelo local.")}`;
    return out;
  }

  function inspectMessages(messages, policy = getPolicy()) {
    const text = messages.map((msg) => msg.content).join("\n");
    return {
      chars: text.length,
      estimatedTokens: estimateTokens(text),
      safeInputTokens: policy.safeInputTokens,
      reservedOutputTokens: policy.reservedOutputTokens,
      messages: messages.length,
    };
  }

  window.BA_LLM_CONTEXT = {
    MODEL_POLICIES,
    getRawPolicy,
    getPolicy,
    resolveMaxOutputTokens,
    estimateTokens,
    truncateChars,
    compactHistory,
    buildSystemMessage,
    buildChatMessages,
    buildMinimalChatSystem,
    buildAgentTurnPrompt,
    mergeSystemIntoUserMessages,
    adaptPromptForLocalWeak,
    enforceBudget,
    inspectMessages,
  };
})();
