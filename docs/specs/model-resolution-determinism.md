# Deterministic Model-Spec Resolution

**Date:** 2026-07-14

**References:** [issue #147](https://github.com/VikashLoomba/agentprism-workflows/issues/147); `@automatalabs/acp-agents` 0.24.1

## 1. Problem

Model selection currently combines two independent heuristics: a model/tier string first chooses an
ACP backend, then the selected agent's advertised config-option catalog is searched for a model. The
result is sensitive to catalog contents and ordering, and neither stage currently distinguishes an
exact selection from a guess.

- `packages/acp-agents/src/runner.ts:1284-1289` (`selectBackend`) checks registered custom backend
  names, then `backendIdForSpec`, then `defaultBackendId`. At
  `packages/acp-agents/src/runner.ts:1441-1454`, `backendIdForSpec` uses the unanchored regular
  expressions `/codex|gpt|openai|\bo\d/` and `/claude|opus|sonnet|haiku|anthropic/`. A spec such as
  `fable`, a typo, or a future family name returns no route. `defaultBackendId` at lines 1459-1466
  then silently chooses `AGENTPRISM_DEFAULT_BACKEND`, with Claude as the historical fallback.
- `packages/acp-agents/src/acp-client.ts:2188-2216` (`matchModelValue`) is a nine-test, first-match
  ladder. Its last two tests accept `value.includes(base)` and `name.includes(base)`. Because the
  first matching catalog row wins, a catalog reorder or a newly advertised lookalike can change the
  selected provider or variant without changing the authored spec.
- The 0.24.1 patch documented at `packages/acp-agents/CHANGELOG.md:53-57` is evidence of the failure
  mode. Before that patch, the valid inner OpenCode spec `zai/glm-5.2[max]` missed exact matching and
  could select the earlier catalog row `huggingface/zai-org/GLM-5.2` instead of `zai/glm-5.2`.
  Adding one earlier exact test fixed that incident, but left the open-ended substring ladder.
- `packages/acp-agents/src/acp-client.ts:1955-2004` (`applyModelModifiers`) currently defines
  `effortAbsorbedByModel` as `modelValue.includes("[")`. Issue #147 records the live consequence:
  `claude-fable-5[high]` matched `claude-fable-5[1m]` through the
  `startsWith(`${baseLower}[`)` test, then `[1m]` was treated as if it covered `[high]`. The
  `reasoning_effort` option was not driven and no modifier fallback was emitted.
- `packages/acp-agents/src/runner.ts:1262-1276` (`applyModelSelection`) calls
  `onModelResolved` for any catalog match and `onModelFallback` only for no match or for a modifier
  descriptor returned by `applyModelModifiers`. It therefore cannot report which matching rule won,
  and issue #147 was invisible even after PR #146 began collecting this callback into
  `WorkflowRunResult.fallbacks`.
- The three built-in backend classes do not and should not own catalog policy. `ClaudeBackend`,
  `CodexBackend`, and `OpenCodeBackend` in `packages/acp-agents/src/backends/{claude,codex,opencode}.ts`
  differ in process launch and structured-output transport. `OpenCodeBackend.stripsRoutingPrefix`
  is the only model-routing flag among them. `CustomAcpBackend` in
  `packages/acp-agents/src/backends/custom.ts` sets the same flag and otherwise uses the same
  `SessionHandle.selectModel` path. Resolution must remain above these strategies so first-class and
  custom ACP agents receive identical semantics.

The required contract is therefore not another special-case test. It is a parsed model-spec
language, a finite and ambiguity-aware routing/matching algorithm, a strict per-call policy, and an
observable compatibility policy. For a fixed backend registry, default-backend setting, advertised
catalog, and spec, the outcome must be a pure function and must not depend on catalog order.

## 2. Current state

### 2.1 Engine precedence and resume identity

`packages/workflow-engine/src/workflow.ts:489-510` resolves the value sent to the runner in this
order:

1. `agentOptions.model`;
2. the selected `agentType` definition's model;
3. a configured model for `agentOptions.tier`;
4. `mainModel` when a tier was requested but has no configured model;
5. the current phase route, then `meta.model` through the routing configuration;
6. no model, leaving the runner/backend session default in control.

When a tier has neither a configured value nor a main model, the engine sends `model: undefined` and
the raw `tier` so the runner can resolve or fall back. `prepareSession` uses `model ?? tier` as the
catalog selector, but today's `selectBackend` may still use `tier` to choose a backend when a
present model did not match a custom or built-in route.

`hashAgentCall` at `packages/workflow-engine/src/workflow.ts:1434-1457` hashes the effective model
spec, `mode` when present, tier, phase, agent type, resolved agent definition, prompt, and schema.
It does not hash the concrete catalog value. A successful live call journals the runner-reported
`displayModel` and actual backend in `JournalEntry.call` at lines 716-729. A replay hit returns the
old result without opening an ACP session or consulting a current catalog at lines 532-554.

### 2.2 Backend routing

The current routing pipeline is:

1. `selectBackend` asks `customBackendForSpec` for `model`, then `tier`. A registered name matches
   the whole lower-cased spec or the first slash-delimited component. Custom names therefore win
   over built-in family heuristics.
2. `backendIdForSpec` asks `model`, then `tier`. It recognizes the exact first-component prefixes
   `opencode`, `openai`/`codex`, and `anthropic`/`claude`. Otherwise it runs the two unanchored family
   regular expressions against the portion after the first slash.
3. `defaultBackendId` uses a registered backend named by `AGENTPRISM_DEFAULT_BACKEND`, exact
   `opencode` or `codex`, and otherwise Claude.
4. `innerModelSpec` at `packages/acp-agents/src/runner.ts:1317-1322` strips the routing name only
   when `Backend.stripsRoutingPrefix` is true. That is true for OpenCode and custom backends. Claude
   and Codex receive the original provider-prefixed or bare string.

Consequently `opencode/zai/glm-5.2` opens OpenCode and sends `zai/glm-5.2` to its catalog, while
`anthropic/claude-opus-4-1` opens Claude and sends the whole string. An unmatched string such as
`fable` opens the configured default backend and is still offered to that backend's catalog.

### 2.3 Session catalog matching

After `session/new`, the runner fires `onSessionOpen`, calls `applyModelSelection`, applies strict
session `mode`, and only then sends the prompt
(`packages/acp-agents/src/runner.ts:781-806`, `AcpAgentRunner.run`). `SessionHandle.selectModel` at
`packages/acp-agents/src/acp-client.ts:1929-1944` finds the first select option whose category is
`model` or whose id is `model`, flattens grouped choices in advertised order, and runs
`matchModelValue`.

For a spec `S`, `afterSlash` is everything after its first slash, `fullBase` is `S` with text from
the first `[` removed, and `base` is `afterSlash` with the bracket removed. The nine tests are
executed in this exact order; each returns the first advertised row that passes:

1. `value` equals full `S`, case-insensitively;
2. `value` equals full `S` with its bracket removed — the 0.24.1 fix;
3. `value` equals `afterSlash`, including its bracket;
4. `value` equals bare `base`;
5. `value` starts with `` `${base}[` ``;
6. `name` equals `afterSlash`;
7. `name` equals bare `base`;
8. `value` contains bare `base`;
9. `name` contains bare `base`.

The selected wire value is sent with `session/set_config_option` unless already current. No
ambiguity check is performed, and a successful response is adopted without checking that its echoed
model `currentValue` is the requested value.

### 2.4 Modifier handling

`bracketTokens` at `packages/acp-agents/src/acp-client.ts:2141-2150` reads one trailing bracket and
splits on whitespace, comma, or plus. `applyModelModifiers` treats `fast` specially and treats every
other token as a reasoning-effort candidate. It finds effort config by id `reasoning_effort` or
category `thought_level`, and Fast mode by id/category `fast-mode`. Effort selection accepts the
first advertised value equal to any requested effort token. Fast accepts a boolean option or a
select row whose value or name is `on`.

The entire modifier block is skipped whenever the selected model value contains any `[`. There is
no comparison between requested and selected bracket tokens. This is exactly the issue #147 bug:
`[1m]` suppresses application and fallback for the unrelated request `[high]`.
Separately, `SessionHandle.selectModel` returns at lines 1933-1937 when the model option or target is
missing, before calling `applyModelModifiers`; requested modifiers are therefore not attempted on
the actual session-default model after a whole-model miss.

### 2.5 Fallback reporting and persistence

When no catalog value matches, `selectModel` leaves the agent's session default in place and returns
`matched: false`. `applyModelSelection` calls `onModelFallback(spec)`. When an effort/Fast option is
missing, it calls the same callback with a string descriptor such as
`gpt-example[high]: reasoning_effort "high" not advertised`.

The engine adapter at `packages/workflow-engine/src/workflow.ts:668-693` updates `displayModel` from
`onModelResolved`, captures `backendId` from `onSessionOpen`, and converts `onModelFallback` into a
log line and `WorkflowRunFallback`. It recognizes modifier events by parsing the descriptor string;
all other events are described as using the session default. `WorkflowRunFallback` is already the
only host-facing degradation record (`packages/shared-types/src/workflow-result.ts:102-118`), and
`WorkflowManager` persists it through `PersistedRunState.fallbacks`
(`packages/workflow-engine/src/run-persistence.ts:86-90`). No new result/event channel is needed.

Issue #147 produced neither callback: the catalog match was considered successful and the bracket
was considered absorbed. Before 0.24.1, the cross-provider GLM incident produced neither callback
for the same first-order reason: a substring row was still a successful match.

## 3. Proposed design

### 3.1 Public contract

Add these types to `@automatalabs/shared-types` (`src/agent-run.ts`, exported by `src/index.ts`). Add
type re-exports to the manual shared-type lists in `@automatalabs/workflow-engine` and
`@automatalabs/workflows`; `@automatalabs/acp-agents` consumes the shared definitions in its public
option declarations rather than defining provider-local variants:

```ts
export type ModelResolutionPolicy = "compatible" | "strict";

export type ModelResolutionStep =
  | "backend-default"
  | "exact-value"
  | "exact-base-value"
  | "current-tier-alias"
  | "unique-tier-alias"
  | "session-default";

export interface ModelFallbackDetail {
  kind: "model" | "modifier";
  reason:
    | "backend-default"
    | "invalid-spec"
    | "model-option-unavailable"
    | "not-advertised"
    | "ambiguous"
    | "non-exact"
    | "selection-rejected"
    | "modifier-not-advertised"
    | "modifier-ambiguous"
    | "modifier-rejected";
  /** The authored effective model/tier spec, before a routing prefix is stripped. */
  requestedSpec: string;
  policy: ModelResolutionPolicy;
  /** Backend selected for this attempt, including a compatible default route. */
  backendId?: string;
  /** Final selected/current model, only when known and actually selected. */
  resolvedModel?: string;
  step?: ModelResolutionStep;
  /** Lower-cased requested modifier token for modifier events. */
  modifier?: string;
  /** True when this event is immediately followed by MODEL_RESOLUTION_FAILED. */
  strictFailure: boolean;
  /** Stable runner-authored explanation without the engine's call label prefix. */
  message: string;
}
```

`step` is set to `backend-default` for invalid/unroutable/unmapped route events,
`current-tier-alias` or `unique-tier-alias` for compatibility alias decisions, and
`session-default` when compatible mode actually retains the current model after an
unavailable/ambiguous/rejected catalog selection. A strict no-match has no successful step and
omits it. Modifier-kind details omit `step` and set `modifier`. `strictFailure` is `true` only when
the callback is immediately followed by `MODEL_RESOLUTION_FAILED`.

Change `RunOptions` additively:

```ts
export interface RunOptions<S extends TSchema | undefined = undefined> {
  /** Default "compatible". See the exact semantic rules below. */
  modelResolution?: ModelResolutionPolicy;

  /**
   * `legacySignal` preserves the existing one-string callback contract. For model events it is
   * the effective authored spec; for modifier events it is the established descriptor string.
   * New consumers use `detail`; old runners may omit it and old callbacks may ignore it.
   */
  onModelFallback?: (
    legacySignal: string,
    detail?: ModelFallbackDetail,
  ) => void;
}
```

Add the same `modelResolution?: ModelResolutionPolicy` field to the exported
`packages/workflow-engine/src/workflow.ts` `AgentOptions`. The engine passes it unchanged to
`RunOptions`. This design deliberately provides per-call, author-controlled strictness and does not
add a run-level override: a workflow can mix portable calls with calls that carry a hard model
requirement, and a host cannot silently strengthen or weaken authored per-call behavior. The field
is not added to `WorkflowAgentOptions`, `WorkflowRunOptions`, or `WorkflowManagerOptions`.

Add the field to the public `packages/acp-agents/src/interactive.ts` options as well:

```ts
export interface InteractiveSessionOptions {
  /** Default "compatible"; applied while the held-open session is prepared. */
  modelResolution?: ModelResolutionPolicy;
}
```

`ReattachSessionOptions` already extends `InteractiveSessionOptions`, so open/load/resume/fork
session preparation receives the same semantics without another option or backend hook.

`SessionHandle` is exported today, so its additive result plumbing is also contractual rather than
an inferred private change:

```ts
export interface ModelSelectionOptions {
  /** Default "compatible". */
  modelResolution?: ModelResolutionPolicy;
  /** Full effective authored spec; defaults to `spec` for direct callers. */
  requestedSpec?: string;
}

export interface ModelSelectionResult {
  /** Retained legacy member: true for an intentional no-selector request or an applied match. */
  matched: boolean;
  /** Retained legacy member, broadened to report a known actual session default. */
  resolved?: string;
  /** Retained legacy descriptors for modifier degradations. */
  modifierFallbacks?: string[];
  status: "resolved" | "defaulted";
  exact: boolean;
  step: Exclude<ModelResolutionStep, "backend-default">;
  fallbackDetails: readonly ModelFallbackDetail[];
}

class SessionHandle {
  selectModel(
    spec: string | undefined,
    options?: ModelSelectionOptions,
  ): Promise<ModelSelectionResult>;
}
```

The one-string call remains valid and defaults to compatible policy. In strict policy,
`selectModel` throws `MODEL_RESOLUTION_FAILED` with the triggering detail; `applyModelSelection`
catches it only long enough to emit `onModelFallback`, then rethrows. Compatible calls return the
richer result and `applyModelSelection` emits every returned detail. Export
`ModelSelectionOptions` and `ModelSelectionResult` from `@automatalabs/acp-agents` and the
`@automatalabs/workflows` facade.

Add `WorkflowErrorCode.MODEL_RESOLUTION_FAILED`. A strict failure throws a non-recoverable
`WorkflowError` with that code and the agent label. `WorkflowError.details` is the triggering
`ModelFallbackDetail`; it never contains the full advertised catalog. Non-recoverable means the
engine does not spend retry attempts on an identical catalog and the failing call sends no prompt.
`undefined` normalizes to `"compatible"`; any other runtime value besides `"compatible"` or
`"strict"` is a non-recoverable `SCRIPT_VALIDATION_ERROR` before process acquisition, because no
valid policy exists under which to emit a resolution fallback.

The callback change is source- and runtime-compatible. A one-argument callback remains assignable.
The optional second argument removes the engine's need to parse prose and lets it accurately
represent successful non-exact matches. Whole-model callbacks consistently receive the full
effective authored spec as their first argument; this corrects the current OpenCode/custom leak of
the prefix-stripped internal selector. Modifier callbacks retain the byte-for-byte descriptor forms
`<spec>: reasoning_effort "<token>" not advertised` and `<spec>: Fast mode not advertised` when
emitting any modifier degrade, including ambiguity, name-only matching, or rejection; the structured
`reason` and `message` are authoritative for the more precise cause. This preserves modifier
classification in an older engine that ignores the second argument. For a legacy runner that
supplies no detail, the engine retains its current parsing and message behavior.

No fields are added to `WorkflowRunFallback` or `WorkflowRunResult`. The engine maps structured
detail into the existing `requestedSpec`, `resolvedModel`, `backendId`, `kind`, and `message` fields.

### 3.2 Canonical model-spec grammar

The authored grammar is:

```ebnf
model-spec       = backend-only | [ routing-prefix, "/" ], model-selector, [ modifiers ] ;
backend-only     = routing-prefix ;
routing-prefix   = "claude" | "codex" | "opencode" | "anthropic" | "openai"
                 | custom-backend-name ;
custom-backend-name = ALPHA, { ALPHA | DIGIT | "." | "_" | "-" } ;
model-selector   = selector-segment, { "/", selector-segment } ;
selector-segment = selector-char, { selector-char } ;
selector-char    = ALPHA | DIGIT | "." | "_" | "-" | ":" | "@" | "+" ;
modifiers        = "[", modifier, { modifier-separator, modifier }, "]" ;
modifier         = ( ALPHA | DIGIT ), { ALPHA | DIGIT | "." | "_" | "-" } ;
modifier-separator = "," | "+" | one-or-more-spaces ;
```

The prose constraints are normative:

- No leading/trailing whitespace, empty path component, backslash, control character, second
  bracket block, or text after the closing bracket is valid. Matching is ASCII case-insensitive,
  but the exact advertised wire value is preserved when setting config.
- Provider/backend prefixes and custom backend names are case-insensitive. `claude`, `codex`, and
  `opencode` are the canonical built-in routing prefixes. `anthropic` and `openai` remain accepted
  aliases for Claude and Codex. A registered custom backend name has priority over every built-in
  prefix/alias and bare-family rule, as it does today; this includes a registered custom backend
  named `anthropic` or `openai`, which the current registry permits.
- `claude`, `codex`, `opencode`, an alias, or a custom name alone is a backend-only request. It
  intentionally selects that backend's current model and is valid under `strict`; it does not
  pretend that the backend name is a model id. Backend-only specs cannot carry modifiers.
- Every recognized routing prefix is stripped exactly once before catalog matching. Thus
  `anthropic/claude-opus-4-1`, `openai/gpt-5.5`, `opencode/zai/glm-5.2`, and
  `browser/vendor/vision-large` offer `claude-opus-4-1`, `gpt-5.5`, `zai/glm-5.2`, and
  `vendor/vision-large` respectively. This replaces the current `stripsRoutingPrefix` asymmetry;
  a routing prefix is never part of an ACP model value. A nested provider component such as `zai/`
  remains part of the selector.
- A slash in an unprefixed spec is a provider qualification, not a guessed backend. Therefore
  `zai/glm-5.2` is unroutable. Compatible mode may still offer the full string to the configured
  default backend after reporting `backend-default`; strict mode requires
  `opencode/zai/glm-5.2` (or a custom backend prefix).
- The only canonical bare-family routes are finite and boundary-based; they are evaluated only when
  the parsed selector base has no slash, before modifiers:
  - Claude: exact `opus`, `sonnet`, or `haiku`, or a selector beginning with
    `claude-`, `anthropic-`, `opus-`, `sonnet-`, or `haiku-`;
  - Codex: a selector beginning with `codex-`, `openai-`, or `gpt-`, or
    matching `^o[0-9]+(?:-|$)`;
  - OpenCode: exact backend-only `opencode`; an OpenCode model must otherwise use the prefix.
  Strings merely containing these words, such as `my-gpt-proxy`, are not family routes.
- Bracket tokens are a set after ASCII lower-casing and duplicate removal. `fast` denotes Fast
  mode. At most one distinct non-`fast` token is valid; that token denotes the model-encoded variant
  or, when not covered by the selected model value, the reasoning/thought-level option. This covers
  `[1m]`, `[high]`, `[max]`, and `[high fast]` without the current “first matching effort token
  wins” ambiguity.
- `tier` remains an alternative input field, not a provider prefix. The engine first maps
  `small`, `medium`, or `big` through its tier configuration. Under `strict`, the resulting model
  spec is resolved normally. An unmapped raw tier that does not itself exactly route has no backend
  and fails; under `compatible`, it is offered to the configured default backend and every
  default/non-exact choice is reported. `model` continues to win over `tier`.

Malformed explicit specs, including an explicitly supplied empty string, are not silently
normalized. `compatible` emits an `invalid-spec` model fallback and runs the configured session
default; `strict` emits the same detail with `strictFailure: true` and throws before spawning.

The parser's exact internal selector shape is:

```ts
type ModelTierAlias = "opus" | "sonnet" | "haiku";

interface ParsedCatalogSelector {
  /** Prefix-stripped selector exactly as authored, including its optional modifier block. */
  full: string;
  /** `full` without the one trailing modifier block. */
  base: string;
  /** ASCII-lower-cased, deduplicated tokens in canonical effort-then-fast order. */
  modifiers: readonly string[];
  /** Present only when `base` is exactly one family tier word. */
  tierAlias?: ModelTierAlias;
}
```

### 3.3 Total backend resolution

Replace `backendIdForSpec` with a parser-backed function that returns one of these internal outcomes:

```ts
type BackendResolution =
  | {
      status: "routed";
      backend: Backend;
      route: "implicit-default" | "explicit" | "bare-family";
      selector?: ParsedCatalogSelector;
      requestedSpec?: string;
    }
  | {
      status: "defaulted";
      backend: Backend;
      reason: "unroutable" | "unmapped-tier" | "invalid-spec";
      selector?: ParsedCatalogSelector;
      requestedSpec: string;
    }
  | {
      status: "rejected";
      reason: "unroutable" | "unmapped-tier" | "invalid-spec";
      requestedSpec: string;
    };
```

Resolution order is exact and finite:

1. No model and no tier means the configured backend/session default by author intent. It produces
   no fallback and strict mode has nothing to reject.
2. Choose exactly one effective input: `model` when it is not `undefined`, otherwise `tier` when it
   is not `undefined`. An explicit model wins for routing as well as catalog selection; the resolver
   never consults `tier` after a model was supplied. Parse that input. A grammar failure returns
   `defaulted` in compatible mode and `rejected` in strict mode.
3. Match a registered custom backend by exact first path component or exact backend-only name.
4. Match an exact built-in prefix/alias and remove that component, just as for a custom backend.
5. Match the finite bare-family table above.
6. Otherwise, compatible mode uses `defaultBackendId` and emits one `backend-default` model event;
   strict mode emits the event and throws `MODEL_RESOLUTION_FAILED` before a process is acquired.

For a compatible default route, a syntactically valid input remains the catalog selector. This
preserves useful legacy behavior: with OpenCode configured as the default, bare
`zai/glm-5.2` can still exact-match that catalog, but the backend choice is no longer silent. An
invalid input has no selector and therefore cannot participate in catalog matching or modifier
application.

An unknown `AGENTPRISM_DEFAULT_BACKEND` continues to mean Claude for backward compatibility. That is
host configuration behavior rather than resolution of an authored spec. A nonempty authored spec
that reaches it through step 6 is nevertheless observable as `backend-default`.

`resolveBackend` is pure over the parsed input, policy, normalized registry names, and configured
default backend. Environment access remains in `defaultBackendId`; its resolved value is passed into
the pure function. Thus identical effective spec, policy, registry/default inputs, and advertised
catalog produce the same result. When machine configuration or catalog state differs, the changed
choice is either exact by the authored id or is reported through the fallback channel.

The exported `selectBackend(opts, registry?)` signature remains unchanged. It projects only the
`backend` from this resolver under compatible policy for callers such as validator attribution and
auth/provider/session-list lifecycle methods, which do not serve a model prompt and expose no
fallback callback. `run()` and interactive open/load/resume/fork use the full
`BackendResolution` and enforce `modelResolution`.

### 3.4 Total catalog resolution

Choose config options without array-order dependence. For each role, a unique stable id wins; only
when that id is absent may a unique base-spec category win: model uses id/category `model`, effort
uses id `reasoning_effort` then category `thought_level`, and Fast uses id `fast-mode` then category
`fast-mode`. More than one option at the winning priority is `ambiguous`; compatible mode reports
the model/modifier fallback and strict mode fails. This id-first/category-second rule handles the
catalog shapes advertised by claude-agent-acp, codex-acp, OpenCode, and generic/custom ACP agents
without consulting a backend id. Model and effort roles accept only `type: "select"`; Fast accepts
`type: "boolean"` or `type: "select"`. A winning id with the wrong shape is unavailable rather than
falling through to a lower-priority category.

Flatten grouped `SessionConfigSelectOptions` without using their order as a tie-breaker. Comparisons
use an ASCII-lower-cased key but retain wire values. Duplicate rows with the same exact wire value
are one candidate. Two distinct wire values that normalize to the same key are ambiguous.

`ParsedCatalogSelector` contains the full prefix-stripped selector, its base with the trailing
modifier block removed, the normalized requested modifier set, and whether the whole base is one of
the family tier aliases `opus`, `sonnet`, or `haiku`. Apply the following ladder. At each step,
collect all distinct matching wire values. One is a match; more than one returns `ambiguous`
immediately; zero advances to the next step.

| Order | Step | Predicate | Semantically exact? |
|---:|---|---|:---:|
| 1 | `exact-value` | `value` equals the prefix-stripped selector including modifiers | yes |
| 2 | `exact-base-value` | `value` equals the prefix-stripped base | yes |
| 3 | `current-tier-alias` | only when the selector is one tier alias and routing chose Claude via that bare alias or a built-in Claude prefix: the advertised `currentValue` names a row whose `value` or `name` contains the alias as an ASCII token | no |
| 4 | `unique-tier-alias` | under the same gate: exactly one row's `value` or `name` contains that alias as an ASCII token | no |

Step 1 is first because an advertised value equal to the complete request atomically satisfies the
model and its encoded tokens. Step 2 supports the base-spec ACP shape used by codex-acp and
OpenCode, where the model value is bare and sibling config options carry effort/Fast. Both are exact
author intent; modifier coverage below determines which requested tokens still need a sibling
option. Steps 3-4 are explicitly non-exact compatibility aliases and are therefore observable.

Steps 3-4 are the complete compatibility path for the three established Claude tier words. A tier
token matches `(^|[^a-z0-9])<token>([^a-z0-9]|$)` case-insensitively, so `claude-opus-4-1` and
`Claude Opus 4.1` qualify while `myopusproxy` does not. The current-value step preserves `opus`
sensibly when a catalog advertises several Opus generations but is already running one; otherwise a
single distinct candidate is required. These steps are unavailable to arbitrary ids such as
`gpt-5.5` or `glm-5.2`, and unavailable on Codex, OpenCode, or custom routes. Multiple remaining
candidates are ambiguous; the resolver never sorts versions or chooses the first row.

There is no `includes` test, reverse-substring test, edit distance, version sorting, catalog-order
tie-break, guessed provider-path removal, general display-name match, or same-base bracket-variant
step. In particular, a missing
`zai/glm-5.2` can never match `huggingface/zai-org/GLM-5.2`, and
`claude-fable-5[high]` can never match `claude-fable-5[1m]`; a qualified or variant miss is a miss.

The total catalog outcome is:

```ts
type CatalogResolution =
  | {
      status: "resolved";
      value: string;
      step: Exclude<ModelResolutionStep, "backend-default" | "session-default">;
      exact: boolean;
    }
  | {
      status: "defaulted";
      currentValue?: string;
      reason: "model-option-unavailable" | "not-advertised" | "ambiguous" | "selection-rejected";
    }
  | {
      status: "rejected";
      reason:
        | "model-option-unavailable"
        | "not-advertised"
        | "ambiguous"
        | "non-exact"
        | "selection-rejected";
    };
```

Policy application is normative:

- `compatible` applies a current/unique tier alias and emits a model fallback detail with
  `reason: "non-exact"`, the step, and the actual selected value. If nothing matches, it leaves the
  model option at its advertised `currentValue`, emits a `session-default` detail, applies requested
  modifiers to that actual default, and proceeds.
- `strict` accepts only steps 1-2. Steps 3-4 emit a strict non-exact detail and throw without
  applying the candidate. Missing/ambiguous catalogs also emit and throw. A backend-only spec is
  accepted because it intentionally contains no model selector.
- When setting a model, the resolver requires the echoed config options to contain the model option
  with `currentValue` exactly equal to the chosen wire value. A request error or mismatched echo is
  `selection-rejected`: compatible mode reports it and proceeds only on the echoed/current session
  default; strict mode reports it and throws. No prompt is sent until this decision completes.
- `onModelResolved` fires at most once with the final actual model whenever the model option exposes
  a current value, including an omitted spec, a backend-only request, and compatible fallback to the
  session default. For a compatible call it fires before fallback callbacks so the engine can attach
  `resolvedModel`. A strict candidate that is rejected before prompting is never reported as
  resolved.

This algorithm is shared by `SessionHandle`; no built-in backend class receives a model map or
matching hook. Claude-agent-acp, codex-acp, OpenCode, and custom agents all contribute the same ACP
`SessionConfigOption` shapes to one resolver.

For source compatibility with the exported `Backend` interface and concrete OpenCode/custom
classes, `Backend.stripsRoutingPrefix?: boolean` remains present but is marked deprecated and is no
longer consulted. Prefix extraction is exclusively the central parser's responsibility; removing
the exported property can wait for a future major release.

### 3.5 Modifier coverage and verified application

Parse the selected model's trailing bracket with the same token parser used for the request. Let
`R` be the requested lower-cased token set and `C` the selected value's token set. A token is
absorbed by the model if and only if it is a member of `R ∩ C`. If the actual model is unknown,
`C` is empty. The presence of an unrelated bracket has no effect, and coverage is per-token rather
than all-or-nothing. A non-canonical or non-trailing bracket in an advertised value yields an empty
`C`; it cannot prove coverage.

For every token in `R - C`, in canonical order (the effort token first, then `fast`):

1. For the effort token, find the reasoning option by the existing id/category rules. An exact
   case-insensitive option `value` is an exact application. If no value matches, a unique exact
   option `name` may be used only in compatible mode and emits a successful `non-exact` modifier
   detail. Absence/value-miss emits the existing legacy descriptor
   `<spec>: reasoning_effort "<token>" not advertised`; duplicate role options or multiple matching
   rows emit a `modifier-ambiguous` detail. Strict mode rejects a name-only match before setting it.
2. For `fast`, a boolean option is set to `true`. A select option first requires exact value `on`;
   a unique exact name `on` is compatible-only and observable as non-exact. Absence emits the
   existing `<spec>: Fast mode not advertised` descriptor.
3. After each `session/set_config_option`, inspect the echoed option. Effort is applied only when
   its `currentValue` equals the chosen wire value; Fast is applied only when the boolean is `true`
   or the select current value equals the chosen `on` value. A request failure, missing echoed
   option, or mismatched current value emits `modifier-rejected`. A value already current is
   verified from the advertised state and requires no wire request.
4. In compatible mode, an unavailable/rejected modifier is observable and the call proceeds with
   the selected model. In strict mode, it is observable and then throws
   `MODEL_RESOLUTION_FAILED`. A covered token requires no separate config option and is valid in
   strict mode.

For issue #147, `claude-fable-5[1m]` is not a model match for `claude-fable-5[high]`. Compatible mode
therefore reports a model fallback and retains the advertised current model. When that current model
is `[1m]`, `R = {high}` and `C = {1m}`: `high` is not covered, so the reasoning option is set to
`high` and verified. If it cannot be set, the existing modifier fallback is emitted; it is never
silently treated as satisfied. Strict mode rejects the model miss before prompting.

The same rule handles partial coverage: for request `[high fast]` and actual model `[high]`, `high`
is satisfied by the model while `fast` must still be driven through Fast mode. An actual
`[high fast]` value covers both, and an actual `[1m]` value covers neither.

### 3.6 Observability wiring

All degradation continues through `RunOptions.onModelFallback` and then
`WorkflowRunResult.fallbacks`; no parallel telemetry or host result is introduced.

The runner emits one structured callback for each independently meaningful event: backend
defaulting, non-exact catalog match, model defaulting, successful non-exact modifier-name match,
unavailable/rejected modifier, or strict rejection. Exact route + exact catalog + fully covered or
exactly applied modifiers emits no fallback.

For compatible `run()` calls, callback order is `onSessionOpen`, final `onModelResolved` when known,
then the route/model/modifier fallback details in that order, then the prompt. Interactive setup has
the same order after its session opens but has no `onSessionOpen` callback. A route decision made
before spawn is held until model preparation finishes so its detail can include the actual model.
A strict parse/route rejection cannot open a session; it emits its detail and throws. A strict
catalog/modifier rejection occurs after session open, emits its detail, and throws without
`onModelResolved` because no model was served.

The engine uses `detail.requestedSpec`, `detail.kind`, `detail.resolvedModel`, `detail.backendId`,
and `detail.message` instead of parsing the legacy string. It prefixes the message with the call
label, falls back to the backend captured by `onSessionOpen`, deduplicates identical events with the
existing `sameFallback` rule, and invokes the existing `WorkflowRunOptions.onFallback`. Accurate
messages replace the current always-“using the session default” wording; examples are:

- `review: model "opus" resolved non-exactly to "claude-opus-4-1" via unique-tier-alias`;
- `review: model "fable" is unroutable; using backend "claude" and model "claude-sonnet-4"`;
- `review: modifier "high" was not advertised for model "claude-fable-5[1m]"`;
- `review: strict model resolution rejected "opus": exact catalog value required`.

Strict callbacks are emitted before the error is thrown, so managed failed results and persisted
state retain the reason. Direct `runner.run` callers receive both their callback and the typed
error.

### 3.7 `mode`, tier, and defaults

`mode` and `modelResolution` are independent. `mode` remains unconditionally strict as documented
at `packages/shared-types/src/agent-run.ts:77-84`: an unsupported session mode fails even when model
resolution is compatible. `modelResolution: "strict"` does not imply a read-only/plan mode, and a
strict mode id does not imply exact model selection.

`modelResolution` defaults to `compatible` at both direct-runner and workflow DSL boundaries. This
is necessary for additive adoption: published workflows rely on bare shorthand, absent model
catalogs, and host defaults. Compatible is no longer silent; every choice outside semantic exactness
is captured in `fallbacks`. Authors can migrate high-assurance calls individually to strict after
observing their real catalogs.

On a workflow call, the policy applies to whichever model spec the existing engine precedence
produces: explicit call model, agent-definition model, mapped tier/main-model fallback, or
phase/meta route. The source does not weaken strictness. When the engine has no model and passes only
an unmapped raw tier, that tier is the effective spec for policy purposes.

Strict applies only when an effective model/tier spec exists. Omitting both remains the explicit
portable request for the host's session default. A backend-only spec is also intentional default
model use on a pinned backend. An unresolved raw tier is not intentional omission and therefore
fails under strict.

### 3.8 Journal and resume behavior

The resolved model should be journaled per successful live call. The engine already has the correct
additive location: `JournalEntry.call.model`, with `call.backendId` alongside it. The implementation
must make `onModelResolved` report a known advertised `currentValue` even for a session-default
selection, so this existing field is populated whenever the agent exposes a model option. No new
journal field is required, and old entries with absent `call.model` remain valid.

The journal is an audit record, not a catalog lock:

- A replay hit does not open a session or consult a catalog. For replay-time `onAgentStart` /
  `onAgentEnd` model attribution, the engine must prefer `cached.call.model` when
  `cached.call.kind === "agent"`, falling back to the newly computed display spec for older
  journals. `cached.call.backendId` remains the journal/inspection attribution and the existing
  cached session ref is re-surfaced unchanged. This is a behavior correction: current
  `workflow.ts` stores `call.model` but does not read it on the replay branch.
- A live suffix resolves against the current advertised catalog. Exact semantic requests either
  select the same named value or fail/default according to policy. Every compatible non-exact or
  default outcome identifies the newly selected value in `fallbacks` and the new journal entry.
- Resume does not compare catalog fingerprints, invalidate an otherwise matching journal entry, or
  reopen replayed calls solely to revalidate availability. Catalogs are environment/login/version
  state, and making them replay identity would convert harmless environment changes into token-
  spending cache misses.
- `hashAgentCall` is byte-for-byte unchanged. `modelResolution` is an execution policy and is not
  added to the identity object. Consequently changing only that policy does not invalidate an old
  replay hit; strictness governs calls that run live. To force reevaluation, start a new run or
  change an existing hashed logical input such as the model spec.

This chooses observability over resume invalidation while giving strict live calls a hard guarantee.
It also satisfies the explicit constraint that replay identity hashes must not change.

## 4. Alternatives considered

### Patch only `effortAbsorbedByModel`

Comparing requested and selected bracket tokens would fix issue #147 but would leave regex routing,
catalog-order dependence, arbitrary substrings, ambiguous names, and unobservable fuzzy success.
The incident is treated as a regression case for the general resolver instead.

### Keep the nine tests and add more provider-prefixed cases

The 0.24.1 fix demonstrates that an earlier exact test can close one hole. It cannot make an
open-ended substring tail safe: every new catalog row creates another possible first match. A
finite exact/constrained ladder with ambiguity rejection is the maintainable boundary.

### Keep a unique same-base bracket variant

Restricting `startsWith(base + "[")` to one row would remove catalog-order dependence but would still
claim that a request for `[high]` selected `[1m]`. Brackets can encode different dimensions, so
uniqueness does not establish equivalence. Compatible mode may ultimately run an already-current
`[1m]` session default, but it records that as a model fallback and independently drives `high`;
strict mode rejects the model miss.

### Require canonical provider prefixes for every model

This is the simplest routing rule but would break established `opus`, `gpt-5.5[high]`, tier config,
and agent-definition models. The finite bare-family grammar retains those forms without the current
“contains a family word anywhere” heuristic. Strict callers may use prefixes when they want the
clearest contract.

### Make strict the default

Existing scripts deliberately rely on host defaults, bare family shorthand, and catalogs that do
not advertise stable ids. A strict default would be a broad behavioral break across all three
providers. Compatible-by-default plus mandatory observability enables migration without preserving
silence.

### Preserve arbitrary fuzzy matching behind a third `legacy` policy

An opt-in would retain cross-provider and catalog-order hazards and create a policy that cannot make
the determinism guarantee. The single constrained tier-alias step covers known shorthand;
arbitrary substring matching is removed rather than renamed.

### Give Claude, Codex, and OpenCode separate resolver maps

Backend-specific aliases would drift, disadvantage custom ACP agents, and make catalog shapes an
adapter concern. All agents already advertise the base ACP config-option shape consumed by
`SessionHandle`; the single ladder is both simpler and symmetric.

### Add a new resolution result/event surface

PR #146 already established `onModelFallback` to `WorkflowRunResult.fallbacks` as the audit path.
Adding a second result array would force every SDK/MCP consumer to merge two channels. An optional
structured callback argument makes the existing channel sufficient and remains compatible with old
runners and consumers.

### Hash the concrete model or catalog fingerprint

This would change existing replay hashes and make login, agent-version, or provider-availability
changes invalidate cached work. It also cannot validate a replay without starting an agent process.
Journaling the actual model for audit and applying strictness only to live calls preserves replay
identity and avoids surprise token spend.

## 5. Compatibility & semver

### 5.1 Package changes and Changesets

| Package | Change | Compatibility | Changesets bump |
|---|---|---|---|
| `packages/shared-types` (`@automatalabs/shared-types`) | Add `ModelResolutionPolicy`, `ModelResolutionStep`, `ModelFallbackDetail`, `RunOptions.modelResolution`, optional second callback argument, and `MODEL_RESOLUTION_FAILED` | Additive type/enum surface; old callbacks and runners remain valid | minor |
| `packages/acp-agents` (`@automatalabs/acp-agents`) | Replace routing/matching internals, add `InteractiveSessionOptions.modelResolution`, `ModelSelectionOptions`, and `ModelSelectionResult`, widen `SessionHandle.selectModel`, verify echoed config, implement strict policy and structured fallback details | Existing one-string `selectModel` calls and legacy result members remain valid; new options/result members are additive, while compatible behavior is intentionally safer and more observable | minor |
| `packages/workflow-engine` (`@automatalabs/workflow-engine`) | Add `AgentOptions.modelResolution`, pass it to the seam, consume structured fallback detail, improve journal coverage, and re-export the three shared resolution types | Additive DSL/type surface; journal schema and hash remain compatible | minor |
| `packages/workflows` (`@automatalabs/workflows`) | Re-export `ModelResolutionPolicy`, `ModelResolutionStep`, `ModelFallbackDetail`, `ModelSelectionOptions`, and `ModelSelectionResult`; update validate/dry-run awareness and SDK docs | Additive SDK/CLI behavior | minor |
| `packages/mcp-server` (`@automatalabs/mcp-server`) | Ship regenerated author-workflow prompt and README/result wording | Documentation/prompt artifact only; tool input/output schemas unchanged | patch |

One Changeset may carry all five coordinated bumps. The root skill and generator output ship with
the repository but are not separate packages.

These are minor rather than major releases because existing option shapes and one-argument callback
implementations remain valid, compatible remains the default, and a model miss still executes via
the session default. The changed choices are correctness hardening of previously undocumented fuzzy
ties; no valid provider-qualified spec is redirected to another backend/provider. The minor bumps
make the observable alias/default changes visible to adopters.

### 5.2 Behavior changes

| Existing spec | Compatible result after this design | Strict result | Why the change is correct |
|---|---|---|---|
| `opus` | Routes to Claude. Exact value `opus` is silent; otherwise the current Opus row or a unique exact-boundary Opus row resolves with a non-exact fallback. Multiple non-current Opus rows are ambiguous and retain the session default with a fallback. | Requires exact advertised value `opus`; a tier-alias step fails. | Keeps the published tier shorthand while making the concrete generation visible and refusing arbitrary first-row/version selection. |
| `opus[1m]` | Routes to Claude. An exact `opus[1m]` value is selected; otherwise a current/unique Opus tier-alias row is selected observably and `1m` must be covered by that row or driven/reported as a modifier. | Requires exact `opus[1m]` or exact `opus` plus an exactly applicable `1m` modifier. | Preserves the shipped long-context example without allowing an unrelated bracket to claim coverage. |
| `gpt-5.5[high]` | Routes to Codex. Exact base `gpt-5.5` plus verified effort `high` is exact. If that base is absent, it uses the session default with model/modifier observability instead of guessing a suffixed variant. | Succeeds only with exact `gpt-5.5`/full value and applied or covered `high`. | Preserves the documented form when advertised and removes adapter-suffix/version guessing. |
| `openai/gpt-5.5[high]` or `anthropic/claude-opus-4-1` | Routes to the same first-class backend and exact-matches the prefix-stripped catalog value. A nonstandard first-class catalog that advertises only the whole routing-prefixed value now defaults observably. | Exact prefix-stripped value is required. | Makes routing-prefix semantics symmetric with OpenCode/custom and matches the actual codex-acp/claude-agent-acp base-id catalogs. |
| `opencode/zai/glm-5.2` | Routes to OpenCode and exact-matches `zai/glm-5.2`. | Same. | Canonical provider-qualified OpenCode form is unchanged. |
| `opencode/zai/glm-5.2[max]` (inner selector `zai/glm-5.2[max]`) | Exact full/base selector tests choose only the `zai` row and apply/verify `max`; a missing `zai` row cannot jump to Hugging Face/OpenRouter. | Same exact selection or failure. | Generalizes the 0.24.1 incident fix and removes its fuzzy escape hatch. |
| `claude-fable-5[high]` with only `claude-fable-5[1m]` advertised/current | Does not match the variant; reports a model fallback, retains the advertised current `[1m]`, then applies and verifies `high`; if effort is unavailable, also reports the existing modifier fallback. | Rejects the model miss before prompting. | Fixes issue #147: `[1m]` never claims to cover `[high]`, and no cross-variant catalog match occurs. |
| `claude-fable-5[high]` with plain `claude-fable-5` advertised | Exact base selection plus verified `high`, with no fallback. | Same. | The author-requested base and modifier are both actually satisfied. |
| `fable` | Continues on the configured default backend and emits `backend-default`; it selects exact catalog value `fable` there if advertised, otherwise retains that session's default. | Fails before prompting. | Preserves execution by default while making an unroutable/future family impossible to miss. |
| `gptt-5.5`, `my-gpt-proxy`, or `o3mini` | No longer routes to Codex through an interior/unterminated family fragment; defaults with a fallback. | Fails. | These are typos/custom names, not canonical GPT/O-series ids; explicit custom registration remains available. |
| `vendor/gpt-5.5` with no registered `vendor` backend | No longer discards the unknown first component and routes from `gpt-5.5`; it uses the configured backend with a route fallback and offers the whole selector there. | Fails before spawn. | An unknown provider component cannot safely select a first-class backend; register/prefix the backend explicitly. |
| explicit `model: "fable"` plus recognizable `tier: "gpt-5.5"` | Routes/defaults solely from `fable` and reports the default; `tier` is not consulted after an explicit model exists. | Fails on `fable`. | Makes the documented “model wins” rule apply to backend routing as well as catalog selection. |
| `opencode/glm-5.2` with provider-qualified GLM rows but no exact bare row | Does not choose any provider row; it is not advertised and uses the session default with a fallback. | Fails. | An unqualified model cannot safely imply a provider. Authors can write `opencode/zai/glm-5.2`. |
| `Claude Opus 4.1` or another display name that is not a valid selector id | No longer selects through exact/substring `name` matching; it is invalid or not advertised and uses the session default with a fallback. | Fails. | Display labels are not stable ids; the canonical tier word is `opus`, and exact ids remain available. |
| `claude`, `codex`, `opencode`, or `<custom-name>` | Pins the backend and intentionally retains its session default without trying to select a same-named model. | Same. | Backend-only syntax becomes consistent across all built-in and custom agents. |
| `""`, whitespace, `gpt-5.5[high][fast]`, or another malformed explicit string | Uses the configured backend/session default and emits `invalid-spec`; no malformed modifier is applied. | Fails before process acquisition. | Explicit malformed input is not equivalent to intentional omission. |
| Omitted `model` and `tier` | Uses the host/session default without a fallback. | Same. | Omission is an intentional portability contract, not a failed resolution. |

No existing valid provider-qualified value changes to a different provider. Behavior changes are
limited to removing unsafe fuzzy choices, surfacing compatibility choices, defining backend-only
forms consistently, and enforcing strictness when explicitly requested.

## 6. Test plan

### 6.1 `packages/shared-types`

- Compile/export tests cover `ModelResolutionPolicy`, every `ModelResolutionStep`,
  `ModelFallbackDetail`, `RunOptions.modelResolution`, the optional callback detail parameter, and
  `WorkflowErrorCode.MODEL_RESOLUTION_FAILED`.
- Type fixtures prove a legacy `(spec: string) => void` callback remains assignable.
- Error tests prove model-resolution errors default to non-recoverable and round-trip structured
  `details` without requiring them in older errors.

### 6.2 `packages/acp-agents`

- Parser table tests cover canonical built-in/custom prefixes, aliases, nested provider ids,
  backend-only forms, bare family boundaries, `small`/`medium`/`big` tier inputs, modifiers and all
  malformed forms. Policy validation covers `undefined`, both valid literals, and invalid direct
  runner values before spawn.
- Public type/runtime compatibility tests call `SessionHandle.selectModel(spec)` with one argument,
  destructure its three legacy members, and exercise the additive options/result members; strict
  low-level selection throws the same typed error as runner preparation.
- Routing tests retain `opus`, `gpt-5.5`, `o3-mini`, `anthropic/…`, `openai/…`,
  `opencode/zai/…`, and custom-name precedence; add negative cases for `my-gpt-proxy`, `gptt-5.5`,
  an unknown slash prefix, and unregistered `fable`. Assert that `model` prevents a recognizable
  `tier` from rerouting it and that every recognized prefix is stripped exactly once.
- Pure resolver table tests exercise every ladder step, zero/one/multiple candidates, normalized
  duplicate rows, grouped select options, current/unique/multiple tier aliases, qualified misses,
  explicit full-value-over-base precedence when both are advertised, and rejection of same-base
  bracket variants carrying different tokens.
- Config-role tests prove a unique stable id beats category-only advertisements, category-only
  custom agents work, and duplicate model/effort/Fast options at the winning priority are ambiguous
  independent of option order.
- Determinism property: for every normalized registry/default-backend fixture, catalog fixture, and
  spec/policy pair, repeated resolution produces deep-equal outcomes and does not mutate the
  fixture. Run the same assertion across every permutation of the config-option list, model option
  groups, and flattened rows; exact, current-alias, unique, ambiguous, and default outcomes must be
  invariant to advertisement order.
- 0.24.1 regression: advertise, in this order,
  `huggingface/zai-org/GLM-5.2`, `openrouter/z-ai/glm-5.2`, and `zai/glm-5.2`; request
  `opencode/zai/glm-5.2[max]`; assert only `zai/glm-5.2` is selected and effort is applied. Remove
  the `zai` row and assert no other provider is selected in either policy.
- Issue #147 regression: advertise `claude-fable-5[1m]` as the current and only value, request
  `claude-fable-5[high]`, and assert compatible mode makes no model set call, emits a
  session-default model event resolved to `[1m]`, sets `reasoning_effort=high`, verifies the echo,
  and emits no modifier-unavailable event. Remove the effort option and assert both the model event
  and existing modifier descriptor. Assert strict mode sends no prompt and never treats `[1m]` as
  a candidate.
- Coverage tests use requested `[high fast]` against selected `[high]`: effort is covered, Fast is
  driven and verified. Selected `[1m]` covers neither. Selected `[high fast]` covers both.
- Rejection tests make `session/set_config_option` throw, omit the echoed option, or echo a different
  `currentValue`; compatible mode reports the exact event and strict mode throws before prompt.
- Callback-order tests assert compatible `onSessionOpen`, then known `onModelResolved`, then
  route/model/modifier detail(s), then prompt. Strict pre-route failures emit fallback then error
  without session/prompt; strict post-open failures emit no `onModelResolved` and no prompt.
- Callback compatibility tests assert whole-model legacy signals use the full authored
  `opencode/...`/custom spec, modifier signals preserve the two established descriptor forms, and a
  one-argument callback observes every event while safely ignoring structured detail.
- Run the same catalog fixtures through Claude, Codex, OpenCode, and a registered custom harness.
  Assert no backend class contains or invokes a provider-specific resolver branch.
- Interactive `openSession`/load/resume/fork setup uses the same policy and algorithm as `run`.

### 6.3 `packages/workflow-engine`

- DSL tests prove `agent({ modelResolution: "strict" })` is passed by exact field name to
  `RunOptions`, while omitted policy arrives as compatible/default behavior in the runner; an
  invalid JavaScript DSL value fails validation with `SCRIPT_VALIDATION_ERROR`.
- Structured fallback tests cover non-exact model, backend default, session default, modifier
  failure, and strict failure. Assert accurate `requestedSpec`, `resolvedModel`, `backendId`, kind,
  message, deduplication, result persistence, and legacy one-argument runner compatibility.
- A non-recoverable `MODEL_RESOLUTION_FAILED` test proves no agent retry occurs and no prompt result
  is journaled as successful.
- Journal tests prove a runner-reported session-default `currentValue` lands in
  `JournalEntry.call.model`, old entries without it replay, and replay-time model attribution prefers
  the original `cached.call.model` rather than re-labeling the result with a newly computed spec.
- Freeze existing `hashAgentCall` fixtures before implementation and assert byte-for-byte hashes are
  unchanged when `modelResolution` is absent or added. A policy-only script edit must not alter the
  hash; documentation must state that the policy applies to live calls.
- Resume tests prove replay hits do not invoke the runner/catalog and a live suffix records its
  current actual model plus any fallback without invalidating the unchanged prefix.

### 6.4 `packages/workflows`

- Public export/type tests compile direct `createAcpRunner().run` and workflow `agent()` examples
  using `ModelResolutionPolicy`.
- Validate CLI dry-run fixtures accept `modelResolution`, retain it in the mock seam, and report the
  same backend attribution rules for canonical prefixes and custom backends.
- Static validation reports invalid policy values and a strict raw unmapped tier, but never predicts
  live catalog availability or ambiguity; those remain runner outcomes.
- README/docs drift tests assert the option list, routing table, strict semantics, and fallback
  wording agree with the skill reference.

### 6.5 `packages/mcp-server`

- Regenerate `src/generated/authoring-prompt-content.ts` and run the existing drift test.
- Prompt assertions cover the canonical grammar, `modelResolution: "strict"`, issue #147 modifier
  coverage rule, compatible default, and the unchanged `fallbacks` result shape.
- Existing workflow-tool schema/projection tests prove no new model-facing tool, input branch, or
  output field was introduced and failed strict calls expose the existing terminal error/fallback
  paths.

## 7. Docs & skill updates

The implementation PR train must update every authored surface in the same release:

1. `skills/agentprism-workflow-authoring/reference.md`
   - replace the routing table with the canonical grammar and finite bare-family table;
   - add `modelResolution` to the complete `agent()` option table;
   - document semantic exactness, compatible fallback events, strict errors, tier/mode interaction,
     modifier coverage, ambiguity, and the behavior examples in section 5.2;
   - add `MODEL_RESOLUTION_FAILED` to the error table and correct the resume-hash text without adding
     the policy to the hash.
2. `skills/agentprism-workflow-authoring/SKILL.md`
   - teach provider-qualified OpenCode/custom forms, compatible observability, when to choose strict,
     and that unrelated model brackets do not absorb requested effort;
   - replace statements that typos “never throw” or “degrade silently” with the policy-specific
     contract;
   - update the author checklist to recommend strict for calls whose named model is a correctness,
     cost, context-window, or compliance requirement.
3. Run `node scripts/generate-authoring-prompt.mjs` after those two source files change and commit
   `packages/mcp-server/src/generated/authoring-prompt-content.ts`. The generator remains the only
   way to edit that artifact; `packages/mcp-server/test/authoring-prompt.test.ts` remains the CI drift
   guard.
4. Update the model option/routing/fallback sections in `README.md` and in
   `packages/{shared-types,workflow-engine,acp-agents,workflows,mcp-server}/README.md`. The
   `acp-agents` and `workflows` READMEs carry the full API/algorithm link; engine/shared-types list
   the new types and hash rule; MCP documents the existing result fallback projection and points
   authors to the prompt/skill.
5. Update the normative runner/model sections in `docs/api.md` and the model-selection description
   in `docs/design-notes.md`: symmetric prefix stripping, exact ladder, policy/error contract,
   modifier coverage, structured callback detail, and replay-neutral journal attribution.
6. Update relevant package changelogs through the Changesets release process. Cite issue #147 and
   the 0.24.1 cross-provider incident in the acp-agents release note so the behavior change is
   auditable.
7. Review shipped skill examples for canonical forms. Existing `opus`, `opus[1m]`,
   `gpt-5.5[high]`, and
   `opencode/zai/glm-5.2` examples remain valid; add `modelResolution: "strict"` only where the
   example's logic truly requires that exact model, not mechanically to every call.

## 8. Implementation breakdown

The work is a short three-PR train. Each PR is independently reviewable, and the final documentation
PR lands before the coordinated Changesets release.

### PR 1 — Core resolver and runner contract (L)

1. **S — shared contracts:** add the public policy/step/detail types, callback extension, error code,
   exports, and type/error tests in `shared-types`.
2. **M — pure parser/router:** implement the grammar, finite route table, total internal outcomes,
   custom-registry precedence, symmetric selector extraction, and order-independent catalog resolver
   in `acp-agents`; remove `innerModelSpec`, stop consulting `Backend.stripsRoutingPrefix`, retain the
   exported flag as a deprecated no-op, and keep resolution independent of process/session classes
   for exhaustive unit testing.
3. **L — session application:** replace `matchModelValue`, generalize bracket coverage, verify echoed
   model/effort/Fast state, implement strict/compatible behavior, and use the same path for run and
   interactive session setup.
4. **M — regression/property suite:** add all Claude/Codex/OpenCode/custom fixtures, catalog
   permutation determinism, issue #147, and the 0.24.1 cross-provider regression.

### PR 2 — Engine, SDK, validation, and persistence wiring (M)

5. **S — DSL plumbing:** add `AgentOptions.modelResolution`, thread it by exact seam field name, and
   re-export it through workflow-engine/workflows.
6. **M — fallback ingestion:** consume `ModelFallbackDetail`, preserve legacy runner behavior,
   produce accurate existing `WorkflowRunFallback` records, and cover strict terminal failures.
7. **S — journal coverage:** ensure known session-default models reach `JournalEntry.call.model`, add
   replay/live-suffix tests, and freeze hash fixtures to prove no identity change.
8. **S — validate CLI:** mirror the field in the mock runner/report, add static warnings that require
   no live catalog, and update validation tests.

### PR 3 — Author contract and release (S)

9. **M — docs and skill:** update both authoring skill sources, all six READMEs,
   `docs/api.md`, `docs/design-notes.md`, examples as needed, and package release notes with the
   exact grammar, policy, and migration table.
10. **S — generated prompt:** run `scripts/generate-authoring-prompt.mjs`, commit the generated MCP
    prompt content, and update prompt/drift assertions.
11. **S — Changeset:** add one coordinated Changeset with minor bumps for shared-types,
    acp-agents, workflow-engine, and workflows, plus a patch bump for mcp-server.
12. **S — contract gate:** run the package-focused test suites and repository docs/prompt drift
    checks, then verify that only exact semantic matches are silent and that all other live outcomes
    enter the existing fallback channel.
