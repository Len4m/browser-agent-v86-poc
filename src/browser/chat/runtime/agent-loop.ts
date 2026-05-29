// @ts-nocheck
// Browser Agent v86 - 14 Agent loop (AI SDK + Transformers.js)
// Un solo loop AI SDK: streamText + tools + stopWhen(stepCountIs) + prepareStep (ver runAgentStreamTurn).
// Esta capa solo orquesta UI, contexto y registro de tools; no planifica tools fuera del SDK.

(function initLLMAgentLoop() {
  let activeTurnAbortController = null;
  let activeTurnGeneration = 0;
  let stopRequested = false;

  const {
    createAssistantMessageShell,
    removeAssistantMessage,
    hidePlanningShell,
    showAssistantMessage,
    pickFinalAssistantText,
    appendFinalAgentBubble,
    flushAssistantBubbleText,
    appendThinkingChunk,
    setChatTailIndicator,
    clearChatTailIndicator,
    renderToolCallBubble,
    appendToolResultToBubble,
    renderDeterministicToolAnswer,
  } = window.BA_LLM_CHAT_UI;

  const {
    flattenErrorMessage,
    isRecoverableGpuMemoryError,
    shouldEnableNativeTools,
    resolveNativeToolNames,
    isLikelyToolPlanText,
    userRequestLikelyNeedsVm,
  } = window.BA_LLM_ROUTING;

  function isStaleTurn(turnGeneration) {
    return turnGeneration !== activeTurnGeneration;
  }

  let streamDeltaLogCount = 0;

  function agentDebug(category, message, data = null) {
    window.BA_LLM_AGENT_DEBUG?.log?.(category, message, data);
  }

  function agentDebugStreamPart(part, extra = "") {
    const dbg = window.BA_LLM_AGENT_DEBUG;
    if (!dbg?.log) return;
    const summary = dbg.summarizeStreamPart?.(part) ?? { type: part?.type };
    if (part?.type === "text-delta") {
      streamDeltaLogCount += 1;
      const sample = part.text ?? part.textDelta ?? part.delta ?? "";
      const interesting = /[{`]|tool|vm\.|arguments|name"/i.test(sample);
      if (streamDeltaLogCount <= 2 || interesting || streamDeltaLogCount % 10 === 0) {
        agentDebug("stream", `text-delta #${streamDeltaLogCount}${extra}`, summary);
      }
      return;
    }
    agentDebug("stream", `${part?.type || "?"}${extra}`, summary);
  }

  function throwIfAborted(abortSignal) {
    if (!abortSignal?.aborted) return;
    const error = new Error("Operación cancelada");
    error.name = "AbortError";
    throw error;
  }

  function isAbortError(error) {
    if (error?.name === "AbortError") return true;
    const msg = String(error?.message || "");
    return /\baborted\b|The user aborted a request/i.test(msg);
  }

  function getToolCallingMode(modelConfig) {
    return modelConfig?.agent?.toolCalling || "fair";
  }

  function canModelChooseToolsWithoutHeuristic(modelConfig) {
    const mode = getToolCallingMode(modelConfig);
    return modelConfig?.engine === "ollama" || mode === "good";
  }

  function buildEmptyResponseMessage({
    modelConfig,
    reasoningText = "",
    showThinking = false,
    streamIsToolPlan = false,
    toolPhaseSeen = false,
    runnerInfo = {},
  } = {}) {
    const finishReason = runnerInfo.finishReason;
    if (reasoningText.trim()) {
      return showThinking
        ? t("chat.empty.reasoningOnly.thinking", "El modelo solo emitió razonamiento, pero no produjo una respuesta final separada. Lo mostrado en «Razonamiento del modelo» no se guarda como respuesta final.")
        : t("chat.empty.reasoningOnly.noThinking", "El modelo generó razonamiento interno, pero no produjo una respuesta final visible. Activa «Mostrar razonamiento» para inspeccionarlo o prueba otro modelo.");
    }
    if (streamIsToolPlan) {
      return t("chat.empty.toolPlan", "El modelo generó un plan de tool en JSON, pero no produjo una respuesta final en texto. Prueba con un modelo con mejor tool calling o reduce las herramientas activas.");
    }
    if (toolPhaseSeen || runnerInfo.hadToolWork) {
      return t("chat.empty.toolNoSynthesis", "La tool se ejecutó, pero el modelo no generó una síntesis final. Revisa el artefacto generado o prueba de nuevo con menos salida de tool.");
    }
    if (/length|max|token/i.test(String(finishReason || ""))) {
      return t("chat.empty.lengthLimit", "La respuesta se cortó por límite de salida del modelo. Sube el presupuesto de salida o usa un modelo con más contexto.");
    }
    const label = modelConfig?.shortLabel || modelConfig?.label || modelConfig?.id || t("chat.empty.defaultModelLabel", "modelo local");
    return t("chat.empty.noVisibleText", "El {label} no generó texto visible. Puede ser salida vacía, incompatibilidad de streaming o un formato que el parser no puede renderizar.", { label });
  }

  function isChatOperationActive() {
    const llm = window.BA_LLM;
    const governor = window.BA_LLM_RESOURCE_GOVERNOR?.getSnapshot?.();
    return Boolean(
      llm?.generating
      || governor?.llmBusy
      || governor?.toolBusy
      || governor?.backgroundToolBusy
    );
  }

  function stopActiveTurn() {
    agentDebug("stop", "stopActiveTurn", {
      generation: activeTurnGeneration,
      governor: window.BA_LLM_RESOURCE_GOVERNOR?.getSnapshot?.(),
    });
    stopRequested = true;
    activeTurnGeneration += 1;
    activeTurnAbortController?.abort();
    activeTurnAbortController = null;
    window.BA_AISDK?.abortActive?.();
    window.BA_BG_TOOLS?.cancelPending?.("usuario");
    if (window.BA_LLM) window.BA_LLM.generating = false;
    window.BA_LLM_RESOURCE_GOVERNOR?.forceReleaseWork?.();
    clearChatTailIndicator();
    document.querySelectorAll(".ba-llm-inference-indicator").forEach((el) => el.remove());
    document.querySelectorAll(".ba-llm-bubble[aria-busy='true']").forEach((el) => {
      el.setAttribute("aria-busy", "false");
    });
    updateChatAvailability();
    window.BA_LLM_EVENTS?.emit("status", { text: t("chat.status.stopped", "Operación detenida"), tone: "warn" });
  }

  function bindChatSubmitButton() {
    const submit = document.getElementById("chat-submit-btn");
    if (!submit || submit.dataset.baStopBound === "1") return;
    submit.dataset.baStopBound = "1";
    submit.addEventListener("click", (event) => {
      if (!submit.classList.contains("is-stop")) return;
      event.preventDefault();
      event.stopPropagation();
      stopActiveTurn();
    });
  }

  function getSelectedModelConfig() {
    const llm = window.BA_LLM;
    const selected = window.BA_LLM_MODELS.find((item) => item.id === llm.selectedModelId) || window.BA_LLM_MODELS[0];
    if (!selected.custom) return { ...selected };

    const customInput = document.getElementById("ba-llm-custom-model");
    return {
      ...selected,
      model: customInput?.value?.trim() || selected.model,
    };
  }

  function isTransformersModel(modelConfig) {
    return (modelConfig?.engine || "transformersjs") === "transformersjs";
  }

  function modelRequiresUnavailableF16(modelConfig, capabilities) {
    return Boolean(modelConfig?.requiresShaderF16 || /f16/i.test(modelConfig?.dtype || ""))
      && capabilities
      && capabilities.webgpu
      && !capabilities.shaderF16;
  }

  async function ensureCapabilities() {
    if (!window.BA_LLM.capabilities && window.BA_detectLLMCapabilities) {
      window.BA_LLM.capabilities = await window.BA_detectLLMCapabilities();
    }
    return window.BA_LLM.capabilities;
  }

  async function ensureAiSdk() {
    await window.BA_AISDK_READY;
    if (!window.BA_AISDK) {
      throw new Error(t("chat.error.aiSdkNotLoaded", "AI SDK bridge no cargado. Ejecuta npm run build y recarga la página."));
    }
    return window.BA_AISDK;
  }

  function isModelReady() {
    return Boolean(window.BA_LLM?.loaded && window.BA_LLM?.aiModelReady && window.BA_AISDK?.isModelReady?.());
  }

  async function loadSelectedModel() {
    const llm = window.BA_LLM;
    const modelConfig = getSelectedModelConfig();
    const caps = await ensureCapabilities();
    const sdk = await ensureAiSdk();

    const needsWebGPU = isTransformersModel(modelConfig) && (modelConfig.device || "webgpu") === "webgpu";
    if (!modelConfig.model) {
      throw new Error(modelConfig.engine === "ollama"
        ? t("chat.error.ollamaModelMissing", "Indica un modelo de Ollama, por ejemplo qwen3.5:4b o qwen3:8b.")
        : t("chat.error.transformersModelMissing", "Indica un modelo compatible con Transformers.js."));
    }
    if (needsWebGPU && !caps?.webgpu) {
      throw new Error(caps?.reason || t("chat.error.webgpuUnavailable", "WebGPU no está disponible en este navegador. Selecciona un modelo experimental WASM o usa Chrome/Edge con WebGPU activado."));
    }
    if (needsWebGPU && modelRequiresUnavailableF16(modelConfig, caps)) {
      throw new Error(t("chat.error.shaderF16", "El modelo seleccionado usa {dtype}, pero esta GPU/navegador no soporta shader-f16. Selecciona una variante q4 o un modelo experimental WASM.", { dtype: modelConfig.dtype }));
    }

    if (!window.BA_LLM_RESOURCE_GOVERNOR?.canStart?.("model-load")) {
      throw new Error(t("chat.error.llmBusy", "Hay una operación LLM/herramienta activa. Espera a que termine antes de cargar otro modelo."));
    }

    window.BA_LLM_RESOURCE_GOVERNOR?.start?.("model-load", t("chat.governor.modelLoad", "carga de modelo"));
    llm.loading = true;
    llm.loaded = false;
    llm.aiModelReady = false;
    llm.lastError = "";
    window.BA_LLM_EVENTS?.emit("status", {
      text: modelConfig.engine === "ollama" && window.BA_ORIGIN?.isPublishedOrigin?.()
        ? t("chat.status.ollamaPermission", "Ollama local: permiso de red + OLLAMA_ORIGINS")
        : (modelConfig.engine === "ollama" ? t("chat.status.connectingOllama", "Conectando con Ollama…") : t("chat.status.loadingModel", "Cargando modelo local…")),
      tone: "warn",
    });

    try {
      sdk.unloadModel();
      await sdk.loadModel(modelConfig, {
        onProgress(detail) {
          window.BA_LLM_EVENTS?.emit("progress", detail);
          if (detail?.status === "fallback") {
            window.BA_LLM_EVENTS?.emit("status", { text: t("chat.status.webgpuFallback", "WebGPU falló; probando alternativa WASM…"), tone: "warn" });
          }
        },
      });

      const activeConfig = sdk.getActiveModelConfig?.() || modelConfig;
      llm.loaded = true;
      llm.aiModelReady = true;
      llm.activeModel = activeConfig;
      updateChatAvailability?.();
      window.BA_LLM_EVENTS?.emit("status", {
        text: `${activeConfig.shortLabel || activeConfig.label}`,
        tone: activeConfig.fallbackReason ? "warn" : "good",
      });
    } finally {
      llm.loading = false;
      window.BA_LLM_RESOURCE_GOVERNOR?.finish?.("model-load");
      updateChatAvailability?.();
    }
  }

  const NATIVE_TOOL_STREAM_SKIP = new Set([
    "tool-call",
    "tool-input-start",
    "tool-input-delta",
    "tool-input-available",
    "tool-result",
    "tool-error",
    "tool-output-available",
    "tool-output-error",
    "step-start",
    "step-finish",
  ]);

  async function handleToolUiAfterExecute({
    userText,
    toolCall,
    toolResult,
    artifact = null,
    bubble,
    source = "agent",
    abortSignal,
  }) {
    throwIfAborted(abortSignal);
    appendToolResultToBubble(bubble, toolResult, artifact);

    if (toolResult.cancelled) {
      const answer = t("chat.tool.cancelledByUser", "Herramienta cancelada por el usuario.");
      window.BA_LLM.messages.push({ role: "user", content: userText });
      window.BA_LLM.messages.push({ role: "assistant", content: answer });
      window.BA_LLM.messages = window.BA_LLM.messages.slice(-8);
      return { toolResult, artifact, answer };
    }

    const decision = window.BA_LLM_TOOL_RESULT_POLICY?.decideAfterTool?.({
      userText,
      toolCall,
      result: toolResult,
      artifact,
    }) || { mode: "direct", reason: "Política no disponible." };

    let answer = "";
    if (toolResult.ok) {
      answer = await renderDeterministicToolAnswer(toolCall, toolResult, artifact, bubble);
    }

    window.BA_LLM.messages.push({ role: "user", content: userText });
    window.BA_LLM.messages.push({
      role: "assistant",
      content: `Herramienta ${toolCall.tool} ejecutada. Artefacto ${artifact?.id || "sin-id"}.`,
    });
    window.BA_LLM.messages = window.BA_LLM.messages.slice(-8);
    return { toolResult, artifact, answer, decision };
  }

  async function runAgentTurn({ userText, source = "agent", abortSignal, turnGeneration } = {}) {
    throwIfAborted(abortSignal);
    if (isStaleTurn(turnGeneration)) {
      const err = new Error("Operación cancelada");
      err.name = "AbortError";
      throw err;
    }
    const sdk = await ensureAiSdk();
    const llm = window.BA_LLM;
    const modelConfig = llm.activeModel || getSelectedModelConfig();
    const policy = window.BA_LLM_CONTEXT?.getPolicy?.(modelConfig) || {};
    const showThinking = Boolean(modelConfig?.thinking?.enabled && llm.settings?.showThinking);

    const referencedArtifact = window.BA_LLM_TOOL_RESULT_POLICY?.selectArtifactForUserText?.(userText) || null;
    const nativeToolsMode = shouldEnableNativeTools({ referencedArtifact });
    const activeToolNames = nativeToolsMode ? resolveNativeToolNames(modelConfig) : [];
    const needsVm = userRequestLikelyNeedsVm(userText);
    const modelMayChooseTools = canModelChooseToolsWithoutHeuristic(modelConfig);
    const useToolLoop = nativeToolsMode && (needsVm || modelMayChooseTools);
    const toolCallingMode = getToolCallingMode(modelConfig);
    streamDeltaLogCount = 0;
    agentDebug("route", "runAgentTurn", {
      modelId: modelConfig?.id,
      toolCalling: toolCallingMode,
      nativeToolsMode,
      needsVm,
      modelMayChooseTools,
      useToolLoop,
      activeToolNames,
      turnMaxStepsPreview: modelConfig?.agent?.maxSteps,
    });

    const prompt = window.BA_LLM_CONTEXT.buildAgentTurnPrompt(userText, {
      artifact: referencedArtifact,
      chatOnly: !useToolLoop,
      nativeTools: nativeToolsMode,
      activeToolNames,
    });

    const inspected = window.BA_LLM_CONTEXT?.inspectMessages?.([
      { role: "system", content: prompt.system },
      ...prompt.messages,
    ], policy);
    window.BA_LLM_EVENTS?.emit("context", inspected || {});

    let bubble = null;
    let mdHost = null;
    let renderer = null;

    async function createResponseStream(extraClass = "") {
      bubble = createAssistantMessageShell(extraClass);
      mdHost = document.createElement("div");
      mdHost.className = "ba-llm-md-host";
      bubble.appendChild(mdHost);
      renderer = await window.BA_createMarkdownStreamRenderer(mdHost);
      return { bubble, mdHost, renderer };
    }

    function responseHasVisibleText() {
      return Boolean((mdHost?.textContent || "").trim());
    }

    await createResponseStream();

    const spinnerLabel = useToolLoop && needsVm
      ? t("chat.spinner.agentLoop", "Agente (loop AI + tools)…")
      : t("chat.spinner.generating", "Generando respuesta…");
    setChatTailIndicator(spinnerLabel);
    bubble.setAttribute("aria-busy", "true");

    const toolBubbles = new Map();
    let toolSeq = 0;
    let lastToolUi = null;
    let sdkAssistantText = "";
    let preToolText = "";
    let reasoningText = "";
    let toolPhaseSeen = false;

    let maxSteps = modelConfig?.agent?.maxSteps || 2;
    if (toolCallingMode === "weak") maxSteps = 1;
    else if (toolCallingMode === "fair") maxSteps = Math.min(maxSteps, 2);
    const turnMaxSteps = useToolLoop ? maxSteps : 1;

    const tools = nativeToolsMode
      ? (window.BA_buildAiSdkTools?.({
        userText,
        source,
        toolNames: activeToolNames,
        onToolStart({ toolCall }) {
          agentDebug("tool", "SDK onToolStart", toolCall);
          if (responseHasVisibleText()) {
            hidePlanningShell(bubble);
          } else {
            removeAssistantMessage(bubble);
          }
          const key = `${toolCall.tool}-${++toolSeq}`;
          const toolBubble = createAssistantMessageShell("ba-llm-tool-step");
          renderToolCallBubble(toolBubble, toolCall, t("chat.tool.executingState", "ejecutando…"));
          toolBubbles.set(key, toolBubble);
          toolCall.__uiKey = key;
          setChatTailIndicator(t("chat.spinner.executingTool", "Ejecutando {tool}…", { tool: toolCall.tool || "tool" }));
        },
        async onToolEnd({ toolCall, toolResult, artifact }) {
          agentDebug("tool", "SDK onToolEnd", {
            tool: toolCall?.tool,
            ok: toolResult?.ok,
            code: toolResult?.code,
            summary: toolResult?.summary,
            artifactId: artifact?.id,
          });
          toolPhaseSeen = true;
          const key = toolCall.__uiKey || `${toolCall.tool}-${toolSeq}`;
          const toolBubble = toolBubbles.get(key) || createAssistantMessageShell("ba-llm-tool-step");
          lastToolUi = await handleToolUiAfterExecute({
            userText,
            toolCall,
            toolResult,
            artifact,
            bubble: toolBubble,
            source,
            abortSignal,
          });
          await createResponseStream("ba-llm-synthesis-after-tool");
          setChatTailIndicator(t("chat.spinner.finalResponse", "Generando respuesta final…"));
        },
      }) || {})
      : {};
    const registeredToolNames = Object.keys(tools);
    const sentActiveToolNames = activeToolNames.filter((name) => registeredToolNames.includes(name));
    agentDebug("tools", "selección vs tools enviadas", {
      selected: activeToolNames,
      registered: registeredToolNames,
      sentActiveTools: sentActiveToolNames,
      profileId: window.state?.activeRuntime?.profile?.id || document.getElementById("vm-profile")?.value || "manual",
      modelId: modelConfig?.id,
    });

    if (nativeToolsMode && !activeToolNames.length) {
      throw new Error(t("chat.error.noToolsEnabled", "Activa al menos una tool en el panel LLM (límite según modelo)."));
    }

    const turnMaxTokens = window.BA_LLM_CONTEXT?.resolveMaxOutputTokens?.(modelConfig, useToolLoop && needsVm ? "plan" : "chat")
      ?? policy.maxNewTokensDefault
      ?? modelConfig.maxNewTokens
      ?? (useToolLoop ? 192 : 512);
    const synthesisMaxTokens = window.BA_LLM_CONTEXT?.resolveMaxOutputTokens?.(modelConfig, "synthesis")
      ?? policy.maxNewTokensForSynthesis
      ?? turnMaxTokens;
    agentDebug("context", "límites de salida resueltos", {
      provider: modelConfig?.engine,
      modelId: modelConfig?.id,
      turnKind: useToolLoop && needsVm ? "plan" : "chat",
      turnMaxTokens,
      synthesisMaxTokens,
    });

    const llmLabel = useToolLoop
      ? t("chat.governor.aiLoop", "loop AI SDK ({tools} tools, {steps} pasos)", { tools: activeToolNames.length, steps: turnMaxSteps })
      : t("chat.governor.chat", "chat");
    window.BA_LLM_RESOURCE_GOVERNOR?.start?.("llm", llmLabel);
    try {
      const streamPrompt = window.BA_LLM_CONTEXT.adaptPromptForLocalWeak?.(prompt, modelConfig) || prompt;
      const runnerOutput = await sdk.runAgentStreamTurn({
        model: sdk.getActiveModel(),
        system: streamPrompt.system,
        messages: streamPrompt.messages,
        tools: useToolLoop ? tools : undefined,
        maxSteps: turnMaxSteps,
        maxTokens: turnMaxTokens,
        synthesisMaxTokens,
        temperature: modelConfig.temperature ?? 0.2,
        topP: modelConfig.topP ?? 0.85,
        needsVm: useToolLoop,
        toolCalling: toolCallingMode,
        activeToolNames: sentActiveToolNames,
        abortSignal,
        onStepFinish(event) {
          agentDebug("step", "onStepFinish", {
            stepNumber: event?.stepNumber,
            finishReason: event?.finishReason,
            toolCalls: event?.toolCalls?.length ?? 0,
            toolResults: event?.toolResults?.length ?? 0,
            textLen: event?.text?.length ?? 0,
          });
        },
        onStreamPart(part) {
          if (nativeToolsMode && NATIVE_TOOL_STREAM_SKIP.has(part.type)) {
            agentDebugStreamPart(part, " (skip UI, native)");
            if ((part.type === "tool-call" || part.type === "tool-input-start") && mdHost) {
              mdHost.hidden = true;
            }
            return;
          }

          const textChunk = sdk.textChunkFromStreamPart(part);
          if (textChunk) {
            if (useToolLoop && needsVm && !toolPhaseSeen) {
              preToolText += textChunk;
              agentDebugStreamPart(part, isLikelyToolPlanText(preToolText) ? " (buffer tool-plan)" : " (buffer pre-tool)");
              return;
            }
            if (useToolLoop && toolPhaseSeen && isLikelyToolPlanText(textChunk)) {
              return;
            }
            sdkAssistantText += textChunk;
            setChatTailIndicator(t("chat.spinner.generating", "Generando respuesta…"));
            showAssistantMessage(bubble);
            mdHost.hidden = false;
            bubble.classList.remove("ba-llm-planning");
            agentDebugStreamPart(part);
            renderer.write(textChunk);
            return;
          }

          const reasoningChunk = sdk.reasoningChunkFromStreamPart(part);
          if (reasoningChunk && !isLikelyToolPlanText(reasoningChunk)) {
            reasoningText += reasoningChunk;
            if (showThinking) {
              appendThinkingChunk(bubble, reasoningChunk);
            }
          }
        },
      });
      const text = runnerOutput?.text || "";

      const runnerText = String(text || "").trim();
      const streamRaw = sdkAssistantText.trim()
        || (runnerText && !isLikelyToolPlanText(runnerText) ? runnerText : "")
        || preToolText.trim();
      const streamFollowUp = pickFinalAssistantText(streamRaw, lastToolUi);
      const streamIsToolPlan = isLikelyToolPlanText(streamRaw);

      agentDebug("end", "runAgentStreamTurn fin", {
        streamFollowUpLen: streamFollowUp.length,
        streamFollowUpSample: streamFollowUp.slice(0, 220),
        toolPhaseSeen,
        streamWasToolPlan: streamIsToolPlan,
        hasLastToolUi: Boolean(lastToolUi),
        answerLen: lastToolUi?.answer?.length ?? 0,
      });

      const renderedStreamText = sdkAssistantText.trim();
      const canKeepStreamedBubble = Boolean(renderedStreamText) && !isLikelyToolPlanText(renderedStreamText);
      const finalText = streamFollowUp
        || (toolPhaseSeen && lastToolUi?.answer ? lastToolUi.answer : "")
        || (toolPhaseSeen && lastToolUi?.toolResult && !lastToolUi.toolResult.ok
          ? t("chat.error.toolFailed", "No se pudo completar la tool: {error}", { error: lastToolUi.toolResult.stderr || lastToolUi.toolResult.summary || "error" })
          : "");

      if (canKeepStreamedBubble) {
        renderer.end();
        agentDebug("ui", "keepStreamedBubble", { len: renderedStreamText.length });
      } else if (finalText && !isLikelyToolPlanText(finalText)) {
        showAssistantMessage(bubble);
        flushAssistantBubbleText(bubble, mdHost, renderer, finalText);
        agentDebug("ui", "flushAssistantBubbleText", { len: finalText.length });
      } else {
        hidePlanningShell(bubble);
        removeAssistantMessage(bubble);
      }

      if (canKeepStreamedBubble || (finalText && !isLikelyToolPlanText(finalText))) {
        // La respuesta ya quedó renderizada incrementalmente en la burbuja original.
      } else {
        const fallback = buildEmptyResponseMessage({
          modelConfig,
          reasoningText,
          showThinking,
          streamIsToolPlan,
          toolPhaseSeen,
          runnerInfo: runnerOutput,
        });
        agentDebug("ui", "chat vacío → aviso", {
          modelId: modelConfig?.id,
          finishReason: runnerOutput?.finishReason,
          reasoningChars: reasoningText.length,
          streamIsToolPlan,
          hadToolWork: runnerOutput?.hadToolWork,
        });
        await appendFinalAgentBubble(fallback);
      }

      return {
        text: streamFollowUp,
        lastToolUi,
      };
    } finally {
      clearChatTailIndicator();
      bubble?.setAttribute("aria-busy", "false");
      window.BA_LLM_RESOURCE_GOVERNOR?.finish?.("llm");
    }
  }

  async function handleUserMessage(userText) {
    const llm = window.BA_LLM;
    if (!isModelReady()) {
      addMessage("agent", t("chat.msg.loadModelFirst", "Carga primero un modelo real desde el panel LLM. Puede ser Transformers.js local o un modelo Ollama disponible en el host."));
      updateChatAvailability?.();
      return;
    }

    if (llm.generating) {
      stopActiveTurn();
      return;
    }

    if (!window.BA_LLM_RESOURCE_GOVERNOR?.canStart?.("llm")) {
      addMessage("agent", t("chat.msg.busyTryLater", "Hay una operación LLM/herramienta activa o la VM está ocupada. Espera a que termine antes de enviar otra petición."));
      updateChatAvailability?.();
      return;
    }

    stopRequested = false;
    const turnGeneration = activeTurnGeneration + 1;
    activeTurnGeneration = turnGeneration;
    agentDebug("turn", "handleUserMessage inicio", { userText, turnGeneration });
    llm.generating = true;
    const turnAbort = new AbortController();
    activeTurnAbortController = turnAbort;
    // No usar setAgentBusy aquí: bloquea assertVmToolPreconditions y las tools serial1 del agente.
    updateChatAvailability?.();
    window.BA_LLM_EVENTS?.emit("status", { text: t("chat.status.agentWorking", "Agente trabajando…"), tone: "warn" });

    try {
      window.BA_LLM_EVENTS?.emit("status", { text: t("chat.status.generating", "Generando…"), tone: "warn" });

      const { text, lastToolUi } = await runAgentTurn({
        userText,
        source: "agent",
        abortSignal: turnAbort.signal,
        turnGeneration,
      });

      if (isStaleTurn(turnGeneration)) return;

      llm.messages.push({ role: "user", content: userText });
      llm.messages.push({
        role: "assistant",
        content: text || lastToolUi?.answer || "",
      });
      llm.messages = llm.messages.slice(-8);

      window.BA_LLM_EVENTS?.emit("status", { text: lastToolUi ? t("chat.status.toolExecuted", "Herramienta ejecutada") : t("chat.status.localModelReady", "Modelo local listo"), tone: "good" });
    } catch (error) {
      if (isAbortError(error) || isStaleTurn(turnGeneration)) {
        if (!stopRequested) {
          addMessage("agent", t("chat.msg.cancelled", "Operación cancelada."));
          window.BA_LLM_EVENTS?.emit("status", { text: t("chat.status.cancelled", "Operación cancelada"), tone: "warn" });
        }
        return;
      }
      const message = flattenErrorMessage(error);
      const bubble = createAssistantMessageShell("ba-llm-error");
      const renderer = await window.BA_createMarkdownStreamRenderer(bubble);
      const recovery = isRecoverableGpuMemoryError(message)
        ? t("chat.error.gpuRecovery", "\n\nLa GPU se ha quedado sin memoria o en estado inválido. He descargado el modelo y el worker. Recarga la página si el error persiste; prueba «solo chat» (tools desactivadas) o para la VM antes de cargar el LLM.")
        : "";
      renderer.write(t("chat.error.llmTools", "⚠️ Error LLM/tools: {message}{recovery}", { message, recovery }));
      renderer.end();
      llm.lastError = message;
      if (isRecoverableGpuMemoryError(message)) {
        window.BA_LLM_RESOURCE_GOVERNOR?.markGpuMemoryPressure?.();
        window.BA_AISDK?.abortActive?.();
        unloadModel();
      }
      window.BA_LLM_EVENTS?.emit("status", { text: t("chat.status.errorLlmTools", "Error LLM/tools"), tone: "bad" });
    } finally {
      if (activeTurnGeneration === turnGeneration) {
        activeTurnAbortController = null;
        llm.generating = false;
        updateChatAvailability?.();
      }
    }
  }

  function clearHistory() {
    window.BA_LLM.messages = [];
    window.BA_LLM.lastContextInspect = null;
    window.BA_LLM_ARTIFACTS?.clear?.();

    const log = document.getElementById("chat-log");
    if (log) log.replaceChildren();

    window.BA_LLM_EVENTS?.emit("context", {});
    window.BA_LLM_EVENTS?.emit("resource", {});
    window.BA_LLM_EVENTS?.emit("status", { text: t("chat.status.historyCleared", "Chat visible, historial LLM y artefactos limpiados"), tone: "good" });
    updateChatAvailability?.();
  }

  function unloadModel() {
    window.BA_AISDK?.abortActive?.();
    window.BA_AISDK?.unloadModel?.();
    window.BA_LLM.loaded = false;
    window.BA_LLM.loading = false;
    window.BA_LLM.generating = false;
    window.BA_LLM.aiModelReady = false;
    window.BA_LLM.activeModel = null;
    updateChatAvailability?.();
    window.BA_LLM_EVENTS?.emit("status", { text: t("chat.status.modelUnloaded", "modelo descargado"), tone: "warn" });
  }

  function setChatSubmitStopMode(submit, isStop) {
    if (!submit) return;
    if (isStop) {
      submit.type = "button";
      submit.classList.add("is-stop");
      submit.setAttribute("aria-label", t("chat.submit.stop.aria", "Detener generación o ejecución de tool"));
      submit.title = t("chat.submit.stop.title", "Detener (cancela inferencia o tool en curso)");
      submit.textContent = t("chat.submit.stop.label", "Detener");
      submit.disabled = false;
      return;
    }
    submit.type = "submit";
    submit.classList.remove("is-stop");
    submit.setAttribute("aria-label", t("chat.submit.send.aria", "Enviar mensaje"));
    submit.title = t("chat.submit.send.title", "Enviar mensaje (Enter)");
    submit.textContent = t("chat.submit.send.label", "Enviar");
  }

  function updateChatAvailability() {
    const input = document.getElementById("chat-input");
    const submit = document.getElementById("chat-submit-btn");
    const llm = window.BA_LLM;
    const governor = window.BA_LLM_RESOURCE_GOVERNOR?.getSnapshot?.();
    const busy = isChatOperationActive();
    const canSend = Boolean(
      isModelReady()
      && !busy
      && !llm.loading
      && !state.agentBusy
    );

    if (input) {
      input.disabled = !canSend;
      input.placeholder = canSend
        ? t("chat.placeholder.ask", "Pregunta al modelo…")
        : (busy
          ? t("chat.placeholder.pressStop", "Pulsa Detener para cancelar la operación en curso…")
          : (llm?.loaded ? t("chat.placeholder.waitOperation", "Espera a que termine la operación actual…") : t("chat.placeholder.loadModel", "Carga primero un modelo en el panel LLM")));
      if (!canSend && input.value === "muestra el kernel") input.value = "";
    }
    if (submit) {
      if (busy) setChatSubmitStopMode(submit, true);
      else {
        setChatSubmitStopMode(submit, false);
        submit.disabled = !canSend;
      }
    }
  }

  window.BA_LLM_AGENT = {
    getSelectedModelConfig,
    loadSelectedModel,
    handleUserMessage,
    clearHistory,
    unloadModel,
    updateChatAvailability,
    isModelReady,
    isChatOperationActive,
    stopActiveTurn,
  };

  if (!window.__BA_CHAT_AVAIL_BOUND) {
    window.__BA_CHAT_AVAIL_BOUND = true;
    window.addEventListener("ba-llm:resource", () => updateChatAvailability());
    window.addEventListener("ba:langchange", () => updateChatAvailability());
  }

  bindChatSubmitButton();
  window.requestAnimationFrame(updateChatAvailability);
})();
