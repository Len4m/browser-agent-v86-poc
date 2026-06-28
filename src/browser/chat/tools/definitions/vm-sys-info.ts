import { t } from "../../../app/i18n";
import { captureCommand, standardFormat, summaryCouldNot, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "vm.sys.info", get label() { return t("tools.name.vm.sys.info"); }, riskLevel: 1, category: "vm.system",
  requiresVm: true, requiresConsole: true, timeoutMs: 10000, maxOutputBytes: 24000,
  get description() { return t("tools.desc.vm.sys.info"); },
  get promptDescription() { return toolPrompt(this.label, "{}"); },
  buildInputSchema(z) { return z.object({}); },
  normalizeArgs() { return {}; },
  buildCommand() {
    return captureCommand("ba-sys-info", [], "uname -a; printf '\\n--- os-release ---\\n'; cat /etc/os-release 2>/dev/null || true; printf '\\n--- memory ---\\n'; free -m 2>/dev/null || true; printf '\\n--- disk ---\\n'; df -h 2>/dev/null || true; printf '\\n--- uptime ---\\n'; uptime 2>/dev/null || true");
  },
  formatResult(result) {
    return standardFormat(this, result, {}, () => t("tools.summary.sysInfoOk"), () => summaryCouldNot("common.verb.get", t("common.noun.basicStatus")));
  },
};
