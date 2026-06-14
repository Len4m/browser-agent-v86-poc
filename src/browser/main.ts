import { initBrowserApp } from "./app/init";

void (async () => {
  await initBrowserApp();
})().catch((error: unknown) => {
  console.error("[browser-agent] app initialization failed", error);
});
