# String Matcher Audit — 2026-07-15

## Executive summary

This audit confirms four brittle string-matching findings and leaves four additional findings disputed for human judgment. Three confirmed high-severity findings form one provider-limit classification chain: `classifyProviderLimit` matches uncontrolled provider prose, while `mapThrownError` and `wrapError` use that result to decide whether an error is a non-recoverable `PROVIDER_USAGE_LIMIT` or a recoverable `AGENT_EXECUTION_ERROR`. The live Fable message recorded in issue #149—“You're out of usage credits. Run /usage-credits...” —does not match the classifier, so a hard quota wall can be retried and can ultimately resolve to `null`; broad terms such as `billing` can also classify unrelated failures as provider limits. The fourth confirmed finding is a medium-severity raw-source determinism regex in `parseWorkflowScript` that rejects harmless occurrences of `Date.now`, `Math.random`, or `new Date()` in strings and comments before the source is parsed. The disputed set covers the declaration of that same determinism blocklist, cross-package parsing of workflow validation prose, abort classification by message text, and a run-ID collision retry keyed by a prose prefix. Remediation should begin with one structured provider-error classification change spanning the shared classifier and both callers, followed by AST-aware determinism validation; the remaining changes should proceed only after the split votes receive human adjudication.

### Result breakdown

| Category | Confirmed | Disputed | Primary remediation theme |
| --- | ---: | ---: | --- |
| Uncontrolled prose | 3 | 2 | Propagate structured provider-limit, nested-resolution, and cancellation discriminants instead of classifying messages. |
| Fragile heuristic | 1 | 1 | Inspect parsed JavaScript nodes instead of scanning raw source text. |
| Stringly contract | 0 | 1 | Represent run-ID conflicts with a shared structured reason or error code. |
| **Total** | **4** | **4** | Address shared machinery once, then update its consumers. |

## Confirmed findings

### Uncontrolled prose

#### `packages/shared-types/src/errors.ts:171` — `classifyProviderLimit`

- Severity: **High**
- Category: **Uncontrolled prose**
- Verdict: **Confirmed (2/2 adversarial votes)**

Matched strings:

```text
"/usage limit|limit reached|insufficient[_\s]?quota|quota exceeded|exceeded your current quota|out of budget|available balance|\bquota\b|rate.?limit|too many requests|\b429\b|GoUsageLimitError|FreeUsageLimitError|\bbilling\b/i"
"/resets?\s+(?:in|at)\s+[^.\n]+/i"
```

Why it is fragile:

Issue #149 supplies a live failure: Fable reports “You're out of usage credits. Run /usage-credits...”, which matches none of these alternatives. `mapThrownError` therefore falls through to recoverable `AGENT_EXECUTION_ERROR`, and the engine retries before resolving `null`. Broad alternatives such as `billing` can also pause unrelated billing or configuration errors.

Verifier reasons:

1. **Real.** This is the canonical anti-pattern, not a false positive. `classifyProviderLimit` tests free-form provider error prose against a fixed list of English alternatives; the matched string is uncontrolled third-party CLI/provider text (the docstring says “from free-form error text,” and the caller scrapes `error.message`/`.data.message`), not an owned constant, wire enum, schema, redaction list, or documented grammar. Issue #149 is a live, owner-filed misfire: Fable's “You're out of usage credits. Run /usage-credits…” matches none of the alternatives, so `mapThrownError` (`packages/acp-agents/src/errors-map.ts:96,105`) falls through to recoverable `AGENT_EXECUTION_ERROR` and retries into the same wall instead of pausing as `PROVIDER_USAGE_LIMIT`. A structured alternative is buildable and already practiced in the same file: `isAcpAuthRequired` prefers JSON-RPC code `−32000` and only falls back to prose, whereas the usage-limit path has no structured-code gate.

2. **Real.** The verifier attempted to refute the finding, but the failure reproduced exactly. Running the regex at `errors.ts:171` against “You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.” returned `matched:false`; none of the alternatives cover “out of usage credits.” The consequence traces through `packages/acp-agents/src/errors-map.ts:96-109`: the call falls through to recoverable `AGENT_EXECUTION_ERROR`, so the engine retries a guaranteed failure and resolves the call to `null` instead of pausing as `PROVIDER_USAGE_LIMIT`. Issue #149 records this live incident in run `mrlbusuw-9dvzcg`, making the finding reachable and high severity rather than contrived.

Suggested structured fix:

