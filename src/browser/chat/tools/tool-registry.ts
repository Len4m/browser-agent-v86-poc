// Browser Agent v86 - LLM tool registry facade.
// Tool definitions live in ./definitions; this module owns profile policy,
// runtime context and prompt/catalog projection.

import { state } from "../../app/state";
import { t } from "../../app/i18n";
import { backgroundToolsApi } from "../../vm/background-tools-serial1";
import { getSelectedProfile, type VmProfile } from "../../vm/profile-config";
import { TOOL_DEFINITIONS } from "virtual:ba-tools";
import { isRecord, normalizeToolName, textValue, toToolArgs } from "./shared";
import type {
  LlmToolRegistryApi,
  NormalizedToolCall,
  RuntimeToolContext,
  SecurityLevel,
  ToolDefinition,
  ToolMetadata,
  ToolRuntimeCheck,
} from "./types";

function isVmProfile(value: unknown): value is VmProfile {
  return isRecord(value) && typeof value.id === "string";
}

function activeRuntimeProfile(): VmProfile | null {
  if (!isRecord(state.activeRuntime)) return null;
  return isVmProfile(state.activeRuntime.profile) ? state.activeRuntime.profile : null;
}

function selectedProfileId(): string {
  const profileSelect = document.getElementById("vm-profile");
  return profileSelect instanceof HTMLSelectElement ? profileSelect.value : "manual";
}

