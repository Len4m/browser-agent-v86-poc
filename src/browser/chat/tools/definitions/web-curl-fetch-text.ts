import { t } from "../../../app/i18n";
import { clampInt } from "../../../app/text-utils";
import { buildCurlFetchTextCommand, normalizeBool, normalizeUrl, standardFormat, summaryCouldNot, summaryHeadTarget, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "web.curl.fetch_text", get label() { return t("tools.name.web.curl.fetch_text"); }, riskLevel: 2, category: "web.http",
  requiresVm: true, requiresConsole: true, timeoutMs: 35000, maxOutputBytes: 32768,
  requiredPackages: ["curl", "python3"],
  get description() { return t("tools.desc.web.curl.fetch_text"); },
  get promptDescription() { return toolPrompt(this.label, '{"url":"https://example.com","maxBytes":8192}'); },
  buildInputSchema(z) {
    return z.object({
      url: z.string().describe(t("tools.schema.urlHttp")),
      maxBytes: z.number().optional(),
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
      timeoutSec: clampInt(args.timeoutSec, 3, 25, 10),
      maxBytes: clampInt(args.maxBytes, 512, 32768, 8192),
    };
  },
  buildCommand: buildCurlFetchTextCommand,
  formatResult(result, args) {
    return standardFormat(this, result, args, () => summaryHeadTarget("common.phrase.contentsOf", args.url), () => summaryCouldNot("common.verb.download", args.url));
  },
};
