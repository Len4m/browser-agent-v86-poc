import { t } from "../../../app/i18n";
import { clampInt, shellQuote } from "../../../app/text-utils";
import { captureCommand, normalizeListArgs, standardFormat, summaryCouldNot, summaryHeadTarget, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "vm.fs.list", get label() { return t("tools.name.vm.fs.list"); }, riskLevel: 1, category: "vm.fs",
  requiresVm: true, requiresConsole: true, timeoutMs: 12000, maxOutputBytes: 32768,
  get description() { return t("tools.desc.vm.fs.list"); },
  get promptDescription() { return toolPrompt(this.label, '{"path":"/ruta","maxEntries":120}'); },
  buildInputSchema(z) {
    return z.object({
      path: z.string().describe(t("tools.schema.vmFsListPath")),
      maxEntries: z.number().optional().describe(t("tools.schema.maxEntries")),
    });
  },
  normalizeArgs: normalizeListArgs,
  buildCommand(args) {
    const safePath = shellQuote(args.path);
    const limit = clampInt(args.maxEntries, 1, 300, 120);
    return captureCommand("ba-fs-list", [], [`p=${safePath}`, "rc=0", `if [ ! -e "$p" ]; then printf 'ERROR: not found: %s\\n' "$p"; rc=2; elif [ ! -d "$p" ]; then printf 'ERROR: not a directory: %s\\n' "$p"; ls -ld "$p" 2>&1; rc=2; else ls -la "$p" 2>&1 | sed -n '1,${limit}p'; rc=$?; fi`, "exit $rc"].join("; "));
  },
  formatResult(result, args) {
    return standardFormat(this, result, args, () => summaryHeadTarget("common.phrase.listingOf", args.path), () => summaryCouldNot("common.verb.list", args.path));
  },
};
