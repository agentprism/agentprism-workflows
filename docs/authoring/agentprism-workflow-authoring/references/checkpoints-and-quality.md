## Built-in quality loops

**Context:** JavaScript passed to the MCP `workflow` tool.

The agent-call fragments below assume an inherited route such as `meta.model: "codex"`.
Quality helpers spawn their own agents and need that inherited route too.

These helpers spawn their own subagents on the inherited route. Hand-roll with `parallel` + `agent` when you want panel members on specific backends. Full signatures are in [`api-control-flow.md`](api-control-flow.md).

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
    { label: `fix:${attempt + 1}`, model: "codex", mode: "agent" },
  ),
  (result) => agent(
    `Run the test suite and review this change summary:\n${result}\n` +
    `Return ok=true only if tests pass and the fix is correct; include the reviewed commit SHA.`,
    { label: "gate-review", model: "claude", mode: "bypassPermissions", schema: { type: "object", additionalProperties: false,
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

`checkpoint(promptText, options?)` is a zero-token, journaled human gate. Every unanswered checkpoint pauses the run; the server persists the pending question, and a later `resume` supplies the explicit answer.

```js
const proceed = await checkpoint(`Apply this plan?\n${JSON.stringify(plan, null, 2)}`, {
  kind: "confirm",          // "confirm" | "input" | "select"
});
if (!proceed) return { applied: false, plan };
```

`kind: "input"` requests free text; `kind: "select"` offers `choices`. The reply is returned verbatim, including a negative confirm answer. While unanswered, status shows `status:"paused"`, `reason:"checkpoint_required"`, and `outcome.checkpointContext` with the `callIndex`, `prompt`, `kind`, and `choices`. Continue with `{ action:"resume", runId, checkpointReplies:{ [checkpointContext.callIndex]: decision } }`, using the exact pending index and a strict-JSON value. The first decision recorded wins forever; repeats are idempotent and conflicts are ignored.

Nothing infers an answer: a closed monitor, a timeout, or conversation text cannot answer a checkpoint. `stop` cancels the run instead. Authored `headless` and `default` options are rejected. The mocked dry run simulates `true` for confirm, sample text for input, or a select choice to inspect control flow; those simulated answers are never persisted or reused. Put a checkpoint before anything hard to reverse.
