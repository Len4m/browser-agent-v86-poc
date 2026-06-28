import { t } from "../../../app/i18n";
import { clampInt, shellQuote } from "../../../app/text-utils";
import { captureCommand, normalizeBool, normalizeUrl, standardFormat, summaryCouldNot, summaryHeadTarget, textValue, toolPrompt } from "../shared";
import type { ToolArgs, ToolDefinition } from "../types";

function buildCurlFetchTextCommand(args: ToolArgs): string {
  const maxBytes = clampInt(args.maxBytes, 512, 32768, 8192);
  const timeoutSec = clampInt(args.timeoutSec, 3, 25, 10);
  const rawBytes = Math.min(Math.max(maxBytes * 6, 65536), 262144);
  const flags = [
    "-sS", "--http1.1", "--no-keepalive", "-H", "Connection: close",
    "--connect-timeout", "4", "--max-time", String(timeoutSec),
    "--range", `0-${rawBytes - 1}`, "--max-filesize", String(rawBytes),
  ];
  if (args.followRedirects) flags.push("-L");
  if (args.insecure) flags.push("-k");

  const code = [
    "import re, sys",
    "from html.parser import HTMLParser",
    "path, max_bytes = sys.argv[1], int(sys.argv[2])",
    "data = open(path, 'rb').read()",
    "text = data.decode('utf-8', 'replace')",
    "sample = text[:4096]",
    "is_html = bool(re.search(r'(?is)<!doctype\\s+html|<html[\\s>]|<body[\\s>]|<head[\\s>]|<title[\\s>]|<(?:p|div|span|a|h[1-6]|li|br|table|section|article|main|nav|header|footer|meta|script|style)(?:\\s|>|/)', sample))",
    "class Extractor(HTMLParser):",
    "    blocks = set('address article aside blockquote br div dl dt dd fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td tfoot th thead tr ul'.split())",
    "    skips = set('script style noscript template svg canvas'.split())",
    "    def __init__(self):",
    "        super().__init__(convert_charrefs=True)",
    "        self.parts = []",
    "        self.skip = 0",
    "    def handle_starttag(self, tag, attrs):",
    "        tag = tag.lower()",
    "        if tag in self.skips:",
    "            self.skip += 1",
    "        elif tag == 'br':",
    "            self.parts.append('\\n')",
    "        elif tag in self.blocks:",
    "            self.parts.append('\\n')",
    "    def handle_endtag(self, tag):",
    "        tag = tag.lower()",
    "        if tag in self.skips and self.skip:",
    "            self.skip -= 1",
    "        elif tag in self.blocks:",
    "            self.parts.append('\\n')",
    "    def handle_data(self, value):",
    "        if not self.skip:",
    "            self.parts.append(value)",
    "def clean(value):",
    "    value = value.replace('\\r\\n', '\\n').replace('\\r', '\\n')",
    "    value = re.sub(r'[\\t\\f\\v ]+', ' ', value)",
    "    value = re.sub(r' *\\n *', '\\n', value)",
    "    value = re.sub(r'\\n{3,}', '\\n\\n', value)",
    "    return value.strip()",
    "if is_html:",
    "    parser = Extractor()",
    "    parser.feed(text)",
    "    output = clean(''.join(parser.parts)) or clean(text)",
    "else:",
    "    output = text.replace('\\r\\n', '\\n').replace('\\r', '\\n').strip()",
    "encoded = output.encode('utf-8')",
    "if len(encoded) > max_bytes:",
    "    output = encoded[:max_bytes].decode('utf-8', 'ignore').rstrip()",
    "sys.stdout.write(output)",
    "if output and not output.endswith('\\n'): sys.stdout.write('\\n')",
  ].join("\n");
  const curlCommand = `body="$tmp.body"; curl ${flags.map(shellQuote).join(" ")} -o "$body" ${shellQuote(textValue(args.url))}; rc=$?; if [ "$rc" -eq 0 ]; then python3 -c ${shellQuote(code)} "$body" ${maxBytes}; pyrc=$?; if [ "$pyrc" -ne 0 ]; then rc=$pyrc; fi; elif [ -s "$body" ]; then head -c ${maxBytes} "$body"; fi; rm -f "$body"; exit $rc`;
  return captureCommand("ba-curl-fetch", ["curl", "python3", "head"], curlCommand);
}

export const toolDefinition: ToolDefinition = {
  name: "web.curl.fetch_text", get label() { return t("tools.name.web.curl.fetch_text"); }, riskLevel: 2, category: "web.http",
  requiresVm: true, requiresConsole: true, timeoutMs: 35000, maxOutputBytes: 32768,
  requiredPackages: ["curl", "python3"],
  get description() { return t("tools.desc.web.curl.fetch_text"); },
  get promptDescription() { return toolPrompt(this.label, '{"url":"https://example.com","maxBytes":8192}'); },
  buildInputSchema(z) {
    return z.object({
      url: z.string().describe(t("tools.schema.urlHttp")),
      maxBytes: z.number().optional(),
      followRedirects: z.boolean().optional(),
      insecure: z.boolean().optional(),
      timeoutSec: z.number().optional(),
    });
  },
  normalizeArgs(args = {}) {
    return {
      url: normalizeUrl(args.url || args.target),
      followRedirects: normalizeBool(args.followRedirects, true),
      insecure: normalizeBool(args.insecure, true),
      timeoutSec: clampInt(args.timeoutSec, 3, 25, 10),
      maxBytes: clampInt(args.maxBytes, 512, 32768, 8192),
    };
  },
  buildCommand: buildCurlFetchTextCommand,
  formatResult(result, args) {
    return standardFormat(this, result, args, () => summaryHeadTarget("common.phrase.contentsOf", args.url), () => summaryCouldNot("common.verb.download", args.url));
  },
};
