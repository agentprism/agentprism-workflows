// Ambient DSL globals for AgentPrism workflow SCRIPTS — author IntelliSense only.
//
// A workflow script is a string executed inside a Node `vm` realm (see
// workflow-engine/src/workflow.ts). The orchestration primitives below are injected
// into that realm as GLOBALS — they are NOT importable functions and there is nothing
// to `import` from this SDK to obtain them. This file declares their shapes so an
// editor offers completion/parameter hints while authoring a script; it ships no
// runtime code.
//
// This is a global ambient SCRIPT (no top-level import/export), so the declarations
// below augment the global scope. Referenced option types are pulled in via inline
// `import(...)` type queries, which do NOT turn this file into a module. Signatures
// mirror workflow.ts exactly (verified against the injected vm context).

type AgentPrismAgentOptions = import("@automatalabs/workflow-engine").AgentOptions & {
  /** Legacy diagnostic annotation. New workflows should omit it.
   * @deprecated Replay is determined by recorded call correspondence, not world state. */
  resume?: { filesystem: "read-only" };
};

/**
 * Run ONE subagent to completion and return its result. With `options.schema` the
 * result is the validated object; otherwise it is the assistant's final text.
 * Each call is journaled under a deterministic index for resume. `options.model` may be a
 * backend-only harness name, or a registered harness prefix plus an id sent verbatim after
 * that one prefix is stripped; unregistered prefixes remain part of the id on the default.
 * `options.configOptions` passes exact agent-advertised option ids and string/boolean values;
 * validate first and use its selected-model table to choose them.
 */
declare function agent(
  prompt: string,
  options?: AgentPrismAgentOptions,
): Promise<unknown>;

/**
 * Run an array of THUNKS concurrently and resolve to their results in input order.
 * Pass functions, not promises: `parallel([() => agent("a"), () => agent("b")])`.
 * A recoverable failure becomes `null` in its slot; a non-recoverable one halts the run.
 */
declare function parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]>;

/**
 * Map `items` through one or more sequential async `stages`, concurrently across items.
 * Each stage receives `(prev, original, index)`. Resolves to the final value per item
 * (a recoverable per-item failure yields `null` for that item).
 */
declare function pipeline(
  items: unknown[],
  ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
): Promise<unknown[]>;

/**
 * Run a saved workflow (by name) or a raw script inline, sharing this run's
 * limiter/counters/budget. Nests at most one level deep.
 */
declare function workflow(nameOrScript: string, args?: unknown): Promise<unknown>;

/**
 * Adversarial verification panel: `reviewers` subagents vote on whether `item` is
 * real/correct; passes when the share voting real meets `threshold`.
 */
declare function verify(
  item: unknown,
  options?: { reviewers?: number; threshold?: number; lens?: string | string[] },
): Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real?: boolean; reason?: string }> }>;

/**
 * LLM-judge panel: score each candidate in `attempts` with `judges` graders against
 * `rubric` and return the highest mean-scoring candidate (stable tie-break by index).
 */
declare function judgePanel(
  attempts: unknown[],
  options?: { judges?: number; rubric?: string },
): Promise<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>;

/**
 * Repeatedly invoke `round(i)` collecting fresh (deduped by `key`) items until it
 * yields nothing `consecutiveEmpty` rounds in a row (or `maxRounds` is hit). Returns
 * every unique item gathered.
 */
declare function loopUntilDry(options: {
  round: (roundIndex: number) => Promise<unknown[]> | unknown[];
  key?: (item: unknown) => string;
  consecutiveEmpty?: number;
  maxRounds?: number;
}): Promise<unknown[]>;

/**
 * Ask a critic subagent what is still MISSING given the task args and results so far.
 */
declare function completenessCheck(taskArgs: unknown, results: unknown): Promise<unknown>;

/**
 * Bounded retry: call `thunk(attempt)` up to `attempts` times, stopping early once
 * `until(result)` holds. Returns the last result when attempts are exhausted.
 */
declare function retry(
  thunk: (attempt: number) => Promise<unknown> | unknown,
  options?: { attempts?: number; until?: (result: unknown) => boolean },
): Promise<unknown>;

/**
 * Validation gate: call `thunk(feedback, attempt)`, validate it, and feed the
 * validator's feedback into the next attempt until it passes or `attempts` run out.
 */
declare function gate<
  TValue = unknown,
  TVerdict extends boolean | { ok: boolean; feedback?: string } | null = {
    ok: boolean;
    feedback?: string;
  },
>(
  thunk: (feedback: string | undefined, attempt: number) => Promise<TValue> | TValue,
  validator: (result: TValue) => Promise<TVerdict> | TVerdict,
  options?: { attempts?: number },
): Promise<{
  ok: boolean;
  value: TValue;
  verdict: TVerdict | null;
  attempts: number;
}>;

/**
 * Deterministic, journaled, replayable human checkpoint. Spends no tokens. Headless
 * runs default immediately unless `options.headless` opts into "abort" or "pause".
 */
declare function checkpoint(
  promptText: string,
  options?: import("@automatalabs/workflow-engine").CheckpointOptions,
): Promise<unknown>;

/** Append a line to the run log. */
declare function log(message: string): void;

/** Open a named phase (optionally with a soft token sub-budget) for subsequent agents. */
declare function phase(title: string, options?: { budget?: number }): void;

/** The arguments passed into this run (the host-provided input bag). */
declare const args: unknown;

/** Live token-budget view for the run. */
declare const budget: {
  /** The total token budget, or `null` when unbounded. */
  readonly total: number | null;
  /** Tokens spent so far. */
  spent(): number;
  /** Tokens remaining (`Infinity` when unbounded). */
  remaining(): number;
};
