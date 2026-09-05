import { t, tn } from "../../app/i18n";
import { state } from "../../app/state";
import { showBaModalPanel } from "../../ui/modal";
import { getSelectedProfile, type VmProfile } from "../../vm/profile-config";
import {
  defaultModelConfig,
  getLlmState,
  getSelectedLlmModel,
  llmModelShortLabel,
  type LlmModelConfig,
} from "../state/chat-state";
import { llmNativeToolsPolicy, type NativeToolsPolicyApi } from "../tools/native-tools-policy";
import { llmToolExecutor } from "../tools/tool-executor";
import { llmToolRegistry } from "../tools/tool-registry";
import type { ToolMetadata } from "../tools/types";
import { createTextElement, eventTargetElement, isRecord, textValue } from "./dom-utils";
import { ensureLlmState } from "./state-utils";

interface NativeToolsPickerState {
  model: LlmModelConfig;
  profileId: string;
  max: number;
  active: Set<string>;
  available: ToolMetadata[];
  policy: NativeToolsPolicyApi | null;
}

function isVmProfile(value: unknown): value is VmProfile {
  return isRecord(value) && typeof value.id === "string";
}

function selectedProfileIdFromDom(): string {
  const profile = document.getElementById("vm-profile");
  return profile instanceof HTMLSelectElement ? profile.value : "";
}

function getActiveToolProfileId(): string {
  if (isRecord(state.activeRuntime) && isRecord(state.activeRuntime.profile)) {
    const id = textValue(state.activeRuntime.profile.id);
    if (id) return id;
  }
  return getSelectedProfile()?.id || selectedProfileIdFromDom();
}

function getActiveToolProfileLabel(profileId: string): string {
  const profile = state.profiles.filter(isVmProfile).find((item) => item.id === profileId);
  return profile?.name || profileId || t("vm.profile.none");
}

function getSelectedModelForTools(): LlmModelConfig {
  const llm = getLlmState();
  return getSelectedLlmModel() || llm?.activeModel || defaultModelConfig("transformersjs", "");
}

function getNativeToolsPickerState(): NativeToolsPickerState {
  const policy = llmNativeToolsPolicy;
  const model = getSelectedModelForTools();
  const profileId = getActiveToolProfileId();
  if (!policy) return { model, profileId, max: 0, active: new Set(), available: [], policy: null };
  const max = policy.getMaxNativeTools(model);
  const available = llmToolRegistry?.listTools({ profileId }) || [];
  const active = new Set(policy.resolveActiveToolNames(model, profileId));
  return { model, profileId, max, active, available, policy };
}

function nativeToolsHintText(model: LlmModelConfig, activeCount: number, max: number): string {
  if (!activeCount) return t("panel.llm.tools.noneSelected");
  const label = llmModelShortLabel(model);
  return model.agent?.toolCalling === "weak"
    ? tn("panel.llm.tools.hintWeak", activeCount, { label, max })
    : tn("panel.llm.tools.hintStrong", activeCount, { label, max });
}

export function updateNativeToolsPickerUi(): void {
  const picker = document.getElementById("ba-chat-tools-picker");
  const hint = document.getElementById("ba-chat-tools-hint");
  if (!picker) {
    updateChatToolsButton();
    return;
  }
  const previousGrid = picker.querySelector<HTMLElement>(".ba-llm-native-tools-grid");
  const previousScrollTop = previousGrid?.scrollTop ?? 0;
  const focusedTool = document.activeElement instanceof Element
    ? document.activeElement.getAttribute("data-tool") || ""
    : "";

  const { model, max, active, available, policy } = getNativeToolsPickerState();
  if (!policy) {
    picker.replaceChildren(createTextElement("small", "", t("panel.llm.tools.policyNotLoaded")));
    updateChatToolsButton();
    return;
  }

  if (hint) hint.textContent = nativeToolsHintText(model, active.size, max);

  const head = document.createElement("div");
  head.className = "ba-llm-native-tools-head";
  const title = document.createElement("strong");
  title.textContent = t("panel.llm.tools.inLoop");
  const count = document.createElement("span");
  count.className = "ba-native-tools-count";
  count.dataset.nativeToolsCount = "";
  count.textContent = `${active.size}/${max}`;
  head.append(title, count);

  const grid = document.createElement("div");
  grid.className = "ba-llm-native-tools-grid ba-llm-native-tools-grid--modal";
  if (available.length) {
    for (const tool of available) {
      const isActive = active.has(tool.name);
      const atMax = active.size >= max && !isActive;
      const row = document.createElement("label");
      row.className = `ba-llm-native-tool-row${atMax ? " is-disabled" : ""}`;
      row.title = tool.label || tool.name;

      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.tool = tool.name;
      input.checked = isActive;
      input.disabled = atMax;

      const name = createTextElement("span", "ba-llm-native-tool-name", tool.name);
      const meta = createTextElement("span", "ba-llm-native-tool-meta", t("panel.llm.tools.levelShort", { level: tool.riskLevel }));
      row.append(input, name, meta);
      grid.appendChild(row);
    }
  } else {
    grid.appendChild(createTextElement("small", "", t("panel.llm.tools.noneForProfile")));
  }

  if (picker.dataset.nativeToolsPickerBound !== "1") {
    picker.dataset.nativeToolsPickerBound = "1";
    picker.addEventListener("change", (event) => {
      const input = eventTargetElement(event)?.closest<HTMLInputElement>("input[data-tool]");
      if (!input || !picker.contains(input)) return;
      const next = getNativeToolsPickerState();
      next.policy?.toggleToolName(next.model, input.getAttribute("data-tool") || "", input.checked, next.profileId);
      updateNativeToolsPickerUi();
    });
  }

  picker.replaceChildren(head, grid);
  const nextGrid = picker.querySelector<HTMLElement>(".ba-llm-native-tools-grid");
  if (nextGrid) {
    nextGrid.scrollTop = previousScrollTop;
    window.requestAnimationFrame(() => {
      nextGrid.scrollTop = previousScrollTop;
      if (focusedTool) {
        picker.querySelector<HTMLElement>(`input[data-tool="${CSS.escape(focusedTool)}"]`)?.focus({ preventScroll: true });
      }
    });
  }
  updateChatToolsButton();
}

