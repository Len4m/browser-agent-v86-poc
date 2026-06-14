// Browser Agent v86 - LLM resource governor.
// Lightweight resource coordination for running v86 + local LLM in the same
// browser tab. The current VM execution still runs through the main-thread
// serial bridge, but this governor prevents overlapping expensive operations.

import { state } from "../../app/state";
import { getLlmState, llmEventsApi } from "../state/chat-state";

export interface ResourceSnapshot {
  [key: string]: unknown;
  llmBusy: boolean;
  toolBusy: boolean;
  modelLoading: boolean;
  lastOOMAt: number;
  lastOperation: string;
  vmBusy: boolean;
  backgroundToolBusy: boolean;
  artifacts: number;
  lastArtifactId: string | null;
}

export interface LlmResourceGovernorApi {
  getSnapshot: () => ResourceSnapshot;
  canStart: (kind: string) => boolean;
  start: (kind: string, label?: string) => void;
  finish: (kind: string) => void;
  markGpuMemoryPressure: () => void;
  forceReleaseWork: () => void;
}

const stateRef = {
  llmBusy: false,
  toolBusy: false,
  modelLoading: false,
  lastOOMAt: 0,
  lastOperation: "inactiva",
};

function emit(): void {
  llmEventsApi.emit("resource", getSnapshot());
}

function getSnapshot(): ResourceSnapshot {
  const llmState = getLlmState();
  return {
    ...stateRef,
    vmBusy: Boolean(state.pending || state.agentBusy),
    backgroundToolBusy: Boolean(state.bgTools.pending),
    artifacts: llmState?.artifacts?.length || 0,
    lastArtifactId: llmState?.lastArtifactId || null,
  };
}

function canStart(kind: string): boolean {
  if (kind === "llm") {
    return !stateRef.llmBusy && !stateRef.toolBusy && !state.pending && !state.bgTools.pending;
  }
  if (kind === "tool") {
    return !stateRef.toolBusy && !stateRef.llmBusy && !state.pending && !state.bgTools.pending;
  }
  if (kind === "model-load") {
    return !stateRef.llmBusy && !stateRef.toolBusy && !state.bgTools.pending;
  }
  return true;
}

function start(kind: string, label = kind): void {
  if (kind === "llm") stateRef.llmBusy = true;
  if (kind === "tool") stateRef.toolBusy = true;
  if (kind === "model-load") stateRef.modelLoading = true;
  stateRef.lastOperation = label;
  emit();
}

function finish(kind: string): void {
  if (kind === "llm") stateRef.llmBusy = false;
  if (kind === "tool") stateRef.toolBusy = false;
  if (kind === "model-load") stateRef.modelLoading = false;
  stateRef.lastOperation = "inactiva";
  emit();
}

function markGpuMemoryPressure(): void {
  stateRef.lastOOMAt = Date.now();
  emit();
}

function forceReleaseWork(): void {
  stateRef.llmBusy = false;
  stateRef.toolBusy = false;
  if (stateRef.lastOperation !== "carga de modelo") stateRef.lastOperation = "inactiva";
  emit();
}

export const llmResourceGovernor: LlmResourceGovernorApi = {
  getSnapshot,
  canStart,
  start,
  finish,
  markGpuMemoryPressure,
  forceReleaseWork,
};
