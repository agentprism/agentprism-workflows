## Built-in quality loops

**Context:** JavaScript passed to the MCP `workflow` tool. Workflow scripts use `agent(prompt, options?)`; REPL evals use a different API.

These helpers spawn their own subagents on the default model. Hand-roll with `parallel` + `agent` when you want panel members on specific backends. Full signatures are in `workflow/api-control-flow`.

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
    { label: `fix:${attempt + 1}`, model: "codex/gpt-5.6-sol" },
  ),
  (result) => agent(
    `Run the test suite and review this change summary:\n${result}\n` +
    `Return ok=true only if tests pass and the fix is correct; include the reviewed commit SHA.`,
    { label: "gate-review", model: "claude/opus[1m]", schema: { type: "object", additionalProperties: false,
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

`checkpoint(promptText, options?)` is a zero-token, journaled human gate. With MCP elicitation (or a live SDK `confirm` callback) it waits for that reply; without a live channel, its default mode takes `default ?? true` immediately, so detached runs never hang.

```js
const proceed = await checkpoint(`Apply this plan?\n${JSON.stringify(plan, null, 2)}`, {
  kind: "confirm",          // "confirm" | "input" | "select"
  default: false,           // default headless mode takes this (or true)
  // headless: "abort",     // abort when no live human is attached
  // headless: "pause",     // or persist a resumable human-decision pause
});
if (!proceed) return { applied: false, plan };
```

`kind: "input"` resolves to free text, `kind: "select"` to one of `choices`. How the question reaches a human is the host's job (elicitation in the MCP server; `ExecOptions.confirm` in the SDK). With no live channel, `headless: "default"` (the default) takes `default ?? true`, `"abort"` aborts, and `"pause"` returns a managed run with `reason: "checkpoint_required"` plus non-secret `checkpointContext`. Resume the last mode with `checkpointReplies: { [context.callIndex]: decision }` or a live confirm. For `resumeFromRunId`, that key is the source context index; an unambiguous identity match may journal the injected answer at a shifted current index. Put a checkpoint before anything hard to reverse — applying diffs, pushing, publishing, or the first commit into a working copy the workflow did not create (`default: true` keeps detached runs moving).
