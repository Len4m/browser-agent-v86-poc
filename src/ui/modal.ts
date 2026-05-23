// @ts-nocheck
// Browser Agent v86 - 02 modal
// Split from app.js in v9.35. Load order is defined in index.html.

function sleepMs(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeModalButtons(buttons = []) {
  return buttons.length ? buttons : [
    { id: "cancel", label: "Cancelar", variant: "secondary" },
    { id: "ok", label: "Aceptar", variant: "primary" },
  ];
}

function resetBaModalLayout({ messageEl, detailEl, bodyEl, iconEl }) {
  if (messageEl) messageEl.hidden = false;
  if (detailEl) detailEl.hidden = !detailEl.textContent;
  if (bodyEl) {
    bodyEl.hidden = true;
    bodyEl.replaceChildren();
  }
  if (iconEl) iconEl.hidden = false;
}

function bindBaModalActions(actionsEl, normalizedButtons, cleanup) {
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

function showBaModal({
  title = "Confirmar acción",
  message = "",
  detail = "",
  buttons = [],
  closeOnBackdrop = false,
} = {}) {
  return new Promise((resolve) => {
    const overlay = $("ba-modal-overlay");
    const titleEl = $("ba-modal-title");
    const messageEl = $("ba-modal-message");
    const detailEl = $("ba-modal-detail");
    const bodyEl = $("ba-modal-body");
    const actionsEl = $("ba-modal-actions");
    const iconEl = overlay?.querySelector(".ba-modal-icon");
    if (!overlay || !titleEl || !messageEl || !detailEl || !actionsEl) {
      resolve(window.confirm(`${title}\n\n${message}${detail ? `\n\n${detail}` : ""}`) ? "confirm" : "cancel");
      return;
    }

    const normalizedButtons = normalizeModalButtons(buttons);
    let settled = false;
    const previousFocus = document.activeElement;

    function cleanup(result) {
      if (settled) return;
      settled = true;
      overlay.classList.remove("show", "ba-modal-panel-mode");
      overlay.setAttribute("aria-hidden", "true");
      document.removeEventListener("keydown", onKeyDown);
      overlay.removeEventListener("pointerdown", onBackdropPointerDown);
      resetBaModalLayout({ messageEl, detailEl, bodyEl, iconEl });
      try { previousFocus?.focus?.(); } catch {}
      resolve(result);
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        const cancel = normalizedButtons.find((button) => button.cancel) || normalizedButtons[0];
        cleanup(cancel.id);
      }
    }

    function onBackdropPointerDown(event) {
      if (!closeOnBackdrop || event.target !== overlay) return;
      const cancel = normalizedButtons.find((button) => button.cancel) || normalizedButtons[0];
      cleanup(cancel.id);
    }

    titleEl.textContent = title;
    messageEl.textContent = message;
    detailEl.textContent = detail || "";
    resetBaModalLayout({ messageEl, detailEl, bodyEl, iconEl });
    detailEl.hidden = !detail;
    bindBaModalActions(actionsEl, normalizedButtons, cleanup);

    overlay.classList.add("show");
    overlay.setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", onKeyDown);
    overlay.addEventListener("pointerdown", onBackdropPointerDown);
    window.setTimeout(() => {
      const preferred = actionsEl.querySelector(".ba-modal-button.danger, .ba-modal-button.primary") || actionsEl.querySelector("button");
      try { preferred?.focus?.(); } catch {}
    }, 0);
  });
}

function showBaModalPanel({
  title = "Panel",
  onMount,
  buttons = [{ id: "close", label: "Listo", variant: "primary" }],
  closeOnBackdrop = true,
} = {}) {
  return new Promise((resolve) => {
    const overlay = $("ba-modal-overlay");
    const titleEl = $("ba-modal-title");
    const messageEl = $("ba-modal-message");
    const detailEl = $("ba-modal-detail");
    const bodyEl = $("ba-modal-body");
    const actionsEl = $("ba-modal-actions");
    const iconEl = overlay?.querySelector(".ba-modal-icon");
    if (!overlay || !titleEl || !bodyEl || !actionsEl) {
      resolve("close");
      return;
    }

    const normalizedButtons = normalizeModalButtons(buttons);
    let settled = false;
    const previousFocus = document.activeElement;

    function cleanup(result) {
      if (settled) return;
      settled = true;
      overlay.classList.remove("show", "ba-modal-panel-mode");
      overlay.setAttribute("aria-hidden", "true");
      document.removeEventListener("keydown", onKeyDown);
      overlay.removeEventListener("pointerdown", onBackdropPointerDown);
      resetBaModalLayout({ messageEl, detailEl, bodyEl, iconEl });
      try { previousFocus?.focus?.(); } catch {}
      resolve(result);
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        const cancel = normalizedButtons.find((button) => button.cancel) || normalizedButtons[0];
        cleanup(cancel.id);
      }
    }

    function onBackdropPointerDown(event) {
      if (!closeOnBackdrop || event.target !== overlay) return;
      const cancel = normalizedButtons.find((button) => button.cancel) || normalizedButtons[0];
      cleanup(cancel.id);
    }

    titleEl.textContent = title;
    messageEl.textContent = "";
    messageEl.hidden = true;
    detailEl.textContent = "";
    detailEl.hidden = true;
    bodyEl.hidden = false;
    bodyEl.replaceChildren();
    if (iconEl) iconEl.hidden = true;
    bindBaModalActions(actionsEl, normalizedButtons, cleanup);

    try { onMount?.(bodyEl); } catch (error) {
      bodyEl.innerHTML = `<p class="ba-modal-detail">${String(error?.message || error)}</p>`;
    }

    overlay.classList.add("show", "ba-modal-panel-mode");
    overlay.setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", onKeyDown);
    overlay.addEventListener("pointerdown", onBackdropPointerDown);
    window.setTimeout(() => {
      const preferred = bodyEl.querySelector("input:not([disabled])") || actionsEl.querySelector("button");
      try { preferred?.focus?.(); } catch {}
    }, 0);
  });
}

async function confirmVmShutdown() {
  const result = await showBaModal({
    title: "Apagar VM",
    message: "Apagar la VM perderá todos los cambios que no estén guardados en un snapshot.",
    detail: "Si has instalado paquetes o creado ficheros en RAM, guarda un snapshot antes de apagar.",
    buttons: [
      { id: "cancel", label: "Cancelar", variant: "secondary", cancel: true },
      { id: "shutdown", label: "Apagar VM", variant: "danger" },
    ],
  });
  return result === "shutdown";
}
