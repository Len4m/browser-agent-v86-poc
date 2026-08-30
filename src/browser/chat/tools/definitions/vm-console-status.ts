import { t } from "../../../app/i18n";
import { captureCommand, standardFormat, summaryCouldNot, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "vm_console_status", get label() { return t("common.xtermConsoleStatus"); }, riskLevel: 1, category: "vm.system",
  requiresVm: true, requiresConsole: true, timeoutMs: 8000, maxOutputBytes: 16000,
  get description() { return t("tools.desc.vm_console_status"); },
  get promptDescription() { return toolPrompt(this.label, "{}"); },
  buildInputSchema(z) { return z.object({}); },
  normalizeArgs() { return {}; },
  buildCommand() {
    return captureCommand("ba-console-status", [], "printf '%s\\n' '--- serial devices ---'; ls -l /dev/ttyS0 /dev/ttyS1 /dev/ttyS2 2>&1 || true; printf '%s\\n' '--- xterm daemon ---'; ps | grep '[b]a-serial2-console-runner' || true; printf '%s\\n' '--- python ---'; python3 --version 2>&1 || true; printf '%s\\n' '--- runner log ---'; tail -40 /tmp/ba-serial2-console-runner.log 2>/dev/null || true");
  },
  formatResult(result) {
    return standardFormat(this, result, {}, () => t("common.xtermConsoleStatus"), () => summaryCouldNot("common.verb.get", t("common.noun.consoleStatus")));
  },
};