Have provider adapters map structured quota codes or typed error data to `WorkflowErrorCode.PROVIDER_USAGE_LIMIT` with a structured reset timestamp, retaining prose only for display.

#### `packages/acp-agents/src/errors-map.ts:96` — `mapThrownError`

- Severity: **High**
- Category: **Uncontrolled prose**
- Verdict: **Confirmed (2/2 adversarial votes)**

Matched string:

```text
"usage limit|limit reached|insufficient[_\s]?quota|quota exceeded|exceeded your current quota|out of budget|available balance|\bquota\b|rate.?limit|too many requests|\b429\b|GoUsageLimitError|FreeUsageLimitError|\bbilling\b"
```

Why it is fragile:

The imported prose classifier does not match issue #149's live “You're out of usage credits. Run /usage-credits…” error. This path therefore returns a recoverable `AGENT_EXECUTION_ERROR` and retries a hard quota wall. Broad alternatives also falsely classify errors such as “billing endpoint unavailable” as provider limits.

Verifier reasons:

1. **Real.** `mapThrownError` runs the thrown error's free-form provider message through `classifyProviderLimit`, a regex over uncontrolled English provider prose—the canonical Class A anti-pattern. The verifier checked issue #149 against `packages/shared-types/src/errors.ts:171` and used `git log -S` to verify that the live “You're out of usage credits / /usage-credits” string was never added. The hard quota wall consequently falls through to the recoverable `AGENT_EXECUTION_ERROR` branch at lines 105–109 and is retried, exactly as #149 reports. The broad `\bbilling\b` alternative also over-matches a transient fault such as “billing endpoint unavailable” into a non-recoverable pause. A structured signal is available or buildable: the `errorText` comment says `codex-acp` already emits a typed `usageLimitExceeded` error.

2. **Real.** The verifier reproduced the behavior: the live issue #149 text does not match the regex, so `mapThrownError` falls through to the recoverable `AGENT_EXECUTION_ERROR` branch at line 105 and retries a hard quota wall instead of raising the non-recoverable `PROVIDER_USAGE_LIMIT` pause. This is the reviewer-named canonical incident, still open as issue #149, with a documented downstream retry → `null` → gate “reviewer unavailable” path. The broad `\bbilling\b` alternative additionally misclassifies transient text such as “billing endpoint unavailable.” Severity is high because the `PROVIDER_USAGE_LIMIT` taxonomy exists to pause and resume instead of burning retries against the same wall.

Suggested structured fix:

Have ACP backends surface a structured provider-limit code or discriminant with reset metadata and map that field directly to `PROVIDER_USAGE_LIMIT`.

#### `packages/workflow-engine/src/errors.ts:65` — `wrapError`

- Severity: **High**
- Category: **Uncontrolled prose**
- Verdict: **Confirmed (2/2 adversarial votes)**

Matched string:

```text
"/usage limit|limit reached|insufficient[_\s]?quota|quota exceeded|exceeded your current quota|out of budget|available balance|\bquota\b|rate.?limit|too many requests|\b429\b|GoUsageLimitError|FreeUsageLimitError|\bbilling\b/i"
```

Why it is fragile:

`wrapError` passes an arbitrary raw `Error.message` into the shared English regex. The live Fable error “Internal error: You're out of usage credits. Run /usage-credits...” matches none of its alternatives, so `limit.matched` is false and `wrapError` returns a recoverable `AGENT_EXECUTION_ERROR`. The engine then retries the quota wall and can resolve the exhausted call to `null` instead of pausing it.

Verifier reasons:

1. **Real.** This is the canonical Class A anti-pattern and maps directly to live incident #149. `wrapError` branches recoverability on `classifyProviderLimit(message)`, where `message` is a raw provider `Error.message`. The shared regex at `packages/shared-types/src/errors.ts:171` has no alternative matching “You're out of usage credits. Run /usage-credits...”, so it returns `matched:false` and the quota wall becomes a retryable `AGENT_EXECUTION_ERROR` that the engine retries and resolves to `null`. The matched text is provider-generated prose, not an owned constant, enum, or wire code, and no formatting or redaction exclusion applies. Issue #149's suggested fix confirms that a structured provider error code is the intended alternative.

