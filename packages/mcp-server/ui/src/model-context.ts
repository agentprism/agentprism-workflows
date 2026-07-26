// Projects the run model onto `ui/update-model-context` pushes: the panel keeps the
// host's model context current so the agent never needs to re-call `workflow`
// (action:"inspect") just to learn run status — each re-call would render another panel
// instance (per-call rendering is the MCP Apps baseline until ext-apps#430 lands reuse).
// Pushes overwrite (the spec keeps only the last update), so each one is a complete,
// self-contained snapshot rather than a delta.
import type { RunModel } from "./state.js";
import { agentCount } from "./state.js";

const ERROR_SNIPPET_CHARS = 140;
const MAX_FAILED_LISTED = 3;
/** Signature field separator — escaped, never a literal NUL, so this file stays text in git. */
const SIGNATURE_SEP = "\u0000";

/** Machine-readable snapshot mirrored into structuredContent. */
export interface ModelContextSnapshot {
  runId: string;
  workflowName?: string;
  status: RunModel["status"];
  finalized: boolean;
  currentPhase?: string;
  phasesSeen: number;
  agentsStarted: number;
  agentsSettled: number;
  agentsFailed: number;
  totalTokens?: number;
  costUsd?: number;
  banner?: string;
}

/**
 * The change key for pushes. Only transitions that alter what the agent would act on are
 * included — per-token transcript churn and progress rows must not trigger a push.
 */
export function modelContextSignature(model: RunModel): string {
  const { settled, failed } = settleCounts(model);
  return [
    model.status,
    model.finalized ? "final" : "live",
    model.phases.at(-1) ?? "",
    model.nodes.size,
    settled,
    failed,
    model.banner ?? "",
  ].join(SIGNATURE_SEP);
}

/** True when the transition warrants an immediate push instead of a throttled one. */
export function isUrgentStatus(model: RunModel): boolean {
  return model.finalized || model.status === "paused";
}

/** Minimum spacing between routine pushes; urgent transitions ignore it. */
export const MODEL_CONTEXT_MIN_INTERVAL_MS = 2000;

/**
 * Trailing-edge delay before the next push. Urgent transitions (paused/terminal) go out
 * immediately; routine ones wait out the remainder of the interval since the last push, so a
 * burst of transitions collapses into one push carrying the latest state.
 */
export function nextPushDelayMs(urgent: boolean, lastPushAt: number, now: number): number {
  if (urgent) return 0;
  return Math.max(0, Math.min(MODEL_CONTEXT_MIN_INTERVAL_MS, MODEL_CONTEXT_MIN_INTERVAL_MS - (now - lastPushAt)));
}

export function buildModelContextSnapshot(model: RunModel): ModelContextSnapshot {
  const { settled, failed } = settleCounts(model);
  const snapshot: ModelContextSnapshot = {
    runId: model.runId,
    status: model.status,
    finalized: model.finalized,
    phasesSeen: model.phases.length,
    agentsStarted: model.nodes.size,
    agentsSettled: settled,
    agentsFailed: failed,
  };
  if (model.name !== undefined) snapshot.workflowName = model.name;
  const currentPhase = model.phases.at(-1);
  if (currentPhase !== undefined) snapshot.currentPhase = currentPhase;
  if (model.usage?.total !== undefined) snapshot.totalTokens = model.usage.total;
  if (model.usage?.cost !== undefined) snapshot.costUsd = model.usage.cost;
  if (model.banner !== undefined) snapshot.banner = model.banner;
  return snapshot;
}

/** One compact, self-contained status paragraph for the model's context. */
export function formatModelContextText(model: RunModel): string {
  const snapshot = buildModelContextSnapshot(model);
  const name = snapshot.workflowName ?? "workflow";
  const lines: string[] = [];
  const statusWord =
    snapshot.status === "completed"
      ? "completed"
      : snapshot.status === "failed"
        ? "FAILED"
        : snapshot.status === "aborted"
          ? "stopped"
          : snapshot.status === "paused"
            ? "PAUSED"
            : "running";
  const phasePart = snapshot.currentPhase !== undefined ? `, phase "${snapshot.currentPhase}"` : "";
  const agentsTotal = agentCount(model);
  lines.push(
    `[run-monitor] Workflow "${name}" (runId ${snapshot.runId}) is ${statusWord}${phasePart}. ` +
      `Agents: ${snapshot.agentsSettled}/${agentsTotal} settled` +
      (snapshot.agentsFailed > 0 ? `, ${snapshot.agentsFailed} failed` : "") +
      (snapshot.totalTokens !== undefined ? `. Tokens: ${snapshot.totalTokens}` : "") +
      ".",
  );
  if (snapshot.banner !== undefined) lines.push(snapshot.banner);
  const failedNodes = [...model.nodes.values()].filter((node) => node.status === "error");
  for (const node of failedNodes.slice(0, MAX_FAILED_LISTED)) {
    const reason = node.errorText ?? node.errorCode ?? "unknown error";
    lines.push(`Failed agent "${node.label}": ${snippet(reason)}`);
  }
  if (failedNodes.length > MAX_FAILED_LISTED) {
    lines.push(`(+${failedNodes.length - MAX_FAILED_LISTED} more failed agents)`);
  }
  lines.push(
    model.finalized
      ? `This status is final; call workflow action:"await" or "inspect" with runId ${snapshot.runId} only if you need the full machine-readable outcome.`
      : "This status is pushed automatically by the live run-monitor panel and is current; do not call workflow action:\"inspect\" just to check on this run.",
  );
  return lines.join("\n");
}

function settleCounts(model: RunModel): { settled: number; failed: number } {
  let settled = 0;
  let failed = 0;
  for (const node of model.nodes.values()) {
    if (node.status === "done" || node.status === "error") settled += 1;
    if (node.status === "error") failed += 1;
  }
  return { settled, failed };
}

function snippet(text: string): string {
  return text.length <= ERROR_SNIPPET_CHARS ? text : `${text.slice(0, ERROR_SNIPPET_CHARS)}…`;
}
