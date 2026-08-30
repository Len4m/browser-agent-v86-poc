// Browser Agent v86 - AI SDK tool bridge.
// Builds ai.tool() definitions from the typed LLM tool registry for the agent runner.

import { state } from "../../app/state";
import { t } from "../../app/i18n";
import {
  getAiSdk,
  type AiSdkSchemaLike,
  type AiSdkToolExecutionOptions,
  type AiSdkZodLike,
} from "../provider/ai-sdk-runtime";
import { llmArtifacts, type LlmArtifact } from "../runtime/artifact-store";
import { llmResourceGovernor } from "../runtime/resource-governor";
import { isRecord, textValue, throwIfAborted, toToolArgs } from "./shared";
import { llmToolExecutor } from "./tool-executor";
import { llmToolRegistry } from "./tool-registry";
import type {
  NormalizedToolCall,
  ToolDefinition,
  ToolExecutionResult,
} from "./types";

export interface BuildAiSdkToolsOptions {
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

interface SerialToolQueue {
  run: <T>(task: () => Promise<T>, abortSignal?: AbortSignal) => Promise<T>;
}

export function createSerialToolQueue(): SerialToolQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>, abortSignal?: AbortSignal): Promise<T> {
      const scheduled = tail.then(async () => {
        throwIfAborted(abortSignal);
        return task();
      });
      tail = scheduled.then(() => undefined, () => undefined);
      return scheduled;
    },
  };
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

function buildToolOutputSchema(z: AiSdkZodLike): AiSdkSchemaLike {
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
  const outputSchema = buildToolOutputSchema(z);
  const allowedToolNames = Array.isArray(toolNames) ? [...new Set(toolNames.filter(Boolean))] : null;
  const availableToolNames = llmToolRegistry.listToolNames({ profileId });
  const available = new Set(availableToolNames);
  const toolNamesToRegister = allowedToolNames
    ? allowedToolNames.filter((name) => available.has(name))
    : availableToolNames;
  const tools: Record<string, unknown> = {};
  const executionQueue = createSerialToolQueue();

  for (const toolName of toolNamesToRegister) {
    const toolDef = llmToolRegistry.getTool(toolName);
    if (!toolDef) continue;

    const schema = toolDef.buildInputSchema?.(z) || z.object({}).passthrough();
    const description = [toolDef.label, toolDef.promptDescription || toolDef.description].filter(Boolean).join(" - ");

    tools[toolDef.name] = sdk.tool({
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
      async execute(args, { toolCallId, abortSignal }: AiSdkToolExecutionOptions): Promise<AiToolOutput> {
        const toolCall: NormalizedToolCall = {
          type: "tool_call",
          toolCallId,
          tool: toolDef.name,
          arguments: toToolArgs(args),
          reason: t("tools.exec.reasonModelRequest", { name: toolDef.name }),
          riskLevel: toolDef.riskLevel,
        };

        return executionQueue.run(async () => {
          throwIfAborted(abortSignal);
          await onToolStart?.({ toolCall, toolDef });

          llmResourceGovernor.start("tool", toolDef.name);
          let toolResult: ToolExecutionResult;
          try {
            toolResult = await llmToolExecutor.runTool(toolCall, {
              source,
              allowedToolNames: toolNamesToRegister,
              toolCallId,
              abortSignal,
            });
          } finally {
            llmResourceGovernor.finish("tool");
          }
          throwIfAborted(abortSignal);

          const artifact = llmArtifacts.storeToolResult(toolCall, toolResult, { userText, source });
          await onToolEnd?.({ toolCall, toolResult, artifact, toolDef });

          return {
            ok: Boolean(toolResult.ok),
            code: Number.isFinite(Number(toolResult.code)) ? Number(toolResult.code) : null,
            tool: toolDef.name,
            summary: toolResult.summary || toolResult.stderr || "",
            artifactId: artifact.id,
            sizeBytes: Number(artifact.sizeBytes || 0),
            truncated: Boolean(toolResult.truncated || artifact.truncated),
            modelText: buildModelText(toolCall, toolResult, artifact),
          };
        }, abortSignal);
      },
    });
  }

  return tools;
}
