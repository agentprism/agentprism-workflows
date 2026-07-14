# Scripted Mock Answers for Validator Dry Runs

**Date:** 2026-07-14

**Reference:** Feedback issue #131, section 4

## 1. Problem

`@automatalabs/workflows` validates a script by parsing it and then executing it in the real workflow realm with an in-process mock `AgentRunner`. For structured calls, that runner always uses `fabricateFromSchema()`, whose boolean default is `true`. This is useful for simple approval gates, but it forces every boolean-controlled call down the same path. A refutation panel whose schema contains `real: boolean`, for example, can never fabricate `real: false`; a correct one-round convergence loop can therefore halt and be reported as `INVALID` solely because of the validator's fixture.

The validator needs deterministic, author-supplied mock answers selected by agent label. Authors must be able to override only the fields that control a branch, reuse an answer for a family of dynamic labels, and provide a sequence for repeated calls so one dry run can exercise reject-then-approve behavior. The machine and human reports must show exactly which rule supplied each answer and identify rules or sequence entries the script never reached. A malformed fixture or a schema violation introduced by an override must fail visibly instead of making a dry run green through silent coercion.

## 2. Current state

- `packages/workflows/src/validate.ts` owns the validator. `validateWorkflowScript()` first calls `parseWorkflowScript()`, constructs a throwaway `WorkflowManager`, and runs with `journaling: false`; invalid scripts are represented by `ValidateWorkflowReport` rather than thrown. `ValidateWorkflowOptions` currently has `args`, `workflows`, `cwd`, `dryRun`, `tokenBudget`, `maxAgents`, and `timeoutMs`, with no mock-answer input.
- In the same file, `fabricateFromSchema()` is explicitly “intentionally simple”: it deterministically chooses `const`, the first `enum`/union variant, defaults, one to three fabricated array items, `mock-<field>` strings, `1` for numbers, and `true` for booleans. It is not a complete JSON Schema instance generator. For example, its three-item clamp violates `minItems: 5`, `mock-<field>` can violate `pattern`, and its numeric `1` can violate `multipleOf: 2`; it also does not generally satisfy formats, `uniqueItems`, or every `maxItems` combination. The local mock runner returns that value without calling TypeBox `Check` whenever `MockRunOptions.schema` is present; schema-less calls return `[dry-run] mock output for <label>`. The absence of a check is why those fabrication limitations do not make scripts invalid today.
- `ValidatedAgentCall` currently records `label`, phase/model/tier/mode attribution, backend, and whether a schema was supplied. `ValidateWorkflowReport.dryRun` records calls, checkpoints, phases, logs, duration, and result. Neither shape records the source of a fabricated value or unused input. `formatValidateReport()` renders those existing fields and the shared `warnings` array.
- `packages/workflows/src/cli.ts` is the `agentprism-workflows` bin. Its only command is `validate`; it parses JSON for `--args`, reads JSON for `--args-file`, maps usage mistakes through `fail()` to exit code `3`, and sends the completed options object to `validateWorkflowScript()`. The call at the end of `main()` is not locally guarded; its top-level `.catch()` prints `validate crashed:` and exits `3`. It has no fixture flags.
- `packages/workflows/src/index.ts` re-exports `validateWorkflowScript`, `fabricateFromSchema`, `formatValidateReport`, `MOCK_TOKENS_PER_AGENT`, and the four current validation types. It is the public SDK barrel that must export the new option and report types.
- `packages/shared-types/src/agent-runner.ts` defines the frozen `AgentRunner.run()` seam and requires a schema-bearing call to resolve to a parsed, schema-validated value. `packages/acp-agents/src/structured-output.ts` enforces that contract for live agents in `validateValue()`/`resolveStructuredOutput()` with TypeBox `Convert` followed by `Check`. The validator's injected runner bypasses that live implementation, so it must validate its own scripted fixtures. The repository's pinned `typebox@1.3.2` exposes `Check` and `Errors` from the ESM subpath `typebox/value`; its localized validation-error pointer field is `instancePath`, as the existing `rejectionText()` in `packages/acp-agents/src/structured-tool.ts` already consumes.
- `packages/workflow-engine/src/workflow.ts` assigns `callIndex` synchronously in `runWorkflow()` before entering `createLimiter()`, and `createLimiter()` services its queue FIFO. The index is deliberately not exposed in `RunOptions` or the `onAgentStart` event. The same `agent()` implementation derives retries from `agentOptions.retries ?? options.agentRetries ?? 0`, invokes `AgentRunner.run()` inside the attempt loop, and uses `isEmptyTextAgentResult()` to turn blank schema-less text into recoverable `AGENT_EMPTY_OUTPUT`. `WorkflowManager` defaults to concurrency `8` (`packages/workflow-engine/src/workflow-manager.ts`), and the validator currently accepts that default. This means widening the frozen runner seam solely to allocate validator sequences would be disproportionate, but runner-invocation-count allocation must also account for retries.
- `packages/workflows/test/validate.test.ts` uses `node:test` and `node:assert/strict` to cover parse/dry-run outcomes, fabricated schema values, call attribution, checkpoints, budgets, and warnings. There is no dedicated CLI test file today.
- Validator documentation appears in `README.md`, `docs/api.md`, `packages/workflows/README.md`, `skills/agentprism-workflow-authoring/SKILL.md`, and `skills/agentprism-workflow-authoring/reference.md`. `scripts/generate-authoring-prompt.mjs` composes the skill, reference, and the quick-wins example into `packages/mcp-server/src/generated/authoring-prompt-content.ts`; `packages/mcp-server/test/authoring-prompt.test.ts` rejects drift.

