import { t } from "../../../app/i18n";
import { clampInt } from "../../../app/text-utils";
import { buildNiktoQuickCommand, captureCommand, formatNiktoResult, normalizeNiktoTuning, normalizeUrl, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "web.nikto.quick", get label() { return t("tools.name.web.nikto.quick"); }, riskLevel: 3, category: "web.scan",
  requiresVm: true, requiresConsole: true, timeoutMs: 170000, maxOutputBytes: 32768,
  requiredPackages: ["nikto"],
  get description() { return t("tools.desc.web.nikto.quick"); },
  get promptDescription() { return toolPrompt(this.label, '{"url":"https://example.com","maxTimeSec":60,"timeoutSec":5,"tuning":"123b"}'); },
  buildInputSchema(z) {
    return z.object({
      url: z.string().describe(t("tools.schema.url")),
      maxTimeSec: z.number().optional(),
      timeoutSec: z.number().optional().describe(t("tools.schema.timeoutSec")),
      tuning: z.string().optional().describe(t("tools.schema.niktoTuning")),
    });
  },
  normalizeArgs(args = {}) {
    return {
      url: normalizeUrl(args.url || args.target),
      maxTimeSec: clampInt(args.maxTimeSec, 15, 120, 60),
      timeoutSec: clampInt(args.timeoutSec, 2, 15, 5),
      tuning: normalizeNiktoTuning(args.tuning),
    };
  },
  buildCommand(args) {
    return captureCommand("ba-nikto", ["perl"], buildNiktoQuickCommand(args));
  },
  formatResult(result, args) {
    return formatNiktoResult(this, result, args);
  },
};
