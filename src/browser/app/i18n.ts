// @ts-nocheck
// Browser Agent v86 - i18n runtime
// All UI copy lives in src/web/locales/*.json; code only references keys.
// At most one locale catalog is kept in heap at a time.

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

// Missing, empty, or whitespace-only catalog entries fall back to the key string.
function baResolveText(key, raw) {
  if (typeof raw === "string" && raw.trim()) return raw;
  return String(key);
}

function t(key, vars) {
  const value = baActiveCatalog?.[key];
  return baInterpolate(baResolveText(key, value), vars);
}

function tn(key, count, vars) {
  const plural = Number(count) === 1 ? "one" : "other";
  return t(`${key}.${plural}`, Object.assign({ count }, vars || {}));
}

async function loadLocale(lang) {
  if (!lang || !BA_I18N_SUPPORTED.includes(lang)) lang = BA_I18N_BASE_LANG;
  const response = await fetch(`./locales/${lang}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  baActiveCatalog = await response.json();
  return baActiveCatalog;
}

function baApplyNode(el) {
  const key = el.dataset.i18n;
  if (key) el.textContent = t(key);
  const attrSpec = el.dataset.i18nAttr;
  if (attrSpec) {
    for (const pair of attrSpec.split(",")) {
      const [attr, attrKey] = pair.split(":").map((part) => part.trim());
      if (!attr || !attrKey) continue;
      el.setAttribute(attr, t(attrKey));
    }
  }
}

function applyDomTranslations(root) {
  const scope = root || document;
  scope.querySelectorAll("[data-i18n], [data-i18n-attr]").forEach(baApplyNode);
}

async function setLang(lang, { persist = true, apply = true } = {}) {
  const next = BA_I18N_SUPPORTED.includes(lang) ? lang : BA_I18N_BASE_LANG;
  if (next === baActiveLang && baActiveCatalog) return baActiveLang;
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
  const pre = window.__BA_I18N__;
  if (pre?.lang && pre.catalog) {
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
      const run = () => applyDomTranslations();
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", run, { once: true });
      } else {
        run();
      }
    });
})();

window.BA_I18N = { t, tn, getLang, setLang, loadLocale, applyDomTranslations, getSupportedLangs, ready: () => baI18nReady };
