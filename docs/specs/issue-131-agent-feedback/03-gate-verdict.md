# Expose the Validator Verdict from `gate()`

**Date:** 2026-07-14

**Issue:** [#131](https://github.com/VikashLoomba/agentprism-workflows/issues/131), item 3

## 1. Problem

The in-script `gate()` DSL helper currently returns `{ ok, value, attempts }`. `value` is the last producer result, while the validator result is used only to decide whether the gate passed and to feed `feedback` into the next producer attempt. Any other structured validator data—such as the reviewed commit SHA, rejection codes, test evidence, or scores—is discarded at the helper boundary.

That forces workflow authors to assign the validator result into an outer closure merely to use it after `gate()` finishes. The workaround is repeated in every gate-then-commit or gate-then-report script, obscures the actual data flow, and is easy to get wrong when a later attempt replaces an earlier verdict. `gate()` must expose the exact last validator result without changing the meaning of its existing `ok`, `value`, or `attempts` fields.

## 2. Current state

### Engine runtime

`packages/workflow-engine/src/workflow.ts` defines `runWorkflow()` and, inside it, the local `gate` function. The current signature accepts:

```ts
thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown
validator: (result: unknown) =>
  | Promise<{ ok: boolean; feedback?: string }>
  | { ok: boolean; feedback?: string }
options?: { attempts?: number }
```

The implementation normalizes the attempt count with `Math.max(1, opts.attempts ?? 3)`, calls `thunk(feedback, i)`, then unconditionally calls `validator(last)` with the producer result. A truthy `verdict?.ok` returns `{ ok: true, value: last, attempts: i + 1 }`; otherwise `verdict?.feedback` becomes the next producer's feedback. Exhaustion returns `{ ok: false, value: last, attempts }`. The local `verdict` is therefore discarded on both the passing and exhausted paths.

`runWorkflow()` injects the function into the VM context as `gate: tracked(gate)`. The `tracked()` wrapper only adopts host promises into the script realm; it does not allocate a call index, hash a call, or write a journal entry.

The same file's `agent()` and `checkpoint()` implementations are the only relevant journal participants. Each increments `RuntimeState.callSeq`, checks `WorkflowRunOptions.resumeJournal`, and sends a `JournalEntry` through `onAgentJournal` for a live result. Consequently, a producer or validator implemented with `agent()` is already journaled as an ordinary agent call, while the `gate()` aggregate is not.

### Published DSL declaration

`packages/workflows/src/dsl.d.ts` declares the ambient, non-importable global `gate()` for workflow authors. Its current return type is:

```ts
Promise<{ ok: boolean; value: unknown; attempts: number }>
```

Its validator type permits only `{ ok: boolean; feedback?: string }`, so it neither advertises a bare boolean verdict nor preserves the type of extra structured fields.

### Persistence and host wire

`packages/shared-types/src/workflow-result.ts` defines `JournalEntry` as `{ index, hash, result, session? }` and `WorkflowRunResult<T>.result` as the script's JSON-serializable top-level return value. `packages/workflow-engine/src/workflow-manager.ts` persists the per-call journal and, after completion, `managed.result?.result` in `PersistedRunState.result`. There is no gate-specific persisted shape.

`packages/mcp-server/src/workflow-tool-output.ts` deliberately types the script result as `z.unknown().optional()` in `workflowToolOutputShape`. A script that returns a gate result can therefore carry an added nested `verdict` without changing the MCP tool input, output schema, or the single-tool surface.

### Token-free validator

`packages/workflows/src/validate.ts` implements `fabricateFromSchema()` and the mock `AgentRunner` used by `validateWorkflowScript()`. `fabricateFromSchema()` returns `true` for a boolean schema and recursively fabricates every declared object property. The mock returns that complete fabricated object whenever an `agent()` call has a schema. Thus a validator schema containing `ok`, `commitSha`, `feedback`, and `scores` already produces all of those fields, with `ok: true`; no mock implementation discards them.

### Tests and authoring surfaces

There is currently no direct `gate()` behavior test in `packages/workflow-engine/test` or `packages/workflows/test`. The closest relevant styles are direct `runWorkflow()` assertions in `packages/workflow-engine/test/workflow-runtime.test.ts`, observable journal/hash assertions in `packages/workflow-engine/test/journal-hash.test.ts`, and whole-script dry-run assertions in `packages/workflows/test/validate.test.ts`.

The current `{ ok, value, attempts }` contract is documented in:

- `README.md` under “Writing workflow scripts”;
- `packages/workflow-engine/README.md` under “The script DSL”;
- `packages/workflows/README.md` in the in-script DSL table;
- `docs/api.md` under “Workflow script DSL”;
- `skills/agentprism-workflow-authoring/SKILL.md` in the quality-loop example and the larger plan/implement/review example;
- `skills/agentprism-workflow-authoring/reference.md` in “DSL globals — complete signatures”; and
- gate-using examples under `packages/workflows/examples/` and the byte-identical skill copy at `skills/agentprism-workflow-authoring/examples/repo-triage.workflow.js`.

`scripts/generate-authoring-prompt.mjs` generates `packages/mcp-server/src/generated/authoring-prompt-content.ts` from `SKILL.md`, `reference.md`, and `examples/quick-wins.workflow.js`. `packages/mcp-server/test/authoring-prompt.test.ts` enforces byte-for-byte drift detection. `quick-wins.workflow.js` does not use `gate()`, but the generated prompt still changes because it embeds the skill and reference.

## 3. Proposed design

### 3.1 Return field and meaning

Add one enumerable field named `verdict` to every fulfilled `gate()` result:

```ts
{
  ok: boolean;
  value: TValue;
  verdict: TVerdict | null;
  attempts: number;
}
```

`verdict` is the last completed validator callback's exact supported return value. The engine must not clone, project, merge, or normalize a structured object, so extra fields and object identity within the live run are preserved. The field is called `verdict` because the existing implementation, schemas, examples, and issue already use that term for the validator's result; it also avoids confusing the producer's `value` with validation metadata.

Passing on the second attempt can therefore produce this JSON-compatible value:

```json
{
  "ok": true,
  "value": {
    "branch": "issue-131",
    "tests": 148
  },
  "verdict": {
    "ok": true,
    "commitSha": "9f4c2e17d8a6",
    "feedback": "All required checks passed.",
    "scores": {
      "correctness": 1,
      "coverage": 0.96
    }
  },
  "attempts": 2
}
```

Exhaustion returns the final rejection rather than an earlier or “best” verdict:

```json
{
  "ok": false,
  "value": {
    "branch": "issue-131",
    "tests": 146
  },
  "verdict": {
    "ok": false,
    "feedback": "The resume regression is still failing.",
    "rejectionCodes": ["RESUME_REGRESSION"]
  },
  "attempts": 3
}
```

`value` remains the last producer result and `attempts` remains the number reported by the existing paths. The default remains three, and the existing minimum-one normalization is unchanged.

### 3.2 Accepted validator shapes

The supported validator result is widened additively from an object to these shapes:

```ts
type GateValidatorVerdict =
  | { ok: boolean; feedback?: string }
  | boolean
  | null;
```

The object is structurally typed: it may contain any additional fields, and generic inference must retain those fields. The meanings are:

- `{ ok: true, ... }` passes; `{ ok: false, ... }` rejects. As today, an object's `feedback` is passed to the next producer after a rejection.
- Bare `true` passes and is returned as `verdict: true`.
- Bare `false` rejects, supplies `undefined` feedback to the next producer, and is returned as `verdict: false` if it is the last verdict.
- `null`, including a recoverably failed validator `agent()` call, rejects, supplies `undefined` feedback, and is returned as `verdict: null` if it is the last completed validator return.

For compatibility with JavaScript scripts that already return an unsupported value, the runtime must not introduce a new validation exception: a non-null value other than the declared object/boolean shapes is retained verbatim, treated as rejected unless its `.ok` is truthy under the existing object behavior, and its `.feedback` is threaded as today. An explicit `undefined` return is outside the ambient contract, remains a rejection with no feedback, and is normalized to `verdict: null` so the new field stays JSON-stable. The ambient declaration advertises only the supported shapes.

The engine should implement acceptance without losing current object semantics:

```ts
const accepted =
  typeof lastVerdict === "boolean"
    ? lastVerdict
    : Boolean((lastVerdict as { ok?: unknown } | null)?.ok);
```

This makes boolean verdicts useful while preserving the current truthiness behavior for legacy object values. Boolean rejection has no feedback; object feedback remains unchanged.

### 3.3 Throwing and no-verdict behavior

Exception behavior does not change:

- If the producer throws or rejects, `gate()` rejects immediately. The validator is not called for that attempt and no `GateResult` exists.
- If the validator throws or rejects, `gate()` rejects immediately. It does not return a partial result containing the thrown value, retry the gate-level validator, or reinterpret the error as a rejection. This is essential for non-recoverable and pause-class `WorkflowError`s to reach `WorkflowManager` unchanged.
- If a caller catches either exception outside `gate()`, the caught value is the exception; there is no hidden partial verdict to inspect.

Initialize the internal last-verdict slot to `null`. If `gate()` ever fulfills without a validator callback completing, return `verdict: null` as the JSON-stable “no verdict” sentinel. With a normal finite attempt count, the present loop always either completes a validator or rejects; this sentinel chiefly makes the new field total for defensive/runtime-invalid paths.

A producer resolving `null` is **not** a no-verdict case. The current implementation calls `validator(last)` unconditionally, so the validator receives `null`. The new behavior preserves that rule:

```json
{
  "ok": false,
  "value": null,
  "verdict": {
    "ok": false,
    "feedback": "The producer returned no result."
  },
  "attempts": 3
}
```

No special null-producer skip is added, because doing so would change control flow and prevent validators from classifying or recovering from a failed producer.

### 3.4 Ambient TypeScript declaration

Update only the ambient global signature in `packages/workflows/src/dsl.d.ts`; do not add an importable `gate` export. The exact declaration is:

```ts
declare function gate<
  TValue = unknown,
  TVerdict extends boolean | { ok: boolean; feedback?: string } | null = {
    ok: boolean;
    feedback?: string;
  },
>(
  thunk: (feedback: string | undefined, attempt: number) => Promise<TValue> | TValue,
  validator: (result: TValue) => Promise<TVerdict> | TVerdict,
  options?: { attempts?: number },
): Promise<{
  ok: boolean;
  value: TValue;
  verdict: TVerdict | null;
  attempts: number;
}>;
```

The `TValue` generic preserves the producer type. `TVerdict` preserves custom structured fields, so a synchronous validator returning `{ ok: true, commitSha: "9f4c2e17d8a6" }` exposes `outcome.verdict?.commitSha` as `string | undefined` rather than collapsing the verdict to the base `{ ok, feedback? }` type. `null` remains in the result because it is both a supported failed-validator return and the no-completed-validator sentinel.

The engine may use private local aliases for readability, but no new named type is exported from `@automatalabs/workflow-engine`, `@automatalabs/workflows`, or `@automatalabs/shared-types`. The DSL function remains a realm global rather than an importable SDK function.

### 3.5 Journaling and resume

No journal or persistence schema changes are required:

1. `gate()` continues not to increment `callSeq` or emit a `JournalEntry`.
2. Producer and validator `agent()` calls continue to journal their raw results independently.
3. On prefix replay, those agent results are returned from the existing `resumeJournal`; the deterministic gate loop recomputes the same `{ ok, value, verdict, attempts }` aggregate.
4. A pure JavaScript validator is recomputed from the producer result, just as it is today.
5. `JournalEntry`, `PersistedRunState`, agent-call hashes, and checkpoint hashes remain byte-compatible. Old journals need no migration and gain the new aggregate field when replayed by the new engine.

If a script returns the entire gate result at top level, `WorkflowRunResult.result`, `PersistedRunState.result`, and the MCP tool's unconstrained `result` naturally include `verdict`. That is ordinary script-result persistence, not a new gate journal entry.

### 3.6 Dry-run validator

The gate-verdict feature requires no changes to `fabricateFromSchema()` or the mock `AgentRunner`,
and it adds no gate-specific `ValidateWorkflowOptions`, CLI flags, or `ValidateWorkflowReport`
fields. The coordinated pack separately adds scripted mock answers and their reports in
`04-dry-run-mock-answers.md`; those additions compose with this feature without changing default
fabrication. A validator agent whose schema declares extra verdict fields already receives a
complete fabricated object, and its `ok` boolean is already `true`, so an unscripted gate terminates
on the first attempt and the new field exposes that object.

Add regression coverage to prove the existing mock behavior reaches `dryRun.result.verdict`; the test, not a new mock knob, is the required validator-package change.

### 3.7 Serialization, size, and redaction

`verdict` has no gate-specific byte cap, truncation, or redaction. It is the same callback value that an agent-backed validator already places in its ordinary `JournalEntry.result`, so adding a second gate-level persistence format or a different redaction policy would create inconsistent data. The helper also performs no JSON serialization while the script is running.

Authors must continue to return only JSON-serializable data from the script's top level, as required by `WorkflowRunResult.result`. If a script returns the whole gate result, the complete verdict is persisted and may be returned through MCP; validator prompts and schemas must therefore avoid credentials and other secrets. Large verdicts can duplicate data between an agent journal entry and the completed top-level result, so schemas should keep evidence concise, but the engine imposes no new limit in this change.

## 4. Alternatives considered

### Keep closure capture

Rejected because it is the reported friction. It duplicates state outside the combinator, makes “last verdict” depend on author bookkeeping, and obscures the producer/validator contract.

### Replace `value` with the validator result

Rejected because `value` has always meant the producer's last result. Changing it would break every caller that uses the accepted artifact after the gate and would still leave no clean way to return both values.

### Name the field `validation`, `validatorValue`, or `lastVerdict`

Rejected in favor of `verdict`. `validation` can mean the process or a boolean, `validatorValue` is implementation-oriented, and `lastVerdict` is redundant because the helper already returns only the terminal attempt's data. `verdict` matches existing schemas, documentation language, and issue #131.

### Normalize the verdict to `{ ok, feedback? }`

Rejected because normalization would discard precisely the commit SHA, scoring, rejection, and evidence fields this feature is intended to expose. Returning the raw structured value also preserves future validator-specific data without further API expansion.

### Spread verdict fields onto the gate result

Rejected because validator fields could collide with `ok`, `value`, or `attempts`, and the origin of fields would be ambiguous. A nested `verdict` creates a stable namespace.

### Return a verdict only on success

Rejected because the final rejection details are equally valuable for diagnostics and fail-closed workflow results. Both terminal paths return the last completed verdict.

### Catch validator errors and return them as verdicts

Rejected because it would change established exception semantics and could swallow token-budget, auth, provider-usage, checkpoint, or schema-compliance faults that must propagate to the manager lifecycle.

### Journal the aggregate gate result

Rejected because producer and validator agent results are already journaled under deterministic call indices. A new gate entry would consume or require a second index namespace, duplicate data, change prefix-replay behavior, and require persistence migrations without improving determinism.

### Keep bare booleans unsupported

Rejected because boolean validators are a natural zero-allocation form of a predicate and the task explicitly requires defined behavior for them. Treating `true`/`false` as pass/reject is additive to the documented object contract and keeps `verdict` faithful to the callback result.

## 5. Compatibility & semver

### `packages/workflow-engine` (`@automatalabs/workflow-engine`)

The runtime change is additive: existing fields retain their names and meanings, object validators behave as before, and old scripts need no edits. Bare boolean `true` changes behavior only for a previously unsupported input (it now passes instead of exhausting). The new enumerable property can affect callers that deep-compare or stringify the entire gate object, which is the principal compatibility caveat.

Changeset: **minor**, because the published DSL runtime gains a new observable result field and a newly supported validator form.

### `packages/workflows` (`@automatalabs/workflows`)

The ambient declaration gains `verdict`, generic inference, and boolean/null validator support. This
item makes no additional production change to the validator or its CLI; the coordinated
mock-answer surface is specified independently in `04-dry-run-mock-answers.md`. Documentation and
runnable examples shipped with this package are updated to teach and exercise the field.

Changeset: **minor**, because the published authoring type surface gains an additive field and accepted input type.

### `packages/mcp-server` (`@automatalabs/mcp-server`)

The `workflow` tool remains the only tool. The gate-verdict item itself adds no input or output field
because `result` is already `unknown`; the coordinated run/inspect/await schema changes are owned by
`01-run-observability.md` and `02-detached-runs.md`. The checked-in `author-workflow` prompt content
changes when regenerated from the updated authoring skill and reference.

Changeset: **patch**, because this package receives a version-matched generated documentation refresh but no tool, prompt argument, or runtime protocol shape change.

No change or Changeset entry is needed for `packages/shared-types` or `packages/acp-agents`.

Use one Changeset file containing the three entries above so the release notes describe one coherent feature.

## 6. Test plan

### `packages/workflow-engine`

Add focused `node:test` cases to `packages/workflow-engine/test/workflow-runtime.test.ts`, using the existing direct `runWorkflow()` plus stub-runner style:

1. A structured validator that passes on the first attempt returns all four fields and preserves extra nested fields (`commitSha`, `scores`) in `verdict`.
2. Two rejected attempts followed by a pass prove that feedback reaches the next producer, `value` is the final producer result, `verdict` is the passing third verdict, and `attempts` is `3`.
3. Exhaustion proves the final producer and final rejection verdict are returned, not the first attempt's values.
4. A bare `true` passes immediately with `verdict: true`; a bare `false` retries without feedback and exhausts with `verdict: false`.
5. A producer returning `null` still invokes the validator with `null` and returns the validator's structured rejection.
6. A validator returning `null` rejects and returns `verdict: null` on exhaustion.
7. A producer throw proves the validator is not invoked and `gate()` rejects; a validator throw proves later attempts do not run and the original error propagates through the existing script-error classification.
8. An unsupported legacy object with extra fields and a truthy `ok` continues to pass without runtime shape validation, guarding the non-breaking object semantics.

Add a replay case alongside the runtime tests or in `packages/workflow-engine/test/journal-hash.test.ts`:

1. Run a gate whose producer and validator are both `agent()` calls and capture `onAgentJournal` entries.
2. Assert there are exactly two entries—no gate aggregate entry.
3. Resume the identical script with those entries as `resumeJournal` and a runner that would fail if called live.
4. Assert the replayed top-level result includes the same structured `verdict` and the journal/hash shape is unchanged.

### `packages/workflows`

Add a dry-run case to `packages/workflows/test/validate.test.ts`. The script should use a producer agent and a validator agent whose JSON Schema declares `ok`, `commitSha`, `feedback`, and a nested score. Assert:

- validation completes successfully in one gate attempt because the mock fabricates `ok: true`;
- `dryRun.agentCalls` records both calls with the validator marked `schema: true`;
- `dryRun.result.value` is the fabricated producer value; and
- `dryRun.result.verdict` contains every fabricated validator field.

This is a regression test only for the gate-verdict PR; it requires no production edit to
`packages/workflows/src/validate.ts`. The later mock-answer PR may edit that file under
`04-dry-run-mock-answers.md`.

Add a compile-only probe covered by the existing `packages/workflows/test/sdk.test.ts` `tsc -p tsconfig.test.json` gate (or a dedicated included test file). It must prove that a structured callback infers `outcome.verdict?.commitSha` as `string | undefined`, preserves the producer type in `outcome.value`, and infers a boolean validator's verdict as `boolean | null`.

### `packages/mcp-server`

Keep the byte-for-byte source/generated assertion in `packages/mcp-server/test/authoring-prompt.test.ts` and add a sentinel assertion that the served prompt contains the `{ ok, value, verdict, attempts }` signature or the `outcome.verdict` example. Retain the existing assertion that `tools/list` is exactly `["workflow"]`.

No `packages/shared-types` or `packages/acp-agents` tests are needed because their types and runtime are unchanged.

## 7. Docs & skill updates

Update every author-facing gate surface in the same PR:

1. `README.md`: replace the bare `gate()` list entry with a concise contract stating that it returns `{ ok, value, verdict, attempts }`, with `value` from the producer and `verdict` from the last validator.
2. `packages/workflow-engine/README.md`: expand the quality-combinator line with the same distinction and mention that inner agent calls, not the aggregate, are journaled.
3. `packages/workflows/README.md`: update the DSL table row to show the four-field result and raw last-validator semantics.
4. `docs/api.md`: update the workflow-script DSL entry to include the exact return shape and boolean/object validator forms.
5. `skills/agentprism-workflow-authoring/SKILL.md`:
   - update the quality-loop table;
   - revise the first gate example so the validator returns an extra field and the code reads it through `outcome.verdict` rather than a closure; and
   - revise the larger plan/implement/review example so its final return demonstrates the terminal review verdict.
6. `skills/agentprism-workflow-authoring/reference.md`: change the signature table to `→ { ok, value, verdict, attempts }`; define `value`, `verdict`, boolean/null behavior, exception propagation, and the fact that a null producer is still validated.
7. `skills/agentprism-workflow-authoring/examples/repo-triage.workflow.js`: add `verdict: null` to the defensive initial gate value and expose the final report-review verdict in the returned result. Apply the same edit first to its canonical source, `packages/workflows/examples/repo-triage/workflows/repo-triage.workflow.js`, and keep the two files byte-identical as required by `skills/agentprism-workflow-authoring/examples/README.md`.
8. `skills/agentprism-workflow-authoring/examples/README.md`: state that the repo-triage example demonstrates access to the terminal review verdict. `skills/agentprism-workflow-authoring/examples/quick-wins.workflow.js` needs no edit because it does not use `gate()`.
9. `packages/workflows/examples/image-gate/image-gate.workflow.js` and its `README.md`: return the image validator's terminal verdict and show it in the documented result shape. This is the clearest runnable demonstration that structured validation evidence is no longer closure-captured.
10. `packages/workflows/examples/repo-triage/README.md` and `packages/workflows/examples/README.md`: update the documented result/feature descriptions to mention the exposed terminal verdict.
11. Run `node scripts/generate-authoring-prompt.mjs` after all skill/reference edits and commit the regenerated `packages/mcp-server/src/generated/authoring-prompt-content.ts`. Do not edit the generated file by hand.
12. Update the prompt sentinel in `packages/mcp-server/test/authoring-prompt.test.ts` so CI checks that the new contract reaches MCP prompt consumers while the existing single-tool assertion remains intact.

The MCP tool surface must remain exactly one `workflow` tool; the documentation change is delivered through the already-existing `author-workflow` prompt.

## 8. Implementation breakdown

This fits in one PR, ordered as follows:

1. **S — Engine return contract.** In `packages/workflow-engine/src/workflow.ts`, retain the latest validator result, add it to both return paths, implement bare-boolean acceptance, keep null/throw behavior as specified, and leave `callSeq`/journal code untouched.
2. **M — Engine behavior and replay tests.** Add the structured, exhaustion, feedback, boolean, null, exception, and two-entry replay cases to the existing engine test style.
3. **S — Published ambient type.** Update the generic `gate()` declaration in `packages/workflows/src/dsl.d.ts` and add the compile-only inference probe.
4. **S — Validator regression coverage.** Add the structured-verdict dry-run test in `packages/workflows/test/validate.test.ts`; make no mock implementation changes.
5. **M — Primary docs and runnable examples.** Update the root/package/API READMEs, both SKILL.md gate examples, `reference.md`, image-gate, and both byte-identical repo-triage script copies plus their example indexes/READMEs.
6. **S — Regenerate and pin the MCP authoring prompt.** Run `scripts/generate-authoring-prompt.mjs`, commit the generated module, and add the new prompt-content sentinel while preserving the one-tool assertion.
7. **S — Release metadata and verification.** Add one Changeset with `workflow-engine: minor`, `workflows: minor`, and `mcp-server: patch`; run the focused tests for those three packages, their typechecks, the authoring-prompt drift test, and the repository's existing docs/example drift checks.
