// Browser Agent v86 - lightweight appearance theme controller.
// The tiny bootstrap in index.html applies the stored preference before CSS
// loads; this module owns the live control, persistence and system changes.

import { appEvents } from "../core/events";
import { t } from "./i18n";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "ba.theme";

let themeControlInitialized = false;
let activePreference: ThemePreference = "system";
let systemThemeQuery: MediaQueryList | null = null;

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

export function nextThemePreference(preference: ThemePreference): ThemePreference {
  if (preference === "system") return "light";
  if (preference === "light") return "dark";
  return "system";
}

function readStoredPreference(): ThemePreference {
  try {
    return normalizeThemePreference(window.localStorage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  try {
    return Boolean(systemThemeQuery?.matches ?? window.matchMedia("(prefers-color-scheme: dark)").matches);
  } catch {
    return false;
  }
}

function syncThemeColor(theme: ResolvedTheme): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#0b1120" : "#2563eb";
}

function applyPreference(preference: ThemePreference, { persist = false } = {}): ResolvedTheme {
  activePreference = normalizeThemePreference(preference);
  const resolved = resolveTheme(activePreference, systemPrefersDark());
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = activePreference;
  syncThemeColor(resolved);

  if (persist) {
    try {
      if (activePreference === "system") window.localStorage?.removeItem(THEME_STORAGE_KEY);
      else window.localStorage?.setItem(THEME_STORAGE_KEY, activePreference);
    } catch {
      // Storage can be unavailable in private or restricted contexts.
    }
  }
  return resolved;
}

function syncThemeButton(button: HTMLButtonElement): void {
  const label = t("header.theme.toggle");
  button.setAttribute("aria-label", label);
  if (button.dataset.title !== undefined) button.dataset.title = label;
  else button.title = label;
}

function setupThemeControl(): void {
  const button = document.getElementById("ba-theme-toggle");
  if (!(button instanceof HTMLButtonElement)) return;

  try {
    systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    systemThemeQuery = null;
  }

  applyPreference(readStoredPreference());
  syncThemeButton(button);

  button.addEventListener("click", () => {
    applyPreference(nextThemePreference(activePreference), { persist: true });
  });

  systemThemeQuery?.addEventListener("change", () => {
    if (activePreference === "system") applyPreference("system");
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    applyPreference(normalizeThemePreference(event.newValue));
  });

  appEvents.on("app:language-changed", () => syncThemeButton(button));
}

export function initThemeControl(): void {
  if (themeControlInitialized) return;
  themeControlInitialized = true;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupThemeControl, { once: true });
  } else {
    setupThemeControl();
  }
}
