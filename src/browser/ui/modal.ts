// Browser Agent v86 - modal helpers.

import { $ } from "../app/state";
import { t } from "../app/i18n";

interface ModalButton {
  id: string;
  label?: string;
  variant?: string;
  cancel?: boolean;
}

interface ShowModalOptions {
  title?: string;
  message?: string;
  detail?: string;
  buttons?: ModalButton[];
  closeOnBackdrop?: boolean;
  abortSignal?: AbortSignal;
}

interface ShowModalPanelOptions {
  title?: string;
  onMount?: (bodyEl: HTMLElement) => void;
  buttons?: ModalButton[];
  closeOnBackdrop?: boolean;
  abortSignal?: AbortSignal;
}

interface ModalLayoutElements {
  messageEl: HTMLElement | null;
  detailEl: HTMLElement | null;
  bodyEl: HTMLElement | null;
  iconEl: HTMLElement | null;
}

function normalizeModalButtons(buttons: ModalButton[] = []): ModalButton[] {
  return buttons.length ? buttons : [
    { id: "cancel", label: t("common.cancel"), variant: "secondary" },
    { id: "ok", label: t("common.accept"), variant: "primary" },
  ];
}

function resetBaModalLayout({ messageEl, detailEl, bodyEl, iconEl }: ModalLayoutElements): void {
  if (messageEl) messageEl.hidden = false;
  if (detailEl) detailEl.hidden = !detailEl.textContent;
  if (bodyEl) {
    bodyEl.hidden = true;
    bodyEl.replaceChildren();
  }
  if (iconEl) iconEl.hidden = false;
}

function bindBaModalActions(
  actionsEl: HTMLElement,
  normalizedButtons: ModalButton[],
  cleanup: (result: string) => void,
): void {
  actionsEl.replaceChildren();
  for (const button of normalizedButtons) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `ba-modal-button ${button.variant || "secondary"}`;
    el.textContent = button.label || button.id;
    el.addEventListener("click", () => cleanup(button.id));
    actionsEl.appendChild(el);
  }
}

function focusElement(el: Element | null): void {
  if (el instanceof HTMLElement) {
    try {
      el.focus();
    } catch {
      // Focus restoration is best-effort.
    }
  }
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Error";
}

function modalAbortError(signal?: AbortSignal): Error {
  const reason = signal ? signal.reason as unknown : undefined;
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string" && reason
      ? reason
      : "The operation was aborted";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function showBaModal({
  title = t("modal.confirmTitle"),
  message = "",
  detail = "",
  buttons = [],
  closeOnBackdrop = false,
  abortSignal,
}: ShowModalOptions = {}): Promise<string> {
  if (abortSignal?.aborted) return Promise.reject(modalAbortError(abortSignal));

  return new Promise((resolve, reject) => {
    const overlay = $("ba-modal-overlay");
    const titleEl = $("ba-modal-title");
    const messageEl = $("ba-modal-message");
    const detailEl = $("ba-modal-detail");
    const bodyEl = $("ba-modal-body");
    const actionsEl = $("ba-modal-actions");
    const iconEl = overlay?.querySelector<HTMLElement>(".ba-modal-icon") || null;
    const normalizedButtons = normalizeModalButtons(buttons);
    if (!overlay || !titleEl || !messageEl || !detailEl || !actionsEl) {
      const cancelButton = normalizedButtons.find((button) => button.cancel)
        || normalizedButtons.find((button) => button.id === "cancel")
        || normalizedButtons[0];
      const confirmButton = normalizedButtons.find((button) => button !== cancelButton)
        || normalizedButtons.at(-1)
        || cancelButton;
      resolve(window.confirm(`${title}\n\n${message}${detail ? `\n\n${detail}` : ""}`)
        ? confirmButton.id
        : cancelButton.id);
      return;
    }
    const modalOverlay = overlay;
    const modalTitleEl = titleEl;
    const modalMessageEl = messageEl;
    const modalDetailEl = detailEl;
    const modalBodyEl = bodyEl;
    const modalActionsEl = actionsEl;
    const modalIconEl = iconEl;

    let settled = false;
    let focusTimer: number | null = null;
    const previousFocus = document.activeElement;

    function cleanup(result: string, error?: Error): void {
      if (settled) return;
      settled = true;
      modalOverlay.classList.remove("show", "ba-modal-panel-mode");
      modalOverlay.setAttribute("aria-hidden", "true");
      document.removeEventListener("keydown", onKeyDown);
      modalOverlay.removeEventListener("pointerdown", onBackdropPointerDown);
      abortSignal?.removeEventListener("abort", onAbort);
      if (focusTimer !== null) window.clearTimeout(focusTimer);
      resetBaModalLayout({ messageEl: modalMessageEl, detailEl: modalDetailEl, bodyEl: modalBodyEl, iconEl: modalIconEl });
      focusElement(previousFocus);
      if (error) reject(error);
      else resolve(result);
    }

    function onAbort(): void {
      cleanup("cancel", modalAbortError(abortSignal));
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        const cancel = normalizedButtons.find((button) => button.cancel) || normalizedButtons[0];
        cleanup(cancel.id);
      }
    }

    function onBackdropPointerDown(event: PointerEvent): void {
      if (!closeOnBackdrop || event.target !== modalOverlay) return;
      const cancel = normalizedButtons.find((button) => button.cancel) || normalizedButtons[0];
      cleanup(cancel.id);
    }

    modalTitleEl.textContent = title;
    modalMessageEl.textContent = message;
    modalDetailEl.textContent = detail || "";
    resetBaModalLayout({ messageEl: modalMessageEl, detailEl: modalDetailEl, bodyEl: modalBodyEl, iconEl: modalIconEl });
    modalDetailEl.hidden = !detail;
    bindBaModalActions(modalActionsEl, normalizedButtons, cleanup);

    modalOverlay.classList.add("show");
    modalOverlay.setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", onKeyDown);
    modalOverlay.addEventListener("pointerdown", onBackdropPointerDown);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    focusTimer = window.setTimeout(() => {
      const preferred = modalActionsEl.querySelector(".ba-modal-button.danger, .ba-modal-button.primary") || modalActionsEl.querySelector("button");
      focusElement(preferred);
    }, 0);
  });
}

