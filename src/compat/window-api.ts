import { appEvents } from "../core/events";

export interface BrowserAgentPublicApi {
  version: string;
  source: string;
  events: typeof appEvents;
  build: {
    sourceOrder: string[];
  };
}

declare global {
  interface Window {
    BA?: BrowserAgentPublicApi;
    BA_BROWSER_SOURCE_ORDER?: string[];
  }
}

export function installWindowApi(scriptOrder: string[]): BrowserAgentPublicApi {
  const api: BrowserAgentPublicApi = {
    version: "0.3.0-typescript-bundle",
    source: "src/main.ts",
    events: appEvents,
    build: {
      sourceOrder: [...scriptOrder],
    },
  };

  window.BA = api;
  window.BA_BROWSER_SOURCE_ORDER = [...scriptOrder];
  appEvents.emit("app:ready", { version: api.version, source: api.source });
  return api;
}