## 3. Proposed design

### 3.1 Public input types and option

Add these exports to `packages/workflows/src/validate.ts` and re-export them from `packages/workflows/src/index.ts`:

```ts
export type MockAnswerJson =
  | null
  | boolean
  | number
  | string
  | MockAnswerJson[]
  | { [key: string]: MockAnswerJson };

export interface MockAnswerSequence {
  readonly $sequence: readonly MockAnswerJson[];
}

export type MockAnswerRule = MockAnswerJson | MockAnswerSequence;

/** Label glob -> one reusable answer or one finite answer sequence. */
export type MockAnswers = Readonly<Record<string, MockAnswerRule>>;
```

Extend `ValidateWorkflowOptions` additively:

```ts
export interface ValidateWorkflowOptions {
  // existing fields unchanged

  /** Dry-run answers selected by the resolved agent label. */
  mockAnswers?: MockAnswers;
}
```

A rule containing a top-level own property named `$sequence` is the sequence form and must contain no other top-level keys. Its value must be a non-empty array. Sequence elements are answer values and are not recursively interpreted as rule wrappers, so an answer whose actual schema contains a `$sequence` field can be represented as the sole element of an outer sequence. A raw JSON array is a single array-valued answer, not a sequence; this removes the ambiguity between a top-level array result and repeated answers.

Examples:

```ts
const report = await validateWorkflowScript(script, {
  mockAnswers: {
    "*": { approved: true },
    "refute:*": { real: false },
    "quality:review": {
      $sequence: [
        { ok: false, feedback: "exercise the revision path" },
        { ok: true },
      ],
    },
  },
});
```

```json
{
  "refute:*": { "real": false },
  "quality:review": {
    "$sequence": [
      { "ok": false, "feedback": "exercise the revision path" },
      { "ok": true }
    ]
  }
}
```

Each call matches against the final resolved label passed to `AgentRunner.run()`: an authored label after the engine's trim, or the engine-generated `<phase> agent <n>` / `agent <n>` label from `defaultAgentLabel()`. Matching is case-sensitive and covers the entire label. The label-glob grammar is intentionally small and path-independent:

- `*` matches zero or more characters, including `:` and `/`.
- `?` matches exactly one character.
- `\\` escapes the next character. This makes `*`, `?`, and `\\` literal and also provides an exact spelling for an otherwise reserved numeric rule key.
- Every other character, including `[`, `]`, `{`, `}`, and `!`, is literal.
- Adjacent `*` characters are equivalent to one `*`; an empty glob or a trailing escape is invalid.
- A raw rule key that is an ECMAScript canonical array-index property name is invalid: `"0"`, or a non-zero decimal integer with no leading zero whose value is at most `4294967294`. `"01"` and `"4294967295"` are not canonical array indexes and are not rejected by this rule. This restriction applies to the raw glob key, not to labels. An exact numeric label remains expressible by escaping any one digit: the JSON or TypeScript source key `"\\10"` decodes to the non-index glob `\10`, which compiles to the literal label `10`.

This is the mock-answer rule-key grammar, not the ad hoc inspection `labelGlob` contract in
`01-run-observability.md`. Both use case-sensitive whole-label `*`, `?`, and backslash matching, but
their reviewed terminal-escape behavior is intentionally distinct: a trailing escape is invalid in
prevalidated mock-answer configuration, while inspection treats it as a literal backslash. Keep
their normalizers separate and pin that distinction in their respective tests.

