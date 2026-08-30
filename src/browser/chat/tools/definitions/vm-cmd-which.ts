import { t } from "../../../app/i18n";
import { shellQuote } from "../../../app/text-utils";
import { captureCommand, standardFormat, summaryCouldNot, summaryHeadTarget, textValue, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "vm_cmd_which", get label() { return t("tools.name.vm_cmd_which"); }, riskLevel: 1, category: "vm.system",
  requiresVm: true, requiresConsole: true, timeoutMs: 8000, maxOutputBytes: 12000,
  get description() { return t("tools.desc.vm_cmd_which"); },
  get promptDescription() { return toolPrompt(this.label, '{"commands":["curl","nmap"]}'); },
  buildInputSchema(z) {
    return z.object({
      commands: z.array(z.string()).describe(t("tools.schema.whichCommands")),
    });
  },
  normalizeArgs(args = {}) {
    const commands = Array.isArray(args.commands) ? args.commands : textValue(args.command || args.commands).split(/[\s,]+/);
    const clean = commands.map((c) => textValue(c).trim()).filter(Boolean).slice(0, 20);
    if (!clean.length) throw new Error(t("tools.error.commandAtLeastOne"));
    if (clean.some((c) => !/^[A-Za-z0-9_.+-]+$/.test(c))) throw new Error(t("tools.error.commandInvalidName"));
    return { commands: clean };
  },
  buildCommand(args) {
    const commands = Array.isArray(args.commands) ? args.commands.map(String) : [];
    const checks = commands.map((cmd) => `if command -v ${shellQuote(cmd)} >/dev/null 2>&1; then printf '%s: ' ${shellQuote(cmd)}; command -v ${shellQuote(cmd)}; else printf '%s: missing\\n' ${shellQuote(cmd)}; fi`).join("; ");
    return captureCommand("ba-cmd-which", [], checks);
  },
  formatResult(result, args) {
    const commands = Array.isArray(args.commands) ? args.commands.map(String) : [];
    return standardFormat(this, result, args, () => summaryHeadTarget("common.phrase.checkOf", commands.join(", ")), () => summaryCouldNot("common.verb.check", t("common.noun.commands")));
  },
};
