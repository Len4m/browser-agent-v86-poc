// Browser Agent v86 - AI SDK tool bridge.
// Builds ai.tool() definitions from the typed LLM tool registry for the agent runner.

import { state } from "../../app/state";
import { t } from "../../app/i18n";
import { getAiSdk, type AiSdkSchemaLike, type AiSdkZodLike } from "../provider/ai-sdk-runtime";
import { llmArtifacts, type LlmArtifact } from "../runtime/artifact-store";
import { llmResourceGovernor } from "../runtime/resource-governor";
import { llmToolExecutor } from "./tool-executor";
import { llmToolRegistry } from "./tool-registry";
import type { NormalizedToolCall, ToolArgs, ToolArgValue, ToolDefinition, ToolExecutionResult } from "./types";

interface BuildAiSdkToolsOptions {
  userText?: string;
  source?: string;
  onToolStart?: (event: { toolCall: NormalizedToolCall; toolDef: ToolDefinition }) => void | Promise<void>;
  onToolEnd?: (event: {
    toolCall: NormalizedToolCall;
    toolResult: ToolExecutionResult;
    artifact: LlmArtifact | null;
    toolDef: ToolDefinition;
  }) => void | Promise<void>;
  toolNames?: string[] | null;
  profileId?: string;
}

interface AiToolOutput {
  ok: boolean;
  code: number | null;
  tool: string;
  summary: string;
  artifactId: string | null;
  sizeBytes: number;
  truncated: boolean;
  modelText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isToolArgValue(value: unknown): value is ToolArgValue {
  if (value == null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
}

function toToolArgs(value: unknown): ToolArgs {
  if (!isRecord(value)) return {};
  const out: ToolArgs = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isToolArgValue(entry) ? entry : textValue(entry);
  }
  return out;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function activeRuntimeProfileId(): string {
  if (isRecord(state.activeRuntime) && isRecord(state.activeRuntime.profile)) {
    return textValue(state.activeRuntime.profile.id);
  }
  return "";
}

function getProfileId(): string {
  const stateProfile = activeRuntimeProfileId();
  if (stateProfile && stateProfile !== "manual") return stateProfile;
  const profileSelect = document.getElementById("vm-profile");
  return profileSelect instanceof HTMLSelectElement ? profileSelect.value : "manual";
}

function buildModelText(toolCall: NormalizedToolCall, toolResult: ToolExecutionResult | null | undefined, artifact: LlmArtifact | null): string {
  if (toolResult?.cancelled) return t("common.toolCancelledByUser");
  if (artifact) {
    const text = llmArtifacts.formatArtifactForModel(artifact);
    if (text) return text;
  }

  const payload = toolResult?.stdout || toolResult?.stderr || "";
  const truncatedSuffix = t("tools.modelText.payloadTruncated");
  const fallback = llmArtifacts.truncateMiddle(payload, 5000);
  const fallbackText = fallback.text || (payload.length > 5000 ? `${payload.slice(0, 5000)}\n${truncatedSuffix}` : payload);
  const code = toolResult?.code ?? t("common.unknownCode");

  const lines = [
    toolResult?.ok
      ? t("tools.modelText.ok", { tool: toolCall.tool })
      : t("tools.modelText.fail", { tool: toolCall.tool }),
    toolResult?.summary ? t("tools.modelText.summary", { summary: toolResult.summary }) : "",
    t("tools.modelText.code", { code }),
    "---BEGIN_TOOL_PAYLOAD---",
    fallbackText || t("common.noUsefulOutput"),
    "---END_TOOL_PAYLOAD---",
    toolResult?.truncated || fallback.truncated ? t("tools.modelText.truncatedNote") : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function buildZodSchemas(z: AiSdkZodLike): Record<string, AiSdkSchemaLike> {
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

function buildToolOutputSchema(z: AiSdkZodLike): AiSdkSchemaLike {
  return z.object({
    ok: z.boolean(),
    code: z.number().nullable?.() || z.number(),
    tool: z.string(),
    summary: z.string(),
    artifactId: z.string().nullable?.() || z.string(),
    sizeBytes: z.number(),
    truncated: z.boolean(),
    modelText: z.string(),
  });
}

export function buildAiSdkTools({
  userText = "",
  source = "agent",
  onToolStart,
  onToolEnd,
  toolNames = null,
  profileId = getProfileId(),
}: BuildAiSdkToolsOptions = {}): Record<string, unknown> {
  const sdk = getAiSdk();
  if (!sdk?.tool || !sdk.z) return {};

  const z = sdk.z;
  const schemas = buildZodSchemas(z);
  const outputSchema = buildToolOutputSchema(z);
  const toolList = llmToolRegistry.listTools({ profileId });
  const allow = toolNames ? new Set(toolNames) : null;
  const tools: Record<string, unknown> = {};

  for (const meta of toolList) {
    if (allow && !allow.has(meta.name)) continue;
    const toolDef = llmToolRegistry.getTool(meta.name);
    if (!toolDef) continue;

    const schema = schemas[meta.name] || z.object({}).passthrough?.() || z.object({});
    const description = [toolDef.label, toolDef.promptDescription || toolDef.description].filter(Boolean).join(" - ");

    tools[meta.name] = sdk.tool({
      description,
      inputSchema: schema,
      outputSchema,
      toModelOutput({ output }) {
        const modelText = isRecord(output) ? textValue(output.modelText) : "";
        return {
          type: "text",
          value: modelText || t("tools.error.noModelOutput"),
        };
      },
      async execute(args): Promise<AiToolOutput> {
        const toolCall: NormalizedToolCall = {
          type: "tool_call",
          tool: meta.name,
          arguments: toToolArgs(args),
          reason: t("tools.exec.reasonModelRequest", { name: meta.name }),
          riskLevel: toolDef.riskLevel,
        };

        await onToolStart?.({ toolCall, toolDef });

        llmResourceGovernor.start("tool", meta.name);
        let toolResult: ToolExecutionResult;
        try {
          toolResult = await llmToolExecutor.runTool(toolCall, { source });
        } finally {
          llmResourceGovernor.finish("tool");
        }

        const artifact = llmArtifacts.storeToolResult(toolCall, toolResult, { userText, source });
        await onToolEnd?.({ toolCall, toolResult, artifact, toolDef });

        return {
          ok: Boolean(toolResult.ok),
          code: Number.isFinite(Number(toolResult.code)) ? Number(toolResult.code) : null,
          tool: meta.name,
          summary: toolResult.summary || toolResult.stderr || "",
          artifactId: artifact.id,
          sizeBytes: Number(artifact.sizeBytes || 0),
          truncated: Boolean(toolResult.truncated || artifact.truncated),
          modelText: buildModelText(toolCall, toolResult, artifact),
        };
      },
    });
  }

  return tools;
}
