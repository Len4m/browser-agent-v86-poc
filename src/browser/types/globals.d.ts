// Ambient declarations for the i18n runtime API.
// These keep the i18n surface typed even though the browser sources currently
// use `@ts-nocheck`; they ease a future removal of those pragmas.

export {};

declare global {
  type BaI18nVars = Record<string, string | number>;

  function t(key: string, esDefault?: string, vars?: BaI18nVars): string;
  function tn(
    key: string,
    count: number,
    esOne: string,
    esOther: string,
    vars?: BaI18nVars
  ): string;
  function loadLocale(lang: string): Promise<Record<string, string> | null>;
  function getLang(): string;
  function setLang(
    lang: string,
    options?: { persist?: boolean; apply?: boolean }
  ): Promise<string>;
  function applyDomTranslations(root?: ParentNode): void;
  function getSupportedLangs(): string[];

  interface Window {
    BA_I18N?: {
      t: typeof t;
      tn: typeof tn;
      getLang: typeof getLang;
      setLang: typeof setLang;
      loadLocale: typeof loadLocale;
      applyDomTranslations: typeof applyDomTranslations;
      getSupportedLangs: typeof getSupportedLangs;
      ready: () => Promise<unknown>;
    };
  }
}
