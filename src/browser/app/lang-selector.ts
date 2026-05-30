// @ts-nocheck
// Browser Agent v86 - language selector
// Populates #ba-lang-select and switches the active locale live (no reload),
// so a running VM is never lost when changing language.

(function initLangSelector() {
  const LANG_LABELS = { es: () => t("lang.name.es"), en: () => t("lang.name.en") };

  function setup() {
    const select = document.getElementById("ba-lang-select");
    if (!select) return;

    const langs = typeof getSupportedLangs === "function" ? getSupportedLangs() : ["es"];
    select.replaceChildren();
    for (const lang of langs) {
      const option = document.createElement("option");
      option.value = lang;
      option.textContent = (typeof LANG_LABELS[lang] === "function" ? LANG_LABELS[lang]() : LANG_LABELS[lang]) || lang.toUpperCase();
      select.appendChild(option);
    }

    select.value = typeof getLang === "function" ? getLang() : "es";

    select.addEventListener("change", async () => {
      const applied = await setLang(select.value);
      select.value = applied;
    });

    window.addEventListener("ba:langchange", (event) => {
      const lang = event?.detail?.lang;
      if (lang && select.value !== lang) select.value = lang;
      for (const option of select.options) {
        const code = option.value;
        option.textContent = (typeof LANG_LABELS[code] === "function" ? LANG_LABELS[code]() : LANG_LABELS[code]) || code.toUpperCase();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup, { once: true });
  } else {
    setup();
  }
})();
