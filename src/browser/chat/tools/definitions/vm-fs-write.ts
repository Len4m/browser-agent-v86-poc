import { t } from "../../../app/i18n";
import { shellQuote, utf8ToBase64 } from "../../../app/text-utils";
import { captureCommand, normalizeBool, normalizeVmPath, standardFormat, summaryCouldNot, textValue, toolPrompt } from "../shared";
import type { ToolArgs, ToolDefinition } from "../types";

const MAX_WRITE_CONTENT_BYTES = 16 * 1024;

function isBlockedVmWritePath(path: unknown): boolean {
  return /^(?:\/dev|\/proc|\/sys)(?:\/|$)/.test(textValue(path));
}

function normalizeWriteArgs(args: ToolArgs = {}): ToolArgs {
  const rawPath = textValue(args.path).trim();
  if (!rawPath) throw new Error(t("tools.error.pathEmpty"));
  const path = normalizeVmPath(rawPath, rawPath);
  if (path === "." || path.endsWith("/")) throw new Error(t("tools.error.writePathNotFile"));
  if (isBlockedVmWritePath(path)) throw new Error(t("tools.error.writePathBlocked"));
  const content = textValue(args.content);
  if (content.includes("\0")) throw new Error(t("tools.error.contentNull"));
  const contentBytes = new TextEncoder().encode(content).length;
  if (contentBytes > MAX_WRITE_CONTENT_BYTES) {
    throw new Error(t("tools.error.contentTooLong", { max: MAX_WRITE_CONTENT_BYTES }));
  }
  return {
    path,
    content,
    createDirs: normalizeBool(args.createDirs ?? args.createDirectories, false),
    overwrite: normalizeBool(args.overwrite, false),
  };
}

function buildWriteFileCommand(args: ToolArgs): string {
  const payload = utf8ToBase64(textValue(args.content));
  const code = [
    "import base64, os, sys",
    "path = sys.argv[1]",
    "create_dirs = sys.argv[2] == '1'",
    "overwrite = sys.argv[3] == '1'",
    "data = base64.b64decode(sys.argv[4].encode('ascii'), validate=True)",
    "parent = os.path.dirname(path) or '.'",
    "if create_dirs: os.makedirs(parent, exist_ok=True)",
    "if parent != '.' and not os.path.isdir(parent): raise SystemExit('ERROR: parent directory not found: %s' % parent)",
    "if os.path.exists(path) and not os.path.isfile(path): raise SystemExit('ERROR: not a regular file: %s' % path)",
    "if os.path.exists(path) and not overwrite: raise SystemExit('ERROR: file exists: %s' % path)",
    "with open(path, 'wb') as handle: handle.write(data)",
    "print('WROTE %d bytes to %s' % (len(data), path))",
  ].join("\n");
  return captureCommand("ba-fs-write", ["python3"], `python3 -c ${shellQuote(code)} ${shellQuote(args.path)} ${args.createDirs ? "1" : "0"} ${args.overwrite ? "1" : "0"} ${shellQuote(payload)}`);
}

export const toolDefinition: ToolDefinition = {
  name: "vm.fs.write", get label() { return t("tools.name.vm.fs.write"); }, riskLevel: 3, category: "vm.fs",
  requiresVm: true, requiresConsole: true, timeoutMs: 12000, maxOutputBytes: 12000,
  requiredPackages: ["python3"],
  runtimeChecks: [{ label: "python3", command: "command -v python3" }],
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