export function showBaModalPanel({
  title = t("modal.panelTitle"),
  onMount,
  buttons = [{ id: "close", label: t("common.done"), variant: "primary" }],
  closeOnBackdrop = true,
  abortSignal,
}: ShowModalPanelOptions = {}): Promise<string> {
  if (abortSignal?.aborted) return Promise.reject(modalAbortError(abortSignal));

  return new Promise((resolve, reject) => {
    const overlay = $("ba-modal-overlay");
    const titleEl = $("ba-modal-title");
    const messageEl = $("ba-modal-message");
    const detailEl = $("ba-modal-detail");
    const bodyEl = $("ba-modal-body");
    const actionsEl = $("ba-modal-actions");
    const iconEl = overlay?.querySelector<HTMLElement>(".ba-modal-icon") || null;
    if (!overlay || !titleEl || !messageEl || !detailEl || !bodyEl || !actionsEl) {
      resolve("close");
      return;
    }
    const modalOverlay = overlay;
    const modalTitleEl = titleEl;
    const modalMessageEl = messageEl;
    const modalDetailEl = detailEl;
    const modalBodyEl = bodyEl;
    const modalActionsEl = actionsEl;
    const modalIconEl = iconEl;

    const normalizedButtons = normalizeModalButtons(buttons);
    let settled = false;
    let focusTimer: number | null = null;
    const previousFocus = document.activeElement;

    function cleanup(result: string, error?: Error): void {
      if (settled) return;
      settled = true;
      modalOverlay.classList.remove("show", "ba-modal-panel-mode");
      modalOverlay.setAttribute("aria-hidden", "true");
      document.removeEventListener("keydown", onKeyDown);
      modalOverlay.removeEventListener("pointerdown", onBackdropPointerDown);
      abortSignal?.removeEventListener("abort", onAbort);
      if (focusTimer !== null) window.clearTimeout(focusTimer);
      resetBaModalLayout({ messageEl: modalMessageEl, detailEl: modalDetailEl, bodyEl: modalBodyEl, iconEl: modalIconEl });
      focusElement(previousFocus);
      if (error) reject(error);
      else resolve(result);
    }

    function onAbort(): void {
      cleanup("close", modalAbortError(abortSignal));
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        const cancel = normalizedButtons.find((button) => button.cancel) || normalizedButtons[0];
        cleanup(cancel.id);
      }
    }

    function onBackdropPointerDown(event: PointerEvent): void {
      if (!closeOnBackdrop || event.target !== modalOverlay) return;
      const cancel = normalizedButtons.find((button) => button.cancel) || normalizedButtons[0];
      cleanup(cancel.id);
    }

    modalTitleEl.textContent = title;
    modalMessageEl.textContent = "";
    modalMessageEl.hidden = true;
    modalDetailEl.textContent = "";
    modalDetailEl.hidden = true;
    modalBodyEl.hidden = false;
    modalBodyEl.replaceChildren();
    if (modalIconEl) modalIconEl.hidden = true;
    bindBaModalActions(modalActionsEl, normalizedButtons, cleanup);

    try {
      onMount?.(modalBodyEl);
    } catch (error) {
      const errorEl = document.createElement("p");
      errorEl.className = "ba-modal-detail";
      errorEl.textContent = messageFromError(error);
      modalBodyEl.replaceChildren(errorEl);
    }

    modalOverlay.classList.add("show", "ba-modal-panel-mode");
    modalOverlay.setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", onKeyDown);
    modalOverlay.addEventListener("pointerdown", onBackdropPointerDown);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    focusTimer = window.setTimeout(() => {
      const preferred = modalBodyEl.querySelector("input:not([disabled])") || modalActionsEl.querySelector("button");
      focusElement(preferred);
    }, 0);
  });
}

export async function confirmVmShutdown(): Promise<boolean> {
  const result = await showBaModal({
    title: t("common.shutdownVm"),
    message: t("modal.shutdown.message"),
    detail: t("modal.shutdown.detail"),
    buttons: [
      { id: "cancel", label: t("common.cancel"), variant: "secondary", cancel: true },
      { id: "shutdown", label: t("common.shutdownVm"), variant: "danger" },
    ],
  });
  return result === "shutdown";
}