export const llmToolRegistry: LlmToolRegistryApi = (() => {
  const SECURITY_LEVELS: SecurityLevel[] = [
    { level: 0, id: "none", get label() { return t("tools.level.none.label"); }, get description() { return t("tools.level.none.desc"); } },
    { level: 1, id: "read", get label() { return t("tools.level.read.label"); }, get description() { return t("tools.level.read.desc"); } },
    { level: 2, id: "diagnostic", get label() { return t("tools.level.diagnostic.label"); }, get description() { return t("tools.level.diagnostic.desc"); } },
    { level: 3, id: "active", get label() { return t("tools.level.active.label"); }, get description() { return t("tools.level.active.desc"); } },
    { level: 99, id: "free", get label() { return t("tools.level.free.label"); }, get description() { return t("tools.level.free.desc"); } },
  ];

  const MANUAL_TOOL_NAMES = [
    "vm_python_exec",
    "vm_sh_exec",
    "vm_fs_list",
    "vm_fs_read",
    "vm_fs_write",
    "vm_cmd_which",
    "web_curl_head",
    "vm_sys_info",
    "vm_console_status",
    "vm_pkg_info",
    "web_curl_fetch_text",
  ];

  const PROFILE_TOOL_NAMES: Record<string, string[]> = {
    manual: MANUAL_TOOL_NAMES,
  };

  const TOOLS: Record<string, ToolDefinition> = Object.fromEntries(
    TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
  );

  function baseRuntimeContext(): RuntimeToolContext {
    const activeProfile = activeRuntimeProfile()?.id
      || getSelectedProfile()?.id
      || selectedProfileId();
    const backgroundToolsReady = backgroundToolsApi.enabled();
    return {
      vmPresent: Boolean(state.vm),
      vmReady: Boolean(state.vmReady),
      consoleReady: Boolean(state.consoleTabs?.ready),
      backgroundToolsReady,
      toolsConsoleAvailable: Boolean(backgroundToolsReady || state.consoleTabs?.tabs?.some((tab) => tab.id === "tools")),
      pendingCommand: Boolean(state.pending),
      backgroundToolBusy: Boolean(state.bgTools?.pending),
      agentBusy: Boolean(state.agentBusy),
      activeProfile,
      networkConfigured: Boolean(state.networkConfigured),
      diskMounted: Boolean(state.diskMounted),
    };
  }

  function profileForId(profileId: string): VmProfile | undefined {
    const runtimeProfile = activeRuntimeProfile();
    if (runtimeProfile?.id === profileId) return runtimeProfile;
    return state.profiles.find((item): item is VmProfile => isVmProfile(item) && item.id === profileId);
  }

  function rawAllowedToolNames(profileId: string): string[] {
    if (profileId === "manual") return MANUAL_TOOL_NAMES;
    const profile = profileForId(profileId);
    if (!profile || !Array.isArray(profile.allowedTools)) return [];
    return profile.allowedTools.map(normalizeToolName).filter(Boolean);
  }

  function hasRequiredPackages(tool: ToolDefinition, profileId: string): boolean {
    const requiredPackages = Array.isArray(tool.requiredPackages) ? tool.requiredPackages : [];
    if (!requiredPackages.length || profileId === "manual") return true;
    const profile = profileForId(profileId);
    if (!profile || !Array.isArray(profile.packages)) return false;
    const packages = new Set(profile.packages);
    return requiredPackages.every((packageName) => packages.has(packageName));
  }

  function isToolEnabledForProfile(tool: ToolDefinition | undefined, profileId = baseRuntimeContext().activeProfile): boolean {
    if (!tool) return false;
    if (!rawAllowedToolNames(profileId).includes(tool.name)) return false;
    return hasRequiredPackages(tool, profileId);
  }

  function assertVmToolPreconditions(): RuntimeToolContext {
    const ctx = baseRuntimeContext();
    if (!ctx.vmPresent) throw new Error(t("tools.error.vmNotBooted"));
    if (!ctx.vmReady) throw new Error(t("tools.error.vmShellNotReady"));
    if (!ctx.toolsConsoleAvailable) throw new Error(t("tools.error.toolsConsoleMissing"));
    // Las tools del agente LLM van por serial1, no por serial0/consola visible.
    // state.agentBusy solo marca bloqueo de la consola principal (snapshot, comandos manuales, etc.)
    // y no debe impedir vm_fs_* mientras el modelo planifica en GPU.
    if (ctx.backgroundToolBusy) throw new Error(t("tools.error.serial1Busy"));
    if (ctx.pendingCommand) throw new Error(t("tools.error.serial0Pending"));
    return ctx;
  }

  function getTool(name: unknown): ToolDefinition | undefined { return TOOLS[normalizeToolName(name)]; }

  function toolMetadata(tool: ToolDefinition): ToolMetadata {
    return {
      name: tool.name,
      label: tool.label,
      riskLevel: tool.riskLevel,
      category: tool.category,
      description: tool.description,
      promptDescription: tool.promptDescription,
      requiresVm: tool.requiresVm,
      requiresConsole: tool.requiresConsole,
      timeoutMs: tool.timeoutMs,
      requiredPackages: tool.requiredPackages || [],
    };
  }

  function toolRuntimeChecks(tool: ToolDefinition): ToolRuntimeCheck[] {
    const checks = Array.isArray(tool.runtimeChecks) ? tool.runtimeChecks : [];
    return checks
      .filter((check) => isRecord(check))
      .map((check) => ({
        label: textValue(check.label).trim(),
        command: textValue(check.command).trim(),
      }))
      .filter((check) => Boolean(check.label && check.command));
  }

  function listToolNames({ profileId = baseRuntimeContext().activeProfile, includeUnavailable = false } = {}): string[] {
    return rawAllowedToolNames(profileId)
      .filter((name, index, names) => names.indexOf(name) === index)
      .filter((name) => {
        const tool = getTool(name);
        if (!tool) return false;
        return includeUnavailable || hasRequiredPackages(tool, profileId);
      });
  }

  function listTools({ profileId = baseRuntimeContext().activeProfile, includeUnavailable = false } = {}): ToolMetadata[] {
    return listToolNames({ profileId, includeUnavailable })
      .map((name) => getTool(name))
      .filter((tool): tool is ToolDefinition => Boolean(tool))
      .map(toolMetadata);
  }

  function listToolRuntimeChecks({ profileId = baseRuntimeContext().activeProfile, includeUnavailable = false } = {}): ToolRuntimeCheck[] {
    const out: ToolRuntimeCheck[] = [];
    const seen = new Set<string>();
    for (const name of listToolNames({ profileId, includeUnavailable })) {
      const tool = getTool(name);
      if (!tool) continue;
      for (const check of toolRuntimeChecks(tool)) {
        if (seen.has(check.label)) continue;
        seen.add(check.label);
        out.push(check);
      }
    }
    return out;
  }

  function buildPromptToolCatalog(): string {
    return listTools().map((tool) => [
      `- ${tool.name}`,
      t("prompt.catalog.security", { level: tool.riskLevel }),
      t("prompt.catalog.usage", { usage: tool.promptDescription }),
      t("prompt.catalog.requirements", {
        vm: tool.requiresVm ? t("prompt.catalog.vmBooted") : t("prompt.catalog.noVm"),
        console: tool.requiresConsole ? t("prompt.catalog.serial1") : "",
      }),
    ].join("\n")).join("\n");
  }

  function buildPromptRuntimeContextCompact({ toolNames = null }: { toolNames?: string[] | null } = {}): string {
    const ctx = baseRuntimeContext();
    const allowed = new Set(listToolNames({ profileId: ctx.activeProfile }));
    const enabled = toolNames?.length
      ? toolNames.filter((name, index, names) => names.indexOf(name) === index && allowed.has(name))
      : [...allowed];
    const vm = ctx.vmReady ? "ok" : (ctx.vmPresent ? "boot" : "off");
    const serial1 = ctx.toolsConsoleAvailable ? "ok" : "no";
    const toolsLine = enabled.length
      ? enabled.slice(0, 10).join(", ") + (enabled.length > 10 ? ", …" : "")
      : t("prompt.none");
    return [
      t("prompt.runtime.compact", {
        vm, serial1,
        profile: ctx.activeProfile || "manual",
        net: ctx.networkConfigured ? t("common.yes") : t("common.no"),
      }),
      t("prompt.runtime.activeTools", { count: enabled.length, tools: toolsLine }),
    ].join("\n");
  }

  function buildPromptRuntimeContext(): string {
    const ctx = baseRuntimeContext();
    const yes = t("common.yes");
    const no = t("common.no");
    return [
      t("prompt.runtime.title"),
      t("prompt.runtime.vmBooted", { v: ctx.vmPresent ? yes : no }),
      t("prompt.runtime.shellReady", { v: ctx.vmReady ? yes : no }),
      t("prompt.runtime.consoleReady", { v: ctx.consoleReady ? yes : no }),
      t("prompt.runtime.toolsReady", { v: ctx.toolsConsoleAvailable ? yes : no }),
      t("prompt.runtime.profile", { profile: ctx.activeProfile || "manual" }),
      t("prompt.runtime.network", { v: ctx.networkConfigured ? yes : no }),
      t("prompt.runtime.disk", { v: ctx.diskMounted ? yes : no }),
      t("prompt.runtime.serials", {
        s0: ctx.pendingCommand || ctx.agentBusy ? t("common.busyFem") : t("prompt.free"),
        s1: ctx.backgroundToolBusy ? t("common.busy") : t("prompt.free"),
      }),
      t("prompt.runtime.availableTools"),
      buildPromptToolCatalog(),
    ].join("\n");
  }

  function normalizeToolCall(value: unknown): NormalizedToolCall {
    if (!isRecord(value)) throw new Error(t("tools.error.responseNotObject"));
    const toolName = value.tool || value.name;
    if (value.type && value.type !== "tool_call") {
      throw new Error(t("tools.error.unsupportedInvocation", { type: textValue(value.type) }));
    }
    const tool = getTool(toolName);
    if (!tool) throw new Error(t("tools.error.toolNotAvailable", { name: toolName ? textValue(toolName) : t("tools.error.emptyToolName") }));
    if (!isToolEnabledForProfile(tool)) {
      const ctx = baseRuntimeContext();
      throw new Error(t("tools.error.toolNotEnabled", { tool: tool.name, profile: ctx.activeProfile }));
    }
    const args = tool.normalizeArgs ? tool.normalizeArgs(toToolArgs(value.arguments)) : toToolArgs(value.arguments);
    return { type: "tool_call", tool: tool.name, arguments: args, reason: (textValue(value.reason) || t("tools.exec.reasonDefault")).slice(0, 400), riskLevel: tool.riskLevel };
  }

  return {
    SECURITY_LEVELS,
    PROFILE_TOOL_NAMES,
    getTool,
    listTools,
    listToolNames,
    listToolRuntimeChecks,
    normalizeToolCall,
    buildPromptRuntimeContext,
    buildPromptRuntimeContextCompact,
    assertVmToolPreconditions,
  };
})();
