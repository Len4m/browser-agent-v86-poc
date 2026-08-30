import { t } from "../../../app/i18n";
import { clampInt, shellQuote } from "../../../app/text-utils";
import { normalizeVmPath, standardFormat, summaryCouldNot, summaryHeadTarget, toolPrompt } from "../shared";
import type { ToolArgs, ToolDefinition } from "../types";

function normalizeReadArgs(args: ToolArgs = {}): ToolArgs {
  return { path: normalizeVmPath(args.path || ""), maxBytes: clampInt(args.maxBytes, 256, 32768, 8192) };
}

export const toolDefinition: ToolDefinition = {
  name: "vm_fs_read", get label() { return t("tools.name.vm_fs_read"); }, riskLevel: 1, category: "vm.fs",
  requiresVm: true, requiresConsole: true, timeoutMs: 12000, maxOutputBytes: 32768,
  get description() { return t("tools.desc.vm_fs_read"); },
  get promptDescription() { return toolPrompt(this.label, '{"path":"/ruta/archivo","maxBytes":8192}'); },
  buildInputSchema(z) {
    return z.object({
      path: z.string().describe(t("tools.schema.vmFsReadPath")),
      maxBytes: z.number().optional().describe(t("tools.schema.maxBytes")),
    });
  },
  normalizeArgs: normalizeReadArgs,
  buildCommand(args) {
    const safePath = shellQuote(args.path);
    const bytes = clampInt(args.maxBytes, 256, 32768, 8192);
    return [`p=${safePath}`, "rc=0", `if [ ! -e "$p" ]; then printf 'ERROR: not found: %s\\n' "$p"; rc=2; elif [ ! -f "$p" ]; then printf 'ERROR: not a regular file: %s\\n' "$p"; ls -ld "$p" 2>&1; rc=2; else head -c ${bytes} "$p" 2>&1; rc=$?; printf '\\012'; fi`, "exit $rc"].join("; ");
  },
  formatResult(result, args) {
    return standardFormat(this, result, args, () => summaryHeadTarget("common.phrase.readOf", args.path), () => summaryCouldNot("common.verb.read", args.path));
  },
};
