import { t } from "../../../app/i18n";
import { buildWriteFileCommand, normalizeWriteArgs, standardFormat, summaryCouldNot, textValue, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "vm.fs.write", get label() { return t("tools.name.vm.fs.write"); }, riskLevel: 3, category: "vm.fs",
  requiresVm: true, requiresConsole: true, timeoutMs: 12000, maxOutputBytes: 12000,
  requiredPackages: ["python3"],
  get description() { return t("tools.desc.vm.fs.write"); },
  get promptDescription() { return toolPrompt(this.label, '{"path":"/tmp/nota.txt","content":"texto","createDirs":false,"overwrite":false}'); },
  buildInputSchema(z) {
    return z.object({
      path: z.string().describe(t("tools.schema.vmFsWritePath")),
      content: z.string().describe(t("tools.schema.vmFsWriteContent")),
      createDirs: z.boolean().optional().describe(t("tools.schema.createDirs")),
      overwrite: z.boolean().optional().describe(t("tools.schema.overwrite")),
    });
  },
  normalizeArgs: normalizeWriteArgs,
  buildCommand: buildWriteFileCommand,
  formatResult(result, args) {
    return standardFormat(this, result, args, () => t("tools.summary.fsWriteOk", { path: textValue(args.path) }), () => summaryCouldNot("common.verb.write", args.path));
  },
};
