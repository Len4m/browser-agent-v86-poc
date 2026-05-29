// @ts-nocheck
// Browser Agent v86 - language selector
// Populates #ba-lang-select and switches the active locale live (no reload),
// so a running VM is never lost when changing language.

(function initLangSelector() {
  const LANG_LABELS = { es: "Español", en: "English" };

  function setup() {
    const select = document.getElementById("ba-lang-select");
    if (!select) return;

    const langs = typeof getSupportedLangs === "function" ? getSupportedLangs() : ["es"];
    select.replaceChildren();
    for (const lang of langs) {
      const option = document.createElement("option");
      option.value = lang;
      option.textContent = LANG_LABELS[lang] || lang.toUpperCase();
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
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup, { once: true });
  } else {
    setup();
  }
})();