2. **Real.** None of the regex alternatives match “Internal error: You're out of usage credits. Run /usage-credits...” because “usage credits” is not “usage limit,” and the message has no quota, 429, billing, or rate-limit token. `limit.matched` is therefore false and `wrapError` returns recoverable `AGENT_EXECUTION_ERROR`. Issue #149, still open, records this exact live misclassification in run `mrlbusuw-9dvzcg`, where the quota wall was retried and resolved to `null`, derailing a gate validator. The finding is a real, reproducible, high-severity consequence of branching on uncontrolled provider prose.

Suggested structured fix:

Propagate a structured provider error code or quota-exhaustion discriminant through the runner and branch on `WorkflowErrorCode.PROVIDER_USAGE_LIMIT`, retaining prose matching only at unavoidable provider-adapter boundaries.

### Fragile heuristic

#### `packages/workflow-engine/src/workflow.ts:1657` — `parseWorkflowScript`

- Severity: **Medium**
- Category: **Fragile heuristic**
- Verdict: **Confirmed (2/2 adversarial votes)**

Matched string:

```text
"/\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/"
```

Why it is fragile:

The regex scans raw JavaScript before parsing. Deterministic scripts containing text such as `"Do not call Date.now()"` in a prompt or comment are rejected with `SCRIPT_VALIDATION_ERROR` even though no forbidden API is executed. The file already applies a runtime determinism prelude.

Verifier reasons:

1. **Real.** The matched input is the raw workflow-script source—arbitrary free-form JavaScript rather than a stable owned contract—and `DETERMINISM_BLOCKLIST` is a lexically unaware regex. `.test(script)` therefore matches `Date.now`, `Math.random`, and `new Date()` inside string literals or comments and hard-throws `SCRIPT_VALIDATION_ERROR`. A structured signal is available because the AST is parsed on the next line, 1665, and the authoritative `DETERMINISM_PRELUDE` at lines 384–401 already neuters these built-ins at execution. The pre-parse regex is strictly weaker as well as over-broad: it misses an alias such as `const d = Date; d.now()` but rejects valid text. The false positive is realistic because the workflow-authoring docs and prompts routinely embed “Date.now()/Math.random()/new Date()”, including meta-workflows that author scripts or prompts telling an agent not to call them.

2. **Real.** The behavior is reproducible and consequential: `DETERMINISM_BLOCKLIST.test(script)` at line 1657 examines the full raw script before the AST parse at line 1665, so the token regexes match inside string literals and comments rather than only executable code. A deterministic script whose `agent()` prompt or comment mentions these APIs—for example, a refactor, code-generation, or meta-authoring workflow—is hard-rejected with a non-recoverable `SCRIPT_VALIDATION_ERROR`. The structured signal is trivially available through the AST, and the runtime prelude only throws on actual calls. Tests assert only the true-positive real-code case, so the unintended false rejection remains uncovered. Medium severity and the fragile-heuristic classification are supported.

Suggested structured fix:

Inspect actual call and new-expression nodes in the parsed AST, or remove the textual hint and rely on the runtime guard.

## Disputed findings — human judgment required

Each finding in this section received one `real: true` vote and one `real: false` vote. Neither is counted as confirmed. Both verifier positions are preserved so a human reviewer can decide whether the audit's scope includes conservative, low-consequence, or same-owner string coupling in addition to demonstrated behavioral failures.

### `packages/workflow-engine/src/workflow.ts:369` — `DETERMINISM_BLOCKLIST`

- Severity: **Medium**
- Category: **Fragile heuristic**
- Verdict: **Disputed (1/2 adversarial votes)**

Matched strings:

```text
"\bDate\s*\.\s*now\b"
"\bMath\s*\.\s*random\b"
"\bnew\s+Date\s*\(\s*\)"
```

Why it may be fragile:

The regex scans raw source before Acorn parses it, so a valid workflow whose description, prompt, or comment mentions `Date.now()`—for example, an audit asking an agent to replace it—is rejected with `SCRIPT_VALIDATION_ERROR` even though it makes no nondeterministic call. The runtime prelude already enforces actual use.

Verifier reasons:

1. **Not real.** The tokens `Date.now`, `Math.random`, and `new Date()` are JavaScript standard-library API names—a maximally stable, owned contract from the ECMAScript specification—not uncontrolled provider or agent prose, a cross-package descriptor parsed by another module, or an ID/name/code for which a protocol enum exists. The scanned input is the workflow author's own source. The regex is an explicit belt-and-suspenders author-time hint, while `DETERMINISM_PRELUDE` is the real enforcement and neuters the built-ins at runtime. On this view, the matcher is a deliberately conservative static-analysis guardrail analogous to an ESLint `no-restricted-syntax` rule or an excluded conservative pattern list, and the regex-versus-AST issue is a code-quality precision suggestion rather than the audited anti-pattern.

