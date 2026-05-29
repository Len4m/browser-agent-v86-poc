// @ts-nocheck
// Browser Agent v86 - i18n runtime
// Base language (es) lives inline in the source as the default for t().
// Only non-base catalogs are fetched on demand; at most one is kept in heap.

const BA_I18N_BASE_LANG = "es";
const BA_I18N_SUPPORTED = ["es", "en"];
const BA_I18N_STORAGE_KEY = "ba.lang";

let baActiveLang = BA_I18N_BASE_LANG;
let baActiveCatalog = null;
let baI18nReady = Promise.resolve();

function baReadStoredLang() {
  try {
    const value = window.localStorage?.getItem(BA_I18N_STORAGE_KEY);
    if (value && BA_I18N_SUPPORTED.includes(value)) return value;
  } catch (_) {}
  try {
    const languages = [navigator.language, ...(navigator.languages || [])]
      .filter(Boolean)
      .map((lang) => String(lang).toLowerCase());
    if (languages.some((lang) => lang === "es" || lang.startsWith("es-"))) {
      return BA_I18N_BASE_LANG;
    }
  } catch (_) {}
  return "en";
}

function getLang() {
  return baActiveLang;
}

function baInterpolate(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  );
}

function t(key, esDefault, vars) {
  if (baActiveLang !== BA_I18N_BASE_LANG && baActiveCatalog) {
    const value = baActiveCatalog[key];
    if (typeof value === "string") return baInterpolate(value, vars);
  }
  return baInterpolate(esDefault != null ? esDefault : key, vars);
}

// Minimal pluralization helper: picks `${key}.one` / `${key}.other` from the
// active catalog and interpolates {count}. Base (es) stays inline as defaults.
function tn(key, count, esOne, esOther, vars) {
  const plural = Number(count) === 1 ? "one" : "other";
  const esDefault = plural === "one" ? esOne : esOther;
  return t(`${key}.${plural}`, esDefault, Object.assign({ count }, vars || {}));
}

async function loadLocale(lang) {
  if (!lang || lang === BA_I18N_BASE_LANG) {
    baActiveCatalog = null;
    return null;
  }
  const response = await fetch(`./locales/${lang}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  baActiveCatalog = await response.json();
  return baActiveCatalog;
}

function baApplyNode(el) {
  const key = el.dataset.i18n;
  if (key) {
    if (el.dataset.i18nBase == null) el.dataset.i18nBase = el.textContent || "";
    el.textContent = t(key, el.dataset.i18nBase);
  }
  const attrSpec = el.dataset.i18nAttr;
  if (attrSpec) {
    for (const pair of attrSpec.split(",")) {
      const [attr, attrKey] = pair.split(":").map((part) => part.trim());
      if (!attr || !attrKey) continue;
      const baseKey = `i18nBase_${attr.replace(/[^a-zA-Z0-9]/g, "_")}`;
      if (el.dataset[baseKey] == null) el.dataset[baseKey] = el.getAttribute(attr) || "";
      el.setAttribute(attr, t(attrKey, el.dataset[baseKey]));
    }
  }
}

function applyDomTranslations(root) {
  const scope = root || document;
  scope.querySelectorAll("[data-i18n], [data-i18n-attr]").forEach(baApplyNode);
}

async function setLang(lang, { persist = true, apply = true } = {}) {
  const next = BA_I18N_SUPPORTED.includes(lang) ? lang : BA_I18N_BASE_LANG;
  if (next === baActiveLang && (next === BA_I18N_BASE_LANG || baActiveCatalog)) {
    return baActiveLang;
  }
  try {
    await loadLocale(next);
  } catch (_) {
    return baActiveLang;
  }
  baActiveLang = next;
  try {
    if (persist) window.localStorage?.setItem(BA_I18N_STORAGE_KEY, next);
  } catch (_) {}
  try {
    document.documentElement.lang = next;
  } catch (_) {}
  if (apply) applyDomTranslations();
  try {
    window.dispatchEvent(new CustomEvent("ba:langchange", { detail: { lang: next } }));
  } catch (_) {}
  return next;
}

function getSupportedLangs() {
  return BA_I18N_SUPPORTED.slice();
}

(function initI18n() {
  // Synchronously preloaded catalog (head script): t() works from the first eval.
  const pre = window.__BA_I18N__;
  if (pre && pre.lang && pre.lang !== BA_I18N_BASE_LANG && pre.catalog) {
    baActiveLang = pre.lang;
    baActiveCatalog = pre.catalog;
    const run = () => {
      try {
        document.documentElement.lang = pre.lang;
      } catch (_) {}
      applyDomTranslations();
      try {
        window.dispatchEvent(new CustomEvent("ba:langchange", { detail: { lang: pre.lang } }));
      } catch (_) {}
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
    return;
  }
  const stored = baReadStoredLang();
  if (stored !== BA_I18N_BASE_LANG) {
    baActiveLang = stored;
    baI18nReady = loadLocale(stored)
      .then(() => {
        try {
          document.documentElement.lang = stored;
        } catch (_) {}
        const run = () => {
          applyDomTranslations();
          try {
            window.dispatchEvent(new CustomEvent("ba:langchange", { detail: { lang: stored } }));
          } catch (_) {}
        };
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", run, { once: true });
        } else {
          run();
        }
      })
      .catch(() => {
        baActiveLang = BA_I18N_BASE_LANG;
        baActiveCatalog = null;
      });
  }
})();

window.BA_I18N = { t, tn, getLang, setLang, loadLocale, applyDomTranslations, getSupportedLangs, ready: () => baI18nReady };
