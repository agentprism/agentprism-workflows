## Determinism and same-run continuation

**Context:** JavaScript passed to the MCP `workflow` tool. Workflow scripts use `agent(prompt, options?)`; REPL evals use a different API.

One MCP run owns one immutable logical execution. Every `agent()` and `checkpoint()` result is
journaled under a deterministic call index. `{ action:"resume", runId }` reconstructs and continues
that exact run; it never forks a child execution and never accepts changed script, args, or agent
configuration.

- Direct `Date.now()`, `Math.random()`, and no-arg `new Date()` / `Date()` fail validation. Pass nondeterministic values through the original Run `args`.
- An agent identity hashes the prompt, resolved model, authored mode, non-empty sorted `configOptions`, tier, phase, agent type/definition, and schema. A separate fingerprint covers label, cwd/isolation, session retention, images, MCP servers, metadata, and approved script backends.
- After durable source acceptance and any backend approval, the host stores format-3 admission with `strict:true`, `routingSnapshot:{modelTiers:null|{tiers},agentDefinitions,mainModel?}`, optional `defaultModel` and approved `scriptBackends`, `routingHash`, and `recordedAt`. Tier and named-agent files are captured once; continuation never rereads changed routing files.
- Actual-call routing is authoritative before hashing and dispatch. Additional configured live calls are valid even if the mock path did not visit them. A missing effective model fails before that call reaches the runner; no ordinal map can replace its route. Durable call records retain `modelRequested`, `modeRequested`, and `configOptionsRequested`.
- Continuation validates format-3 admission integrity and reuses immutable routing inputs without discovery. Older admissions remain inspectable but cannot execute through MCP; the SDK's separately supported journal eras remain unchanged.
- Exact index/hash journal hits rebuild script state without spawning a provider session, adding provider usage, or appending duplicate journal entries. Live usage is added to the run's existing cumulative total.
- A usage/auth-interrupted root call may reattach its recorded ACP session when its call identity, inputs, cwd, backend pool identity, and reopen capability agree. Failed eligibility falls back to a fresh live call within the same run, never a child run.
- The persisted event stream remains one stream for the run. A continuation appends a `resumed` event and new execution observations at the existing durable cursor.
- MCP status is an immediate snapshot. Reissue it or consume the event resource for later progress.

### Durable checkpoints

Every unanswered checkpoint pauses. Resume with
`{ action:"resume", runId, checkpointReplies:{ [checkpointContext.callIndex]: decision } }`.
The decision must be strict JSON. Under the run lease, the first answer is journaled before
continuation. An identical repeat is idempotent. A different later answer is ignored and reported
against the durable first answer. Cold reconstruction replays the decision forever.

Checkpoint input fingerprints use format 2 and bind explicit-decision semantics plus `timeoutMs`.
Prompt, kind, and choices remain the checkpoint identity. Current journal results, result call
records, and injected checkpoint decisions carry `checkpointDecision:"explicit-v1"`. Historical
automatic or ambiguous answers fail with `checkpoint-provenance-incompatible` and require a fresh
run; read-only inspection remains available. Non-journaled validation simulations never authorize
live execution.

### Failure and restart

A paused or failed run with valid admission metadata can continue. A completed or aborted run is
terminal. A pre-contract record without the required canonical admission may remain observable but
must be replaced with a fresh `{ action:"run", ... }`; no migration or inferred mapping exists.

A cancelled Run persists nothing and a cancelled Resume changes nothing; once admitted, client
disconnection leaves execution active. Repeating an earlier checkpoint answer cannot advance a
later checkpoint. Execution-owner loss recovers from durable state, and explicit Stop remains
authoritative through cold recovery.

Give repeated calls stable labels and narrate decisions with `log()`. Retain the original run ID:
the same ID addresses its script, event stream, cumulative usage, status, and result.
