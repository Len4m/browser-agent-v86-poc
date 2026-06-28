import { t } from "../../../app/i18n";
import { clampInt } from "../../../app/text-utils";
import { buildHttpxProbeCommand, captureCommand, normalizeBool, normalizeUrl, standardFormat, summaryToolFailedOn, summaryToolOn, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "web.httpx.probe", get label() { return t("tools.name.web.httpx.probe"); }, riskLevel: 3, category: "web.http",
  requiresVm: true, requiresConsole: true, timeoutMs: 45000, maxOutputBytes: 24000,
  requiredPackages: ["httpx"],
  get description() { return t("tools.desc.web.httpx.probe"); },
  get promptDescription() { return toolPrompt(this.label, '{"url":"https://example.com","rate":10,"threads":2,"techDetect":false}'); },
  buildInputSchema(z) {
    return z.object({
      url: z.string().describe(t("tools.schema.url")),
      rate: z.number().optional(),
      threads: z.number().optional(),
      timeoutSec: z.number().optional(),
      techDetect: z.boolean().optional().describe(t("tools.schema.techDetect")),
    });
  },
  normalizeArgs(args = {}) {
    return {
      url: normalizeUrl(args.url || args.target),
      rate: clampInt(args.rate, 1, 30, 10),
      threads: clampInt(args.threads, 1, 5, 2),
      timeoutSec: clampInt(args.timeoutSec, 1, 10, 3),
      techDetect: normalizeBool(args.techDetect ?? args.detectTech, false),
    };
  },
  buildCommand(args) {
    return captureCommand("ba-httpx", ["httpx"], buildHttpxProbeCommand(args));
  },
  formatResult(result, args) {
    return standardFormat(this, result, args, () => summaryToolOn("HTTPX", args.url), () => summaryToolFailedOn("HTTPX", args.url));
  },
};
