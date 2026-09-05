// Browser Agent v86 - LLM panel GPU capability badges.

import { t } from "../../app/i18n";
import { errorMessage, setDisabled } from "../../app/value-utils";
import { appEvents } from "../../core/events";
import { getLlmState } from "../state/chat-state";

interface CapabilityRecheckOptions {
  checkCapabilities?: (options?: { force?: boolean }) => unknown;
  setStatus?: (text: string, tone: string) => void;
}

interface LlmPanelCapabilitiesApi {
  capabilityRecheckTitle: (currentTitle: unknown) => string;
  decorateCapabilityRecheckBadge: (target: HTMLElement | null) => void;
  decorateCapabilityRecheckBadges: () => void;
  bindCapabilityRecheckBadge: (target: HTMLElement | null, onRecheck?: () => void) => void;
  bindCapabilityRecheckBadges: (onRecheck?: () => void) => void;
  runCapabilityRecheckFromBadge: (options?: CapabilityRecheckOptions) => Promise<void>;
  ensureCapabilitiesWhenPanelOpens: (details: HTMLDetailsElement | null | undefined, options?: CapabilityRecheckOptions) => Promise<void>;
}

function capabilityRecheckTitle(currentTitle: unknown): string {
  const action = t("caps.view.recheckAction");
  const base = typeof currentTitle === "string" ? currentTitle.trim() : "";
  if (!base) return action;
  if (base.includes(action)) return base;
  return `${base} ${action}`;
}

function decorateCapabilityRecheckBadge(target: HTMLElement | null): void {
  if (!target) return;
  target.classList.add("ba-capability-recheck-badge");
  if (target.tagName !== "BUTTON") {
    target.setAttribute("role", "button");
    target.setAttribute("tabindex", "0");
  }
  target.setAttribute("aria-label", t("caps.view.recheckAria"));
  target.title = capabilityRecheckTitle(target.title);
}

function decorateCapabilityRecheckBadges(): void {
  decorateCapabilityRecheckBadge(document.getElementById("badge-gpu"));
}

function bindCapabilityRecheckBadge(target: HTMLElement | null, onRecheck?: () => void): void {
  if (!target || target.dataset.baCapabilityRecheckBound === "1") return;
  target.dataset.baCapabilityRecheckBound = "1";
  target.addEventListener("click", (event) => {
    event.preventDefault();
    onRecheck?.();
  });
  target.addEventListener("keydown", (event) => {
    if (target.tagName === "BUTTON") return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onRecheck?.();
  });
}

function bindCapabilityRecheckBadges(onRecheck?: () => void): void {
  const targets = [
    document.getElementById("badge-gpu"),
  ];
  for (const target of targets) {
    decorateCapabilityRecheckBadge(target);
    bindCapabilityRecheckBadge(target, onRecheck);
  }
}

async function runCapabilityRecheckFromBadge({ checkCapabilities, setStatus }: CapabilityRecheckOptions = {}): Promise<void> {
  const llmState = getLlmState();
  if (llmState?.capabilitiesChecking) return;
  try {
    await checkCapabilities?.({ force: true });
  } catch (error) {
    const latest = getLlmState();
    if (latest) latest.lastError = errorMessage(error);
    setStatus?.(t("caps.view.recheckError"), "bad");
  } finally {
    decorateCapabilityRecheckBadges();
  }
}

async function ensureCapabilitiesWhenPanelOpens(
  details: HTMLDetailsElement | null | undefined,
  { checkCapabilities, setStatus }: CapabilityRecheckOptions = {},
): Promise<void> {
  const llmState = getLlmState();
  if (!details?.open || llmState?.capabilitiesChecked || llmState?.capabilitiesChecking) return;

  const load = document.getElementById("ba-llm-load");
  setDisabled(load, true);

  try {
    await checkCapabilities?.();
  } catch (error) {
    const latest = getLlmState();
    if (latest) latest.lastError = errorMessage(error);
    setStatus?.(t("caps.view.recheckError"), "bad");
  } finally {
    const latest = getLlmState();
    setDisabled(load, Boolean(latest?.loading));
  }
}

appEvents.on("app:language-changed", () => {
  decorateCapabilityRecheckBadges();
});

export const llmPanelCapabilities: LlmPanelCapabilitiesApi = {
  capabilityRecheckTitle,
  decorateCapabilityRecheckBadge,
  decorateCapabilityRecheckBadges,
  bindCapabilityRecheckBadge,
  bindCapabilityRecheckBadges,
  runCapabilityRecheckFromBadge,
  ensureCapabilitiesWhenPanelOpens,
};
