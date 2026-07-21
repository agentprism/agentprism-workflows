# Journal replay contract

**Status:** current · **Date:** 2026-07-21 · **Motivation:** issue #271

This contract supersedes the filesystem-safety and purity rules in
[`incremental-resume-spec.md`](incremental-resume-spec.md). The engine replays recorded workflow
calls; it does not decide whether the surrounding filesystem or world is safe to reuse.

## Core rule

For `resumeFromRunId`, every root call is handled independently:

1. A completed source call with one unambiguous matching identity and equal execution-input
   fingerprint replays its journaled result.
2. A matching non-result agent call runs live. When it is a coherent usage/auth pause with a
   reopenable ACP session, the existing continuation channel may reattach that unfinished turn.
3. A missing, changed, consumed, ambiguous, empty, malformed, or otherwise uncorrespondable call
   runs live.

There is no fourth branch based on filesystem state, ambient state, inferred purity, or whether an
agent was expected to read or write. Replay is correspondence, not environmental restoration.

## Identity and admission

Agent identity continues to hash authored behavior: prompt, resolved model, mode/configuration,
tier, phase, agent definition, and schema. The separate execution-input fingerprint covers label,
per-call cwd, isolation, session/tool attachments, metadata, and approved script backends. Exact
path/hash matching wins; otherwise one unique hash+input match may move after script edits.

Source admission remains fail-to-live for journal integrity: terminal/non-aborted status, exact
effective cwd, supported fingerprint formats, complete call/journal/allocation metadata, a dense
manifest, and a valid retained seed. These checks answer “can this recorded call be identified and
trusted as a journal row?” They do not answer “does the current world resemble the recorded world?”

Git HEAD, dirty digest, `environmentKey`, Node/V8 versions, producing engine version, and captured
start/terminal environment values are diagnostics only. For provenance reporting, the recorded
terminal environment (or start environment when no terminal capture exists) is compared with the
current environment. Differences may appear in `replayEligibility.provenanceChanges`; none can
disable replay or turn a matching call live.

## World neutrality

All completed matching calls are eligible, including writers, readers, worktree calls, headless
checkpoint results, and calls recorded before or after live calls, nested workflows, worktree
degradation, or host checkpoint callbacks. A live call never clears unrelated candidates. A
nested workflow still executes live because child calls are not part of the parent's journal, but
matching parent calls before and after it remain replayable.

The legacy DSL field `resume: { filesystem: "read-only" }`, persisted `resumeSafety`, terminal
environment capture, and old safety/fallback reason literals remain readable for backward
compatibility and diagnostics. They have no effect on admission or matching. New scripts should
omit the `resume` field.

The consequence is intentional: replay does not reproduce filesystem writes from a completed
call, and a later live agent may encounter a different world. Navigating that world is the live
agent's job. The engine must not spend the user's tokens again merely to speculate that rerunning
earlier intelligence could make the world safer.

## Checkpoints and continuation

Completed checkpoint results follow the same identity/fingerprint rule regardless of whether the
source decision came from a host callback or headless default. A durable `checkpointReplies` value
is more constrained because it is a new human decision, not a completed source result: exact call
sites may consume it after a live prefix, while a moved unique match is accepted only while prior
journal correspondence remains intact. Changed checkpoint inputs or a different same-text branch
leave the reply unapplied and the checkpoint live.

Usage/auth continuation remains independent of result replay. A matching completed prefix replays;
the interrupted call itself runs at the live boundary and may reattach only when call index,
identity, input fingerprint, cwd, backend/pool identity, recorded session, and reopen capability
agree. A failed continuation gate starts that call fresh without invalidating later candidates.

## Compatibility

Marker-less and old input-format recordings retain their legacy positional bridge. Explicit
`resumePolicy: "positional"` still requests index/prefix correspondence, but new-format positional
rows require structural identity and equal input fingerprints—not safety markers or world-state
agreement. Historical public enum literals remain exported so old journals and consumers continue
to parse; their presence does not imply that current code emits or acts on them.
