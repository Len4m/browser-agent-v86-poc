import { initBrowserApp } from "./app/init";
import { installWindowApi } from "./compat/window-api";

void (async () => {
  await initBrowserApp();
  installWindowApi();
})().catch((error: unknown) => {
  console.error("[browser-agent] app initialization failed", error);
});