2. **Real.** The behavior was reproduced: `DETERMINISM_BLOCKLIST.test(script)` at `workflow.ts:1657` runs over the entire raw script before Acorn parses it at line 1665, so it matches the tokens inside prompts, `meta.description`, and comments. Runnable checks showed that “Find and replace Date.now() calls,” “Replace Math.random() with seeded RNG,” and “migrate new Date() usages” were all rejected with non-recoverable `SCRIPT_VALIDATION_ERROR`, while a clean control passed. The verifier classifies this as Class C because the AST is built immediately afterward, and the code's own comment says `DETERMINISM_PRELUDE` is “the real enforcement.” The failure is realistic in audit or migration workflows, and tests cover only true-positive rejections, not the over-rejection.

Suggested structured fix if upheld:

Parse first and walk the Acorn AST for actual `Date.now`/`Math.random` calls and zero-argument `Date` construction, retaining the runtime prelude as enforcement.

Human judgment point:

Decide whether a deliberately conservative scan of author-controlled source belongs in the brittle-string-matcher audit when it demonstrably rejects non-executable text, or whether it is outside scope as a stable standard-library pattern used only as a static-analysis hint. This candidate describes the same blocklist mechanism as the confirmed `parseWorkflowScript` finding above but evaluates the declaration and scope classification separately.

### `packages/workflows/src/validate.ts:1114` — `validateWorkflowScript`

- Severity: **Low**
- Category: **Uncontrolled prose**
- Verdict: **Disputed (1/2 adversarial votes)**

Matched strings:

```text
"must be the first statement"
"/\bworkflow\s*\(/"
```

Why it may be fragile:

A wording-only change to the workflow-engine parse diagnostic makes a genuine unresolved bare-name workflow call lose its `--workflows-dir` guidance. Conversely, `workflow(` inside a comment or string can make an unrelated failure containing that phrase receive the misleading warning.

Verifier reasons:

1. **Real.** This is a Class B cross-package coupling: `workflow-engine` emits “must be the first statement in the script” as a generic `SCRIPT_VALIDATION_ERROR` at `workflow.ts:1676`, and `packages/workflows/src/validate.ts:1114` substring-parses that surfaced reason plus a `/\bworkflow\s*\(/` source-text regex to infer a specific nested-workflow bare-name failure. The text is neither a shared exported constant nor a documented grammar. When no workflows directory is configured, `workflowFn` degrades a bare name to a script and the first-statement parse fails; the heuristic reverse-engineers that condition. The verifier identifies two low-severity misfires: a top-level “forgot/misplaced meta” error whose source merely contains `workflow(`, including in a comment, can receive a misleading “provide workflow dirs” hint, and rewording the engine diagnostic silently drops the hint for genuine cases. A structured nested-resolution error code or detail is buildable because `SCRIPT_VALIDATION_ERROR` is too coarse.

2. **Not real.** The matcher only appends an advisory warning; it never affects the validation verdict because `ok`, `exitCode`, and `reason` are computed independently at lines 1154–1161 from `runOk` and `optionErrors`. The matched `run.reason` is the engine's own same-monorepo diagnostic from `workflow-engine/src/workflow.ts:1676`, not uncontrolled provider prose. The alleged false positive is described as unreachable: a top-level first-statement failure returns earlier from `parseWorkflowScript` at line 936, so the dry-run reason can carry the phrase only through genuine nested workflow resolution. A comment- or string-only `workflow(` cannot produce that reason. The wording-drift path is test-guarded by `workflow-dir.test.ts:90`, which asserts the warning, and even a drift leaves the real reason and exit code unchanged.

Suggested structured fix if upheld:

Have the engine expose a structured nested-workflow-resolution error code or detail and branch on it instead of diagnostic prose and a source regex.

Human judgment point:

Determine whether a same-monorepo, test-guarded heuristic that only changes advisory guidance qualifies despite the contested reachability of its false-positive path and its lack of effect on the validation verdict.

### `packages/workflow-engine/src/errors.ts:29` — `isAbortError`

- Severity: **Medium**
- Category: **Uncontrolled prose**
- Verdict: **Disputed (1/2 adversarial votes)**

Matched string:

```text
"/\babort(?:ed)?\b/i"
```

Why it may be fragile:

