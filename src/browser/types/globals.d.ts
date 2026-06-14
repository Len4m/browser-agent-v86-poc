// Ambient declarations for boot-time browser globals.

export {};

declare global {
  interface Window {
    __BA_I18N__?: {
      lang: string;
      catalog: Record<string, string>;
    };
  }
}
