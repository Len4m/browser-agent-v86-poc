import { appEvents } from "../core/events";

export interface BrowserAgentPublicApi {
  version: string;
  source: string;
  events: typeof appEvents;
  build: Record<string, never>;
}

declare global {
  interface Window {
    BA?: BrowserAgentPublicApi;
  }
}

export function installWindowApi(): BrowserAgentPublicApi {
  const api: BrowserAgentPublicApi = {
    version: "0.3.0-typescript-bundle",
    source: "src/browser/main.ts",
    events: appEvents,
    build: {},
  };

  window.BA = api;
  appEvents.emit("app:ready", { version: api.version, source: api.source });
  return api;
}