`wrapError()` maps any `Error` whose free-form message contains “abort” or “aborted” to `WORKFLOW_ABORTED`. A backend error such as “transaction aborted because validation failed” is therefore mislabeled, while an error named `AbortError` with message “The operation was cancelled” is missed. The classifier is used throughout the agent, parallel, and pipeline failure paths.

Verifier reasons:

1. **Real.** `isAbortError()` branches error classification on `/\babort(?:ed)?\b/i` over uncontrolled message prose. Because `wrapError()` returns early for `WorkflowError` at `errors.ts:41`, the regex sees raw non-`WorkflowError` throwables from Node, undici, or backends. True cancellations already use the structured `AbortController` signal: `signal.aborted` is checked before `wrapError` at `workflow.ts:1111/1161/1192`, and explicit `WORKFLOW_ABORTED` errors are thrown at `workflow.ts:549` and `isolation.ts:1664`. The text match thus fires when `signal.aborted` is false. A Node socket “Error: aborted” (`ECONNRESET`) or Postgres “current transaction is aborted” can be tagged `WORKFLOW_ABORTED`, violating the invariant at `workflow-manager.ts:794` that reserves that code for actual cancellation and exposing a misleading `errorCode` to hosts. An analogous structured check is available next door: `isTimeoutError` uses `error.name === 'TimeoutError'`, so abort handling could use `error.name === 'AbortError'` or signal propagation.

2. **Not real.** Cancellation in the engine is already carried by structured signals. The engine throws `WORKFLOW_ABORTED` from `signal.aborted` at `workflow.ts:549`; the runner maps the protocol enum `stopReason === 'cancelled'` to an already wrapped `WorkflowError` at `runner.ts:1268`, which short-circuits at `errors.ts:41`; and agent, parallel, and pipeline failure paths check `signal.aborted` before calling `wrapError` at `workflow.ts:1111/1161/1192`. The manager derives the `aborted` run status from `managed.controller.signal.aborted` at `workflow-manager.ts:814`, not from the error code. On this view, `isAbortError` is a residual fallback that runs only when `signal.aborted` is false, and its recoverable `WORKFLOW_ABORTED` result behaves like the recoverable `AGENT_EXECUTION_ERROR` fallback: both retry then return `null` in `agent()`, both return `null` in parallel or pipeline, and both become `failed` at top level. The alleged false positive or false negative changes only a log label, not control flow or recoverability.

Suggested structured fix if upheld:

Propagate cancellation through `AbortSignal` or a shared structured abort discriminant instead of inspecting error-message prose.

Human judgment point:

Decide whether incorrect public or logged error taxonomy is a sufficient consequence when the verifier evidence indicates that run status, recoverability, retries, and top-level behavior do not change.

### `packages/workflow-engine/src/isolation.ts:1625` — `runIsolation`

- Severity: **Medium**
- Category: **Stringly contract**
- Verdict: **Disputed (1/2 adversarial votes)**

Matched string:

```text
"run id already exists:"
```

Why it may be fragile:

`WorkflowManager` formats run-ID collisions as prose and `runIsolation` parses that prefix to decide whether to generate another attempt. A harmless wording or capitalization change makes a collision propagate as `PERSISTENCE_ERROR` instead of retrying, while another persistence error reusing the prefix would be retried incorrectly.

Verifier reasons:

1. **Real.** `workflow-manager.ts:366/382` formats “run id already exists: ${runId}” under generic `PERSISTENCE_ERROR`, and `isolation.ts:1625` parses that prefix with `startsWith` to decide whether to regenerate `rootRunId` and retry through `createAttempt` at `1511/1629` or propagate. This is a Category B internal stringly contract because producer and consumer use independent literals rather than a shared exported constant. The branch controls an exercised isolation recovery path, so wording or capitalization drift can convert a recoverable collision into a propagated `PERSISTENCE_ERROR`. The codebase already uses `WorkflowError.details` for structured data on `RECORDING_UNUSABLE`, `REPLAY_TARGET_INVALID`, and `REPLAY_DIVERGENCE`, while the `AUTH_REQUIRED` contract explicitly mandates reading structured surfaces and “never the human message.”

