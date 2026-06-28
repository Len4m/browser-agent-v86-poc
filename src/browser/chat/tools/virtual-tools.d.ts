/* eslint-disable @typescript-eslint/consistent-type-imports */
type BaVirtualToolDefinition = import("./types").ToolDefinition;

declare module "virtual:ba-tools" {
  export const TOOL_DEFINITIONS: BaVirtualToolDefinition[];
}
