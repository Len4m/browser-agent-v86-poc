import { t } from "../../../app/i18n";
import { buildFfufLightCommand, captureCommand, normalizeFfufArgs, standardFormat, summaryToolFailedOn, summaryToolOn, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "web.ffuf.dir_light", get label() { return t("tools.name.web.ffuf.dir_light"); }, riskLevel: 3, category: "web.fuzz",
  requiresVm: true, requiresConsole: true, timeoutMs: 1230000, maxOutputBytes: 24000,
  requiredPackages: ["ffuf", "python3"],
  get description() { return t("tools.desc.web.ffuf.dir_light"); },
  get promptDescription() { return toolPrompt(this.label, '{"url":"http://host/FUZZ","wordlist":"common","threads":2,"rate":10}', t("tools.prompt.ffufNoOptionalDefaults")); },
  buildInputSchema(z) {
    return z.object({
      url: z.string().describe(t("tools.schema.ffufUrl")),
      wordlist: z.string().optional(),
      threads: z.number().optional(),
      rate: z.number().optional(),
      maxTimeSec: z.number().optional().describe(t("tools.schema.ffufMaxTimeSec")),
      filterLength: z.string().optional().describe(t("tools.schema.ffufFilterLength")),
      filterWords: z.string().optional().describe(t("tools.schema.ffufFilterWords")),
      filterLines: z.string().optional().describe(t("tools.schema.ffufFilterLines")),
    });
  },
  normalizeArgs: normalizeFfufArgs,
  buildCommand(args) {
    return captureCommand("ba-ffuf-light", ["ffuf", "python3"], buildFfufLightCommand(args));
  },
  formatResult(result, args) {
    return standardFormat(this, result, args, () => summaryToolOn(t("common.toolShort.ffuf"), args.url), () => summaryToolFailedOn("FFUF", args.url));
  },
};
