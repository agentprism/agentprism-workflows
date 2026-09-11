# Workflow control-flow API reference

**Context:** JavaScript passed to the MCP `workflow` tool. Workflow scripts use `agent(prompt, options?)`; REPL evals use a different API.

The agent-call fragments below assume an explicit workflow default such as `meta.model: "codex"`.
Quality helpers also need an effective inherited route; MCP never chooses one automatically.

## DSL globals — complete signatures

```
agent(prompt, options?)                    → Promise<string | object | null>
parallel(thunks)                           → Promise<results[]>   // barrier; input order; failed slot = null
pipeline(items, ...stages)                 → Promise<results[]>   // no inter-stage barrier; stage(prev, original, index); failed item = null
workflow(nameOrScript, args?)              → Promise<unknown>     // one nesting level; names resolve from the host's workflows folder, inline scripts always work
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
`verdict: null`. If the script returns the gate result, its complete verdict is persisted and may
reach the host; keep evidence concise and never put credentials or other secrets in verdict data.

`verify`, `judgePanel`, and `completenessCheck` spawn their subagents on the run's default model — hand-roll with `parallel` + `agent` to pin panel members to specific backends.

## `checkpoint()` options

| option | type | meaning |
|---|---|---|
| `kind` | `"confirm" \| "input" \| "select"` | Reply shape: boolean / free text / one of `choices`. Affects the journal hash and the host UI widget. |
| `choices` | `string[]` | For `kind: "select"`. |
| `timeoutMs` | positive finite `number` | Deadline for an SDK host's live prompt; expiry leaves the checkpoint unanswered and pauses. |

Every unanswered checkpoint pauses with non-secret `checkpointContext`. MCP exposes the pending question through status/monitor and accepts a separate bounded `{ action:"resume", runId, checkpointReplies:{ [context.callIndex]: decision } }`. An SDK host may collect an explicit answer with `ExecOptions.confirm`; a missing callback, `undefined`, non-JSON value, rejection, or interaction timeout pauses. Panel closure cannot answer or cancel a checkpoint. Explicit stop/cancellation remains available.

Replies must be strict JSON and are returned verbatim, including explicit `false`, `null`, or an empty string. The first decision stored under the run lease is authoritative forever: repeats are idempotent and conflicts are ignored. The only authored options are `kind`, `choices`, and `timeoutMs`; retired `headless` and `default` fields are rejected, including the former opt-in `headless:"pause"`.

## Error codes (`WorkflowError.code`)

| code | recoverable | engine behavior |
|---|---|---|
| `AGENT_CANCELLED` | yes | The host selected this in-flight call for cancellation. It resolves `null` immediately through an engine race, skips retries, leaves the run live, and is recorded as a failed call rather than a replayable journal result. |
| `AGENT_EMPTY_OUTPUT` | yes | No assistant text on a schema-less call; same retry-then-`null`. |
| `AGENT_EXECUTION_ERROR` | yes* | Generic agent failure (*refusal/truncation variants are non-recoverable). |
| `SCHEMA_NONCOMPLIANCE` | no | Structured output never validated after the re-prompt ladder. Halts the run (catchable in-script). |
| `PROVIDER_USAGE_LIMIT` | no | Quota/rate wall — the run **pauses** (journaled, resumable), with the provider's reset hint. |
| `AGENT_LIMIT_EXCEEDED` | no | `maxAgents` cap hit. |
| `AUTH_REQUIRED` | no | Backend needs authentication. `WorkflowManager` returns a resumable pause with `reason: "auth_required"` and redacted `authContext`; a direct runner throws. The host completes auth before resuming/retrying. |
| `CHECKPOINT_REQUIRED` | no | No explicit answer is available. `WorkflowManager` returns `reason: "checkpoint_required"` plus non-secret `checkpointContext`; answer through `checkpointReplies` or an SDK live confirm. Catching the signal inside the script cannot bypass the gate. |
| `PAUSE_REQUESTED` | no | The host asked for a pause. Executing calls finish and journal, nothing new is admitted, and `WorkflowManager` settles the run as paused with `reason: "requested"`; resume continues from the journal. Catching it cannot keep the run going. |
| `SCRIPT_VALIDATION_ERROR` | no | Script failed parse/validation (bad meta, nondeterministic API, bad `meta.backends` shape). |
| `SCRIPT_ERROR` | no | The script itself crashed (uncaught throw, floated rejection). |
| `WORKFLOW_ABORTED` | — | Real cancellation (stop/host signal) — never used for crashes. The stopped run can still resume from its journal. |

`loopUntilDry` absorbs `AGENT_LIMIT_EXCEEDED` from its rounds and returns the partial result; everywhere else it propagates.
