import {
  defaultProfile,
  validateProfile,
} from "../models/model-profiles";
import type {
  LlmUserProfile,
  OllamaThinkMode,
  ToolCallingQuality,
  ToolStrategy,
} from "../models/model-types";
import { llmAgent } from "../runtime/agent-loop";
import {
  registerModelProfile,
  selectLlmModel,
  type LlmModelConfig,
} from "../state/chat-state";
import { inputById, selectById, textValue } from "./dom-utils";
import { ensureLlmState, getSelectedModel } from "./state-utils";

interface ProfileControlsHooks {
  setStatus: (text: string, tone?: string) => void;
  onModelChanged: (config: LlmModelConfig) => void;
}

export interface ProfileControls {
  bind: () => void;
  sync: (config?: LlmModelConfig) => void;
}

function numericInput(id: string, fallback: number): number {
  const value = Number(inputById(id)?.value);
  return Number.isFinite(value) ? value : fallback;
}

export function createProfileControls(hooks: ProfileControlsHooks): ProfileControls {
  function sync(config = getSelectedModel()): void {
    const profile = config.profile;
    if (!profile) return;
    const setValue = (id: string, value: unknown): void => {
      const element = document.getElementById(id);
      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) element.value = textValue(value);
    };
    setValue("ba-llm-tool-strategy", profile.toolStrategy);
    setValue("ba-llm-tool-calling", profile.toolCalling);
    setValue("ba-llm-max-steps", profile.maxSteps);
    setValue("ba-llm-max-tools", profile.maxNativeTools);
    setValue("ba-llm-temperature", profile.temperature);
    setValue("ba-llm-top-p", profile.topP);
    setValue("ba-llm-context-window", profile.contextWindowTokens);
    setValue("ba-llm-safe-input", profile.safeInputTokens);
    setValue("ba-llm-max-output", profile.maxOutputTokens);
    setValue("ba-llm-max-plan", profile.maxNewTokensForPlan);
    setValue("ba-llm-device", profile.device || "auto");

    const dtype = selectById("ba-llm-dtype");
    if (dtype) {
      const dtypes = ["auto", profile.dtype, ...(config.inspection?.availableDtypes || [])]
        .filter((value): value is string => Boolean(value));
      dtype.replaceChildren(...[...new Set(dtypes)].map((value) => new Option(value, value)));
      dtype.value = profile.dtype || "auto";
    }

    const think = selectById("ba-llm-think-mode");
    if (think) {
      const options = profile.engine === "ollama"
        ? ["auto", "off", "on", "low", "medium", "high", "max"]
        : ["off", "on"];
      think.replaceChildren(...options.map((value) => new Option(value, value)));
      think.value = profile.engine === "ollama"
        ? profile.ollamaThink || "auto"
        : (profile.transformersThinking?.enabled ? "on" : "off");
    }

    const setChecked = (id: string, value: boolean): void => {
      const input = inputById(id);
      if (input) input.checked = value;
    };
    setChecked("ba-llm-show-thinking", profile.showThinking);
    setChecked("ba-llm-reuse-cache", Boolean(profile.reuseGenerationCache));
    setChecked("ba-llm-start-reasoning", Boolean(profile.transformersThinking?.startWithReasoning));
    setValue("ba-llm-thinking-tag", profile.transformersThinking?.tagName || "think");
    for (const id of ["ba-llm-device-wrap", "ba-llm-dtype-wrap", "ba-llm-cache-wrap", "ba-llm-tag-wrap", "ba-llm-reasoning-start-wrap"]) {
      const element = document.getElementById(id);
      if (element instanceof HTMLElement) element.hidden = profile.engine !== "transformersjs";
    }
  }

  function fromUi(config: LlmModelConfig): LlmUserProfile | null {
    const current = config.profile || defaultProfile(config.engine, config.model || "");
    const thinkMode = selectById("ba-llm-think-mode")?.value || "off";
    return validateProfile({
      ...current,
      toolStrategy: selectById("ba-llm-tool-strategy")?.value as ToolStrategy,
      toolCalling: selectById("ba-llm-tool-calling")?.value as ToolCallingQuality,
      maxSteps: numericInput("ba-llm-max-steps", current.maxSteps),
      maxNativeTools: numericInput("ba-llm-max-tools", current.maxNativeTools),
      temperature: numericInput("ba-llm-temperature", current.temperature),
      topP: numericInput("ba-llm-top-p", current.topP),
      contextWindowTokens: numericInput("ba-llm-context-window", current.contextWindowTokens),
      safeInputTokens: numericInput("ba-llm-safe-input", current.safeInputTokens),
      maxOutputTokens: numericInput("ba-llm-max-output", current.maxOutputTokens),
      maxNewTokensForPlan: numericInput("ba-llm-max-plan", current.maxNewTokensForPlan),
      showThinking: Boolean(inputById("ba-llm-show-thinking")?.checked),
      device: selectById("ba-llm-device")?.value || "auto",
      dtype: selectById("ba-llm-dtype")?.value || "auto",
      reuseGenerationCache: Boolean(inputById("ba-llm-reuse-cache")?.checked),
      transformersThinking: current.engine === "transformersjs" ? {
        enabled: thinkMode === "on",
        tagName: inputById("ba-llm-thinking-tag")?.value.trim() || "think",
        startWithReasoning: Boolean(inputById("ba-llm-start-reasoning")?.checked),
      } : undefined,
      ollamaThink: current.engine === "ollama" ? thinkMode as OllamaThinkMode : undefined,
    });
  }

  function saveFromUi(): void {
    const current = getSelectedModel();
    const profile = fromUi(current);
    if (!profile) {
      hooks.setStatus("Invalid model profile", "bad");
      return;
    }
    if (ensureLlmState().loaded) llmAgent.unloadModel();
    const config = registerModelProfile(profile, current.inspection || null);
    selectLlmModel(config);
    hooks.onModelChanged(config);
  }

  function reset(): void {
    const current = getSelectedModel();
    const profile = defaultProfile(current.engine, current.model || "");
    const config = registerModelProfile(profile, current.inspection || null);
    selectLlmModel(config);
    sync(config);
    hooks.onModelChanged(config);
  }

  function bind(): void {
    const ids = [
      "ba-llm-tool-strategy", "ba-llm-tool-calling", "ba-llm-max-steps", "ba-llm-max-tools",
      "ba-llm-think-mode", "ba-llm-show-thinking", "ba-llm-temperature", "ba-llm-top-p",
      "ba-llm-context-window", "ba-llm-safe-input", "ba-llm-max-output", "ba-llm-max-plan",
      "ba-llm-device", "ba-llm-dtype", "ba-llm-reuse-cache", "ba-llm-thinking-tag", "ba-llm-start-reasoning",
    ];
    for (const id of ids) document.getElementById(id)?.addEventListener("change", saveFromUi);
    document.getElementById("ba-llm-profile-reset")?.addEventListener("click", reset);
  }

  return { bind, sync };
}
