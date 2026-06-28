import { t } from "../../../app/i18n";
import { captureCommand, standardFormat, summaryCouldNot, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "net.ip.status", get label() { return t("common.vmNetworkStatus"); }, riskLevel: 1, category: "net.local",
  requiresVm: true, requiresConsole: true, timeoutMs: 10000, maxOutputBytes: 24000,
  requiredPackages: ["iproute2"],
  runtimeChecks: [{ label: "ip", command: "command -v ip" }],
  get description() { return t("tools.desc.net.ip.status"); },
  get promptDescription() { return toolPrompt(this.label, "{}"); },
  buildInputSchema(z) { return z.object({}); },
  normalizeArgs() { return {}; },
  buildCommand() {
    return captureCommand("ba-ip-status", ["ip"], "ip addr show; printf '\\n--- route ---\\n'; ip route show; printf '\\n--- sockets ---\\n'; ss -tuna 2>/dev/null | sed -n '1,80p' || true");
  },
  formatResult(result) {
    return standardFormat(this, result, {}, () => t("common.vmNetworkStatus"), () => summaryCouldNot("common.verb.get", t("common.noun.networkStatus")));
  },
};
