# Verbatim Model-Spec Passthrough

**Date:** 2026-07-15

**References:** [issue #147](https://github.com/VikashLoomba/agentprism-workflows/issues/147); `@automatalabs/acp-agents` 0.24.1 changelog entry

## 1. Problem

Model selection today is a client-side guessing apparatus layered over information the agents
already own. `backendIdForSpec()` (`packages/acp-agents/src/runner.ts`) routes with unanchored
family regular expressions (`/codex|gpt|openai|\bo\d/`, `/claude|opus|sonnet|haiku|anthropic/`);
`matchModelValue()` (`packages/acp-agents/src/acp-client.ts`) maps the authored string onto the
agent-advertised catalog through a nine-test ladder ending in bidirectional substring matches; and
`applyModelModifiers()` treats a requested effort bracket as satisfied whenever the matched catalog
value contains *any* bracket. Each layer produced a real incident: the pre-0.24.1 cross-provider
jump (`zai/glm-5.2[max]` matched `huggingface/zai-org/GLM-5.2`), and issue #147
(`claude-fable-5[high]` matched `claude-fable-5[1m]` and silently dropped the effort request).

The information being guessed at is not ours to guess. Every ACP agent advertises its model list as
session config options at `session/new`, built at runtime from that machine's harness state — the
Claude Code install's available models, the Codex app-server's configured models (including local
models wired through `config.toml`), OpenCode's configured providers. The client cannot know model
names better than the harness that serves them.

This contract removes the guessing entirely. The authored string is passed through verbatim; our
hardcoded prefixes exist only to route to the right harness; the harness is the sole authority on
whether a model id is valid.

## 2. The contract

### 2.1 Routing — one exact table lookup

For an effective model spec `S` (after the engine's existing precedence: call `model`, agent-
definition model, tier mapping, phase/meta route):

1. Split `S` on its first `/`. If the first segment, ASCII-case-insensitively, is a **registered
   harness name** — the built-ins `claude`, `codex`, `opencode`, or any registered custom backend
   name (which continues to take priority over the built-ins on collision, as today) — route to
   that harness and strip exactly that one segment. The remainder is the model id.
2. Otherwise route the **entire string `S`, unmodified,** to the configured default backend
   (`AGENTPRISM_DEFAULT_BACKEND`, historical default `claude`).
3. `S` consisting of a registered harness name alone (`claude`, `codex`, `opencode`, `browser`) is a
   **backend-only request**: route to that harness and select no model — the harness's own
   configured default model serves the call. This is the recommended form when the user configured
   the model inside the harness (e.g. a local model in Codex `config.toml`).

There are no other routing inputs. The family regexes, the `anthropic`/`openai` prefix aliases, the
bare-family words (`opus`, `gpt-…`), and `Backend.stripsRoutingPrefix` are all removed as routing
mechanisms. `anthropic/claude-opus-4-1` is not a Claude route; it is the literal model id
`anthropic/claude-opus-4-1` sent verbatim to the default backend. A slash in an unprefixed spec is
part of the model id, never a guessed backend.

Routing is a pure function of (first segment, registered names, configured default). Identical
inputs produce identical routes on every machine.

### 2.2 Model selection — verbatim, echo-verified, or fail

After the optional trailing modifier bracket is separated (§2.3), the remaining model id is applied
to the session exactly as authored:

1. Locate the agent's model config option by the existing stable-id/category rule (id or category
   `model`, `type: "select"`).
2. If the request named a model id and the agent advertises **no** model option, the call fails
   (§2.5). The client never pretends an unselectable model was selected.
3. Set the option to the authored id via `session/set_config_option` — no case folding beyond the
   agent's own semantics, no normalization, no catalog pre-matching, no nearest-neighbor selection.
   The one permitted convenience: if an advertised value equals the authored id
   ASCII-case-insensitively, the advertised wire value is sent (agents advertise the canonical
   casing; authors should not fail on case).
4. Verify the echoed config state: the model option's `currentValue` must equal the value sent. A
   request error or a mismatched echo means the harness did not accept the id, and the call fails
   (§2.5).
5. Backend-only requests and requests with no model spec skip selection entirely;
   `onModelResolved` still reports the advertised `currentValue` when the option exposes one.

The agent-advertised catalog is never *matched against* — it is only consulted for the casing
convenience in step 3 and for populating `onModelResolved`. Whatever the harness accepts is
correct by definition, including local models, aliases the harness itself supports, and ids that
did not exist when this client was published.

### 2.3 Modifiers — the one envelope, applied or visible

A single trailing `[…]` bracket remains the AgentPrism-level envelope for tuning knobs, because
some harnesses take effort/Fast as separate config options rather than encoding them in the model
id. Grammar is unchanged from today: tokens split on whitespace/comma/plus, ASCII-lower-cased,
deduplicated; `fast` denotes Fast mode; at most one other token denotes reasoning effort. A second
bracket block or text after the closing bracket makes the spec malformed (§2.5). The bracket is
separated before §2.2; everything before it is the verbatim model id.

