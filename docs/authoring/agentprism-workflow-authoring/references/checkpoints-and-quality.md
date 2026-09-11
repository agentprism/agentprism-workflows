## Built-in quality loops

**Context:** JavaScript passed to the MCP `workflow` tool. Workflow scripts use `agent(prompt, options?)`; REPL evals use a different API.

The agent-call fragments below assume an explicit workflow default such as `meta.model: "codex"`.
Quality helpers also need an effective inherited route; MCP never chooses one automatically.

These helpers spawn their own subagents on the default model. Hand-roll with `parallel` + `agent` when you want panel members on specific backends. Full signatures are in [`api-control-flow.md`](api-control-flow.md).

| helper | shape | use for |
|---|---|---|
| `gate(produce, validate, { attempts })` | produce → validate → feed `feedback` back; return `{ ok, value, verdict, attempts }` | produce-until-a-reviewer-approves loops that need the final review evidence |
| `retry(thunk, { attempts, until })` | bounded retry until `until(result)` holds | flaky single steps |
| `verify(item, { reviewers, threshold, lens })` | N adversarial reviewers vote `real`/not | killing plausible-but-wrong findings |
| `judgePanel(attempts, { judges, rubric })` | score candidates 0–1 against a rubric, return the best | picking among independent solutions |
| `loopUntilDry({ round, key, consecutiveEmpty, maxRounds })` | repeat a round, dedup by `key`, stop when dry | unknown-size discovery (bugs, edge cases) |
| `completenessCheck(args, results)` | one critic lists what's still missing | a final "what did we not cover?" pass |

The `gate` pattern, spelled out — note how the producer thunk threads the validator's feedback into a *fresh* agent's prompt (sessions have no memory):

```js
const outcome = await gate(
  (feedback, attempt) => agent(
    `Implement the fix described here:\n${JSON.stringify(plan)}\n` +
    (feedback ? `\nA reviewer rejected attempt ${attempt}: ${feedback}\nAddress every point.` : ""),
    { label: `fix:${attempt + 1}`, model: "codex/gpt-5.6-sol", mode: "agent" },
  ),
  (result) => agent(
    `Run the test suite and review this change summary:\n${result}\n` +
    `Return ok=true only if tests pass and the fix is correct; include the reviewed commit SHA.`,
    { label: "gate-review", model: "claude/opus[1m]", mode: "bypassPermissions", schema: { type: "object", additionalProperties: false,
      required: ["ok"], properties: { ok: { type: "boolean" }, feedback: { type: "string" },
        commitSha: { type: "string" } } } },
  ),
  { attempts: 3 },
);
if (!outcome.ok) log(`reviewer never approved after ${outcome.attempts} attempts`);
else log(`reviewer approved commit ${outcome.verdict?.commitSha ?? "(unspecified)"}`);
```

Feedback is the producer's only context for the next attempt. Interpolate everything it needs, and name only files that provably exist.

## Human gates: `checkpoint()`

`checkpoint(promptText, options?)` is a zero-token, journaled human gate. Every unanswered checkpoint pauses. MCP persists the pending question and returns control; a later bounded Resume supplies the explicit answer. An SDK host can collect a reply through `ExecOptions.confirm`.

```js
const proceed = await checkpoint(`Apply this plan?\n${JSON.stringify(plan, null, 2)}`, {
  kind: "confirm",          // "confirm" | "input" | "select"
});
if (!proceed) return { applied: false, plan };
```

`kind: "input"` requests free text; `kind: "select"` offers `choices`. The explicit strict-JSON reply is returned verbatim, including a negative confirm answer. Without an answer, the run has `reason:"checkpoint_required"` and non-secret `checkpointContext`. Continue it with `{ action:"resume", runId, checkpointReplies:{ [context.callIndex]: decision } }`, using the exact pending index. The first decision persisted under the lease wins forever; repeats are idempotent and conflicts are ignored.

Absent panels, dismissal, invalid non-JSON replies, callback rejection, and interaction timeouts leave the gate unanswered. An explicit stop cancels the run. Authored `headless` and `default` policies are rejected. Validation may simulate `true` for confirm, sample text for input, or a select choice to inspect control flow; those answers are never persisted or reused for live approval. Put a checkpoint before anything hard to reverse.
