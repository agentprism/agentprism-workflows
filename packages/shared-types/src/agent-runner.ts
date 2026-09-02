// packages/shared-types/src/agent-runner.ts
//
// THE SEAM — the single, frozen coupling point between @automatalabs/workflow-engine
// and ANY agent backend (acp-agents). The engine references the runner by THIS one
// method only: it is the exact shape behind `Pick<WorkflowAgent,"run">` (pi
// workflow.ts:59). It is BOUND at workflow.ts:283 (`const agentRunner = options.agent`
// — now REQUIRED; the Pi `?? new WorkflowAgent(options)` default is DROPPED) and
// CALLED exactly ONCE per agent() at workflow.ts:465, inside the limiter thunk.
// The call site casts the opts bag
// `as any` (workflow.ts:488) — so FIELD NAMES are the real contract: renaming a field
// silently mis-binds at runtime with NO compile error. This file freezes that seam.
import type { TSchema } from "typebox";
import type { RunOptions } from "./agent-run.js";
import type { AgentResult } from "./agent-run.js";

export interface AgentRunner {
  /**
   * Run ONE subagent to completion.
   *
   * FROZEN CONTRACT (verified against pi agent.ts:332-335 + the call site
   * workflow.ts:465-488; do not widen without re-cutting the seam):
   *
   *  - `prompt` is a plain positional string; `options` is one optional bag that
   *    DEFAULTS TO {} (the engine's historical Pick<WorkflowAgent,"run"> seam relies
   *    on options being optional).
   *
   *  - RETURN is the RAW value, NEVER an envelope (AgentResult, agent.ts:286-288):
   *       schema present => Static<schema>   (a parsed + validated object)
   *       no schema       => the assistant's final text (string)
   *    Usage is delivered OUT-OF-BAND via options.onUsage; it is NOT in the return.
   *    A {result, usage} wrapper would change the frozen call — rejected.
   *
   *  - The return MUST be JSON-serializable and STABLE for a fixed resume identity
   *    (sha256{prompt, model, mode-when-set, tier, phase, agentType, agentDef, schema}, hashAgentCall
   *    workflow.ts:1045-1064): the engine journals it verbatim (onAgentJournal,
   *    workflow.ts:502) and replays it on resume (:413). callIndex is assigned at
   *    LEXICAL call time before the limiter (:391), so parallel()/pipeline() fan-out
   *    stays reproducible — the runner MUST NOT depend on invocation/completion order
   *    for identity.
   *
   *  - On failure THROW — ideally a WorkflowError{code, recoverable} from this same
   *    package (so `instanceof` holds across packages). The engine classifies via
   *    wrapError (:515): recoverable => retried up to agentRetries then resolves null;
   *    non-recoverable => rethrown and halts the run (incl. inside parallel/pipeline).
   *    Leaf codes the runner raises:
   *      AGENT_EMPTY_OUTPUT     (recoverable)      no assistant text on a no-schema call
   *      SCHEMA_NONCOMPLIANCE   (non-recoverable)  schema never satisfied after the ladder
   *      PROVIDER_USAGE_LIMIT   (non-recoverable)  quota/rate wall -> engine PAUSES, carries resetHint
   *    (AGENT_CANCELLED + WORKFLOW_ABORTED + SCRIPT_ERROR are added by the ENGINE, not the runner.)
   *
   *  - ABORT is the ENGINE's responsibility: the engine passes options.signal and calls
   *    throwIfAborted() before/after. The runner SHOULD honor options.signal by wiring it to
   *    backend session cancellation (ACP session/cancel).
   *
   *  - There is NO checkpoint method: human-in-the-loop is the engine's options.confirm
   *    callback (workflow.ts:798-829), not a runner concern.
   */
  run<S extends TSchema | undefined = undefined>(
    prompt: string,
    options?: RunOptions<S>,
  ): Promise<AgentResult<S>>;
}
