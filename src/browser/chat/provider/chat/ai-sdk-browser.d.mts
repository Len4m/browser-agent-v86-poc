import type * as ai from "ai";
import type * as zod from "zod";
import type * as ollama from "../ai-sdk/ollama-browser-model";
import type * as runner from "../ai-sdk/browser-agent-runner";
import type * as textToolMiddleware from "../ai-sdk/transformers-text-tool-middleware";
import type * as transformers from "@browser-ai/transformers-js";

export declare const tool: typeof ai.tool;
export declare const wrapLanguageModel: typeof ai.wrapLanguageModel;
export declare const transformersJS: typeof transformers.transformersJS;
export declare const ollamaBrowser: typeof ollama.ollamaBrowser;
export declare const z: typeof zod.z;
export declare const runAgentStreamTurn: typeof runner.runAgentStreamTurn;
export declare const textChunkFromStreamPart: typeof runner.textChunkFromStreamPart;
export declare const reasoningChunkFromStreamPart: typeof runner.reasoningChunkFromStreamPart;
export declare const transformersReasoningMiddleware: typeof textToolMiddleware.transformersReasoningMiddleware;
export declare const transformersTextToolMiddleware: typeof textToolMiddleware.transformersTextToolMiddleware;
