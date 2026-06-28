import { t } from "../../../app/i18n";
import { clampInt, shellQuote } from "../../../app/text-utils";
import { captureCommand, normalizeHost, standardFormat, summaryToolFailedOn, summaryToolOn, textValue, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

function normalizePortList(value: unknown): string {
  const raw = Array.isArray(value) ? value.join(",") : textValue(value).trim();
  if (!raw) return "";
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(raw)) throw new Error(t("tools.error.portsInvalid"));
  const parts = raw.split(",");
  if (parts.length > 20) throw new Error(t("tools.error.portsTooMany"));
  for (const part of parts) {
    const [startRaw, endRaw = startRaw] = part.split("-");
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
      throw new Error(t("tools.error.portsInvalid"));
    }
  }
  return raw;
}

export const toolDefinition: ToolDefinition = {
  name: "net.nmap.quick", get label() { return t("tools.name.net.nmap.quick"); }, riskLevel: 3, category: "net.scan",
  requiresVm: true, requiresConsole: true, timeoutMs: 70000, maxOutputBytes: 32768,
  requiredPackages: ["nmap"],
  runtimeChecks: [{ label: "nmap", command: "command -v nmap" }],
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