2. **Not real.** “run id already exists:” is a stable, owned literal emitted and consumed within the same `workflow-engine` package by the same maintainer in adjacent files, rather than third-party prose, provider text, or agent output. The matcher is reachable only after a run-ID collision, which requires a time-of-check/time-of-use race on a randomly generated `generateRunId()` because `createAttempt` already checks `persistence.load(rootRunId) !== null`. The verifier therefore regards it as a rare defensive backstop. A search of every `PERSISTENCE_ERROR` throw site found that only the two intended collision emitters use the prefix, undermining the proposed false-positive path. Even if producer wording changed, the result would be a recoverable isolation-replay failure rather than a user-facing misclassification like issue #149.

Suggested structured fix if upheld:

Attach a shared run-ID-conflict reason enum to `WorkflowError.details` or introduce a dedicated error code and branch on it.

Human judgment point:

Decide whether a same-package, same-owner prose contract on a rare collision race belongs in scope when wording drift would alter retry behavior but the verifier found no current competing use of the prefix.

## Remediation strategy

The proposed units below are ordered first by confirmed severity, then by shared machinery. Disputed-only work is explicitly gated on human adjudication.

### PR 1 — Structured provider-limit classification (high, confirmed)

Cover these three confirmed findings together:

- `packages/shared-types/src/errors.ts:171` — `classifyProviderLimit`
- `packages/acp-agents/src/errors-map.ts:96` — `mapThrownError`
- `packages/workflow-engine/src/errors.ts:65` — `wrapError`

Define or propagate a structured provider-limit code or discriminant at provider-adapter boundaries, include structured reset metadata, and map it directly to `WorkflowErrorCode.PROVIDER_USAGE_LIMIT`. Carry the typed classification through the runner so `mapThrownError` and `wrapError` do not decide recoverability from provider `Error.message`. Keep provider prose for display and, only where an adapter cannot obtain structured data, as a boundary-local fallback rather than shared workflow-engine control flow. Regression coverage should include the supplied live “You're out of usage credits. Run /usage-credits...” text and the supplied “billing endpoint unavailable” counterexample so the hard quota wall pauses while unrelated billing text does not.

### PR 2 — AST-aware determinism validation (medium, confirmed; one related disputed candidate)

Cover the confirmed `parseWorkflowScript` finding at `packages/workflow-engine/src/workflow.ts:1657` and, if the human reviewer upholds it separately, the disputed `DETERMINISM_BLOCKLIST` finding at line 369. Parse the script first and inspect actual call expressions and zero-argument `new Date()` expressions instead of matching the raw source. Retain `DETERMINISM_PRELUDE` as runtime enforcement, or remove the textual author-time hint if the runtime guard is sufficient. Add cases in which the exact API tokens occur in prompts, descriptions, and comments without being executed, alongside actual-use rejection cases.

### PR 3 — Structured cancellation fallback (medium, disputed; human decision required)

If upheld, replace `packages/workflow-engine/src/errors.ts:29` message matching with `AbortSignal`, a shared abort discriminant, or an `error.name === 'AbortError'` check analogous to the adjacent timeout handling. Preserve the existing structured cancellation paths and decide explicitly whether error-code accuracy alone warrants the change when the split vote found no difference in recoverability, retries, or terminal run status.

### PR 4 — Structured run-ID collision reason (medium, disputed; human decision required)

If upheld, have the collision producers at `workflow-manager.ts:366/382` attach a shared run-ID-conflict reason enum in `WorkflowError.details`, or use a dedicated error code. Update `packages/workflow-engine/src/isolation.ts:1625` to branch on that structured field rather than `startsWith("run id already exists:")`. This isolates retry policy from message wording while preserving human-readable collision text.

### PR 5 — Structured nested-workflow resolution guidance (low, disputed; human decision required)

If upheld, expose a structured nested-workflow-resolution error code or detail from the engine and use it at `packages/workflows/src/validate.ts:1114` to decide whether to append `--workflows-dir` guidance. Remove the conjunction of “must be the first statement” and `/\bworkflow\s*\(/` as the inferred contract. Because the warning is advisory and the split vote contests the false-positive reachability, schedule this after the higher-severity classification work.

## Methodology

A finder model produced candidate brittle string-matcher findings with locations, categories, matched strings, failure explanations, severity, and suggested structured alternatives. Two adversarial verifier model passes independently attempted to confirm or refute each candidate using the cited code paths, live incident details, reproductions, exclusions, reachability, and consequences. A finding is **confirmed** only when both verifier votes are `real: true` (2/2). A finding is **disputed** when the verifiers split 1/2; those candidates are not included in the confirmed count and are presented with both reasons for human adjudication. This report uses only the files, lines, symbols, strings, incidents, and rationale contained in the supplied findings data.