Normalization captures `Object.keys(mockAnswers)` exactly once, after runtime JSON-data validation, and builds a frozen ordered array of normalized rules. Canonical array-index keys are rejected because ECMAScript moves them ahead of other keys regardless of source/insertion order; after their rejection, the remaining distinct string keys retain JSON member order for CLI input and property-creation order for a programmatic record. Duplicate names in CLI JSON collapse to one property under the existing `JSON.parse()` behavior and therefore never create two rules. Matching and reporting operate only on the captured normalized array and never re-enumerate the caller's object.

If several rules match, the **last matching rule in that normalized order wins**. This supports a broad default followed by narrow exceptions and gives the same result for inline JSON, file JSON, and a programmatically constructed object. Only the winning rule consumes an answer; earlier matching rules increment their report's match count but do not advance a sequence.

A single answer is reusable and supplies every call for which its rule wins. A sequence is finite: item `0` supplies the first winning call, item `1` the second, and so on. Exhaustion fails the dry run with `SCRIPT_VALIDATION_ERROR` and a redacted reason naming the label, glob, sequence length, and number already consumed. It does not repeat the last entry and does not fall back to fabrication. Consumption state is created afresh for every `validateWorkflowScript()` invocation and is shared by root and nested workflow calls within that invocation.

### 3.2 CLI flags

Add the following options to `USAGE` and the parser in `packages/workflows/src/cli.ts`:

```text
--mock-answers <json>       label-glob mock answers for dry-run agent calls
--mock-answers-file <path>  read the label-glob mock answers JSON from a UTF-8 file
```

The inline form supports the issue's requested command directly:

```bash
agentprism-workflows validate flow.workflow.js \
  --mock-answers '{"refute:*":{"real":false}}'
```

The file path is resolved against the process working directory, matching `--args-file`. The two flags are mutually exclusive, and each may appear at most once. A missing value, unreadable file, invalid JSON, non-object top level, invalid rule/glob, or limit violation is a usage error: the CLI prints the established `fail()` message and exits `3` without executing the workflow. `--json` affects only report rendering, not how the input is parsed.

`validateWorkflowScript()` accepts an already parsed object and owns all semantic validation of rules, including the top-level record check, glob compilation, `$sequence` shape, JSON-data restrictions, and normalized size/count/depth limits. Supplying an invalid `options.mockAnswers` value from untyped JavaScript is an option-contract error and throws `TypeError` before script parsing; the existing guarantee that an invalid **workflow script** returns a report remains unchanged.

The CLI parses the JSON and enforces source byte size, flag repetition, and mutual exclusion, but delegates rule/glob validation to `validateWorkflowScript()`. Its call site must be changed from the current unguarded call to a local `try/catch`: a `TypeError` from `validateWorkflowScript()` while either mock-answer flag supplied the option is passed to `fail()` with the relevant flag name, producing the established usage footer and exit `3`; a non-`TypeError` is rethrown to the existing top-level “validate crashed” handler. Thus a bad glob is a clean usage error, not an internal-crash diagnostic.

### 3.3 Answer construction and schema enforcement

For every schema-bearing call:

1. Produce a fresh base value with the existing `fabricateFromSchema(schema)` behavior.
2. Select and, for a sequence, reserve the winning scripted answer.
3. Deep-merge the answer over the fresh base while recording the JSON Pointer paths that the answer replaced or added.
4. Run TypeBox `Check(schema, merged)`, without `Convert`.
5. If the merged value passes, return it. If it fails, apply the baseline-delta rule below; return it only when every remaining failure is inherited from an untouched defect in the fabricated base.

Deep merge is defined only for JSON objects: when both base and override at a position are non-null, non-array objects, merge their own keys recursively; otherwise the override replaces the base at that position. Arrays are replaced whole, not concatenated or index-merged. `false`, `0`, `""`, and `null` are intentional replacements and are never treated as missing. Every sequence entry starts from a new fabricated base; answers do not accumulate across rounds. The merge creates new objects and arrays and must use data-property creation rather than assignment through `__proto__`, so neither the schema-derived base nor the caller's options are mutated and JSON keys cannot alter prototypes.

The **baseline-delta rule** prevents the new strict check from turning a correct opted-in script invalid merely because `fabricateFromSchema()` already mishandles part of its schema. `packages/workflows/src/validate.ts` must add both functions from the package's ESM value subpath (and must not import or apply `Convert`):

```ts
import { Check, Errors } from "typebox/value";
```

