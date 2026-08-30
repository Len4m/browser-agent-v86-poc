import { t } from "../../../app/i18n";
import { clampInt, shellQuote } from "../../../app/text-utils";
import { captureCommand, normalizeHost, standardFormat, textValue, toolPrompt } from "../shared";
import type { ToolDefinition } from "../types";

export const toolDefinition: ToolDefinition = {
  name: "tls_openssl_cert", get label() { return t("tools.name.tls_openssl_cert"); }, riskLevel: 2, category: "tls",
  requiresVm: true, requiresConsole: true, timeoutMs: 18000, maxOutputBytes: 16000,
  requiredPackages: ["openssl"],
  runtimeChecks: [{ label: "openssl", command: "command -v openssl" }],
  get description() { return t("tools.desc.tls_openssl_cert"); },
  get promptDescription() { return toolPrompt(this.label, '{"host":"example.com","port":443}'); },
  buildInputSchema(z) {
    return z.object({
      host: z.string().describe(t("tools.schema.host")),
      port: z.number().optional(),
    });
  },
  normalizeArgs(args = {}) {
    return { host: normalizeHost(args.host || args.target), port: clampInt(args.port, 1, 65535, 443) };
  },
  buildCommand(args) {
    const host = textValue(args.host);
    const port = clampInt(args.port, 1, 65535, 443);
    return captureCommand("ba-openssl-cert", ["openssl"], `echo | openssl s_client -servername ${shellQuote(host)} -connect ${shellQuote(`${host}:${port}`)} 2>/dev/null | openssl x509 -noout -subject -issuer -dates -fingerprint -sha256`);
  },
  formatResult(result, args) {
    const port = clampInt(args.port, 1, 65535, 443);
    const host = textValue(args.host);
    return standardFormat(this, result, args, () => t("common.summaryTlsOk", { host, port }), () => t("common.summaryTlsFail", { host, port }));
  },
};
