// Built to public/assets/chat/workers/llm-browser-ai.worker.mjs via npm run build
import { TransformersJSWorkerHandler } from "@browser-ai/transformers-js";

const handler = new TransformersJSWorkerHandler();
type WorkerHandlerMessage = Parameters<TransformersJSWorkerHandler["onmessage"]>[0];

self.onmessage = (msg: MessageEvent<unknown>) => {
  handler.onmessage(msg as WorkerHandlerMessage);
};
