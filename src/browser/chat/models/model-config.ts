import type { LlmUserProfile } from "./model-types";
import type { LlmModelConfig } from "../state/chat-state";

function runtimeProfile(config: LlmModelConfig): LlmUserProfile | null {
  return config.profile || null;
}

export function requiresLlmRuntimeReload(current: LlmModelConfig, next: LlmModelConfig): boolean {
  if (current.engine !== next.engine || current.model !== next.model) return true;
  const currentProfile = runtimeProfile(current);
  const nextProfile = runtimeProfile(next);
  if (current.engine === "ollama") {
    return (currentProfile?.ollamaThink ?? current.thinking?.generate)
      !== (nextProfile?.ollamaThink ?? next.thinking?.generate);
  }
  const currentThinking = currentProfile?.transformersThinking;
  const nextThinking = nextProfile?.transformersThinking;
  const thinkingChanged = currentThinking?.enabled !== nextThinking?.enabled
    || Boolean(nextThinking?.enabled && (
      currentThinking?.tagName !== nextThinking.tagName
      || currentThinking?.startWithReasoning !== nextThinking.startWithReasoning
    ));
  return (currentProfile?.device ?? current.device) !== (nextProfile?.device ?? next.device)
    || (currentProfile?.dtype ?? current.dtype) !== (nextProfile?.dtype ?? next.dtype)
    || (currentProfile?.reuseGenerationCache ?? current.reuseGenerationCache)
      !== (nextProfile?.reuseGenerationCache ?? next.reuseGenerationCache)
    || thinkingChanged;
}

export function resolveTurnModelConfig(
  active: LlmModelConfig,
  selected: LlmModelConfig | null,
): LlmModelConfig {
  if (!selected || active.engine !== selected.engine || active.model !== selected.model) return active;
  return {
    ...active,
    temperature: selected.temperature,
    topP: selected.topP,
    contextWindowTokens: selected.contextWindowTokens,
    contextPolicy: selected.contextPolicy ? { ...selected.contextPolicy } : undefined,
    agent: selected.agent ? {
      ...selected.agent,
      activeToolNames: [...(selected.agent.activeToolNames || [])],
    } : undefined,
    profile: selected.profile ? {
      ...selected.profile,
      activeToolNames: [...selected.profile.activeToolNames],
    } : undefined,
  };
}
