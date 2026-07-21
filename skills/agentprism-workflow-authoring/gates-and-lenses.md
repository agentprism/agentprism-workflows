## Built-in quality loops

These helpers spawn their own subagents (on the default model — hand-roll with `parallel` + `agent` when you want panel members on specific backends). Full signatures in `reference.md`.

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

## Designing review gates and lenses

The quality helpers give you the machinery; these rules — each bought with a real failure — govern how to aim it:

- **A lens is a falsifiable question, not a job title.** Charge each reviewer with ONE failure mode and an explicit pass condition: "ok=true only if you *failed* to find a real bug" reads differently to a model than "review for correctness", and the difference shows in output. Overlapping mandates produce duplicate findings and diffuse accountability.
- **Force evidence generation, not opinion formation.** Require an `evidence` field of literal commands + exit codes; charge reviewers to *run* things — drive the e2e themselves, reproduce the bug on the wire, re-run the suite from the committed state. A lens that only reads produces plausible opinions; a lens that runs produces facts. Always include one lens whose entire job is independently re-verifying greenness while trusting nothing in the producer's report.
- **Cap the structured fields; overflow to files.** Evidence and feedback fields must stay small (tens of lines) — an oversized structured output can fail schema repair and kill the round. Full transcripts and detailed findings go to per-round files in a design directory; the structured verdict carries conclusions and pointers. A worktree-isolated reviewer's checkout is destroyed when its call ends, so point its overflow files at an absolute design directory OUTSIDE the repository (fine for calls that make no replay-safety declaration); at minimum, the terminal adjudication is always written somewhere durable.
- **Demand values, not attestations.** A schema field that asserts a check passed (`headMatchesReport: true`) can be emitted without the check ever running. Require the underlying value instead: the producer reports its `headSha`, each reviewer reports the `reviewedHeadSha` it actually inspected, and SCRIPT CODE compares them. The comparison is free and unfakeable — it turns "the reviewer says it looked at the right commit" into "the reviewer provably did".
- **Gate the plan before the expensive rounds.** For plan-and-implement work, the plan itself deserves one bounded cross-vendor review before any implementer runs — a plan defect costs every downstream round. Strongest form: make the plan schema carry its own source diff (`additions` / `omissions` / `reframings` against the verbatim source, with omissions and reframings required empty), so hop-zero fidelity is enforced by the schema at runtime instead of only by authoring discipline.
- **Diversity of question beats count of reviewers — and watch for the question nobody owns.** Distinct failure-mode lenses (compliance, correctness, deferred work, green-verify) beat N generic reviewers. When every lens verifies against the same derived artifact, add one whose only input is the ORIGINAL source (the user's verbatim request) and whose only question is fidelity: enumerate every addition, omission, narrowing, or reframing. Scope drift is invisible to every other lens by construction.
- **Constrain each lens's jurisdiction explicitly.** A minimalism lens will otherwise "improve" the design by descoping requested features: state that it judges HOW, never the owner's WHAT. Requested scope is not a design variable.
- **Feedback must be self-contained.** The producer's next round sees ONLY the feedback string — sessions are memoryless. Never template in references to files that may not exist ("read review-X.md" when no reviewer ran); interpolate everything the producer needs. A phantom citation sends an honest producer into a correct-but-wasteful STOP. The rule generalizes beyond feedback: EVERY path any prompt references must be traceable to a writer — an earlier call instructed to create it, a host-supplied `args` input, or that same prompt's own instructions. Before launching, walk every interpolated path in the script and name its writer; a file that "should obviously exist" but has no writer is one of the commonest authoring defects.
- **Adversarial gates do not self-converge — design the terminal state.** At high effort, each fix commit is fresh attack surface: rejections narrow but never reach zero on their own. Bound the rounds, then run a TERMINAL adjudicator whose verdict is final: it reads all rounds' files, independently spot-checks surprising verdicts in both directions (lens verdicts are inputs, not votes), resolves what the repo actually answers, and emits findings as a CLOSED list plus any genuine owner decisions.
- **The fix round after adjudication uses no panel.** One producer pass applying the closed list exactly — nothing more — judged directly by the SAME adjudicator re-verifying its own findings. Re-opening a multi-lens gate on a fix round generates novel findings forever. Match review breadth to the openness of the question: open question → panel; closed list → the author of the list.
- **Reconcile contradictions above the producer.** When lenses (or rounds) issue conflicting directives, the workflow owner adjudicates before the next produce round — an implementer will otherwise obey whichever spoke last, and the conflict lands unresolved on the terminal verdict.
- **Don't spend lenses where code suffices.** SHA-format checks, placeholder detection, "does the report name the mandated path" — script code, run in the checker BEFORE any reviewer burns tokens. Lenses are expensive instruments; point them only at questions requiring judgment.

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

`kind: "input"` resolves to free text, `kind: "select"` to one of `choices`. How the question reaches a human is the host's job (elicitation in the MCP server; `ExecOptions.confirm` in the SDK). With no live channel, `headless: "default"` (the default) takes `default ?? true`, `"abort"` aborts, and `"pause"` returns a managed run with `reason: "checkpoint_required"` plus non-secret `checkpointContext`. Resume the last mode with `checkpointReplies: { [context.callIndex]: decision }` or a live confirm. For `resumeFromRunId`, that key is the source context index; an unambiguous identity match may journal the injected answer at a shifted current index. Put a checkpoint before anything hard to reverse — applying diffs, pushing, publishing — and treat the FIRST commit into a user-owned checkout as exactly that: a workflow that mutates a working copy it did not create carries at least one checkpoint before its first mutation (`default: true` keeps detached runs moving).