- Only after the merged value fails `Check`, run `Check(schema, base)` and collect `Errors(schema, merged)` and `Errors(schema, base)`. Immediately normalize every TypeBox `TLocalizedValidationError` to an internal `{ path, message }` record with `path` copied from `error.instancePath`; do not read a nonexistent `error.path`. Fingerprint normalized errors by `.path` plus `.message`. Answer values are never part of a fingerprint or report.
- Compute replaced paths during merge. When both values at a position are non-null, non-array JSON objects, recurse and do not mark the container itself; otherwise mark that position as replaced. A new key is marked at its key path. Construct paths as RFC 6901 token arrays (escaping `~` and `/` when rendered), treat TypeBox's empty root `instancePath` (`""`) as the empty token sequence, render that root as `/` only in diagnostics, and compare tokens rather than raw string prefixes. An error path and a replaced path are related when either token sequence is equal to or an ancestor of the other. This deliberately treats root/cross-field failures as answer-related whenever the answer replaced any path.
- A merged error is **override-introduced** if its fingerprint is absent from the base errors or its path is related to any replaced path. Any override-introduced error is fatal. This catches an invalid replacement even when the simple base happened to fail at the same array or object path.
- A merged error is **inherited fabrication debt** only when the identical fingerprint exists for the base and its path is unrelated to every replaced path. If all merged errors are in this class, accept the merged value and add one value-free warning incident for later grouping by label, winning glob, and ordered set of error paths. The human warning says the validator accepted pre-existing fabricated-default limitations at up to three paths and includes an occurrence count; it never claims the fixture itself is schema-conforming. Repeated identical incidents are one warning. These warnings remain non-fatal and also appear in the normal `warnings` array in JSON reports.
- If `Check` or `Errors` throws for an exotic schema, treat it as an override-introduced validation failure and raise `SCHEMA_NONCOMPLIANCE`; do not silently accept a value that could not be compared.

This makes a partial fixture such as `{ "real": false }` valid for an object schema that also requires `reason`: the default fabricated `reason` remains in the result. It also allows `{ "real": false }` when an unrelated untouched base field has `minItems: 5` and the fabricator produced three items, but reports that limitation as a warning. Conversely, an override that introduces a forbidden property, replaces that array with too few items, replaces an object with the wrong primitive, violates an enum/range, or supplies `"false"` for a boolean fails the dry run. The mock runner throws non-recoverable `SCHEMA_NONCOMPLIANCE`; `WorkflowManager.runSync()` converts it into the existing dry-run failure report (`ok: false`, `exitCode: 2`). The reason identifies the label, winning glob, optional one-based sequence position, and at most the first three schema paths/messages. It never includes the supplied answer, schema, prompt, or values from TypeBox error records, and the completed reason is capped at 1,024 characters.

For a schema-less call, a winning scripted answer replaces the existing `[dry-run] ...` string and must be a string containing at least one non-whitespace character. A non-string or blank fixture fails immediately with the same non-recoverable `SCHEMA_NONCOMPLIANCE` path. With no matching rule, both schema-bearing and schema-less calls retain today's fabricated behavior and do not gain an additional schema check, preserving existing validation results for users who do not opt in.

`packages/workflows` will use `Check`/`Errors` from `typebox/value`; `typebox@1.3.2` therefore moves from `devDependencies` to runtime `dependencies` in `packages/workflows/package.json`. No `acp-agents` export or behavior changes.

### 3.4 Deterministic sequence consumption

When `mockAnswers` is supplied, the validator constructs its `WorkflowManager` with `concurrency: 1`. The DSL still invokes `parallel()` and `pipeline()` normally and preserves their input-ordered result arrays, but the zero-cost mock service processes agent calls one at a time through the engine's existing FIFO limiter. Because `runWorkflow()` allocates `callIndex` synchronously before that limiter, a fixed script, args object, workflow directory view, and mock-answer object consume sequence entries in lexical call/FIFO order independent of completion timing.

This serialization applies only to validator runs with `mockAnswers`; validation without the option retains today's manager concurrency and output. It avoids adding a validator-only call index to `RunOptions`, the frozen cross-package `AgentRunner` seam, or engine events. Report binding uses a FIFO pending-call record in the serialized path: the manager's synchronous `agentStart` event creates and enqueues the `ValidatedAgentCall`, and the immediately serviced mock invocation shifts and fills that exact record with tier/mode/schema/backend and mock-answer attribution. Repeated labels therefore do not collide in the current `mockMeta` map.

Sequence reservation occurs once at the start of that mock invocation. The engine can invoke `AgentRunner.run()` again for the same `callIndex` when a recoverable `AGENT_EMPTY_OUTPUT` is returned and the script set `agent({ retries })`; the validator cannot override that per-agent option. Scripted schema-less answers therefore reject whitespace-only strings before returning them, and every other fixture failure is raised as non-recoverable `SCHEMA_NONCOMPLIANCE`. Unmatched schema-less calls return the existing nonblank text, while schema-bearing calls are not subject to `isEmptyTextAgentResult()`. Consequently this mock runner has no recoverable result/error path, so an authored retry count cannot cause a second invocation or double-consume a sequence entry. This invariant must have an explicit retry regression test.

