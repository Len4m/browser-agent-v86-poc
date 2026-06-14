export interface AiSdkSchemaLike {
  describe: (text: string) => AiSdkSchemaLike;
  optional: () => AiSdkSchemaLike;
  nullable?: () => AiSdkSchemaLike;
  passthrough?: () => AiSdkSchemaLike;
}

export interface AiSdkZodLike {
  string: () => AiSdkSchemaLike;
  number: () => AiSdkSchemaLike;
  boolean: () => AiSdkSchemaLike;
  array: (schema: AiSdkSchemaLike) => AiSdkSchemaLike;
  object: (shape: Record<string, AiSdkSchemaLike>) => AiSdkSchemaLike;
}

export interface AiSdkToolConfig {
  description: string;
  inputSchema: AiSdkSchemaLike;
  outputSchema: AiSdkSchemaLike;
  toModelOutput: (args: { output?: unknown }) => { type: "text"; value: string };
  execute: (args: unknown) => Promise<unknown>;
}

export interface AiSdkGlobalApi {
  z: AiSdkZodLike;
  tool: (config: AiSdkToolConfig) => unknown;
}

type AiSdkWindow = Window & typeof globalThis & {
  BA_AISDK?: AiSdkGlobalApi;
};

export function getAiSdk(): AiSdkGlobalApi | null {
  return (window as AiSdkWindow).BA_AISDK || null;
}
