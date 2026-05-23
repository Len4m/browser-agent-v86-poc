// @ts-nocheck
// Browser Agent v86 - 17 LLM tool executor
// v9.37.5: async tool execution coordinator with permission levels.
//
// The VM execution itself must stay on the main thread because it talks to the
// v86 serial adapter and tmux state. It is still non-blocking for the browser:
// execVm returns a Promise and completes from serial events/timeouts. CPU-heavy
// parsing can later move to workers without changing the public API here.

(function initLLMToolExecutor() {
  const STORAGE_KEY = "ba.llm.toolAutonomyMaxLevel";

  function nowId(prefix = "tool") {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function getAutonomyMaxLevel() {
    const fromState = Number(window.BA_LLM?.settings?.toolAutonomyMaxLevel);
    if (Number.isFinite(fromState)) return fromState;
    const stored = Number(localStorage.getItem(STORAGE_KEY) || "1");
    return Number.isFinite(stored) ? stored : 1;
  }

  function setAutonomyMaxLevel(level) {
    const value = Math.max(0, Math.min(99, Number(level) || 0));
    if (window.BA_LLM?.settings) window.BA_LLM.settings.toolAutonomyMaxLevel = value;
    localStorage.setItem(STORAGE_KEY, String(value));
    window.BA_LLM_EVENTS?.emit("tool-policy", { autonomyMaxLevel: value });
    return value;
  }

  function shouldConfirm(toolCall) {
    return Number(toolCall.riskLevel || 0) > getAutonomyMaxLevel();
  }

  function shortJson(value, max = 900) {
    const text = JSON.stringify(value, null, 2);
    return text.length > max ? `${text.slice(0, max)}\n...` : text;
  }

  async function confirmToolCall(toolCall, toolDef) {
    if (!shouldConfirm(toolCall)) return true;
    const decision = await showBaModal({
      title: "Confirmar tool del agente",
      message: `${toolDef.label || toolDef.name} · nivel ${toolDef.riskLevel}`,
      detail: `${toolCall.reason || "Sin motivo."}\n\nArgumentos:\n${shortJson(toolCall.arguments)}`,
      buttons: [
        { id: "cancel", label: "Cancelar", variant: "secondary", cancel: true },
        { id: "run", label: "Ejecutar tool", variant: toolDef.riskLevel >= 3 ? "danger" : "primary" },
      ],
    });
    return decision === "run";
  }

  async function runTool(toolCall, { source = "agent" } = {}) {
    const registry = window.BA_LLM_TOOL_REGISTRY;
    if (!registry) throw new Error("Registro de herramientas no inicializado.");

    const normalized = registry.normalizeToolCall(toolCall);
    const toolDef = registry.getTool(normalized.tool);
    if (!toolDef) throw new Error(`Herramienta no disponible: ${normalized.tool}`);

    if (toolDef.requiresVm || toolDef.requiresTmux) {
      try {
        registry.assertVmToolPreconditions();
      } catch (error) {
        return {
          id: nowId("tool-precondition"),
          ok: false,
          code: 1,
          stdout: "",
          stderr: error?.message || String(error),
          summary: "No se cumplen las precondiciones para ejecutar la herramienta.",
          toolCall: normalized,
        };
      }
    }

    const allowed = await confirmToolCall(normalized, toolDef);
    if (!allowed) {
      return {
        id: nowId("tool-cancelled"),
        ok: false,
        cancelled: true,
        code: 130,
        stdout: "",
        stderr: "Herramienta cancelada por el usuario.",
        summary: "Herramienta cancelada por el usuario.",
        toolCall: normalized,
      };
    }

    const command = toolDef.buildCommand(normalized.arguments);
    const id = nowId("tool-run");
    window.BA_LLM_EVENTS?.emit("tool-start", { id, toolCall: normalized, tool: toolDef, source });
    logTool(`${NL}[agent-tool] ${toolDef.name} nivel=${toolDef.riskLevel} args=${JSON.stringify(normalized.arguments)}${NL}`);

    try {
      const raw = await execVm(command, {
        lock: true,
        label: `Agente ejecutando ${toolDef.label || toolDef.name}…`,
        timeoutMs: toolDef.timeoutMs || 15000,
        maxOutputBytes: toolDef.maxOutputBytes || 32768,
        log: false,
        targetTools: true,
      });
      if (raw?.code === 130) {
        return {
          id,
          ok: false,
          cancelled: true,
          code: 130,
          stdout: raw.stdout || "",
          stderr: raw.stderr || "Tool cancelada.",
          summary: "Tool cancelada por el usuario.",
          toolCall: normalized,
        };
      }
      const result = toolDef.formatResult ? toolDef.formatResult(raw, normalized.arguments) : raw;
      result.id = id;
      result.toolCall = normalized;
      window.BA_LLM_EVENTS?.emit("tool-done", { id, result });
      return result;
    } catch (error) {
      const result = {
        id,
        ok: false,
        code: 1,
        stdout: "",
        stderr: error?.message || String(error),
        summary: `Error ejecutando ${toolDef.name}`,
        toolCall: normalized,
      };
      window.BA_LLM_EVENTS?.emit("tool-error", { id, result });
      return result;
    }
  }

  window.BA_LLM_TOOL_EXECUTOR = {
    getAutonomyMaxLevel,
    setAutonomyMaxLevel,
    runTool,
  };

  // Keep persisted setting synchronized at boot.
  setAutonomyMaxLevel(getAutonomyMaxLevel());
})();
