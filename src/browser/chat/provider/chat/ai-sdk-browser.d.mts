import type * as ai from "ai";
import type * as zod from "zod";
import type * as ollama from "../ai-sdk/ollama-browser-model";
import type * as runner from "../ai-sdk/browser-agent-runner";
import type * as textToolMiddleware from "../ai-sdk/transformers-text-tool-middleware";
import type * as transformersWorkerModel from "../ai-sdk/transformers-worker-model";

type LanguageModelV3 = Extract<ai.LanguageModel, { specificationVersion: "v3" }>;
type BrowserSessionLanguageModel = LanguageModelV3 & {
  availability?: () => Promise<string>;
  createSessionWithProgress?: (onProgress?: (progress: unknown) => void) => Promise<unknown>;
};

export declare const tool: typeof ai.tool;
export declare const wrapLanguageModel: typeof ai.wrapLanguageModel;
export declare const extractReasoningMiddleware: typeof ai.extractReasoningMiddleware;
export declare const transformersWorker: typeof transformersWorkerModel.transformersWorker;
export declare const ollamaBrowser: typeof ollama.ollamaBrowser;
export declare const z: typeof zod.z;
export declare const runAgentStreamTurn: typeof runner.runAgentStreamTurn;
export declare const textChunkFromStreamPart: typeof runner.textChunkFromStreamPart;
export declare const reasoningChunkFromStreamPart: typeof runner.reasoningChunkFromStreamPart;
export declare const transformersTextToolMiddleware: typeof textToolMiddleware.transformersTextToolMiddleware;
