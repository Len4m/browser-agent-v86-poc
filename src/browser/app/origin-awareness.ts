// Browser Agent v86 - local service origin awareness

import { t } from "./i18n";

let originAwarenessInitialized = false;

function localHostname(hostname: string): boolean {
  const value = String(hostname || "").toLowerCase();
  return value === "localhost"
    || value === "127.0.0.1"
    || value === "::1"
    || value === "[::1]"
    || value.endsWith(".localhost");
}

function isLocalOrigin(): boolean {
  const loc = window.location;
  if (!loc) return false;
  if (loc.protocol === "file:") return true;
  return localHostname(loc.hostname);
}

export function isPublishedOrigin(): boolean {
  const loc = window.location;
  if (!loc) return false;
  if (!["http:", "https:"].includes(loc.protocol)) return false;
  return !isLocalOrigin();
}

function localServiceWarningText(kind = "servicios locales"): string {
  const origin = window.location?.origin || t("origin.thisOrigin");
  if (kind === "ollama") return t("origin.ollama", { origin });
  if (kind === "wsnic") return t("origin.wsnic");
  return t("origin.default");
}

function applyNotice(id: string, kind: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  const show = isPublishedOrigin();
  el.hidden = !show;
  if (show) el.textContent = localServiceWarningText(kind);
}

function syncWarnings(): void {
  applyNotice("ws-origin-notice", "wsnic");
  applyNotice("ba-llm-ollama-origin-notice", "ollama");
}

export const originApi = {
  isLocalOrigin,
  isPublishedOrigin,
  localServiceWarningText,
  syncWarnings,
};

export function initOriginAwareness(): void {
  if (originAwarenessInitialized) return;
  originAwarenessInitialized = true;
  window.addEventListener("ba:langchange", () => syncWarnings());
}
