// Browser Agent v86 - 09 bootstrap layout
// Split from app.js in v9.35. Load order is defined in index.html.
// v9.37.20: header GPU badge delegates to the shared LLM capability service.

import { backgroundToolsApi } from "../vm/background-tools-serial1";
import {
  cancelCurrentTool,
  closeHumanConsoleTab,
  createHumanConsoleTab,
  getActiveConsoleTab,
  redrawActiveConsoleScreen,
  renderConsoleTabs,
  showConsoleHelpModal,
} from "../console/xterm-consoles";
import { ensureLLMCapabilities, syncLLMCapabilityBadges } from "../chat/state/capabilities";
import { originApi } from "./origin-awareness";
import { addMessage, setLoading } from "../vm/runtime-assets";
import { $, state } from "./state";
import {
  connectWs,
  copyDockerCommand,
  openRestoreSnapshotPicker,
  restoreSnapshotFromFile,
  runCommandFromInput,
  saveSnapshot,
  sendChat,
  toggleDiskInVm,
} from "../vm/operations";
import { loadProfiles, updateDiskHint, updateProfileHint } from "../vm/profile-config";
import { runChecks } from "../ui/checks-panel";
import { scheduleSerialFit, toggleVmPower } from "../vm/serial-vm";
import {
  syncChecksButton,
  syncDiskCheckButton,
  syncPowerButtons,
  syncSnapshotButtons,
  syncWsButton,
} from "../ui/status-controls";
import { t } from "./i18n";

const CHAT_LAYOUT_STORAGE_KEY = "ba.chatExpanded";

let initialized = false;

function setChatExpanded(expanded: boolean, { persist = true }: { persist?: boolean } = {}): void {
  const enabled = Boolean(expanded);
  document.body.classList.toggle("chat-expanded", enabled);
  const button = $("chat-layout-toggle");
  if (button) {
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.setAttribute("aria-label", enabled
      ? t("app.chatToggle.collapse.aria")
      : t("app.chatToggle.expand.aria"));
    button.textContent = "";
    button.title = enabled
      ? t("app.chatToggle.collapse.title")
      : t("app.chatToggle.expand.title");
  }
  if (persist) {
    try {
      window.localStorage?.setItem(CHAT_LAYOUT_STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      // Ignore storage failures in private modes or restricted embeds.
    }
  }
}

function initChatLayoutToggle(): void {
  const button = $("chat-layout-toggle");
  if (!button) return;
  let initial = false;
  try {
    initial = window.localStorage?.getItem(CHAT_LAYOUT_STORAGE_KEY) === "1";
  } catch {
    initial = false;
  }
  setChatExpanded(initial, { persist: false });
  button.addEventListener("click", () => {
    setChatExpanded(!document.body.classList.contains("chat-expanded"));
    scheduleSerialFit();
  });
}

function enhanceInterface(): void {
  document.body.classList.add("xterm-direct-console-mode-pending");

  const terminal = $("terminal");
  const screen = $("screen-container");
  const vmPanel = terminal?.closest(".panel");

  const serialConsole = $("serial-console");
  if (screen) {
    screen.classList.add("hidden-vga");
  }
  if (serialConsole) {
    serialConsole.classList.add("serial-screen");
  }

  if (terminal && vmPanel && terminal.parentNode) {
    terminal.className = "terminal tool-log";
    terminal.textContent = t("app.toolLog.intro") + "\n";

    const details = document.createElement("details");
    details.className = "tool-log-details";
    const summary = document.createElement("summary");
    summary.textContent = t("app.toolLog.summary");
    terminal.parentNode.insertBefore(details, terminal);
    details.appendChild(summary);
    details.appendChild(terminal);

    // El formulario manual de ejecución pertenece al mismo bloque que el log.
    // Movemos el nodo existente para conservar IDs y listeners posteriores.
    const commandForm = document.getElementById("command-form");
    if (commandForm) {
      commandForm.classList.add("tool-log-command-form");
      details.appendChild(commandForm);
    }
  }

  const commandButton = document.querySelector<HTMLButtonElement>("#command-form button");
  if (commandButton) {
    commandButton.textContent = t("common.tool");
    commandButton.classList.add("manual-tool-btn");
    commandButton.title = commandButton.title || t("app.manualTool.title");
  }

  backgroundToolsApi.mountUi();

  window.addEventListener("resize", () => {
    scheduleSerialFit();
  });
}

function applyDockerCopyLabels(): void {
  const pairs = [
    { id: "copy-docker-command", action: t("common.dockerAction.start") },
    { id: "copy-docker-stop-command", action: t("common.dockerAction.stop") },
  ];
  for (const { id, action } of pairs) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.setAttribute("aria-label", t("common.copyDockerAria", { action }));
    btn.setAttribute("title", t("common.copyDockerTitle", { action }));
  }
}