The opt-in serialization can also make the engine's soft token-budget gate observe one mock call's 1,000 reported tokens before admitting the next call, where today's concurrent wave may be admitted before any of those calls settle. That scheduling change is the cost of deterministic sequence allocation and is confined to dry runs that supplied `mockAnswers`; the report and docs must describe it so authors do not treat the validator as a concurrency/load simulator.

### 3.5 Report contract

Add and export these report types:

```ts
export interface ValidatedMockAnswerUse {
  glob: string;
  /** Zero-based in the machine report; absent for a reusable single answer. */
  sequenceIndex?: number;
  sequenceLength?: number;
}

export interface ValidatedMockAnswerRule {
  glob: string;
  kind: "single" | "sequence";
  /** Reached calls whose labels matched this glob, including calls won by a later glob. */
  matchingCalls: number;
  /** Calls for which this rule won and reserved an answer, including fixture-validation failures. */
  consumedCalls: number;
  sequenceLength?: number;
}

export interface UnusedMockAnswer {
  glob: string;
  /** Zero-based sequence item; absent for a reusable single answer. */
  sequenceIndex?: number;
  reason: "no-match" | "shadowed" | "not-reached";
}

export interface ValidatedMockAnswers {
  /** Captured normalized rule order, which also documents last-match precedence. */
  rules: ValidatedMockAnswerRule[];
  unused: UnusedMockAnswer[];
}
```

Extend the existing shapes additively:

```ts
export interface ValidatedAgentCall {
  // existing fields unchanged
  mockAnswer?: ValidatedMockAnswerUse;
}

export interface ValidateWorkflowReport {
  // existing fields unchanged
  dryRun?: {
    // existing fields unchanged
    mockAnswers?: ValidatedMockAnswers;
  };
}
```

`dryRun.mockAnswers` is present whenever `options.mockAnswers` was supplied and a dry run began, including an empty object and a failed dry run; it is absent otherwise. Parse failures and `dryRun: false` retain today's absence of `dryRun`; mock-answer input is still structurally validated before parsing, but it produces no unused-answer warning when execution was intentionally skipped or could not begin. A call gets `mockAnswer` immediately after it reserves a single answer or sequence entry, before merge/schema validation, so a bad fixture remains attributable and its entry is not later reported as unused. A call that fails because a sequence is exhausted reserves nothing and therefore has no false consumption attribution, although the failure reason names the selected rule.

For unused reporting, a reusable single answer is unused only if it was never consumed. An unconsumed sequence contributes one `UnusedMockAnswer` per remaining item. `no-match` means no reached label matched the glob; `shadowed` means labels matched but a later rule won every time; `not-reached` means the sequence was partially consumed and later entries were not needed. Rules, unused entries, and their grouped warnings are emitted in captured normalized rule order, with sequence indexes ascending. Unused answers never change `report.ok` or `exitCode`. One grouped, value-free string per affected rule is appended to `report.warnings`, so the existing human formatter makes the condition visible without flooding output; the structured `unused` array retains item-level detail.

`formatValidateReport()` appends `mock=<json-quoted-glob>` to every consuming call, with `[<one-based-index>/<length>]` for a sequence. It does not print fixture values. The rules and unused records likewise contain globs, counts, positions, and reasons only.

### 3.6 Input limits and data handling

Mock answers are test fixtures, not a secret-storage mechanism. Enforce all of the following before execution:

- Maximum raw UTF-8 size for either CLI JSON source: 256 KiB; check a file's size before reading it.
- Maximum canonical `JSON.stringify()` UTF-8 size for the programmatic object: 256 KiB.
- Maximum 256 rules, raw glob length 1–256 UTF-16 code units, maximum 256 entries per sequence, and maximum answer nesting depth 32. Canonical array-index rule keys are rejected under section 3.1 before any dry run; an escaped spelling counts against the raw glob length.
- Values must be JSON data: finite numbers, strings, booleans, null, arrays, and ordinary/null-prototype records whose own properties are enumerable, string-keyed data properties. Reject `undefined`, holes, functions, symbols, bigint, class instances, non-enumerable properties, accessors, and cycles rather than letting `Object.keys()` or serialization silently change them.

Attribution, warnings, and fixture-validation errors never echo answer values. A valid fixture still enters the workflow like any real agent result, so author code can deliberately expose it through `log()` or the script's returned value; those continue to appear in `dryRun.logs` and `dryRun.result`, including under `--json`. Documentation must state that consequence and advise against putting credentials or production data in mock-answer files.

## 4. Alternatives considered