Application is coverage-based, never assumed:

- Let `R` be the requested token set and `C` the token set of the *actually selected* model value's
  own trailing bracket (empty when the value has none or the model is unknown). A token is absorbed
  by the model only when it is in `R ∩ C`. An advertised `[1m]` never absorbs a requested `[high]`
  (issue #147's fix, generalized: coverage is per-token, so `[high fast]` against an actual
  `[high]` value still drives `fast`).
- Each token in `R − C` is driven through the advertised option (effort: id `reasoning_effort`,
  then category `thought_level`; Fast: id/category `fast-mode`; boolean or select as today) and
  **echo-verified** the same way as the model: applied only when the echoed current value matches.
- A modifier that cannot be applied — option not advertised, value not offered, or echo mismatch —
  does **not** fail the call. It emits the existing modifier descriptor through `onModelFallback`
  (byte-for-byte `<spec>: reasoning_effort "<token>" not advertised` / `<spec>: Fast mode not
  advertised`) and lands in `WorkflowRunResult.fallbacks`. Model identity is a hard requirement;
  tuning knobs are best-effort but always visible. (If operational experience shows authors need
  hard modifiers, a follow-up can add an opt-in without touching this contract's core.)

### 2.4 Tier

`tier` (`small` | `medium` | `big`) remains an input that the host's tier configuration maps to a
full model spec, which then follows §2.1–2.3 unchanged. `model` continues to win over `tier`. A
tier with no configured mapping and no main-model fallback selects no model (the default backend's
session default serves the call) and emits one fallback entry naming the unmapped tier — a tier is
a soft request by definition, so it degrades observably instead of failing.

### 2.5 Failure semantics

A named model is identity, so failing to honor it fails the call:

- The harness rejecting the id (§2.2 step 4), a named model with no advertised model option
  (§2.2 step 2), or a malformed spec (empty string, second bracket block, trailing text,
  leading/trailing whitespace, control characters) throws a non-recoverable `WorkflowError` with
  the new code `WorkflowErrorCode.MODEL_RESOLUTION_FAILED` before any prompt is sent. No tokens are
  spent, no retries run against an identical harness state, and the error message names the call
  label, the authored spec, and the harness's response.
- The matching `ModelFallbackDetail` (kind `"model"`, reason `"rejected"` | `"unselectable"` |
  `"invalid-spec"`) is emitted through `onModelFallback` before the throw, so managed failed
  results, `WorkflowRunResult.fallbacks`, and persisted state retain the cause.
- There is no silent fall-back to the session default for a named model, and consequently no
  `compatible`/`strict` policy knob: verbatim-or-fail is the only mode. The soft paths that remain
  are exactly the documented semantics — unprefixed specs run on the default backend (that is the
  rule, not a fallback), unmapped tiers degrade per §2.4, and modifiers degrade per §2.3.

### 2.6 Observability and journaling

- `onModelFallback` keeps its existing signature and gains the optional structured second argument
  `ModelFallbackDetail { kind: "model" | "modifier"; reason: "rejected" | "unselectable" |
  "invalid-spec" | "unmapped-tier" | "modifier-not-advertised" | "modifier-rejected";
  requestedSpec; backendId?; resolvedModel?; message }` so the engine stops parsing prose. One-
  argument callbacks remain assignable; legacy modifier descriptor strings are preserved as the
  first argument.
- `WorkflowRunResult.fallbacks` (PR #146) remains the only host-facing degradation record; no new
  result fields.
- `onModelResolved` fires with the advertised `currentValue` whenever the model option exposes one
  (including backend-only and no-spec calls), so `JournalEntry.call.model` keeps carrying the model
  that actually served each live call. Replay attribution prefers the journaled
  `cached.call.model`; `hashAgentCall` is byte-for-byte unchanged, so existing journals replay
  identically. Catalogs are never part of replay identity.
- For discovery, `SessionHandle` exposes the already-parsed advertised model list as
  `listAdvertisedModels(): { value: string; name?: string; current: boolean }[]` so hosts and
  future tooling can show what a harness actually offers; it adds no MCP surface.

## 3. What this removes

| Removed | Replaced by |
| --- | --- |
| `backendIdForSpec()` family regexes; `anthropic`/`openai` routing aliases; bare-family routes (`opus`, `gpt-…`, `^o\d`) | §2.1 exact first-segment table |
| `matchModelValue()` nine-test ladder (all fuzzy, substring, startsWith-bracket, and name tests) | §2.2 verbatim set + echo verification |
| `effortAbsorbedByModel = value.includes("[")` | §2.3 per-token `R ∩ C` coverage |
| Silent session-default fallback for a named model | §2.5 `MODEL_RESOLUTION_FAILED` |
| `Backend.stripsRoutingPrefix` consultation (property remains, deprecated, for source compat) | prefix stripping lives only in §2.1 |

## 4. Behavior changes and migration

The published spec-string corpus, under the new contract (default backend `claude` unless noted):

| Authored spec | Today | New behavior |
| --- | --- | --- |
| `claude` / `codex` / `opencode` / custom name (backend-only) | routes; session default | unchanged |
| `opencode/zai/glm-5.2[max]` | routes to OpenCode; exact match post-0.24.1 | unchanged route; `zai/glm-5.2` verbatim; `[max]` coverage-checked |
| `codex/gpt-5.5[high]`, `claude/claude-opus-4-8` | routes; ladder match | unchanged route; id verbatim; accepted iff the harness accepts it |
| `gpt-5.5[high]`, `opus`, `sonnet`, `claude-fable-5[high]` (unprefixed) | family-regex route + ladder/alias match | verbatim to the **default backend**; runs iff that harness accepts the id — **docs/skills/examples migrate to prefixed or backend-only forms** |
| `anthropic/claude-opus-4-1`, `openai/gpt-5.5` | alias-routes to Claude/Codex | whole string verbatim to the default backend; migrate to `claude/…` / `codex/…` |
| `zai/glm-5.2` (unprefixed) | pre-0.24.1 hazard class | whole string verbatim to the default backend; migrate to `opencode/zai/glm-5.2` |
| `fable`, typos, unknown families | silent default backend + silent ladder | verbatim to the default backend; fails loudly if rejected |
| `""`, `x[a][b]`, trailing text | accidental normalization | `invalid-spec` failure |

Migration is one implementation-PR sweep: update every model spec in README, docs/api.md,
`skills/agentprism-workflow-authoring` (SKILL.md routing section + reference.md model-specs table
are rewritten to this contract), and both example trees to prefixed or backend-only forms whose ids
the target harnesses actually advertise (verified at implementation time against live
claude-agent-acp/codex-acp/opencode catalogs), then regenerate the authoring prompt.

## 5. Compatibility & semver

Routing and rejection semantics change observable behavior for unprefixed shorthand and for
harness-rejected ids (previously silent session-default). All packages are 0.x; ship as one
coordinated release with these Changesets:

| Package | Change | Bump |
| --- | --- | --- |
| `@automatalabs/shared-types` | `ModelFallbackDetail`, `WorkflowErrorCode.MODEL_RESOLUTION_FAILED` | minor |
| `@automatalabs/acp-agents` | verbatim routing/selection, modifier coverage, `listAdvertisedModels`, removed matchers | minor (documented behavior change) |
| `@automatalabs/workflow-engine` | structured-detail consumption, replay-attribution read of `call.model`, error passthrough | minor |
| `@automatalabs/workflows` | re-exports, dsl.d.ts note on model semantics | minor |
| `@automatalabs/mcp-server` | regenerated authoring prompt; no tool-schema change | patch |

`hashAgentCall` unchanged; journals, resume, and the MCP tool input/output schemas are untouched.

## 6. Test plan

- **acp-agents**: routing table cases (registered-name priority incl. a custom `anthropic`;
  first-segment stripping exactly once; unprefixed passthrough; backend-only); selection cases
  (verbatim set + casing convenience + echo verification; rejection → `MODEL_RESOLUTION_FAILED`
  with detail; no model option + named model → fail; backend-only skips selection); modifier
  coverage matrix (`[high]` vs `[1m]`, `[high fast]` vs `[high]`, absent options, echo mismatch —
  regression-pinned to issue #147); determinism property: shuffled catalog option order never
  changes any outcome; the 0.24.1 cross-provider fixture now fails loudly instead of mismatching.
- **workflow-engine**: structured detail → `WorkflowRunFallback` mapping without prose parsing;
  `MODEL_RESOLUTION_FAILED` is non-recoverable (no retry, no prompt); unmapped-tier fallback entry;
  replay attribution prefers `cached.call.model`; hash bytes unchanged against a pinned fixture.
- **workflows / mcp-server**: facade re-exports compile; authoring-prompt drift test with updated
  sentinels (prefix table, verbatim rule, `MODEL_RESOLUTION_FAILED`).

## 7. Docs & skill updates

Root README model-routing section, docs/api.md, `packages/acp-agents/README.md`,
`skills/agentprism-workflow-authoring/SKILL.md` ("Choosing the agent for each call" rewritten: three
first-class prefixes + custom names, verbatim rule, backend-only recommendation for
harness-configured/local models, bracket envelope), `reference.md` model-specs table replaced by
the §2.1/§2.4 tables, examples updated per §4, `node scripts/generate-authoring-prompt.mjs`
regenerated, prompt sentinels updated.

## 8. Implementation breakdown

One PR:

1. **S — shared-types**: `ModelFallbackDetail`, `MODEL_RESOLUTION_FAILED`.
2. **M — acp-agents**: replace `backendIdForSpec`/`matchModelValue`/absorption with §2.1–2.5;
   `listAdvertisedModels`; deprecate `stripsRoutingPrefix`; tests.
3. **S — workflow-engine**: consume structured detail; replay-attribution read; tier fallback
   entry; tests.
4. **M — docs/skill/examples sweep** per §4/§7 with live-catalog verification of every published
   id; regenerate prompt; Changesets.
