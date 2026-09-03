// Browser Agent v86 - ESM application initializer.

import { initBootstrap } from "./bootstrap";
import { initI18n } from "./i18n";
import { initLangSelector } from "./lang-selector";
import { initThemeControl } from "./theme";
import { initOriginAwareness } from "./origin-awareness";
import { initLlmAgentDebug } from "../chat/runtime/agent-debug";
import { initLlmAgentLoop } from "../chat/runtime/agent-loop";
import { initLlmPanel } from "../chat/panel/panel";
import { installLlmState } from "../chat/state/chat-state";
import { initLlmCapabilities } from "../chat/state/capabilities";
import { initXtermConsoles } from "../console/xterm-consoles";
import { initStatusControls } from "../ui/status-controls";
import { initTooltips } from "../ui/tooltips";
import { initBackgroundToolsSerial1 } from "../vm/background-tools-serial1";
import { initProfileConfig } from "../vm/profile-config";

let initialized = false;

export async function initBrowserApp(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await initI18n();
  installLlmState();
  initLlmCapabilities();
  initBackgroundToolsSerial1();
  initXtermConsoles();
  initOriginAwareness();
  initStatusControls();
  initProfileConfig();
  initLangSelector();
  initThemeControl();
  initLlmAgentDebug();
  initTooltips();
  initBootstrap();
  initLlmAgentLoop();
  initLlmPanel();
}
