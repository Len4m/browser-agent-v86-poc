import { t } from "../../../app/i18n";
import { clampInt, shellQuote } from "../../../app/text-utils";
import { captureCommand, standardFormat, textValue, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

function normalizeShellCommand(value: unknown): string {
  const command = textValue(value).trim();
  if (!command) throw new Error(t("tools.error.shellEmpty"));
  if (command.includes("\0")) throw new Error(t("tools.error.commandNull"));
  if (command.length > 2400) throw new Error(t("tools.error.commandTooLong"));
  if (/\brm\s+-[^\n;]*r[^\n;]*f[^\n;]*(?:\/\s*$|\/\s|\/\*|--no-preserve-root)/i.test(command)) {
    throw new Error(t("tools.error.blockedRmrf"));
  }
  if (/\b(?:mkfs|mkswap|fdisk|parted)\b/i.test(command)) {
    throw new Error(t("tools.error.blockedDisk"));
  }
  if (/\bdd\b[^\n;]*\bof=\/dev\//i.test(command)) {
    throw new Error(t("tools.error.blockedDevWrite"));
  }
  return command;
}

export const toolDefinition: ToolDefinition = {
  name: "vm_sh_exec", get label() { return t("tools.name.vm_sh_exec"); }, riskLevel: 3, category: "vm.exec",
  requiresVm: true, requiresConsole: true, timeoutMs: 30000, maxOutputBytes: 32768,
  get description() { return t("tools.desc.vm_sh_exec"); },
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
