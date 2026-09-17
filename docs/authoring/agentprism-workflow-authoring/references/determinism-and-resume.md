## Determinism and same-run continuation

**Context:** JavaScript passed to the MCP `workflow` tool.

One run owns one immutable logical execution. Every `agent()` and `checkpoint()` result is journaled
under a deterministic call index. `{ action:"resume", runId }` reconstructs and continues that exact
run; it never forks a child run and never accepts changed `args`.

- Direct `Date.now()`, `Math.random()`, and no-arg `new Date()` / `Date()` fail validation. Pass nondeterministic values through the original run `args`.
- A call's replay identity hashes the prompt, resolved model, authored `mode`, non-empty `configOptions`, `phase`, `agentType` and its resolved definition, and `schema`. `label`, `cwd`, `isolation`, `images`, `mcpServers`, `meta`, and `promptMeta` are not part of it, so changing them never invalidates a journaled result.
- On resume, a journaled call whose index and identity still match is replayed from the journal without spawning a session or spending tokens. Anything else runs live, and live usage is added to the run's cumulative total.
- Because a retried or gated attempt's prompt embeds the previous attempt's live result, editing an early prompt cascades into live re-execution of everything downstream of it. That is correct; expect it.
- Resume re-reads the script from `scriptPath`. An unchanged file continues the admitted text. An edited file is validated like a new run (same preflight, same rejections) and continues with an identity-matched replay: unchanged calls replay, edited or new calls run live, and the acknowledgement reports `continuation.scriptRevised:true`. A revision cannot declare backends the setup never approved and cannot change routing that admission captured.
- Resume never re-selects models. The routing captured at admission is reused as is.
- A call interrupted by a usage or auth pause may reattach its recorded backend session on resume when the call is unchanged; otherwise it runs fresh within the same run.
- The event stream stays one stream per run; a continuation appends a `resumed` event and new observations at the existing cursor.
- Status is an immediate snapshot. Reissue it, or read the events resource, for later progress.

### Durable checkpoints

Every unanswered checkpoint pauses. Resume with
`{ action:"resume", runId, checkpointReplies:{ [checkpointContext.callIndex]: decision } }`.
The decision must be strict JSON. The first answer is journaled before continuation and replays
forever; an identical repeat is idempotent, and a different later answer is ignored and reported
against the durable first answer. Prompt, kind, and choices are the checkpoint's identity, so editing
a checkpoint's prompt in a revision makes it a new, unanswered checkpoint.

### Failure and restart

A paused or failed run can continue. A stopped (`aborted`) run can continue too: it replays its journal
and re-runs the calls that were interrupted. A completed run is terminal. A cancelled Run request persists
nothing and a cancelled Resume request changes nothing; once admitted, client disconnection leaves
execution active, and a server restart recovers the run from durable state.

Give repeated calls stable labels and narrate decisions with `log()`. Retain the original run ID:
the same ID addresses its script, event stream, cumulative usage, status, and result.