### Boolean distribution or probability knob

Rejected. A global true/false percentage cannot identify which semantic boolean controls convergence, can create mutually inconsistent objects, and cannot guarantee a reject-then-approve path. An unseeded distribution would make validation nondeterministic; a seed would make it repeatable but still opaque and label-insensitive. Explicit answers and sequences state the intended branch in reviewable JSON while retaining fabricated defaults for every field the author does not care about.

### Exact labels only

Rejected because quality loops commonly generate labels such as `refute:<round>` or `validate:<attempt>`. Globs cover those dynamic suffixes without making authors enumerate a loop cap.

### Most-specific or first-match precedence

Rejected. “Most specific” requires a surprising scoring algorithm, especially once escapes and multiple wildcards exist. First-match makes a broad rule at the top prevent later exceptions. Last match in the once-captured normalized rule order is simple and supports default-then-override layering; rejecting raw canonical array-index keys makes that order consistent with distinct-key JSON member order and programmatic property-creation order.

### Ordered-array, `Map`, or custom JSON-parser input

Rejected as the primary answer shape. An ordered entry array or `Map` would preserve source insertion for canonical array-index globs, and a token-level JSON parser could separately capture raw member order, but each would create a second public shape or make inline/file behavior differ from the requested programmatic `Record`. The selected contract keeps the issue's concise `{ "label-glob": answer }` wire shape, rejects only raw keys whose ECMAScript reordering would violate precedence, and retains exact numeric-label matching through the escape spelling defined in section 3.1.

### Arrays as implicit sequences

Rejected because structured agent schemas may legitimately return a top-level array. The explicit `$sequence` wrapper leaves raw arrays available as single answer values.

### Repeat the final sequence item or fall back when exhausted

Rejected because either behavior can hide an unexpected extra loop round. Exhaustion is an authoring signal and must fail with the rule and consumption count; authors who want indefinite reuse use a single answer instead.

### Warn and coerce schema-invalid answers

Rejected. These inputs are authored test fixtures, not noisy model text. Coercing `"false"` to `false` or dropping/reshaping data would make the report claim it exercised data the author did not actually supply. Override-introduced violations therefore fail without coercion. The narrowly defined warning for an identical, untouched failure already present in the fabricated base is not coercion and does not excuse any violation caused by the supplied answer.

### Make `fabricateFromSchema()` a complete conforming generator

Rejected for this item. Correctly generating arbitrary TypeBox/JSON Schema instances requires handling regex synthesis, registered formats, numeric divisibility and exclusive bounds, tuple/contains/unique array constraints, object dependencies, intersections, recursion, and unsatisfiable schemas. That is a separate schema-generation subsystem with a much larger compatibility surface. The baseline-delta rule preserves today's dry-run acceptance for untouched fabricated fields while still making every answer-touched violation fatal.

### Validate only answer-touched sub-schemas

Rejected because many constraints do not belong to a single leaf: `additionalProperties`, `required`, `dependentRequired`, `minProperties`, `contains`, `uniqueItems`, and conditional/composed schemas can be invalidated by a child edit but report at an ancestor. Whole-value `Check` plus path-overlap comparison catches those interactions, while the base comparison isolates limitations that the answer did not cause.

### Reject every merged value that fails whole-value `Check`

Rejected because it would add false `INVALID` reports for opted-in calls whose untouched fabricated base violates constraints such as `minItems`, `pattern`, or `multipleOf`. That regresses the validator for the exact users enabling this feature. The selected baseline-delta rule is strict about answer-caused failures without pretending the current simple fabricator is complete.

### Carry engine call indexes through `AgentRunner`

Rejected because the index is currently an engine-private resume detail and `packages/shared-types/src/agent-runner.ts` deliberately freezes the seam. Serializing the in-process mock only when scripted answers are enabled gives deterministic consumption without changing `shared-types`, `workflow-engine`, live backends, journals, or the DSL.

### Add a glob library

Rejected for this label-only grammar. Filesystem glob semantics (`**`, dotfiles, path separators, extglobs) are irrelevant and would add a runtime dependency plus a larger compatibility contract. The specified `*`/`?`/escape matcher is small enough to test exhaustively in `packages/workflows`.

## 5. Compatibility & semver

