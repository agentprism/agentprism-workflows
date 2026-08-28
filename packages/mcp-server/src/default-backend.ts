import {
  probeHarnessConfig,
  type HarnessConfigReport,
  type PersistedRunState,
  type ValidateHarnessOptions,
  type ValidateProbeRunner,
  type ValidateWorkflowReport,
} from "@automatalabs/workflows";

import type {
  AutoDefaultBackendSelection,
  ProjectContext,
} from "./project-registry.js";

export const DEFAULT_BACKEND_ENV = "AGENTPRISM_DEFAULT_BACKEND";
const BUILTIN_BACKENDS = new Set(["claude", "codex", "opencode", "pi"]);

export type AutoDefaultBackendCandidate =
  | (AutoDefaultBackendSelection & { status: "ready" | "unknown" })
  | { backendId: string; status: "unavailable"; reason: string };

/** Admission error for a model-less workflow when every configured backend is definitely unusable. */
export class NoAutoDefaultBackendError extends Error {
  constructor(readonly candidates: readonly AutoDefaultBackendCandidate[]) {
    super(
      [
        "No usable default ACP backend was found for workflow agent() calls that omit model/tier.",
        ...candidates.map((candidate) => `- ${candidate.backendId}: ${candidate.reason}`),
        `Authenticate or install a backend, set ${DEFAULT_BACKEND_ENV} explicitly, or pin model on each agent() call.`,
      ].join("\n"),
    );
    this.name = "NoAutoDefaultBackendError";
  }
}

/** The mock dry run has already applied agentType/tier/phase/meta routing to call.model. */
export function workflowNeedsPinnedDefault(report: ValidateWorkflowReport): boolean {
  return report.dryRun?.agentCalls.some((call) => call.model === undefined && call.tier === undefined) === true;
}

/**
 * Preserve an automatic default across a resume. Current recordings carry defaultModel directly;
 * older recordings can be migrated when every model-less call was served by one recorded backend.
 */
export function recordedDefaultModel(source: PersistedRunState | null): string | undefined {
  if (!source) return undefined;
  if (typeof source.defaultModel === "string" && source.defaultModel.trim() !== "") return source.defaultModel;
  const backends = new Set(
    (source.calls ?? [])
      .filter((call) => call.kind === "agent" && call.modelRequested === undefined && call.backendId)
      .map((call) => call.backendId!),
  );
  return backends.size === 1 ? [...backends][0] : undefined;
}

function modelCatalogState(harness: ValidateHarnessOptions): "usable" | "empty" | "absent" {
  const option = (harness.options ?? []).find(
    (candidate) => candidate.id === "model" && candidate.type === "select",
  );
  if (!option || option.type !== "select") return "absent";
  const current = typeof option.currentValue === "string" ? option.currentValue.trim() : "";
  return current !== "" || option.options.length > 0 ? "usable" : "empty";
}

/**
 * Classify what the zero-token session/config probe actually proves. "ready" is deliberately
 * reserved for built-ins whose session-open path checks authorization (Codex) or whose model
 * catalog is credential-filtered (Pi). Other successful probes remain "unknown": session-ready,
 * but not a universal proof that a first prompt will authenticate.
 */
export function classifyAutoDefaultCandidates(
  report: HarnessConfigReport,
  customBackendIds: readonly string[] = [],
): AutoDefaultBackendCandidate[] {
  const customs = new Set(customBackendIds.map((id) => id.toLowerCase()));
  return report.harnessOptions.map((harness) => {
    const backendId = harness.backendId.toLowerCase();
    if (!harness.probed) {
      return {
        backendId: harness.backendId,
        status: "unavailable" as const,
        reason: `probe failed${harness.error ? ` — ${harness.error}` : ""}`,
      };
    }

    const builtIn = BUILTIN_BACKENDS.has(backendId) && !customs.has(backendId);
    const catalog = modelCatalogState(harness);
    if (builtIn && catalog === "empty") {
      return {
        backendId: harness.backendId,
        status: "unavailable" as const,
        reason: "session opened but the built-in advertised no usable default or selectable model",
      };
    }

    if (builtIn && backendId === "codex") {
      return {
        backendId: harness.backendId,
        status: "ready" as const,
        readiness: "ready" as const,
        reason: "session/config probe succeeded and Codex checks authorization during session creation",
      };
    }
    if (builtIn && backendId === "pi" && catalog === "usable") {
      return {
        backendId: harness.backendId,
        status: "ready" as const,
        readiness: "ready" as const,
        reason: "session/config probe succeeded with Pi's credential-filtered model catalog",
      };
    }

    return {
      backendId: harness.backendId,
      status: "unknown" as const,
      readiness: "unknown" as const,
      reason: "session/config probe succeeded; zero-token authentication readiness is not universally observable",
    };
  });
}

/** Prefer positive no-token readiness evidence, then fall back to the first session-ready unknown. */
export function selectAutoDefaultBackend(
  report: HarnessConfigReport,
  customBackendIds: readonly string[] = [],
): AutoDefaultBackendSelection {
  const candidates = classifyAutoDefaultCandidates(report, customBackendIds);
  const selected = candidates.find((candidate) => candidate.status === "ready")
    ?? candidates.find((candidate) => candidate.status === "unknown");
  if (!selected || selected.status === "unavailable") throw new NoAutoDefaultBackendError(candidates);
  return { backendId: selected.backendId, readiness: selected.readiness, reason: selected.reason };
}

/**
 * Resolve and cache one automatic default per project/daemon. Candidate probes run concurrently
 * across backends; the report is reassembled in the runner's deterministic registry order.
 * Failed discovery is not cached, so an out-of-band login/install can make the next run succeed.
 */
export async function discoverProjectDefaultBackend(
  context: ProjectContext,
  probeRunner: ValidateProbeRunner,
  timeoutMs = 60_000,
): Promise<AutoDefaultBackendSelection> {
  if (context.autoDefaultBackend) return context.autoDefaultBackend;
  if (context.autoDefaultBackendPending) return context.autoDefaultBackendPending;

  const backendIds = [...new Set(probeRunner.listBackends?.() ?? [])];
  if (backendIds.length === 0) throw new NoAutoDefaultBackendError([]);

  const pending = Promise.all(
    backendIds.map((backendId) =>
      probeHarnessConfig({
        harnesses: [backendId],
        cwd: context.projectDir,
        timeoutMs,
        probeRunner,
      })
    ),
  ).then((reports) => {
    const harnessOptions = reports.flatMap((report) => report.harnessOptions);
    const report: HarnessConfigReport = {
      ok: harnessOptions.every((harness) => harness.probed),
      exitCode: harnessOptions.every((harness) => harness.probed) ? 0 : 1,
      harnessOptions,
    };
    const selected = selectAutoDefaultBackend(report, probeRunner.listCustomBackends?.() ?? []);
    context.autoDefaultBackend = selected;
    return selected;
  });

  context.autoDefaultBackendPending = pending;
  try {
    return await pending;
  } finally {
    context.autoDefaultBackendPending = undefined;
  }
}
