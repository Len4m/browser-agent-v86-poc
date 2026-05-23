// @ts-nocheck
// Browser Agent v86 - 17b native tools policy
// Per-model caps on how many AI SDK tools are registered (VRAM). User picks subset in panel.

(function initLLMNativeToolsPolicy() {
  const STORAGE_PREFIX = "ba.llm.nativeTools.";

  function getProfileId() {
    const stateProfile = window.state?.activeRuntime?.profile?.id;
    if (stateProfile && stateProfile !== "manual") return stateProfile;
    return document.getElementById("vm-profile")?.value || "manual";
  }

  function getModelConfig(modelConfig) {
    return modelConfig
      || window.BA_LLM?.activeModel
      || window.BA_LLM_MODELS?.find((m) => m.id === window.BA_LLM?.selectedModelId)
      || window.BA_LLM_MODELS?.[0]
      || { id: "custom-transformersjs", agent: { maxNativeTools: 4 } };
  }

  function getMaxNativeTools(modelConfig) {
    const agent = getModelConfig(modelConfig)?.agent || {};
    const max = Number(agent.maxNativeTools);
    if (Number.isFinite(max) && max > 0) return Math.min(12, Math.floor(max));
    return 4;
  }

  function listAvailableToolNames(modelConfig, profileId = getProfileId()) {
    return (window.BA_LLM_TOOL_REGISTRY?.listTools?.({ profileId }) || []).map((t) => t.name);
  }

  function getDefaultToolNames(modelConfig, profileId = getProfileId()) {
    const agent = getModelConfig(modelConfig)?.agent || {};
    const available = new Set(listAvailableToolNames(modelConfig, profileId));
    const fromModel = Array.isArray(agent.defaultNativeTools) ? agent.defaultNativeTools : [];
    const picked = fromModel.filter((n) => available.has(n));
    if (picked.length) return picked.slice(0, getMaxNativeTools(modelConfig));

    const fallback = [
      "vm.fs.list",
      "vm.fs.read",
      "vm.sys.info",
      "vm.tmux.status",
      "vm.cmd.which",
      "net.ip.status",
      "web.curl.head",
    ];
    return fallback.filter((n) => available.has(n)).slice(0, getMaxNativeTools(modelConfig));
  }

  function loadStored(modelId) {
    try {
      const raw = localStorage.getItem(`${STORAGE_PREFIX}${modelId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : null;
    } catch {
      return null;
    }
  }

  function saveStored(modelId, names) {
    localStorage.setItem(`${STORAGE_PREFIX}${modelId}`, JSON.stringify(names));
  }

  function resolveActiveToolNames(modelConfig, profileId = getProfileId()) {
    const cfg = getModelConfig(modelConfig);
    const max = getMaxNativeTools(cfg);
    const available = new Set(listAvailableToolNames(cfg, profileId));
    const stored = loadStored(cfg.id);
    const defaults = getDefaultToolNames(cfg, profileId);
    const source = stored !== null ? stored : defaults;
    let chosen = source.filter((n) => available.has(n));
    if (!chosen.length && stored === null) chosen = defaults.filter((n) => available.has(n));
    const out = chosen.slice(0, max);
    if (window.BA_LLM?.settings) window.BA_LLM.settings.nativeToolNames = out;
    return out;
  }

  function setActiveToolNames(modelConfig, names, profileId = getProfileId()) {
    const cfg = getModelConfig(modelConfig);
    const max = getMaxNativeTools(cfg);
    const available = new Set(listAvailableToolNames(cfg, profileId));
    const clean = [...new Set((names || []).filter((n) => available.has(n)))].slice(0, max);
    saveStored(cfg.id, clean);
    if (window.BA_LLM?.settings) window.BA_LLM.settings.nativeToolNames = clean;
    window.BA_LLM_EVENTS?.emit("native-tools", { names: clean, max, modelId: cfg.id });
    return clean;
  }

  function toggleToolName(modelConfig, name, enabled, profileId = getProfileId()) {
    const cfg = getModelConfig(modelConfig);
    const max = getMaxNativeTools(cfg);
    const current = resolveActiveToolNames(cfg, profileId);
    let next;
    if (enabled) {
      if (current.includes(name)) return current;
      if (current.length >= max) return current;
      next = [...current, name];
    } else {
      next = current.filter((n) => n !== name);
    }
    return setActiveToolNames(cfg, next, profileId);
  }

  window.BA_LLM_NATIVE_TOOLS = {
    getMaxNativeTools,
    getDefaultToolNames,
    resolveActiveToolNames,
    setActiveToolNames,
    toggleToolName,
    listAvailableToolNames,
  };
})();
