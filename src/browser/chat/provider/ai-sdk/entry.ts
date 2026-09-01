// Re-exports consumed by ai-sdk-bridge.ts (esbuild -> public/assets/chat/ai-sdk-browser.mjs)
import { zodSchemaFactory } from "./zod-schema-factory";

export {
  tool,
  wrapLanguageModel,
} from "ai";
export { transformersJS } from "@browser-ai/transformers-js";
export { ollamaBrowser } from "./ollama-browser-model";
export {
  runAgentStreamTurn,
  textChunkFromStreamPart,
  reasoningChunkFromStreamPart,
} from "./browser-agent-runner";
export {
  transformersReasoningMiddleware,
  transformersTextToolMiddleware,
} from "./transformers-text-tool-middleware";

// The application only needs this small schema surface. Exporting Zod's full
// namespace also bundles every locale and unrelated schema constructor.
export const z = zodSchemaFactory;
