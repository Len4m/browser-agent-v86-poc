import { t, tn } from "../../app/i18n";
import { llmArtifacts, type LlmArtifactSummary } from "../runtime/artifact-store";
import { llmContextBudget } from "../runtime/context-budget";
import { llmResourceGovernor } from "../runtime/resource-governor";
import { createTextElement, isRecord, numberValue, textValue } from "./dom-utils";
import { ensureLlmState, getSelectedModel } from "./state-utils";

export interface ResourceContext {
  estimatedTokens?: number;
  chars?: number;
}

interface ResourceUpdateExtra {
  context?: ResourceContext;
}

export function resourceContext(value: unknown): ResourceContext | undefined {
  if (!isRecord(value)) return undefined;
  return {
    estimatedTokens: numberValue(value.estimatedTokens),
    chars: numberValue(value.chars),
  };
}

function artifactLineText(artifact: LlmArtifactSummary): string {
  const pathValue = textValue(artifact.args?.path);
  const path = pathValue ? ` · ${pathValue}` : "";
  const stateText = artifact.ok ? t("common.okLower") : t("panel.llm.resources.stateError");
  const size = artifact.sizeBytes ? ` · ${Math.ceil(artifact.sizeBytes / 1024)} KB` : "";
  const truncated = artifact.truncated ? t("panel.llm.resources.truncated") : "";
  return t("panel.llm.resources.artifactLine", {
    id: artifact.id,
    tool: artifact.tool || t("panel.llm.resources.toolFallback"),
    state: stateText,
    size,
    truncated,
    path,
  });
}

function artifactContextLimit(): number {
  const policy = llmContextBudget.getPolicy(getSelectedModel());
  const limit = Number(policy.maxToolResultCharsForSynthesis ?? policy.maxToolResultChars);
  return Number.isFinite(limit) ? Math.max(0, limit) : 0;
}

