import {
  $,
  CR,
  DOCKER_WSNIC_COMMAND,
  NL,
  VM_DISK_MOUNT_COMMAND,
  VM_DISK_UNMOUNT_COMMAND,
  VM_NETWORK_COMMAND,
  state,
} from "../app/state";
import {
  applyDomTranslations,
  getLang,
  getSupportedLangs,
  i18nApi,
  initI18n,
  loadLocale,
  setLang,
  t,
  tn,
} from "../app/i18n";
import { initLangSelector } from "../app/lang-selector";
import { initOriginAwareness, originApi } from "../app/origin-awareness";
import { runChecks } from "../ui/checks-panel";
import { confirmVmShutdown, showBaModal, showBaModalPanel } from "../ui/modal";
import { backgroundToolsApi, initBackgroundToolsSerial1 } from "../vm/background-tools-serial1";
import { consoleControlApi } from "../vm/console-control-serial2";
import * as vmOperations from "../vm/operations";
import * as profileConfig from "../vm/profile-config";
import * as runtimeAssets from "../vm/runtime-assets";
import * as terminalMarkers from "../vm/terminal-markers";
import {
  appendBoundedText,
  blurSerialConsole,
  formatLoggedCommand,
  initStatusControls,
  isWsConnected,
  logTool,
  safeTrim,
  setAgentBusy,
  setBadge,
  syncChecksButton,
  syncDiskCheckButton,
  syncPowerButtons,
  syncSnapshotButtons,
  syncWsButton,
} from "../ui/status-controls";
import { initTooltips } from "../ui/tooltips";
import {
  BA_TEXT_UTILS,
  clampExecVmOutputBytes,
  clampInt,
  normalizeNewlines,
  shellQuote,
  stripAnsi,
  stripAnsiAndControls,
  trimLines,
  trimLinesSimple,
  utf8ToBase64,
} from "../app/text-utils";

type LegacyWindow = Window & typeof globalThis & typeof vmOperations & typeof profileConfig & typeof runtimeAssets & typeof terminalMarkers & {
  $: typeof $;
  CR: typeof CR;
  DOCKER_WSNIC_COMMAND: typeof DOCKER_WSNIC_COMMAND;
  NL: typeof NL;
  VM_DISK_MOUNT_COMMAND: typeof VM_DISK_MOUNT_COMMAND;
  VM_DISK_UNMOUNT_COMMAND: typeof VM_DISK_UNMOUNT_COMMAND;
  VM_NETWORK_COMMAND: typeof VM_NETWORK_COMMAND;
  state: typeof state;
  applyDomTranslations: typeof applyDomTranslations;
  getLang: typeof getLang;
  getSupportedLangs: typeof getSupportedLangs;
  loadLocale: typeof loadLocale;
  setLang: typeof setLang;
  t: typeof t;
  tn: typeof tn;
  BA_I18N: typeof i18nApi;
  BA_ORIGIN: typeof originApi;
  BA_TEXT_UTILS: typeof BA_TEXT_UTILS;
  BA_BG_TOOLS: typeof backgroundToolsApi;
  BA_CONSOLE_CONTROL: typeof consoleControlApi;
  clampExecVmOutputBytes: typeof clampExecVmOutputBytes;
  clampInt: typeof clampInt;
  normalizeNewlines: typeof normalizeNewlines;
  shellQuote: typeof shellQuote;
  stripAnsi: typeof stripAnsi;
  stripAnsiAndControls: typeof stripAnsiAndControls;
  trimLines: typeof trimLines;
  trimLinesSimple: typeof trimLinesSimple;
  utf8ToBase64: typeof utf8ToBase64;
  confirmVmShutdown: typeof confirmVmShutdown;
  runChecks: typeof runChecks;
  showBaModal: typeof showBaModal;
  showBaModalPanel: typeof showBaModalPanel;
  appendBoundedText: typeof appendBoundedText;
  blurSerialConsole: typeof blurSerialConsole;
  formatLoggedCommand: typeof formatLoggedCommand;
  isWsConnected: typeof isWsConnected;
  logTool: typeof logTool;
  safeTrim: typeof safeTrim;
  setAgentBusy: typeof setAgentBusy;
  setBadge: typeof setBadge;
  syncChecksButton: typeof syncChecksButton;
  syncDiskCheckButton: typeof syncDiskCheckButton;
  syncPowerButtons: typeof syncPowerButtons;
  syncSnapshotButtons: typeof syncSnapshotButtons;
  syncWsButton: typeof syncWsButton;
};

let installed = false;

export function installLegacyFacades(): void {
  if (installed) return;
  installed = true;

  const legacyWindow = window as LegacyWindow;
  Object.assign(legacyWindow, vmOperations, profileConfig, runtimeAssets, terminalMarkers, {
    $,
    CR,
    DOCKER_WSNIC_COMMAND,
    NL,
    VM_DISK_MOUNT_COMMAND,
    VM_DISK_UNMOUNT_COMMAND,
    VM_NETWORK_COMMAND,
    state,
    applyDomTranslations,
    getLang,
    getSupportedLangs,
    loadLocale,
    setLang,
    t,
    tn,
    clampExecVmOutputBytes,
    clampInt,
    normalizeNewlines,
    shellQuote,
    stripAnsi,
    stripAnsiAndControls,
    trimLines,
    trimLinesSimple,
    utf8ToBase64,
    confirmVmShutdown,
    runChecks,
    showBaModal,
    showBaModalPanel,
    appendBoundedText,
    blurSerialConsole,
    formatLoggedCommand,
    isWsConnected,
    logTool,
    safeTrim,
    setAgentBusy,
    setBadge,
    syncChecksButton,
    syncDiskCheckButton,
    syncPowerButtons,
    syncSnapshotButtons,
    syncWsButton,
  });

  legacyWindow.BA_I18N = i18nApi;
  legacyWindow.BA_ORIGIN = originApi;
  legacyWindow.BA_TEXT_UTILS = BA_TEXT_UTILS;
  legacyWindow.BA_BG_TOOLS = backgroundToolsApi;
  legacyWindow.BA_CONSOLE_CONTROL = consoleControlApi;

  void initI18n();
  initBackgroundToolsSerial1();
  initOriginAwareness();
  initStatusControls();
  profileConfig.initProfileConfig();
  initLangSelector();
  initTooltips();
}
