// Browser Agent v86 - chat submit controller.

import { $, state } from "../../app/state";
import { addMessage } from "../../vm/runtime-assets";
import { getLlmState } from "../state/chat-state";
import { llmAgent } from "./agent-loop";

export async function sendChat(event: Event): Promise<void> {
  event.preventDefault();

  if (llmAgent.isChatOperationActive()) {
    llmAgent.stopActiveTurn();
    return;
  }

  const input = $<HTMLTextAreaElement>("chat-input");
  const text = input?.value.trim() || "";
  if (!input || !text || state.agentBusy || getLlmState()?.generating) return;
  input.value = "";
  addMessage("user", text);

  await llmAgent.handleUserMessage(text);
}
