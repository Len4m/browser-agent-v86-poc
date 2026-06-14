export type ToolArgValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | string[]
  | number[]
  | boolean[];

export type ToolArgs = Record<string, ToolArgValue>;

export interface SecurityLevel {
  level: number;
  id: string;
  label: string;
  description: string;
}

export interface ToolExecutionResult {
  id?: string;
  ok?: boolean;
  cancelled?: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  summary?: string;
  truncated?: boolean;
  toolCall?: NormalizedToolCall;
}

export interface ToolDefinition {
  name: string;
  label: string;
  riskLevel: number;
  category: string;
  requiresVm: boolean;
  requiresConsole: boolean;
  timeoutMs: number;
  maxOutputBytes?: number;
  requiredPackages?: string[];
  description: string;
  promptDescription: string;
  normalizeArgs?: (args?: ToolArgs) => ToolArgs;
  buildCommand: (args: ToolArgs) => string;
  formatResult?: (result: ToolExecutionResult, args: ToolArgs) => ToolExecutionResult;
}

export interface ToolMetadata {
  name: string;
  label: string;
  riskLevel: number;
  category: string;
  description: string;
  promptDescription: string;
  requiresVm: boolean;
  requiresConsole: boolean;
  timeoutMs: number;
  requiredPackages: string[];
}

export interface RuntimeToolContext {
  vmPresent: boolean;
  vmReady: boolean;
  consoleReady: boolean;
  backgroundToolsReady: boolean;
  toolsConsoleAvailable: boolean;
  pendingCommand: boolean;
  backgroundToolBusy: boolean;
  agentBusy: boolean;
  activeProfile: string;
  networkConfigured: boolean;
  diskMounted: boolean;
}

export interface NormalizedToolCall {
  type: "tool_call";
  tool: string;
  arguments: ToolArgs;
  reason: string;
  riskLevel: number;
}

interface ListToolsOptions {
  profileId?: string;
  includeUnavailable?: boolean;
}

interface PromptRuntimeContextCompactOptions {
  toolNames?: string[] | null;
}

export interface LlmToolRegistryApi {
  SECURITY_LEVELS: SecurityLevel[];
  PROFILE_TOOL_NAMES: Record<string, string[]>;
  getTool: (name: unknown) => ToolDefinition | undefined;
  listTools: (options?: ListToolsOptions) => ToolMetadata[];
  normalizeToolCall: (value: unknown) => NormalizedToolCall;
  buildPromptRuntimeContext: () => string;
  buildPromptRuntimeContextCompact: (options?: PromptRuntimeContextCompactOptions) => string;
  assertVmToolPreconditions: () => RuntimeToolContext;
}

export interface RunToolOptions {
  source?: string;
  allowedToolNames?: string[] | null;
}

export interface ToolExecutorApi {
  getAutonomyMaxLevel: () => number;
  setAutonomyMaxLevel: (level: unknown) => number;
  runTool: (toolCall: unknown, options?: RunToolOptions) => Promise<ToolExecutionResult>;
}
