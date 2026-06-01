// @ts-nocheck
// Browser Agent v86 - 16b AI SDK tool bridge
// Builds ai.tool() definitions from BA_LLM_TOOL_REGISTRY for streamText / ToolLoopAgent.

(function initLLMAiSdkTools() {
  function buildModelText(toolCall, toolResult, artifact) {
    if (toolResult?.cancelled) return t("common.toolCancelledByUser");
    if (artifact) {
      const text = window.BA_LLM_ARTIFACTS?.formatArtifactForModel?.(artifact);
      if (text) return text;
    }

    const payload = String(toolResult?.stdout || toolResult?.stderr || "");
    const truncatedSuffix = t("tools.modelText.payloadTruncated");
    const fallback = window.BA_LLM_ARTIFACTS?.truncateMiddle?.(payload, 5000) || {
      text: payload.length > 5000 ? `${payload.slice(0, 5000)}\n${truncatedSuffix}` : payload,
      truncated: payload.length > 5000,
    };

    const lines = [
      toolResult?.ok
        ? t("tools.modelText.ok", { tool: toolCall.tool })
        : t("tools.modelText.fail", { tool: toolCall.tool }),
      toolResult?.summary ? t("tools.modelText.summary", { summary: toolResult.summary }) : "",
      t("tools.modelText.code", { code: toolResult?.code ?? t("common.unknownCode") }),
      "---BEGIN_TOOL_PAYLOAD---",
      fallback.text || t("common.noUsefulOutput"),
      "---END_TOOL_PAYLOAD---",
      toolResult?.truncated || fallback.truncated ? t("tools.modelText.truncatedNote") : "",
    ];
    return lines.filter(Boolean).join("\n");
  }

  function getProfileId() {
    const stateProfile = window.state?.activeRuntime?.profile?.id;
    if (stateProfile && stateProfile !== "manual") return stateProfile;
    return document.getElementById("vm-profile")?.value || "manual";
  }

  function buildZodSchemas(z) {
    return {
      "vm.fs.list": z.object({
        path: z.string().describe(t("tools.schema.vmFsListPath")),
        maxEntries: z.number().optional().describe(t("tools.schema.maxEntries")),
      }),
      "vm.fs.read": z.object({
        path: z.string().describe(t("tools.schema.vmFsReadPath")),
        maxBytes: z.number().optional().describe(t("tools.schema.maxBytes")),
      }),
      "vm.fs.write": z.object({
        path: z.string().describe(t("tools.schema.vmFsWritePath")),
        content: z.string().describe(t("tools.schema.vmFsWriteContent")),
        createDirs: z.boolean().optional().describe(t("tools.schema.createDirs")),
        overwrite: z.boolean().optional().describe(t("tools.schema.overwrite")),
      }),
      "vm.cmd.which": z.object({
        commands: z.array(z.string()).describe(t("tools.schema.whichCommands")),
      }),
      "vm.sys.info": z.object({}),
      "vm.console.status": z.object({}),
      "vm.pkg.info": z.object({
        filter: z.string().optional().describe(t("tools.schema.pkgFilter")),
      }),
      "web.curl.head": z.object({
        url: z.string().describe(t("tools.schema.urlHttp")),
        followRedirects: z.boolean().optional(),
        insecure: z.boolean().optional(),
        timeoutSec: z.number().optional(),
      }),
      "web.curl.fetch_text": z.object({
        url: z.string().describe(t("tools.schema.urlHttp")),
        maxBytes: z.number().optional(),
        followRedirects: z.boolean().optional(),
        insecure: z.boolean().optional(),
        timeoutSec: z.number().optional(),
      }),
      "net.dns.lookup": z.object({
        host: z.string().describe(t("tools.schema.hostOrDomain")),
        type: z.string().optional().describe(t("tools.schema.dnsType")),
      }),
      "net.ip.status": z.object({}),
      "net.nmap.quick": z.object({
        target: z.string().describe(t("tools.schema.ipOrHost")),
        ports: z.string().optional().describe(t("tools.schema.ports")),
        topPorts: z.number().optional(),
      }),
      "web.ffuf.dir_light": z.object({
        url: z.string().describe(t("tools.schema.ffufUrl")),
        wordlist: z.string().optional(),
        threads: z.number().optional(),
        rate: z.number().optional(),
        maxTimeSec: z.number().optional().describe(t("tools.schema.ffufMaxTimeSec")),
        filterLength: z.string().optional().describe(t("tools.schema.ffufFilterLength")),
        filterWords: z.string().optional().describe(t("tools.schema.ffufFilterWords")),
        filterLines: z.string().optional().describe(t("tools.schema.ffufFilterLines")),
      }),
      "vm.python.exec": z.object({
        code: z.string().describe(t("tools.schema.pythonCode")),
      }),
      "web.httpx.probe": z.object({
        url: z.string().describe(t("tools.schema.url")),
        rate: z.number().optional(),
        threads: z.number().optional(),
        timeoutSec: z.number().optional(),
        techDetect: z.boolean().optional().describe(t("tools.schema.techDetect")),
      }),
      "web.nikto.quick": z.object({
        url: z.string().describe(t("tools.schema.url")),
        maxTimeSec: z.number().optional(),
        timeoutSec: z.number().optional().describe(t("tools.schema.timeoutSec")),
        tuning: z.string().optional().describe(t("tools.schema.niktoTuning")),
      }),
      "tls.openssl.cert": z.object({
        host: z.string().describe(t("tools.schema.host")),
        port: z.number().optional(),
      }),
      "vm.sh.exec": z.object({
        command: z.string().describe(t("tools.schema.shCommand")),
        timeoutMs: z.number().optional(),
        maxOutputBytes: z.number().optional(),
      }),
    };
  }

  function buildToolOutputSchema(z) {
    return z.object({
      ok: z.boolean(),
      code: z.number().nullable(),
      tool: z.string(),
      summary: z.string(),
      artifactId: z.string().nullable(),
      sizeBytes: z.number(),
      truncated: z.boolean(),
      modelText: z.string(),
    });
  }

  function buildAiSdkTools(options = {}) {
    const { userText = "", source = "agent", onToolStart, onToolEnd, toolNames = null } = options;
    const registry = window.BA_LLM_TOOL_REGISTRY;
    const sdk = window.BA_AISDK;
    if (!registry || !sdk?.tool || !sdk?.z) return {};

    const z = sdk.z;
    const schemas = buildZodSchemas(z);
    const outputSchema = buildToolOutputSchema(z);
    const profileId = options.profileId || getProfileId();
    const toolList = registry.listTools({ profileId });
    const allow = toolNames ? new Set(toolNames) : null;
    const tools = {};

    for (const meta of toolList) {
      if (allow && !allow.has(meta.name)) continue;
      const toolDef = registry.getTool(meta.name);
      if (!toolDef) continue;

      const schema = schemas[meta.name] || z.object({}).passthrough();
      const description = [toolDef.label, toolDef.promptDescription || toolDef.description].filter(Boolean).join(" — ");

      tools[meta.name] = sdk.tool({
        description,
        inputSchema: schema,
        outputSchema,
        toModelOutput({ output }) {
          return {
            type: "text",
            value: output?.modelText || t("tools.error.noModelOutput"),
          };
        },
        execute: async (args) => {
          const toolCall = {
            type: "tool_call",
            tool: meta.name,
            arguments: args,
            reason: t("tools.exec.reasonModelRequest", { name: meta.name }),
            riskLevel: toolDef.riskLevel,
          };

          onToolStart?.({ toolCall, toolDef });

          window.BA_LLM_RESOURCE_GOVERNOR?.start?.("tool", meta.name);
          let toolResult;
          try {
            toolResult = await window.BA_LLM_TOOL_EXECUTOR.runTool(toolCall, { source });
          } finally {
            window.BA_LLM_RESOURCE_GOVERNOR?.finish?.("tool");
          }

          const artifact = window.BA_LLM_ARTIFACTS?.storeToolResult?.(toolCall, toolResult, { userText, source }) || null;
          if (onToolEnd) await onToolEnd({ toolCall, toolResult, artifact, toolDef });

          return {
            ok: Boolean(toolResult?.ok),
            code: Number.isFinite(Number(toolResult?.code)) ? Number(toolResult.code) : null,
            tool: meta.name,
            summary: String(toolResult?.summary || toolResult?.stderr || ""),
            artifactId: artifact?.id || null,
            sizeBytes: Number(artifact?.sizeBytes || 0),
            truncated: Boolean(toolResult?.truncated || artifact?.truncated),
            modelText: buildModelText(toolCall, toolResult, artifact),
          };
        },
      });
    }

    return tools;
  }

  window.BA_buildAiSdkTools = buildAiSdkTools;
})();
