import { t } from "../../../app/i18n";
import { clampInt, shellQuote } from "../../../app/text-utils";
import { captureCommand, normalizeBool, normalizeUrl, standardFormat, summaryCouldNot, summaryHeadTarget, textValue, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "web.curl.head", get label() { return t("tools.name.web.curl.head"); }, riskLevel: 2, category: "web.http",
  requiresVm: true, requiresConsole: true, timeoutMs: 30000, maxOutputBytes: 24000,
  requiredPackages: ["curl"],
  runtimeChecks: [{ label: "curl", command: "command -v curl" }],
  get description() { return t("tools.desc.web.curl.head"); },
  get promptDescription() { return toolPrompt(this.label, '{"url":"https://example.com","followRedirects":true,"insecure":true,"timeoutSec":8}'); },
  buildInputSchema(z) {
    return z.object({
      url: z.string().describe(t("tools.schema.urlHttp")),
      followRedirects: z.boolean().optional(),
      insecure: z.boolean().optional(),
      timeoutSec: z.number().optional(),
    });
  },
  normalizeArgs(args = {}) {
    return {
      url: normalizeUrl(args.url || args.target),
      followRedirects: normalizeBool(args.followRedirects, true),
      insecure: normalizeBool(args.insecure, true),
      timeoutSec: clampInt(args.timeoutSec, 3, 20, 8),
    };
  },
  buildCommand(args) {
    const timeoutSec = clampInt(args.timeoutSec, 3, 20, 8);
    const flags = ["-I", "-sS", "--http1.1", "--no-keepalive", "-H", "Connection: close", "--connect-timeout", "4", "--max-time", String(timeoutSec)];
    if (args.followRedirects) flags.push("-L");
    if (args.insecure) flags.push("-k");
    flags.push(textValue(args.url));
    return captureCommand("ba-curl-head", ["curl"], `curl ${flags.map(shellQuote).join(" ")}`);
  },
  formatResult(result, args) {
    return standardFormat(this, result, args, () => summaryHeadTarget("common.phrase.headersOf", args.url), () => summaryCouldNot("common.verb.query", args.url));
  },
};
