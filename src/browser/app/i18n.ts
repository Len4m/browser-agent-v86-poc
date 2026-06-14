// Browser Agent v86 - i18n runtime
// All UI copy lives in src/web/locales/*.json; code only references keys.
// At most one locale catalog is kept in heap at a time.

export type I18nVars = Record<string, string | number>;
export type I18nCatalog = Record<string, string>;
export type SupportedLang = "es" | "en";

export const I18N_BASE_LANG: SupportedLang = "es";
export const I18N_SUPPORTED = ["es", "en"] as const;
export const I18N_STORAGE_KEY = "ba.lang";

let baActiveLang: SupportedLang = I18N_BASE_LANG;
let baActiveCatalog: I18nCatalog | null = null;
let baI18nReady: Promise<unknown> = Promise.resolve();
let baI18nStarted = false;

function isSupportedLang(lang: string): lang is SupportedLang {
  return (I18N_SUPPORTED as readonly string[]).includes(lang);
}

function baReadStoredLang(): SupportedLang {
  try {
    const value = window.localStorage?.getItem(I18N_STORAGE_KEY);
    if (value && isSupportedLang(value)) return value;
  } catch {}
  try {
    const languages = [navigator.language, ...(navigator.languages || [])]
      .filter(Boolean)
      .map((lang) => String(lang).toLowerCase());
    if (languages.some((lang) => lang === "es" || lang.startsWith("es-"))) {
      return I18N_BASE_LANG;
    }
  } catch {}
  return "en";
}

export function getLang(): SupportedLang {
  return baActiveLang;
}

function baInterpolate(text: string, vars?: I18nVars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
    const value = vars[key];
    return typeof value === "string" || typeof value === "number" ? String(value) : match;
  });
}

// Missing, empty, or whitespace-only catalog entries fall back to the key string.
function baResolveText(key: string, raw: unknown): string {
  if (typeof raw === "string" && raw.trim()) return raw;
  return String(key);
}

export function t(key: string, vars?: I18nVars): string {
  const value = baActiveCatalog?.[key];
  return baInterpolate(baResolveText(key, value), vars);
}

export function tn(key: string, count: number, vars?: I18nVars): string {
  const plural = Number(count) === 1 ? "one" : "other";
  return t(`${key}.${plural}`, Object.assign({ count }, vars || {}));
}

export async function loadLocale(lang: string): Promise<I18nCatalog> {
  const next = isSupportedLang(lang) ? lang : I18N_BASE_LANG;
  const response = await fetch(`./locales/${next}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  baActiveCatalog = await response.json() as I18nCatalog;
  return baActiveCatalog;
}

function baApplyNode(el: Element): void {
  const target = el as HTMLElement;
  const key = target.dataset.i18n;
  if (key) el.textContent = t(key);
  const attrSpec = target.dataset.i18nAttr;
  if (attrSpec) {
    for (const pair of attrSpec.split(",")) {
      const [attr, attrKey] = pair.split(":").map((part) => part.trim());
      if (!attr || !attrKey) continue;
      el.setAttribute(attr, t(attrKey));
    }
  }
}

export function applyDomTranslations(root: ParentNode = document): void {
  const scope = root || document;
  scope.querySelectorAll("[data-i18n], [data-i18n-attr]").forEach(baApplyNode);
}

export async function setLang(
  lang: string,
  { persist = true, apply = true }: { persist?: boolean; apply?: boolean } = {},
): Promise<SupportedLang> {
  const next = isSupportedLang(lang) ? lang : I18N_BASE_LANG;
  if (next === baActiveLang && baActiveCatalog) return baActiveLang;
  try {
    await loadLocale(next);
  } catch {
    return baActiveLang;
  }
  baActiveLang = next;
  try {
    if (persist) window.localStorage?.setItem(I18N_STORAGE_KEY, next);
  } catch {}
  try {
    document.documentElement.lang = next;
  } catch {}
  if (apply) applyDomTranslations();
  try {
    window.dispatchEvent(new CustomEvent("ba:langchange", { detail: { lang: next } }));
  } catch {}
  return next;
}

export function getSupportedLangs(): SupportedLang[] {
  return I18N_SUPPORTED.slice();
}

export function initI18n(): Promise<unknown> {
  if (baI18nStarted) return baI18nReady;
  baI18nStarted = true;
  const pre = window.__BA_I18N__;
  if (pre?.lang && pre.catalog) {
    baActiveLang = isSupportedLang(pre.lang) ? pre.lang : I18N_BASE_LANG;
    baActiveCatalog = pre.catalog;
    const run = () => {
      try {
        document.documentElement.lang = baActiveLang;
      } catch {}
      applyDomTranslations();
      try {
        window.dispatchEvent(new CustomEvent("ba:langchange", { detail: { lang: baActiveLang } }));
      } catch {}
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
    return baI18nReady;
  }
  const stored = baReadStoredLang();
  baActiveLang = stored;
  baI18nReady = loadLocale(stored)
    .then(() => {
      try {
        document.documentElement.lang = stored;
      } catch {}
      const run = () => {
        applyDomTranslations();
        try {
          window.dispatchEvent(new CustomEvent("ba:langchange", { detail: { lang: stored } }));
        } catch {}
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", run, { once: true });
      } else {
        run();
      }
    })
    .catch(() => {
      baActiveLang = I18N_BASE_LANG;
      baActiveCatalog = null;
      const run = () => applyDomTranslations();
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", run, { once: true });
      } else {
        run();
      }
    });
  return baI18nReady;
}

export const i18nApi = { t, tn, getLang, setLang, loadLocale, applyDomTranslations, getSupportedLangs, ready: () => baI18nReady };

export type I18nApi = typeof i18nApi;
