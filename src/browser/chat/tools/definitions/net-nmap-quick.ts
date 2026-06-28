import { t } from "../../../app/i18n";
import { clampInt, shellQuote } from "../../../app/text-utils";
import { captureCommand, normalizeHost, normalizePortList, standardFormat, summaryToolFailedOn, summaryToolOn, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "net.nmap.quick", get label() { return t("tools.name.net.nmap.quick"); }, riskLevel: 3, category: "net.scan",
  requiresVm: true, requiresConsole: true, timeoutMs: 70000, maxOutputBytes: 32768,
  requiredPackages: ["nmap"],
  get description() { return t("tools.desc.net.nmap.quick"); },
  get promptDescription() { return toolPrompt(this.label, '{"target":"192.168.1.10","ports":"80,443,8000"}'); },
  buildInputSchema(z) {
    return z.object({
      target: z.string().describe(t("tools.schema.ipOrHost")),
      ports: z.string().optional().describe(t("tools.schema.ports")),
      topPorts: z.number().optional(),
    });
  },
  normalizeArgs(args = {}) {
    const ports = normalizePortList(args.ports || args.portList || args.port);
    return { target: normalizeHost(args.target || args.host), ports, topPorts: ports ? null : clampInt(args.topPorts, 10, 100, 30) };
  },
  buildCommand(args) {
    const target = shellQuote(args.target);
    const topPorts = clampInt(args.topPorts, 10, 100, 30);
    const scanTarget = args.ports
      ? `-p ${shellQuote(args.ports)} ${target}`
      : `--top-ports ${topPorts} ${target}`;
    return captureCommand("ba-nmap-quick", ["nmap"], `nmap -Pn -sT -T2 --max-retries 1 --host-timeout 55s ${scanTarget}`);
  },
  formatResult(result, args) {
    return standardFormat(this, result, args, () => summaryToolOn(t("common.toolShort.nmap"), args.target), () => summaryToolFailedOn("Nmap", args.target));
  },
};
