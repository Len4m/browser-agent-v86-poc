import { t } from "../../../app/i18n";
import { clampInt, shellQuote } from "../../../app/text-utils";
import { captureCommand, normalizeShellCommand, standardFormat, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "vm.sh.exec", get label() { return t("tools.name.vm.sh.exec"); }, riskLevel: 3, category: "vm.exec",
  requiresVm: true, requiresConsole: true, timeoutMs: 30000, maxOutputBytes: 32768,
  get description() { return t("tools.desc.vm.sh.exec"); },
  get promptDescription() { return toolPrompt(this.label, '{"command":"uname -a","timeoutMs":10000,"maxOutputBytes":8192}', t("tools.prompt.onlyIfNoSpecific")); },
  buildInputSchema(z) {
    return z.object({
      command: z.string().describe(t("tools.schema.shCommand")),
      timeoutMs: z.number().optional(),
      maxOutputBytes: z.number().optional(),
    });
  },
  normalizeArgs(args = {}) {
    return {
      command: normalizeShellCommand(args.command || args.cmd),
      timeoutMs: clampInt(args.timeoutMs, 1000, 30000, 10000),
      maxOutputBytes: clampInt(args.maxOutputBytes, 512, 32768, 8192),
    };
  },
  buildCommand(args) {
    return captureCommand("ba-sh-exec", ["sh"], `sh -lc ${shellQuote(args.command)}`);
  },
  formatResult(result, args) {
    const oldMax = this.maxOutputBytes;
    this.maxOutputBytes = clampInt(args.maxOutputBytes, 512, 32768, 8192);
    const formatted = standardFormat(this, result, args, () => t("common.summaryExecuted", { label: t("common.noun.shCommand") }), () => t("common.shCommandFailed"));
    this.maxOutputBytes = oldMax;
    return formatted;
  },
};
