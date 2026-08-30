import { t } from "../../../app/i18n";
import { shellQuote } from "../../../app/text-utils";
import { captureCommand, standardFormat, summaryCouldNot, textValue, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "vm_pkg_info", get label() { return t("tools.name.vm_pkg_info"); }, riskLevel: 1, category: "vm.system",
  requiresVm: true, requiresConsole: true, timeoutMs: 10000, maxOutputBytes: 24000,
  get description() { return t("tools.desc.vm_pkg_info"); },
  get promptDescription() { return toolPrompt(this.label, '{"filter":"curl"}'); },
  buildInputSchema(z) {
    return z.object({
      filter: z.string().optional().describe(t("tools.schema.pkgFilter")),
    });
  },
  normalizeArgs(args = {}) { return { filter: textValue(args.filter).trim().slice(0, 80) }; },
  buildCommand(args) {
    const f = shellQuote(args.filter || "");
    return captureCommand("ba-pkg-info", [], `packages=$(sed -n 's/^P://p' /lib/apk/db/installed 2>/dev/null); if [ -n ${f} ]; then matches=$(printf '%s\\n' "$packages" | grep -i -- ${f} | sed -n '1,120p'); if [ -n "$matches" ]; then printf '%s\\n' "$matches"; else printf 'ERROR: no installed packages match: %s\\n' ${f}; exit 1; fi; else printf '%s\\n' "$packages" | sed -n '1,160p'; fi`);
  },
  formatResult(result) {
    return standardFormat(this, result, {}, () => t("tools.summary.pkgInfoOk"), () => summaryCouldNot("common.verb.query", t("common.noun.packages")));
  },
};