export function initBootstrap(): void {
  if (initialized) return;
  initialized = true;

  enhanceInterface();
  applyDockerCopyLabels();
  initChatLayoutToggle();
  window.addEventListener("ba:langchange", () => {
    setChatExpanded(document.body.classList.contains("chat-expanded"), { persist: false });
    applyDockerCopyLabels();
  });
  // The global GPU/WASM badge is now driven by the same capability service
  // used by the LLM panel/model selector. This avoids the old mismatch where
  // the page header only checked navigator.gpu while the LLM panel checked the
  // real GPUAdapter/features such as shader-f16.
  syncLLMCapabilityBadges();
  void ensureLLMCapabilities({ source: "startup" }).catch((error: unknown) => {
    console.warn("[llm-capabilities] startup check failed", error);
  });
  const welcomeMessage = addMessage("agent", t("app.chat.welcome"));
  welcomeMessage?.querySelector?.(".bubble")?.setAttribute("data-i18n", "app.chat.welcome");
  void loadProfiles();
  renderConsoleTabs();

  $("console-help")?.addEventListener("click", showConsoleHelpModal);
  $("cancel-tool")?.addEventListener("click", cancelCurrentTool);
  $("new-console")?.addEventListener("click", () => {
    void createHumanConsoleTab();
  });
  $("redraw-console")?.addEventListener("click", () => {
    void redrawActiveConsoleScreen();
  });
  $("close-console")?.addEventListener("click", () => {
    void closeHumanConsoleTab(getActiveConsoleTab()?.id);
  });
  $("start-vm")?.addEventListener("click", () => {
    void toggleVmPower();
  });
  $("save-state")?.addEventListener("click", () => {
    void saveSnapshot();
  });
  $("restore-state")?.addEventListener("click", openRestoreSnapshotPicker);
  $("restore-state-file")?.addEventListener("change", (event) => {
    void restoreSnapshotFromFile(event);
  });
  $("check-disk")?.addEventListener("click", () => {
    void toggleDiskInVm();
  });
  $("run-checks")?.addEventListener("click", () => {
    void runChecks();
  });
  $("connect-ws")?.addEventListener("click", () => {
    void connectWs();
  });
  $("copy-docker-command")?.addEventListener("click", (event) => {
    void copyDockerCommand(event);
  });
  $("copy-docker-stop-command")?.addEventListener("click", (event) => {
    void copyDockerCommand(event);
  });
  $("vm-profile")?.addEventListener("change", () => {
    state.assetBuffers = null;
    state.assetCacheKey = "";
    updateProfileHint({ applyDefaults: true });
    updateDiskHint();
    void runChecks();
  });
  $("vm-ram-mb")?.addEventListener("change", () => { state.assetBuffers = null; state.assetCacheKey = ""; });
  $("vm-vram-mb")?.addEventListener("change", () => { state.assetBuffers = null; state.assetCacheKey = ""; });
  $("vm-disk")?.addEventListener("change", () => { updateDiskHint(); syncDiskCheckButton(); });
  updateDiskHint();
  originApi.syncWarnings();
  syncPowerButtons();
  syncDiskCheckButton();
  syncSnapshotButtons();
  syncWsButton();
  syncChecksButton();
  $("command-form")?.addEventListener("submit", (event) => {
    void runCommandFromInput(event);
  });
  $("chat-form")?.addEventListener("submit", (event) => {
    void sendChat(event);
  });
  initChatInputKeys();
  setLoading(false);

  window.setTimeout(() => {
    void runChecks({ probeWsRelay: false });
  }, 400);
}

function initChatInputKeys(): void {
  const input = $<HTMLTextAreaElement>("chat-input");
  if (!input || input.dataset.chatKeysBound === "1") return;
  input.dataset.chatKeysBound = "1";
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    $<HTMLFormElement>("chat-form")?.requestSubmit();
  });
}
