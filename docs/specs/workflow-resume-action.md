# Canonical workflow resume action

Status: **implemented MCP contract**.

## Scope

The model-facing `workflow` tool continues one already-admitted run in place:

```ts
interface WorkflowResumeToolInput {
  action: "resume";
  runId: string;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  checkpointReplies?: Record<number, unknown>;
  background?: boolean;
}
```

`runId` is both the input and output run identity. Resume never allocates a child run, exposes an
attempt identity, accepts new script content, or accepts replacement args. It reloads the persisted
script, args, canonical host-owned agent configuration, journal, event stream, cumulative usage,
checkpoint decisions, and eligible interrupted ACP session state. The same event stream continues
from its durable cursor and provider usage is added to the run's existing total.

`maxAgents`, `concurrency`, and `agentRetries` are runtime controls for the continuing execution;
they do not change logical inputs or agent routing. `background:true` returns after the continuation
has been durably admitted under the same run lease. Foreground waits for the same run to settle.

The MCP schema accepts no replacement script, arguments, provider selection, or source-run
selector. The Run action accepts explicit new content only and cannot name a prior run.

## Canonical admission

Before the first live call, the host atomically persists a versioned admission snapshot containing
the canonical effective occurrence-indexed model/mode/config selection, host-pinned default model,
approved script backend map, selection hash, source, and admission timestamp. Raw form fields are
never persisted. A continued run uses that snapshot without probing or eliciting again.

Strict occurrence coverage remains active for the life of the run. If execution reaches an agent
occurrence that admission did not cover, the occurrence is durably recorded and the run fails
closed. Every later resume refuses with `admission-uncovered`. A pre-contract run with no valid
admission snapshot remains observable when its stored data permits, but MCP continuation refuses
with a named admission error and instructs the caller to start a fresh Run. There is no migration,
mapping guess, or fallback selection.

## Checkpoint decisions

`checkpointReplies` keys name this run's exact `checkpointContext.callIndex`. The reply must be
strict JSON. Under the run lease, the first reply is appended to the durable journal before script
continuation or acknowledgement. Repeating that exact value is idempotent. A later different value
is reported as ignored and the first durable value remains authoritative. Cold reconstruction
replays that decision forever and never re-asks the checkpoint.

Only paused or failed continuable runs may start execution again. Missing, lease-owned,
not-continuable, and admission-missing/invalid/uncovered states are tool errors naming the reason.
Running, terminal, auth-blocked, and unanswered-checkpoint states are not errors: the response is
the run's current observation (the same shape as `status`, including the pending `authContext` or
`checkpointContext` and any reported checkpoint resolutions) with guidance on what to do next.
Completed and aborted runs are terminal.

Only a newly accepted answer for the pending checkpoint moves the run past that pause. An
idempotent repeat or an ignored conflict for an already-journaled checkpoint is reported but never
substitutes for the missing decision, and it never lets a later checkpoint fall back to its
authored default. A foreground resume from a form-capable client elicits the pending checkpoint
directly (and every later checkpoint the continuation reaches) through the same `inputRequired`
lifecycle a fresh run uses; the client's retry re-enters as `resume` with `checkpointReplies` for
that call, merged with any replies the original resume carried. A retry that names a checkpoint
the run is no longer paused at continues with the caller's original replies so the response
reports the durable decision or the checkpoint that is now pending.

## Protocol and verification

The stateful legacy 2025 transport and stateless `2026-07-28` transport expose this identical
lifecycle through one implementation. Their elicitation fulfillment mechanics differ, but their
workflow schema and same-ID behavior do not.

Focused coverage pins stable run IDs, immutable script/args/config, cumulative usage, exact journal
prefix replay, cold continuation, admission failures, lease races, first-answer checkpoint
durability, idempotent repeats, ignored conflicts, and both protocol eras.