export function updateChatToolsButton(): void {
  const button = document.getElementById("chat-tools-btn");
  const badge = document.getElementById("chat-tools-badge");
  if (!button) return;

  const { model, max, active, policy } = getNativeToolsPickerState();
  const activeCount = active.size;
  const label = llmModelShortLabel(model);
  if (badge) {
    badge.textContent = activeCount ? String(activeCount) : "";
    badge.hidden = !activeCount;
    badge.setAttribute("aria-hidden", activeCount ? "false" : "true");
  }
  button.title = !policy
    ? t("panel.llm.toolsBtn.policyNotLoaded")
    : (activeCount
      ? tn("panel.llm.toolsBtn.active", activeCount, { max, label })
      : t("panel.llm.toolsBtn.none", { max, label }));
  button.setAttribute("aria-label", button.title);
}

export function openChatToolsModal(): void {
  void showBaModalPanel({
    title: t("panel.llm.toolsModal.title"),
    onMount(bodyEl) {
      const hint = document.createElement("small");
      hint.id = "ba-chat-tools-hint";
      hint.className = "ba-llm-note ba-chat-tools-hint";
      const picker = document.createElement("div");
      picker.id = "ba-chat-tools-picker";
      picker.className = "ba-llm-native-tools-picker ba-llm-native-tools-picker--modal";
      bodyEl.replaceChildren(hint, picker);
      updateNativeToolsPickerUi();
    },
    buttons: [{ id: "close", label: t("common.done"), variant: "primary" }],
  });
}

export function updateAvailableToolsUi(): void {
  const box = document.getElementById("ba-llm-tool-list");
  if (!box) return;
  const countBadge = document.getElementById("ba-llm-tool-count");
  if (!llmToolRegistry?.listTools) {
    if (countBadge) countBadge.textContent = "—";
    const title = document.createElement("b");
    title.textContent = t("panel.llm.tools.available");
    box.replaceChildren(title, createTextElement("span", "", t("panel.llm.tools.registryUnavailable")));
    return;
  }

  const profileId = getActiveToolProfileId();
  const profileLabel = getActiveToolProfileLabel(profileId);
  const tools = llmToolRegistry.listTools({ profileId });
  if (countBadge) {
    countBadge.textContent = tn("panel.llm.tools.count", tools.length);
    countBadge.title = t("panel.llm.tools.availableForTitle", { profile: profileLabel });
  }
  const title = document.createElement("b");
  title.textContent = t("panel.llm.tools.availableFor", { profile: profileLabel });
  const children: HTMLElement[] = [title];
  for (const tool of tools) {
    const chip = createTextElement("span", "", t("common.levelChip", { name: tool.name, level: tool.riskLevel }));
    chip.title = t("common.levelChip", { name: tool.label || tool.name, level: tool.riskLevel });
    children.push(chip);
  }
  if (!tools.length) children.push(createTextElement("span", "", t("panel.llm.tools.noneAvailableForProfile")));
  box.replaceChildren(...children);
}

export function syncToolPolicyUi(): void {
  const select = document.getElementById("ba-llm-tool-autonomy");
  const detail = document.getElementById("ba-llm-tool-autonomy-detail");
  if (!(select instanceof HTMLSelectElement)) return;
  const value = String(llmToolExecutor.getAutonomyMaxLevel() ?? ensureLlmState().settings.toolAutonomyMaxLevel ?? 1);
  if (select.value !== value) select.value = value;
  const level = llmToolRegistry.SECURITY_LEVELS.find((item) => String(item.level) === value);
  if (detail) detail.textContent = level?.description || t("panel.llm.toolPolicy.defaultDetail");
}
