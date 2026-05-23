// @ts-nocheck
// Built to public/assets/chat/workers/llm-browser-ai.worker.mjs via npm run build
import { TransformersJSWorkerHandler } from "@browser-ai/transformers-js";

const handler = new TransformersJSWorkerHandler();
self.onmessage = (msg) => {
  handler.onmessage(msg);
};
