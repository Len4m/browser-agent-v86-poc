// @ts-nocheck
// Browser Agent v86 - 21 LLM resource governor
// v9.37.8: lightweight resource coordination for running v86 + local LLM in
// the same browser tab.
//
// The current VM execution still runs through the existing main-thread serial
// bridge, but this governor prevents overlapping expensive operations and
// exposes a compact state snapshot for UI/context diagnostics.

(function initLLMResourceGovernor() {
  const stateRef = {
    llmBusy: false,
    toolBusy: false,
    modelLoading: false,
    lastOOMAt: 0,
    lastOperation: "inactiva",
  };

  function emit() {
    window.BA_LLM_EVENTS?.emit("resource", getSnapshot());
  }

  function getSnapshot() {
    const appState = (typeof state !== "undefined") ? state : window.state;
    return {
      ...stateRef,
      vmBusy: Boolean(appState?.pending || appState?.agentBusy),
      backgroundToolBusy: Boolean(appState?.bgTools?.pending),
      artifacts: window.BA_LLM?.artifacts?.length || 0,
      lastArtifactId: window.BA_LLM?.lastArtifactId || null,
    };
  }

  function canStart(kind) {
    const appState = (typeof state !== "undefined") ? state : window.state;
    if (kind === "llm") return !stateRef.llmBusy && !stateRef.toolBusy && !appState?.pending && !appState?.bgTools?.pending;
    if (kind === "tool") return !stateRef.toolBusy && !stateRef.llmBusy && !appState?.pending && !appState?.bgTools?.pending;
    if (kind === "model-load") return !stateRef.llmBusy && !stateRef.toolBusy && !appState?.bgTools?.pending;
    return true;
  }

  function start(kind, label = kind) {
    if (kind === "llm") stateRef.llmBusy = true;
    if (kind === "tool") stateRef.toolBusy = true;
    if (kind === "model-load") stateRef.modelLoading = true;
    stateRef.lastOperation = label;
    emit();
  }

  function finish(kind) {
    if (kind === "llm") stateRef.llmBusy = false;
    if (kind === "tool") stateRef.toolBusy = false;
    if (kind === "model-load") stateRef.modelLoading = false;
    stateRef.lastOperation = "inactiva";
    emit();
  }

  function markGpuMemoryPressure() {
    stateRef.lastOOMAt = Date.now();
    emit();
  }

  /** Libera locks LLM/tool tras cancelación explícita del usuario (no toca model-load). */
  function forceReleaseWork() {
    stateRef.llmBusy = false;
    stateRef.toolBusy = false;
    if (stateRef.lastOperation !== "carga de modelo") stateRef.lastOperation = "inactiva";
    emit();
  }

  window.BA_LLM_RESOURCE_GOVERNOR = {
    getSnapshot,
    canStart,
    start,
    finish,
    markGpuMemoryPressure,
    forceReleaseWork,
  };
})();
