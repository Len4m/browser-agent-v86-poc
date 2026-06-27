import { t } from "../../app/i18n";
import { appEvents } from "../../core/events";

const BOTTOM_TOLERANCE_PX = 64;
const FOLLOW_BUTTON_INSET_PX = 12;

interface ChatScrollState {
  button: HTMLButtonElement;
  paused: boolean;
}

const states = new WeakMap<HTMLElement, ChatScrollState>();
let followButtonLanguageListenerRegistered = false;

function applyFollowButtonLabels(button: HTMLButtonElement): void {
  const label = t("chat.follow.label");
  button.title = label;
  button.setAttribute("aria-label", label);
}

function ensureFollowButtonLanguageListener(): void {
  if (followButtonLanguageListenerRegistered) return;
  followButtonLanguageListenerRegistered = true;
  appEvents.on("app:language-changed", () => {
    document.querySelectorAll<HTMLButtonElement>(".ba-chat-follow-button").forEach(applyFollowButtonLabels);
  });
}

function isNearBottom(log: HTMLElement): boolean {
  return log.scrollHeight - log.scrollTop - log.clientHeight <= BOTTOM_TOLERANCE_PX;
}

function placeButton(log: HTMLElement, button: HTMLButtonElement): void {
  const rect = log.getBoundingClientRect();
  button.style.left = `${rect.left + rect.width / 2}px`;
  button.style.top = `${rect.bottom - FOLLOW_BUTTON_INSET_PX}px`;
}

function updateButton(log: HTMLElement, state: ChatScrollState): void {
  const show = state.paused && !isNearBottom(log);
  state.button.hidden = !show;
  if (show) placeButton(log, state.button);
}

function setupChatScroll(log: HTMLElement): ChatScrollState {
  const existing = states.get(log);
  if (existing) return existing;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ba-chat-follow-button";
  button.textContent = "\u2193";
  applyFollowButtonLabels(button);
  ensureFollowButtonLanguageListener();
  button.hidden = true;

  const state: ChatScrollState = { button, paused: false };
  button.addEventListener("click", () => {
    state.paused = false;
    log.scrollTop = log.scrollHeight;
    updateButton(log, state);
  });
  log.addEventListener("scroll", () => {
    state.paused = !isNearBottom(log);
    updateButton(log, state);
  }, { passive: true });
  window.addEventListener("resize", () => updateButton(log, state), { passive: true });
  window.addEventListener("scroll", () => updateButton(log, state), { passive: true });
  document.body.appendChild(button);
  states.set(log, state);
  return state;
}

function resolveChatLog(target: Element | null | undefined): HTMLElement | null {
  if (!target) return null;
  if (target instanceof HTMLElement && target.classList.contains("chat-log")) return target;
  return target.closest<HTMLElement>(".chat-log");
}

export function scrollChatLogToBottom(target: Element | null | undefined, force = false): void {
  const log = resolveChatLog(target);
  if (!log) return;
  const state = setupChatScroll(log);
  if (force || !state.paused || isNearBottom(log)) {
    state.paused = false;
    log.scrollTop = log.scrollHeight;
  }
  updateButton(log, state);
}