- `@automatalabs/workflows`: **minor**. `ValidateWorkflowOptions.mockAnswers`, two CLI flags, eight exported mock-answer input/report types, `ValidatedAgentCall.mockAnswer`, and `dryRun.mockAnswers` are additive. Existing calls without `mockAnswers` preserve fabrication, concurrency, report-field presence, and exit behavior. The programmatic function gains a new `TypeError` rejection path only when a caller supplies the new option with an invalid runtime value; SDK embedders using untyped input should catch that option-contract error, while invalid workflow scripts continue to resolve to reports. Move the already-used workspace version of `typebox` into runtime dependencies. Add one Changesets minor entry.
- `@automatalabs/mcp-server`: **patch**. This item adds no mock-answer field to the `workflow` tool
  and keeps the single-tool surface; only the generated public `author-workflow` prompt gains
  validator instructions, and its workspace dependency will point at the new workflows minor. The
  coordinated run/inspect/await changes remain owned by specs 01 and 02. Add a Changesets patch entry
  (or the equivalent patch dependency release produced by the repo's
  `updateInternalDependencies: "patch"` policy) and describe the refreshed authoring prompt.

`@automatalabs/shared-types`, `@automatalabs/workflow-engine`, and `@automatalabs/acp-agents` receive no source, API, or release change for this design.

## 6. Test plan

### `packages/workflows`

Extend `packages/workflows/test/validate.test.ts` using its existing `node:test`/strict-assert style:

1. A direct `{ "real": false }` rule deep-merges over a schema that also requires a string, drives the false branch, and is reusable for several matching calls.
2. A two-item `$sequence` drives a `gate()` through reject then approve; the result reports two attempts and call records contain zero-based indexes `0` and `1` with the correct length.
3. A repeated-label `parallel()` script consumes a sequence in thunk-array/FIFO order. Run the same validation several times and assert byte-equivalent results and attribution.
4. Nested workflow calls share the same sequence state and appear in the same rule counters.
5. `*` followed by `refute:*` proves last-match wins in captured normalized order; reversing property order reverses the winner. The losing rule records matches without consumption and is reported as shadowed when it never wins. Inline JSON, file JSON, and programmatic `{ "*": ..., "10": ... }` reject the canonical array-index glob before execution; `{ "*": ..., "\\10": ... }` accepts the escaped glob, matches the exact label `10`, and lets that later rule win. `"01"` and `"4294967295"` prove the stated non-index boundaries.
6. A raw array is one array answer; `$sequence` is a sequence; an answer containing `$sequence` as data is representable as a sequence element.
7. Objects merge recursively, while arrays, nulls, falsy primitives, and scalars replace. Each sequence entry receives a fresh fabricated base rather than the prior entry's merged value.
8. Sequence exhaustion returns exit `2` with `SCRIPT_VALIDATION_ERROR`, names the glob/count without echoing values, and does not attach `mockAnswer` to the exhausting call.
9. Wrong types, additional properties under `additionalProperties: false`, and `"false"` for a boolean return exit `2` with `SCHEMA_NONCOMPLIANCE`; there is no coercion. Cap diagnostics and assert a sentinel secret from the answer is absent from reason/warnings/attribution.
10. A schema with untouched `minItems: 5`, digit `pattern`, and `multipleOf: 2` fields proves the fabricated base fails `Check`; a partial answer changing an unrelated boolean is accepted with grouped inherited-fabrication warnings. Assert against TypeBox's real `instancePath`, including its empty root `""`, while the normalized comparison record uses `.path`; replacing any constrained field with an invalid value is fatal even when its error fingerprint also existed for the base. A valid replacement can repair the base limitation and produces no warning for the repaired path.
11. A schema-less nonblank string override replaces the default dry-run text; an object, `""`, and whitespace-only text fail non-recoverably. With authored `retries: 2`, a blank first sequence item still consumes only index `0`, fails once with `SCHEMA_NONCOMPLIANCE`, and never invokes the runner for or attributes index `1`.
12. Unmatched single rules, wholly shadowed rules, and partially unused sequences produce the specified structured reasons and grouped non-fatal warnings. A fully used configuration has no unused warning.
13. Invalid top-level values, malformed/empty `$sequence`, invalid globs/escapes, raw canonical array-index keys, non-JSON programmatic values, cycles, depth/count/size excesses, and non-finite numbers throw `TypeError` before parse.
14. With no `mockAnswers`, retain the existing all-true fabricated result and omit both new optional report fields. With `{}`, include an empty `dryRun.mockAnswers` object but otherwise use defaults.
15. `formatValidateReport()` prints the winning glob and one-based sequence position, groups unused and inherited-fabrication warnings, and never prints answer bodies.

Add `packages/workflows/test/cli.test.ts`, also with `node:test`, strict assertions, temporary files, and a spawned CLI process:

