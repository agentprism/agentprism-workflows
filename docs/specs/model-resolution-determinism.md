# Verbatim Model-Spec Passthrough

**Date:** 2026-07-15

**References:** [issue #147](https://github.com/agentprism/agentprism-workflows/issues/147) (resolved by removal under this contract)

## 1. Problem

Model selection today is client-side guessing layered over information the agents already own:
`backendIdForSpec()` (`packages/acp-agents/src/runner.ts`) routes with unanchored family regular
expressions, `matchModelValue()` (`packages/acp-agents/src/acp-client.ts`) maps authored strings
onto the agent-advertised catalog through a nine-test ladder ending in substring matches, and
`applyModelModifiers()`/`bracketTokens()` interpret a trailing `[…]` as tuning instructions with an
absorption rule that produced issue #147. Every ACP agent already advertises and validates its own
model list at runtime — built from that machine's harness state, including local models configured
directly in the harness (e.g. Codex `config.toml`). The client cannot know model names better than
the harness that serves them, so it should stop having opinions about them.

## 2. The contract

For an effective model spec `S` (after the engine's existing precedence — call `model`, agent-
definition model, tier mapping, phase/meta route, then an optional host-pinned `defaultModel` — and
the host tier configuration, which maps `small`/`medium`/`big` to a full spec string that then follows
these same rules). `defaultModel` is an additive composition-root input introduced by
[`mcp-automatic-default-backend.md`](mcp-automatic-default-backend.md); absent it, the historical
runner-default behavior below is unchanged:

1. **Routing.** Split `S` on its first `/`. If the first segment, ASCII-case-insensitively, is a
   registered harness name — the first-class prefixes `claude`, `codex`, `opencode`, `pi`, or any
   registered custom backend name (custom names keep priority over built-ins on collision) — route
   to that harness and strip exactly that one segment. Otherwise route the **entire string,
   unmodified, to the configured default backend** (`AGENTPRISM_DEFAULT_BACKEND`, historical
   default `claude`).
2. **Backend-only.** `S` equal to a registered harness name alone routes there and selects no
   model: the harness's own configured default serves the call. This is the recommended form when
   the model is configured inside the harness.
3. **Selection.** Whatever remains after routing is the model id, passed through **verbatim**: the
   runner sets the agent's model config option (`session/set_config_option`) to exactly that
   string — no case folding, no normalization, no catalog matching, no bracket parsing, no
   nearest-neighbor selection. Brackets, dots, provider-style prefixes (`anthropic/…`, `zai/…`),
   and anything else are ordinary characters in the id.
4. **Errors.** Whatever the harness returns is the outcome. A `set_config_option` error propagates
   through the existing agent-error path exactly like any other ACP failure; the client adds no
   resolution-specific error code, no retry logic, no echo verification, and no fallback semantics.
   If a harness accepts or ignores an id silently, that is the harness's documented behavior, not
   ours to second-guess. Existing attribution is unchanged: `onModelResolved`/`onSessionOpen`
   continue to record the model/backend that actually served the call in `JournalEntry.call`.

Routing is a pure function of (first segment, registered names, configured default): identical
inputs produce identical routes on every machine, and everything after routing is the harness's
authority. Nothing else exists.

## 3. What this removes

| Removed | Replaced by |
| --- | --- |
| `backendIdForSpec()` family regexes; `anthropic`/`openai` routing aliases; bare-family routes (`opus`, `gpt-…`, `^o\d`) | the §2.1 first-segment table |
| `matchModelValue()` and its nine-test ladder | verbatim `set_config_option` |
| `bracketTokens()`, `applyModelModifiers()`, effort/Fast option driving, absorption (`effortAbsorbedByModel`) | nothing — brackets are ordinary id characters (closes #147 by removal) |
| `onModelFallback` model/modifier emissions from resolution logic | nothing — harness errors propagate on the existing agent-error path |
| `Backend.stripsRoutingPrefix` consultation (property remains, deprecated, for source compatibility) | prefix stripping lives only in §2.1 |

`WorkflowRunResult.fallbacks` (PR #146) and the `onModelFallback` callback remain in the public
API for compatibility, but the resolution pipeline no longer produces model-resolution events for
them; they simply carry nothing unless some other subsystem emits.

## 4. Behavior changes and migration

Default backend `claude` unless noted:

| Authored spec | Today | New behavior |
| --- | --- | --- |
| `claude` / `codex` / `opencode` / `pi` / custom name | backend-only; session default | unchanged |
| `pi/openrouter/vendor/model-id` | first-class Pi route | strips `pi/` once; sends `openrouter/vendor/model-id` verbatim so Pi splits provider `openrouter` from model id `vendor/model-id` |
| `opencode/zai/glm-5.2` | routes to OpenCode; ladder match | unchanged route; `zai/glm-5.2` verbatim |
| `codex/gpt-5.5[high]` | route + ladder + effort option | route; `gpt-5.5[high]` verbatim — works where the harness catalog encodes effort in the id (codex-acp does); otherwise the harness decides |
| `opencode/zai/glm-5.2[max]` | thought-level driven by client | `zai/glm-5.2[max]` verbatim — effort moves to harness-side configuration; example specs migrate |
| `opus`, `sonnet`, `gpt-5.5`, `claude-fable-5[high]` (unprefixed) | family-regex route + ladder/alias | whole string verbatim to the default backend; the harness decides — docs/skills/examples migrate to prefixed ids the harnesses actually accept, or backend-only forms |
| `anthropic/claude-opus-4-1`, `openai/gpt-5.5` | alias-routes | whole string verbatim to the default backend; migrate to `claude/…` / `codex/…` |
| `fable`, typos | silent default backend + ladder | verbatim to the default backend; the harness's response is the outcome |

Migration is one sweep in the implementation PR: every model spec in README, docs/api.md,
`skills/agentprism-workflow-authoring` (SKILL.md "Choosing the agent for each call" and the
reference.md model-spec/routing tables are rewritten to §2), and both example trees moves to a
first-class prefix + an id verified against the live harness catalogs, or a backend-only form;
then `node scripts/generate-authoring-prompt.mjs` regenerates the authoring prompt.

## 5. Compatibility & semver

Observable behavior changes for unprefixed shorthand, alias prefixes, and bracket specs on
option-based harnesses. All packages are 0.x; one coordinated release:

| Package | Change | Bump |
| --- | --- | --- |
| `@automatalabs/acp-agents` | first-segment routing, verbatim selection, matcher/modifier machinery removed | minor (documented behavior change) |
| `@automatalabs/workflow-engine` | none required (attribution callbacks unchanged) | none, unless dead prose-parsing paths are pruned → patch |
| `@automatalabs/workflows` | dsl.d.ts / docs semantics update | patch |
| `@automatalabs/mcp-server` | regenerated authoring prompt | patch |
| `@automatalabs/shared-types` | none | none |

`hashAgentCall`, journals, resume, and the MCP tool schemas are untouched.

## 6. Test plan

- **acp-agents**: routing table (registered-name priority incl. a custom name shadowing a
  built-in; exactly-one-segment stripping; unprefixed whole-string passthrough; backend-only);
  verbatim selection (the authored string — brackets, dots, slashes and all — is the exact
  `set_config_option` value; no other config option is touched); harness rejection propagates as
  the existing agent error (no new code, no retry); determinism property: catalog option order and
  content never affect routing or the value sent; regression: the #147 spec `claude-fable-5[high]`
  is sent verbatim and no effort option is driven.
- **workflow-engine**: existing attribution tests still pass unchanged (`JournalEntry.call.model`
  from `onModelResolved`); replay/hash fixtures byte-identical.
- **mcp-server**: authoring-prompt drift test with updated sentinels (prefix table, verbatim rule).

## 7. Docs & skill updates

Root README model-routing section, docs/api.md, `packages/acp-agents/README.md`, SKILL.md,
reference.md, both example trees (per §4), regenerated authoring prompt, updated prompt sentinels.
Close #147 on merge of the implementation PR (resolved by removal).

## 8. Implementation breakdown

One PR:

1. **M — acp-agents**: replace routing/selection per §2; delete `matchModelValue`,
   `bracketTokens`, `applyModelModifiers`, and the resolution fallback emissions; deprecate
   `stripsRoutingPrefix`; tests.
2. **S — engine/workflows**: prune now-dead fallback prose parsing if present; docs types note.
3. **M — docs/skill/examples sweep** per §4 with live-catalog verification of every published id;
   regenerate prompt; Changesets.