function createArtifactResourceRow(summary: LlmArtifactSummary): HTMLDivElement {
  const artifact = llmArtifacts.findById(summary.id);
  const attached = Boolean(summary.contextAttached);
  const canAttach = artifactContextLimit() > 0;
  const row = document.createElement("div");
  row.className = `ba-llm-artifact-row${attached ? " is-attached" : ""}`;
  row.dataset.artifactId = summary.id;

  const label = document.createElement("button");
  label.type = "button";
  label.className = "ba-llm-artifact-summary";
  label.textContent = artifactLineText(summary) + (attached ? t("panel.llm.resources.artifactAttachedSuffix") : "");
  label.setAttribute("aria-label", t("panel.llm.resources.artifactPreviewTitle", { id: summary.id }));
  label.setAttribute("aria-expanded", "false");

  const actions = document.createElement("div");
  actions.className = "ba-llm-artifact-actions";

  const attach = document.createElement("button");
  attach.type = "button";
  attach.className = `ba-llm-artifact-action${attached ? " is-attached-action" : ""}`;
  attach.textContent = attached
    ? t("panel.llm.resources.artifactDetach")
    : (canAttach ? t("panel.llm.resources.artifactAttach") : t("panel.llm.resources.artifactAttachUnavailable"));
  attach.title = attached
    ? t("panel.llm.resources.artifactDetachTitle", { id: summary.id })
    : (canAttach
      ? t("panel.llm.resources.artifactAttachTitle", { id: summary.id })
      : t("panel.llm.resources.artifactAttachUnavailableTitle", { id: summary.id }));
  attach.disabled = !attached && !canAttach;
  attach.addEventListener("click", () => {
    if (attached) llmArtifacts.clearContextArtifact();
    else llmArtifacts.attachToContext(summary.id);
    updateResourceLines();
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ba-llm-artifact-action ba-llm-artifact-delete ba-icon-only";
  remove.setAttribute("aria-label", t("panel.llm.resources.artifactDeleteTitle", { id: summary.id }));
  remove.title = t("panel.llm.resources.artifactDeleteTitle", { id: summary.id });
  remove.addEventListener("click", () => {
    llmArtifacts.remove(summary.id);
    updateResourceLines();
  });

  actions.append(attach, remove);

  const preview = document.createElement("pre");
  preview.className = "ba-llm-artifact-preview";
  preview.hidden = true;

  label.addEventListener("click", () => {
    const willOpen = preview.hidden;
    preview.textContent = willOpen
      ? (artifact ? llmArtifacts.formatArtifactForDisplay(artifact, { maxChars: 5000 }) : t("common.noOutputParen"))
      : "";
    preview.hidden = !willOpen;
    label.setAttribute("aria-expanded", String(willOpen));
  });

  row.append(label, actions, preview);
  return row;
}

export function updateResourceLines(extra: ResourceUpdateExtra = {}): void {
  const box = document.getElementById("ba-llm-resource-lines");
  if (!box) return;
  const llm = ensureLlmState();
  const snapshot = llmResourceGovernor.getSnapshot();
  const storedContext = resourceContext(llm.lastContextInspect);
  const context = extra.context || storedContext || null;
  if (extra.context) llm.lastContextInspect = extra.context;
  const selected = getSelectedModel();
  const policy = llmContextBudget.getPolicy(selected);
  const contextWindow = selected.contextWindowTokens ?? policy.contextWindowTokens;
  const safeInput = policy.safeInputTokens;
  const maxOutput = policy.maxNewTokensDefault;
  const planOutput = policy.maxNewTokensForPlan;
  const budgetLine = contextWindow && safeInput && maxOutput
    ? t("panel.llm.resources.budget", { context: contextWindow, input: safeInput, output: maxOutput })
      + (planOutput ? t("panel.llm.resources.budgetPlan", { plan: planOutput }) : "")
    : t("panel.llm.resources.budgetPending");
  const artifactCount = numberValue(snapshot.artifacts ?? llm.artifacts?.length ?? 0);
  const artifactBadge = document.getElementById("ba-llm-artifact-count");
  if (artifactBadge) {
    artifactBadge.textContent = tn("panel.llm.artifactCount", artifactCount);
    artifactBadge.title = snapshot.lastArtifactId
      ? t("panel.llm.resources.lastArtifact", { id: snapshot.lastArtifactId })
      : t("panel.llm.resources.artifactsSaved");
  }
  const recentArtifacts = llmArtifacts.listSummaries({ limit: 3 }).filter((item): item is LlmArtifactSummary => Boolean(item));
  const attachedArtifact = llmArtifacts.getContextArtifact();
  const attachedSummary = attachedArtifact ? llmArtifacts.summarizeArtifact(attachedArtifact) : null;
  const artifactsById = new Map<string, LlmArtifactSummary>();
  for (const artifact of recentArtifacts.slice().reverse()) artifactsById.set(artifact.id, artifact);
  if (attachedSummary && !artifactsById.has(attachedSummary.id)) artifactsById.set(attachedSummary.id, attachedSummary);
  const artifactRows = Array.from(artifactsById.values()).map(createArtifactResourceRow);
  const attachedLine = attachedSummary
    ? (artifactContextLimit() > 0
      ? t("panel.llm.resources.artifactAttachedLine", { id: attachedSummary.id })
      : t("panel.llm.resources.artifactAttachedBlockedLine", { id: attachedSummary.id }))
    : "";
  const operationLine = (snapshot.lastOperation
    ? t("panel.llm.resources.operationLine", { op: snapshot.lastOperation })
    : t("panel.llm.resources.operation"))
    + (snapshot.llmBusy ? t("panel.llm.resources.llmBusy") : "")
    + (snapshot.toolBusy ? t("panel.llm.resources.toolBusy") : "");
  const lines: HTMLElement[] = [
    createTextElement(
      "span",
      "",
      t("panel.llm.resources.artifacts", { count: artifactCount })
        + (snapshot.lastArtifactId ? ` · ${snapshot.lastArtifactId}` : "")
        + (attachedLine ? ` · ${attachedLine}` : ""),
    ),
    ...artifactRows,
    createTextElement("span", "", budgetLine),
    createTextElement("span", "", context
      ? t("panel.llm.resources.contextActive", { tokens: context.estimatedTokens || 0, chars: context.chars || 0 })
      : t("panel.llm.resources.context")),
    createTextElement("span", "", operationLine),
  ];
  if (artifactCount) {
    const button = document.createElement("button");
    button.id = "ba-llm-clear-artifacts";
    button.type = "button";
    button.textContent = t("panel.llm.resources.clearArtifacts");
    button.addEventListener("click", () => {
      llmArtifacts.clear();
      updateResourceLines();
    });
    lines.push(button);
  }
  box.replaceChildren(...lines);
}
