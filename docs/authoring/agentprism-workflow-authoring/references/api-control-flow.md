# Workflow control-flow API reference

**Context:** JavaScript passed to the MCP `workflow` tool.

The agent-call fragments below assume an inherited route such as `meta.model: "codex"`.
Quality helpers spawn their own agents and need that inherited route too.

## DSL globals — complete signatures

```
agent(prompt, options?)                    → Promise<string | object | null>
parallel(thunks)                           → Promise<results[]>   // barrier; input order; failed slot = null
pipeline(items, ...stages)                 → Promise<results[]>   // no inter-stage barrier; stage(prev, original, index); failed item = null
workflow(script, args?)                    → Promise<unknown>     // run a child script inline; one nesting level; shares this run's limits
gate(thunk, validator, { attempts = 3 })   → { ok, value, verdict, attempts }
    // thunk(feedback, attempt); validator(result) → { ok, feedback?, ... } | boolean | null (may be async / an agent call)
retry(thunk, { attempts = 3, until? })     → last result           // thunk(attempt); stops early when until(result)
verify(item, { reviewers = 2, threshold = 0.5, lens? })
    → { real, realCount, total, votes: [{ real?, reason? }] }
    // N adversarial reviewers prompted to REFUTE; lens (string | string[]) rotates focus per reviewer
judgePanel(attempts, { judges = 3, rubric = "overall quality and correctness" })
    → { index, attempt, score, judgments }  // mean 0–1 score per candidate; stable tie-break by index
loopUntilDry({ round, key = JSON.stringify, consecutiveEmpty = 2, maxRounds = 50 })
    → unique items[]   // round(i) returns items; stops after N dry rounds; agent-limit exhaustion returns the partial result
completenessCheck(taskArgs, results)       → { complete, missing?: string[] }
checkpoint(promptText, options?)           → Promise<reply>       // journaled human gate; zero tokens
phase(title)                               → void                 // open a named phase
log(message)                               → void                 // console.log/info/warn/error route here too
args                                       // the host-provided input value, verbatim
cwd                                        // the run's base working directory (string); process.cwd() returns it too
```

For `gate()`, `value` is the final producer result and `verdict` is the exact last completed
validator return, including any extra structured fields. `{ ok: true }` and bare `true` pass;
`{ ok: false, feedback? }`, bare `false`, and `null` reject. Only object feedback is threaded into
the next producer attempt. A producer result of `null` is still passed to the validator. Producer
or validator exceptions propagate immediately, so no partial gate result is returned and no later
attempt runs. An explicit unsupported `undefined` validator return is a rejection represented as
`verdict: null`. If the script returns the gate result, its complete verdict is persisted and
reaches the run result; keep evidence concise and never put credentials or other secrets in verdict data.

`verify`, `judgePanel`, and `completenessCheck` spawn their agents on the run's inherited route (phase model or `meta.model`) — hand-roll with `parallel` + `agent` to pin panel members to specific backends.

## `checkpoint()` options

| option | type | meaning |
|---|---|---|
| `kind` | `"confirm" \| "input" \| "select"` | Reply shape: boolean / free text / one of `choices`. Part of the checkpoint identity and shown in `checkpointContext`. |
| `choices` | `string[]` | For `kind: "select"`. |

Every unanswered checkpoint pauses the run with `reason: "checkpoint_required"` and a non-secret `outcome.checkpointContext` (`callIndex`, `prompt`, `kind`, `choices`) in status. Answer it with `{ action:"resume", runId, checkpointReplies:{ [checkpointContext.callIndex]: decision } }`. Nothing else answers a checkpoint: no timeout, no default, no inferred answer.

Replies must be strict JSON and are returned to the script verbatim, including explicit `false`, `null`, or an empty string. The first decision recorded for a checkpoint is authoritative forever: repeats are idempotent and a different later answer is ignored. Retired `headless` and `default` options are rejected.

## Error codes (`WorkflowError.code`)

| code | recoverable | behavior |
|---|---|---|
| `AGENT_CANCELLED` | yes | You cancelled this in-flight call with `stop` + `callIndex`. It resolves `null` immediately, skips retries, and leaves the run live. Not journaled, so a resume re-runs it. |
| `AGENT_EMPTY_OUTPUT` | yes | No assistant text on a schema-less call; same retry-then-`null`. |
| `AGENT_EXECUTION_ERROR` | yes* | Generic agent failure (*refusal/truncation variants are non-recoverable). |
| `SCHEMA_NONCOMPLIANCE` | no | Structured output never validated after the re-prompt ladder. Fails the run (catchable in-script). |
| `PROVIDER_USAGE_LIMIT` | no | Quota/rate wall — the run **pauses** (`reason: "usage_limit"`); resume after the provider's reset. Always rethrow it. |
| `AGENT_LIMIT_EXCEEDED` | no | `maxAgents` cap hit. |
| `AUTH_REQUIRED` | no | The backend needs authentication. The run pauses with `reason: "auth_required"` and a redacted `authContext` naming the backend; configure the credential, then resume. Always rethrow it. |
| `CHECKPOINT_REQUIRED` | no | A `checkpoint()` has no answer. The run pauses with `reason: "checkpoint_required"` and `checkpointContext`; answer through `checkpointReplies`. Catching it inside the script cannot bypass the gate. |
| `PAUSE_REQUESTED` | no | You called `pause`. Executing calls finish and journal, nothing new is admitted, and the run settles `paused` with `reason: "requested"`. Catching it cannot keep the run going. |
| `SCRIPT_VALIDATION_ERROR` | no | Script failed parse/validation (bad meta, nondeterministic API, bad `meta.backends` shape). Reported by the run request itself; no run exists. |
| `SCRIPT_ERROR` | no | The script itself crashed (uncaught throw, floated rejection). |
| `WORKFLOW_ABORTED` | — | Real cancellation (`stop`) — never used for crashes. The stopped run can still resume from its journal. |

`loopUntilDry` absorbs `AGENT_LIMIT_EXCEEDED` from its rounds and returns the partial result; everywhere else it propagates.
