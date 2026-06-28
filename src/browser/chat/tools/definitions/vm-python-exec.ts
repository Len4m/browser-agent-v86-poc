import { t } from "../../../app/i18n";
import { shellQuote } from "../../../app/text-utils";
import { captureCommand, standardFormat, textValue, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "vm.python.exec", get label() { return t("tools.name.vm.python.exec"); }, riskLevel: 3, category: "vm.exec",
  requiresVm: true, requiresConsole: true, timeoutMs: 25000, maxOutputBytes: 32768,
  requiredPackages: ["python3"],
  runtimeChecks: [{ label: "python3", command: "command -v python3" }],
  get description() { return t("tools.desc.vm.python.exec"); },
  get promptDescription() { return toolPrompt(this.label, '{"code":"print(\'hi\')"}'); },
  buildInputSchema(z) {
    return z.object({
      code: z.string().describe(t("tools.schema.pythonCode")),
    });
  },
  normalizeArgs(args = {}) {
    const code = textValue(args.code).trim();
    if (!code) throw new Error(t("tools.error.pythonEmpty"));
    if (code.length > 2500) throw new Error(t("tools.error.pythonTooLong"));
    return { code };
  },
  buildCommand(args) {
    return captureCommand("ba-python", ["python3"], `python3 -c ${shellQuote(args.code)}`);
  },
  formatResult(result) {
    return standardFormat(this, result, {}, () => t("common.summaryExecuted", { label: "Python" }), () => t("common.pythonFailed"));
  },
};
