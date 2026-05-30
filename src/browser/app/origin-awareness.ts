// @ts-nocheck
// Browser Agent v86 - local service origin awareness

(function initOriginAwareness() {
  function localHostname(hostname) {
    const value = String(hostname || "").toLowerCase();
    return value === "localhost"
      || value === "127.0.0.1"
      || value === "::1"
      || value === "[::1]"
      || value.endsWith(".localhost");
  }

  function isLocalOrigin() {
    const loc = window.location;
    if (!loc) return false;
    if (loc.protocol === "file:") return true;
    return localHostname(loc.hostname);
  }

  function isPublishedOrigin() {
    const loc = window.location;
    if (!loc) return false;
    if (!["http:", "https:"].includes(loc.protocol)) return false;
    return !isLocalOrigin();
  }

  function localServiceWarningText(kind = "servicios locales") {
    const origin = window.location?.origin || t("origin.thisOrigin");
    if (kind === "ollama") return t("origin.ollama", { origin });
    if (kind === "wsnic") return t("origin.wsnic");
    return t("origin.default");
  }

  function applyNotice(id, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    const show = isPublishedOrigin();
    el.hidden = !show;
    if (show) el.textContent = localServiceWarningText(kind);
  }

  function syncWarnings() {
    applyNotice("ws-origin-notice", "wsnic");
    applyNotice("ba-llm-ollama-origin-notice", "ollama");
  }

  window.addEventListener("ba:langchange", () => syncWarnings());

  window.BA_ORIGIN = {
    isLocalOrigin,
    isPublishedOrigin,
    localServiceWarningText,
    syncWarnings,
  };
})();
