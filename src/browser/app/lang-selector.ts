// Browser Agent v86 - language selector
// Populates #ba-lang-select and switches the active locale live (no reload),
// so a running VM is never lost when changing language.

import { getLang, getSupportedLangs, setLang, t, type SupportedLang } from "./i18n";

const LANG_LABELS: Record<SupportedLang, () => string> = {
  es: () => t("lang.name.es"),
  en: () => t("lang.name.en"),
};

let langSelectorInitialized = false;

function labelForLang(lang: string): string {
  return (lang === "es" || lang === "en" ? LANG_LABELS[lang]() : "") || lang.toUpperCase();
}

function langFromEvent(event: Event): string {
  if (!(event instanceof CustomEvent)) return "";
  const detail: unknown = event.detail;
  if (!detail || typeof detail !== "object" || !("lang" in detail)) return "";
  const lang = (detail as { lang?: unknown }).lang;
  return typeof lang === "string" ? lang : "";
}

function setupLangSelector(): void {
  const select = document.getElementById("ba-lang-select");
  if (!(select instanceof HTMLSelectElement)) return;

  const langs = getSupportedLangs();
  select.replaceChildren();
  for (const lang of langs) {
    const option = document.createElement("option");
    option.value = lang;
    option.textContent = labelForLang(lang);
    select.appendChild(option);
  }

  select.value = getLang();

  select.addEventListener("change", () => {
    void (async () => {
      const applied = await setLang(select.value);
      select.value = applied;
    })();
  });

  window.addEventListener("ba:langchange", (event) => {
    const lang = langFromEvent(event);
    if (typeof lang === "string" && lang && select.value !== lang) select.value = lang;
    for (const option of select.options) {
      const code = option.value;
      option.textContent = labelForLang(code);
    }
  });
}

export function initLangSelector(): void {
  if (langSelectorInitialized) return;
  langSelectorInitialized = true;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupLangSelector, { once: true });
  } else {
    setupLangSelector();
  }
}
