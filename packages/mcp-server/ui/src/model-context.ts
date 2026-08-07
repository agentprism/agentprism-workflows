// Projects the run model onto `ui/update-model-context` pushes: the panel keeps the
// host's model context current so the agent never needs to re-call `workflow`
// (action:"inspect") just to learn run status — each re-call would render another panel
// instance (per-call rendering is the MCP Apps baseline until ext-apps#430 lands reuse).
// Pushes overwrite (the spec keeps only the last update), so each one is a complete,
// self-contained snapshot rather than a delta.
//
// SCOPE: this channel is for MILESTONES ONLY. Exactly three things push:
//   1. an agent call goes terminal (settled: done or error)
//   2. the workflow itself changes terminal-ish state (completed/failed/aborted, or paused)
//   3. a new phase starts
// Nothing else. Banners, progress rows, transcript tokens, agent STARTS, and token/cost
// tallies never push on their own: they are live-view detail that belongs in the panel and in
// the event log, which the agent can read on demand via the `workflow` tool. Pushing
// per-second status churn would flood the model's context with information it did not ask
// for, and in hosts that treat a context update as conversational input it would wake the
// agent over and over.
import type { RunModel } from "./state.js";
import { agentCount } from "./state.js";

const ERROR_SNIPPET_CHARS = 140;
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
 * The change key for pushes. It contains ONLY milestone facts, so a signature change is by
 * construction an agent settling, a new phase starting, or the run reaching a terminal/paused
 * state.
 *
 * Deliberately excluded: banner, agents STARTED, tokens, and cost. Those move constantly
 * during a healthy run and carry no decision the agent needs to make mid-flight.
 */
export function modelContextSignature(model: RunModel): string {
  const { settled } = settleCounts(model);
  return [
    // Terminal/paused workflow state. Running-vs-pending is not a milestone.
    model.finalized ? `final:${model.status}` : model.status === "paused" ? "paused" : "live",
    // One increment per agent that reaches a terminal outcome.
    settled,
    // Phase boundaries are the workflow's own structural checkpoints. `phases` collapses a
    // consecutively re-announced title, so a re-announced identical phase is not a new one.
    model.phases.length,
  ].join(SIGNATURE_SEP);
}

/** True when the transition warrants an immediate push instead of a throttled one. */
export function isUrgentStatus(model: RunModel): boolean {
  return model.finalized || model.status === "paused";
}

/**
 * True once the panel has folded at least one events page — the workflow name is known or the
 * cursor has advanced past the seed. Gates the very first model-context push: the effect seeds an
 * empty model and bumps a render before any page lands, and pushing that seed leaks the "workflow"
 * name fallback and an agents-settled 0/0 into the model's context before real data has folded.
 */
export function hasFoldedEvents(model: RunModel): boolean {
  return model.name !== undefined || model.cursor > 0;
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

/**
 * One compact, self-contained status snapshot for the model's context, shaped as the
 * documented YAML-frontmatter-plus-prose form so hosts and models can parse the fields
 * without reading the prose. Failure detail is summarized, not enumerated: naming every
 * failed agent turns this channel into a log feed.
 */
export function formatModelContextText(model: RunModel): string {
  const snapshot = buildModelContextSnapshot(model);
  const name = snapshot.workflowName ?? "workflow";
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
  const agentsTotal = agentCount(model);

  const front: string[] = [
    `run-id: ${snapshot.runId}`,
    `workflow: ${yamlScalar(name)}`,
    `status: ${snapshot.status}`,
    `finalized: ${snapshot.finalized}`,
  ];
  if (snapshot.currentPhase !== undefined) {
    // A phase start is one of the three push triggers, so name the phase and its ordinal: the
    // title alone does not tell the model how far along the run is.
    front.push(`current-phase: ${yamlScalar(snapshot.currentPhase)}`);
    front.push(`phase-number: ${snapshot.phasesSeen}`);
  }
  front.push(`agents-settled: ${snapshot.agentsSettled}/${agentsTotal}`);
  if (snapshot.agentsFailed > 0) front.push(`agents-failed: ${snapshot.agentsFailed}`);
  if (snapshot.totalTokens !== undefined) front.push(`total-tokens: ${snapshot.totalTokens}`);
  if (snapshot.costUsd !== undefined) front.push(`cost-usd: ${snapshot.costUsd}`);

  const lines: string[] = ["---", ...front, "---", ""];
  const phasePart =
    snapshot.currentPhase !== undefined
      ? `, phase ${snapshot.phasesSeen} "${snapshot.currentPhase}"`
      : "";
  lines.push(
    `The run-monitor panel is displaying workflow "${name}" (runId ${snapshot.runId}): ` +
      `${statusWord}${phasePart}, ${snapshot.agentsSettled}/${agentsTotal} agents settled` +
      (snapshot.agentsFailed > 0 ? `, ${snapshot.agentsFailed} failed` : "") +
      ".",
  );
  if (snapshot.banner !== undefined) lines.push(snapshot.banner);
  if (snapshot.agentsFailed > 0) {
    const firstFailure = [...model.nodes.values()].find((node) => node.status === "error");
    if (firstFailure) {
      const reason = firstFailure.errorText ?? firstFailure.errorCode ?? "unknown error";
      lines.push(
        `First failure — agent "${firstFailure.label}": ${snippet(reason)}` +
          (snapshot.agentsFailed > 1 ? ` (+${snapshot.agentsFailed - 1} more failed)` : ""),
      );
    }
  }
  lines.push(
    model.finalized
      ? `This status is final; call workflow action:"await" or "inspect" with runId ${snapshot.runId} only if you need the full machine-readable outcome, including per-agent detail.`
      : 'This status is pushed automatically by the live run-monitor panel and is current; do not call workflow action:"inspect" just to check on this run.',
  );
  return lines.join("\n");
}

/** Quote YAML scalars that would otherwise break parsing (colons, quotes, leading markers). */
function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(value) ? value : JSON.stringify(value);
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