1. `--mock-answers` makes a bounded refutation-loop fixture complete and exposes attribution under `--json`.
2. `--mock-answers-file` reads a two-round sequence and the human report shows `[1/2]` and `[2/2]`.
3. Both flags together, either flag repeated, malformed JSON, a non-object top level, an invalid/trailing-escape glob, a raw canonical array-index glob, a malformed rule, a missing file, and an oversized source exit `3` with the established `fail()` usage footer rather than the top-level “validate crashed” text.
4. Existing exit codes `0`, `1`, and `2` remain unchanged for valid, parse-invalid, and dry-run-invalid scripts.

The package typecheck fixture in `packages/workflows/test/sdk.test.ts` must import and instantiate `MockAnswers`, `MockAnswerSequence`, `ValidatedMockAnswerUse`, and `ValidatedMockAnswers`, proving the root barrel publishes the declared shapes.

### `packages/mcp-server`

Regenerate the prompt and keep the byte-for-byte drift assertion in `packages/mcp-server/test/authoring-prompt.test.ts`. Add sentinels asserting the generated prompt contains `--mock-answers`, `--mock-answers-file`, and `$sequence`; retain the assertion that `listTools()` is exactly `["workflow"]`.

## 7. Docs & skill updates

- Update the validator paragraph in root `README.md` with one direct false-branch example and a link to the detailed workflows documentation.
- Update `docs/api.md` and `packages/workflows/README.md` with both flags, the `ValidateWorkflowOptions.mockAnswers` type, captured-order last-match precedence, the raw canonical array-index-key restriction and escaped numeric-label spelling, `$sequence`, deep merge, strict answer-caused validation, inherited fabricated-base warnings, nonblank schema-less text, exhaustion, unused reporting, size limits, and the warning that values may flow into script logs/results. Extend the public-export list with all new types.
- Update `skills/agentprism-workflow-authoring/SKILL.md` so its pre-flight advice tells authors to script convergence branches rather than accept the all-true default.
- Update the validator table and programmatic signature in `skills/agentprism-workflow-authoring/reference.md`. Include the exact inline and file JSON examples, glob/precedence rules including reserved raw numeric keys and their escape spelling, zero-based machine versus one-based human indexes, strict answer-caused schema failure, inherited fabricated-base warnings, blank-text rejection, and sequence exhaustion.
- Add byte-identical `report-gate.mock-answers.json` fixtures under both `packages/workflows/examples/repo-triage/` and `skills/agentprism-workflow-authoring/examples/`. The fixture scripts the existing `report:review` label to return `{ "ok": false }` and then `{ "ok": true, "feedback": "" }`, demonstrating partial deep merge and both sides of the existing gate. Update both example READMEs with the command that consumes the file.
- Run `node scripts/generate-authoring-prompt.mjs` after the skill/reference changes and commit `packages/mcp-server/src/generated/authoring-prompt-content.ts`. Do not hand-edit the generated module. The MCP server continues to expose exactly one tool, `workflow`; this update changes only the user-invoked `author-workflow` prompt content.
- Add the Changesets entries described above and release notes for the new CLI/SDK surface.

## 8. Implementation breakdown

One PR is sufficient; perform the work in this order:

1. **M — Input normalization and matching.** Add the public JSON/rule types, limits, JSON-data validation, `$sequence` normalization, canonical array-index-key rejection, the escape-aware label-glob compiler, one-time ordered rule capture, last-match precedence, counters, and unit coverage in `packages/workflows/src/validate.ts`.
2. **L — Mock execution and reports.** Add fresh-base deep merge with RFC 6901 touched paths, whole-value TypeBox validation with `Check`/`Errors` imported from `typebox/value`, immediate `instancePath`-to-internal-`.path` normalization, base-versus-merged error classification, grouped inherited-fabrication warnings, nonblank schema-less enforcement, finite sequence allocation/exhaustion, serialized mock execution, retry-safe exact call binding, report types/fields, unused classification, redacted diagnostics, and `formatValidateReport()` rendering. Move `typebox` to runtime dependencies and update the lockfile.
3. **S — CLI and exports.** Re-export all types from `packages/workflows/src/index.ts`; add the mutually exclusive inline/file flags, byte checks, help text, and the local `TypeError`-to-`fail()` mapping in `packages/workflows/src/cli.ts`.
4. **M — Validation coverage.** Extend the programmatic tests, add CLI subprocess tests, and add SDK barrel type assertions for every contract in section 6.
5. **M — Documentation and examples.** Update root/package/API docs, the authoring skill and reference, both copies of the report-gate answer fixture and their READMEs, then regenerate the MCP authoring prompt and add prompt sentinels.
6. **S — Release metadata and verification.** Add the workflows minor and MCP-server patch Changesets; run package typechecks/tests plus the MCP authoring-prompt drift test, and confirm the mock-answer work itself adds no MCP tool-input field or DSL declaration beyond the coordinated changes specified by specs 01 through 03.
