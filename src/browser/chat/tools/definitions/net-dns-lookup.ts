import { t } from "../../../app/i18n";
import { shellQuote } from "../../../app/text-utils";
import { captureCommand, normalizeHost, standardFormat, summaryCouldNot, textValue, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

function normalizeDnsType(value: unknown): string {
  const type = (textValue(value) || "A").trim().toUpperCase();
  const allowed = new Set(["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "ANY"]);
  return allowed.has(type) ? type : "A";
}

export const toolDefinition: ToolDefinition = {
  name: "net_dns_lookup", get label() { return t("tools.name.net_dns_lookup"); }, riskLevel: 2, category: "net.dns",
  requiresVm: true, requiresConsole: true, timeoutMs: 10000, maxOutputBytes: 16000,
  requiredPackages: ["bind-tools"],
  runtimeChecks: [{ label: "dig", command: "command -v dig" }],
  get description() { return t("tools.desc.net_dns_lookup"); },
  get promptDescription() { return toolPrompt(this.label, '{"host":"example.com","type":"A"}'); },
  buildInputSchema(z) {
    return z.object({
      host: z.string().describe(t("tools.schema.hostOrDomain")),
      type: z.string().optional().describe(t("tools.schema.dnsType")),
    });
  },
  normalizeArgs(args = {}) {
    return { host: normalizeHost(args.host || args.domain || args.target), type: normalizeDnsType(args.type) };
  },
  buildCommand(args) {
    return captureCommand("ba-dns", ["dig"], `dig +time=3 +tries=1 ${shellQuote(args.type)} ${shellQuote(args.host)}; printf '\\n--- short ---\\n'; dig +short +time=3 +tries=1 ${shellQuote(args.type)} ${shellQuote(args.host)}`);
  },
  formatResult(result, args) {
    return standardFormat(this, result, args, () => t("common.summaryDns", { type: textValue(args.type), host: textValue(args.host) }), () => summaryCouldNot("common.verb.resolve", args.host));
  },
};
