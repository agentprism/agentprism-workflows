import type {
  ResumePolicy,
  WorkflowCallRecord,
  WorkflowResumeCallFailedReason,
  WorkflowResumeCallLiveReason,
  WorkflowResumeDisabledReason,
  WorkflowResumeFallbackReason,
} from "@automatalabs/shared-types";
import type { PersistedResumeSeed } from "./run-persistence.js";

export const RESUME_FALLBACK_REASONS = Object.freeze([
  "legacy-recording",
  "forced-positional",
  "unsafe-recording",
  "nested-workflows",
  "legacy-resume",
] as const satisfies readonly WorkflowResumeFallbackReason[]);

export const RESUME_DISABLED_REASONS = Object.freeze([
  "unsupported-format",
  "source-not-terminal",
  "abort-residue",
  "isolation-recording",
  "resume-metadata-missing",
  "manifest-invalid",
  "cwd-mismatch",
  "runtime-mismatch",
  "environment-missing",
  "environment-mismatch",
  "source-environment-drift",
  "resume-seed-invalid",
] as const satisfies readonly WorkflowResumeDisabledReason[]);

export const RESUME_CALL_LIVE_REASONS = Object.freeze([
  "strategy-live",
  "positional-miss",
  "positional-suffix",
  "not-recorded",
  "path-missing",
  "inputs-missing",
  "inputs-changed",
  "ambiguous-identity",
  "ambiguous-content",
  "candidate-consumed",
  "empty-output",
  "safety-changed",
  "unsafe-suffix",
  "worktree-degraded",
] as const satisfies readonly WorkflowResumeCallLiveReason[]);

export const RESUME_CALL_FAILED_REASONS = Object.freeze([
  "seed-persistence-error",
  "resume-fatal-latch",
] as const satisfies readonly WorkflowResumeCallFailedReason[]);

/** Manager-prepared, engine-internal execution input. */
export type PreparedResume =
  | {
      strategy: "identity-v1";
      sourceRunId: string;
      requestedPolicy: ResumePolicy;
      seed: PersistedResumeSeed;
      /** Synchronously replace the durable remaining seed. Throws PERSISTENCE_ERROR
       *  on failure; the engine must not expose a replay/live decision first. */
      commitSeed: (remaining: PersistedResumeSeed) => void;
    }
  | {
      strategy: "positional-v1";
      sourceRunId: string;
      requestedPolicy: ResumePolicy;
      fallbackReason: WorkflowResumeFallbackReason;
      /** "legacy" is the exact historical matcher. "safe-prefix" permits only
       *  safety-marked new-format hits. "all-live" initializes firstMiss to 0. */
      eligibility: "legacy" | "safe-prefix" | "all-live";
      /** Root source manifest by source index when available; empty for pre-manifest legacy
       *  sources. Used only to carry safety/provenance into fresh current rows. */
      sourceCalls: ReadonlyMap<number, WorkflowCallRecord>;
      /** Present only for a new-format shifted checkpoint injection. Its candidates
       *  array is empty; commitSeed has the same critical semantics as above. */
      checkpoint?: {
        seed: PersistedResumeSeed;
        commitSeed: (remaining: PersistedResumeSeed) => void;
      };
    }
  | {
      strategy: "live";
      sourceRunId: string;
      requestedPolicy: ResumePolicy;
      disabledReason: WorkflowResumeDisabledReason;
    };
