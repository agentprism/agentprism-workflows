# Workflow control-flow API reference

**Context:** JavaScript passed to the MCP `workflow` tool. Workflow scripts use `agent(prompt, options?)`; REPL evals use a different API.

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
| `kind` | `"confirm" \| "input" \| "select"` | Reply shape: boolean-ish / free text / one of `choices`. Affects the journal hash and the host UI widget. |
| `choices` | `string[]` | For `kind: "select"`. |
| `default` | `unknown` | Reply taken in the default headless mode — journaled like a real reply. Defaults to `true`. |
| `headless` | `"default" \| "abort" \| "pause"` | No live channel: `"default"` takes `default ?? true`, `"abort"` aborts, and `"pause"` creates a persisted `checkpoint_required` pause. Default `"default"`. |
| `timeoutMs` | `number` | Deadline for the interactive prompt. |

The host supplies the live human channel (elicitation in the MCP server; `ExecOptions.confirm` in the SDK), and that channel wins even when `headless: "pause"` is declared. A durable pause carries non-secret `checkpointContext`; resume with `ExecOptions.checkpointReplies: { [context.callIndex]: decision }` or attach a live channel. On a new `resumeFromRunId` execution, reply keys always name indexes in the **source** recording; identity matching may inject that decision at a shifted current index. Completed host and headless checkpoint results both replay when identity and the checkpoint-options fingerprint over `default`, `headless`, and `timeoutMs` match. A changed option or ambiguous match runs fresh. Detached runs never pause for a checkpoint unless the author opts into `"pause"`.

## Error codes (`WorkflowError.code`)

| code | recoverable | engine behavior |
|---|---|---|
| `AGENT_TIMEOUT` | yes | Total wall-clock attempt cap exhausted. Every retry gets a fresh clock; after the final attempt the call resolves `null`, and ACP cancel escalates to close/recycle when the turn does not stop. |
| `AGENT_IDLE_TIMEOUT` | yes | Opt-in no-backend-activity cap exhausted. Real backend events re-arm it; retries and cancellation match `AGENT_TIMEOUT`. |
| `AGENT_CANCELLED` | yes | The host selected this in-flight call for cancellation. It resolves `null` immediately through an engine race, skips retries, leaves the run live, and is recorded as a failed call rather than a replayable journal result. |
| `AGENT_EMPTY_OUTPUT` | yes | No assistant text on a schema-less call; same retry-then-`null`. |
| `AGENT_EXECUTION_ERROR` | yes* | Generic agent failure (*refusal/truncation variants are non-recoverable). |
| `SCHEMA_NONCOMPLIANCE` | no | Structured output never validated after the re-prompt ladder. Halts the run (catchable in-script). |
| `PROVIDER_USAGE_LIMIT` | no | Quota/rate wall — the run **pauses** (journaled, resumable), with the provider's reset hint. |
| `AGENT_LIMIT_EXCEEDED` | no | `maxAgents` cap hit. |
| `AUTH_REQUIRED` | no | Backend needs authentication. `WorkflowManager` returns a resumable pause with `reason: "auth_required"` and redacted `authContext`; a direct runner throws. The host completes auth before resuming/retrying. |
| `CHECKPOINT_REQUIRED` | no | `headless: "pause"` reached without a live channel. `WorkflowManager` returns `reason: "checkpoint_required"` plus non-secret `checkpointContext`; resume with `checkpointReplies` or live confirm. |
| `SCRIPT_VALIDATION_ERROR` | no | Script failed parse/validation (bad meta, nondeterministic API, bad `meta.backends` shape). |
| `SCRIPT_ERROR` | no | The script itself crashed (uncaught throw, floated rejection). |
| `WORKFLOW_ABORTED` | — | Real cancellation (pause/stop/host signal) — never used for crashes. |

`loopUntilDry` absorbs `AGENT_LIMIT_EXCEEDED` from its rounds and returns the partial result; everywhere else it propagates.
