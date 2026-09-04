# MCP automatic default backend selection

**Status:** Implemented

## Source request

> In practice, users never set AGENTPRISM_DEFAULT_BACKEND, so claude always gets selected when their agent that calls the workflows tool omits a selection in agent calls. I think we should be choosing a default backend in the MCP server intelligently by probing available backends first. But my question to you is if our probeHarnessConfig function accounts for authentication status. If it does then we should choose the first available backend, if not we'll need to discuss what to do
>
> Got it. Lets go with your recommendation.

## Scope

This is an MCP composition-root policy. The SDK runner's routing contract remains unchanged: an
omitted model still uses `AGENTPRISM_DEFAULT_BACKEND`, whose historical fallback is Claude.
For MCP clients that advertise form elicitation, the workflow tool fills unresolved models on
dry-run-observed `agent()` occurrences with one pre-execution user selection form (see the MCP server
API contract). Authored effective models, including inherited and backend-only specs, are preserved;
optional mode/config omissions never trigger that form. Automatic selection is the host policy only when all of these
are true:

1. the connected client does not support form elicitation;
2. a mock routing-discovery pass reaches an unmodelled call, or conservative static analysis finds a direct model-less `agent()`/default-model helper/nested workflow hidden behind another branch;
3. `AGENTPRISM_DEFAULT_BACKEND` is truly absent from the daemon environment; and
4. the injected runner exposes backend listing, default identity, and no-prompt config probing.

For a non-eliciting client, an explicitly present environment value always wins, including the historical empty/unknown value
behavior. Agent-less workflows and workflows whose direct calls are statically pinned (including a top-level
`meta.model`) do not run automatic discovery. Dynamic model expressions and unresolved branch shapes
fail conservatively toward discovery.

## Readiness semantics

`probeHarnessConfig()` opens `session/new`, optionally selects a model, reads configuration, and
closes the session without prompting. A failed spawn/session/auth/model-selection request is
`probed:false`, but `probed:true` is not a universal authentication proof because ACP backends may
defer credential validation until `session/prompt` and ambient CLI credentials are invisible to the
runner's auth bookkeeping.

Automatic selection therefore uses three internal states:

- **ready**: the no-prompt probe succeeded and the built-in exposes stronger evidence available at
  session-open time. Codex checks authorization during session creation. Pi's model catalog is
  credential-filtered and must contain a current or selectable model.
- **unknown**: the session/config probe succeeded, but zero-token prompt readiness is not universally
  observable (Claude, OpenCode, and custom backends).
- **unavailable**: the probe failed, or a built-in explicitly advertised neither a current nor a
  selectable model.

Candidates retain registry order. Selection takes the first `ready` candidate, then the first
`unknown` candidate. If all candidates are unavailable, admission fails before a run ID is created
and reports bounded per-backend diagnostics. Successful discovery is cached per project for the
daemon lifetime; failures are not cached, so an out-of-band install/login can make the next run
succeed.

## Determinism and continuation

The selected backend name is injected as the engine's host-pinned `defaultModel` before full
validation and execution. It applies after explicit model, agent-definition model, tier, and
phase/meta routing. Consequently it is passed to the runner as a backend-only model spec and enters
the existing model field of the agent identity hash.

The resolved pin and full occurrence configuration are persisted atomically in the run's versioned
canonical admission snapshot. Nested workflows share the occurrence space. Same-ID MCP continuation
inherits that exact host-owned snapshot without probing, eliciting, recovering, or guessing a new
provider. A pre-contract run without valid admission metadata remains inspectable but must start a
fresh Run. The backend never changes mid-run: a later `AUTH_REQUIRED` follows the normal resumable
pause path rather than silently sending the prompt to another provider.

## Tests

Credential-free coverage pins:

- readiness classification, custom shadows, empty built-in catalogs, and failure diagnostics;
- positive-evidence preference and unknown fallback;
- per-project discovery caching;
- explicit environment precedence;
- no discovery for fully pinned/agent-less workflows;
- persistence and call-identity inclusion of `defaultModel`; and
- exact canonical selection inheritance on same-ID MCP continuation.
