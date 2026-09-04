## Determinism and same-run continuation

**Context:** JavaScript passed to the MCP `workflow` tool. Workflow scripts use `agent(prompt, options?)`; REPL evals use a different API.

One MCP run owns one immutable logical execution. Every `agent()` and `checkpoint()` result is
journaled under a deterministic call index. `{ action:"resume", runId }` reconstructs and continues
that exact run; it never forks a child execution and never accepts changed script, args, or agent
configuration.

- Direct `Date.now()`, `Math.random()`, and no-arg `new Date()` / `Date()` fail validation. Pass nondeterministic values through the original Run `args`.
- An agent identity hashes the prompt, resolved model, authored mode, non-empty sorted `configOptions`, tier, phase, agent type/definition, and schema. A separate fingerprint covers label, cwd/isolation, session retention, images, MCP servers, metadata, and approved script backends.
- At admission the host atomically stores a versioned canonical effective occurrence map, default model, approved script backends, stable selection hash, source, and timestamp. Raw elicitation form fields are not stored.
- Strict coverage is permanent. If live control flow reaches an occurrence the admission pass did not cover, that occurrence fails before ACP dispatch and is recorded durably. Later continuation refuses; it never shifts a configuration to another ordinal.
- Exact index/hash journal hits rebuild script state without spawning a provider session, adding provider usage, or appending duplicate journal entries. Live usage is added to the run's existing cumulative total.
- A usage/auth-interrupted root call may reattach its recorded ACP session when its call identity, inputs, cwd, backend pool identity, and reopen capability agree. Failed eligibility falls back to a fresh live call within the same run, never a child run.
- The persisted event stream remains one stream for the run. A continuation appends a `resumed` event and new execution observations at the existing durable cursor.
- MCP status is an immediate snapshot. Reissue it or consume the event resource for later progress.

### Durable checkpoints

For a `headless:"pause"` checkpoint, resume with
`{ action:"resume", runId, checkpointReplies:{ [checkpointContext.callIndex]: decision } }`.
The decision must be strict JSON. Under the run lease, the first answer is journaled before
continuation. An identical repeat is idempotent. A different later answer is ignored and reported
against the durable first answer. Cold reconstruction replays the decision forever.

### Failure and restart

A paused or failed run with valid admission metadata can continue. A completed or aborted run is
terminal. A pre-contract record without the required canonical admission may remain observable but
must be replaced with a fresh `{ action:"run", ... }`; no migration or inferred mapping exists.

Give repeated calls stable labels and narrate decisions with `log()`. Retain the original run ID:
the same ID addresses its script, event stream, cumulative usage, status, and result.
