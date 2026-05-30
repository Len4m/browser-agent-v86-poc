// @ts-nocheck
// Browser Agent v86 - 15b LLM panel GPU capability badges
// Capability badge helpers extracted from 15-llm-ui-panel.js.

(function initLLMPanelCapabilities() {
  function capabilityRecheckTitle(currentTitle) {
    const action = t("caps.view.recheckAction");
    const base = String(currentTitle || "").trim();
    if (!base) return action;
    if (base.includes(action)) return base;
    return `${base} ${action}`;
  }

  function decorateCapabilityRecheckBadge(target) {
    if (!target) return;
    target.classList.add("ba-capability-recheck-badge");
    if (target.tagName !== "BUTTON") {
      target.setAttribute("role", "button");
      target.setAttribute("tabindex", "0");
    }
    target.setAttribute("aria-label", t("caps.view.recheckAria"));
    target.title = capabilityRecheckTitle(target.title);
  }

  function decorateCapabilityRecheckBadges() {
    decorateCapabilityRecheckBadge(document.getElementById("badge-gpu"));
  }

  function bindCapabilityRecheckBadge(target, onRecheck) {
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

  function bindCapabilityRecheckBadges(onRecheck) {
    const targets = [
      document.getElementById("badge-gpu"),
    ];
    for (const target of targets) {
      decorateCapabilityRecheckBadge(target);
      bindCapabilityRecheckBadge(target, onRecheck);
    }
  }

  async function runCapabilityRecheckFromBadge({ checkCapabilities, setStatus } = {}) {
    if (window.BA_LLM?.capabilitiesChecking) return;
    try {
      await checkCapabilities?.({ force: true });
    } catch (error) {
      window.BA_LLM.lastError = error?.message || String(error);
      setStatus?.(t("caps.view.recheckError"), "bad");
    } finally {
      decorateCapabilityRecheckBadges();
    }
  }

  async function ensureCapabilitiesWhenPanelOpens(details, { checkCapabilities, setStatus } = {}) {
    if (!details?.open || window.BA_LLM.capabilitiesChecked || window.BA_LLM.capabilitiesChecking) return;

    const select = document.getElementById("ba-llm-model");
    const load = document.getElementById("ba-llm-load");
    if (select) select.disabled = true;
    if (load) load.disabled = true;

    try {
      await checkCapabilities?.();
    } catch (error) {
      window.BA_LLM.lastError = error?.message || String(error);
      setStatus?.(t("caps.view.recheckError"), "bad");
    } finally {
      if (select) select.disabled = false;
      if (load) load.disabled = Boolean(window.BA_LLM.loading);
    }
  }

  window.addEventListener("ba:langchange", () => decorateCapabilityRecheckBadges());

  window.BA_LLM_PANEL_CAPS = {
    capabilityRecheckTitle,
    decorateCapabilityRecheckBadge,
    decorateCapabilityRecheckBadges,
    bindCapabilityRecheckBadge,
    bindCapabilityRecheckBadges,
    runCapabilityRecheckFromBadge,
    ensureCapabilitiesWhenPanelOpens,
  };
})();
