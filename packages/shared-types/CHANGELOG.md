# @automatalabs/shared-types

## 0.12.0

### Minor Changes

- 1b89287: Close out the remaining audit findings: dead-code removal, two small architecture seams, and a docs-truth pass with enforcement.

  - **workflow-engine**: `WorkflowManagerOptions.persistence` — inject a custom `RunPersistence` implementation (default filesystem behavior unchanged). New manager-level `journal` event (`{ runId, entry }`) streams journal entries as they append — the ingest seam for hosts that want live deltas instead of re-reading files; events are observation, so they emit even under `journaling: false` (which still writes no files and still disallows resume). Removed dead Pi-era exports: `DEFAULT_TOKEN_BUDGET`, keyword-trigger constants.
  - **acp-agents**: `AcpAgentRunner` now implements `Symbol.asyncDispose` (`await using` works); ownership rule documented (whoever constructs the runner disposes it). Removed the dead `ModelRoute.useRegex` flag.
  - **shared-types**: `ClaudeCodeSessionMeta` lost its phantom `model` member (nothing implemented it — Claude model selection rides `session/set_config_option`) and now actually types the Claude backend's session meta.
  - **workflows**: re-exports `RunPersistence` for embedders.
  - **mcp-server**: the MCP initialize response now reports the real package version instead of `0.0.0`.
  - Docs: corrected the root README's false claim that `cwd` isn't a script-level `agent()` option, the phantom Claude `_meta` model channel, stale Node 18/adapter-version references, missing elicitation events in event tables, and the acp-agents README's export list — now enforced by a docs-drift tripwire test that pins event tables and version citations to the code.

## 0.11.0

### Minor Changes

- b94b824: Drive ACP auth + providers — the protocol's login story, and the last product-relevant passthrough group. `runner.authMethods()` surfaces the backend's advertised auth methods (env_var / terminal shapes) without opening a session — the discovery call a host's onboarding UI needs; `runner.authenticate({ methodId })` drives the login flow; `listProviders`/`setProvider`/`disableProvider`/`logout` manage multi-provider agents (gated on `agentCapabilities.providers` / `auth.logout` where the protocol advertises; `authenticate` has no advertisement — method-not-found surfaces legibly naming backend + method). New `WorkflowErrorCode.AUTH_REQUIRED` (non-recoverable): an expired/missing agent login on session/new or prompt now fails with the backend named and the advertised method ids in the message ("run authenticate() with one of: …") instead of a generic execution error — classification requires BOTH the ACP auth-required code (-32000) and its message shape, so unrelated server errors can't masquerade. Coverage: all five flip to "driven" (agent side now 15 driven / 1 guarded). Adapter reality: both claude-agent-acp and codex-acp implement authenticate + logout (codex advertises api-key / chat-gpt methods); neither implements providers/\* yet.

## 0.10.0

### Minor Changes

- f743d0f: Serve MCP-over-ACP — the client-side ACP surface is now COMPLETE (14/14 methods served). Hosts can proxy in-process MCP servers over the ACP connection: declare `{ type: "acp", name, serverId }` in `mcpServers` and provide `clientHandlers.mcp` (`connect`/`message`/`disconnect`, all-or-nothing like terminal handlers) — payloads stay opaque, so any MCP implementation plugs in. Requests route with per-session context (`connectionId`→session tracked; the client allocates `McpConnectionId`), and live MCP connections are best-effort disconnected on session release/connection death — never leaked. The ACP transport is gated strictly on BOTH sides before any tokens are spent: the agent must advertise `mcpCapabilities.acp` AND the client must have `mcp` handlers wired; a declaration either side can't serve fails fast with a distinct message. Note: neither claude-agent-acp 0.56 nor codex-acp 1.4 advertises the ACP transport yet — coverage is protocol-complete and fixture-verified; the gate protects against declaring it prematurely.

## 0.9.0

### Minor Changes

- 8fea18f: Promote ACP session modes to a driven public surface. Runs and interactive sessions can now request strict agent-advertised modes, mode catalogs stay visible and live-updated, and unsupported or failed mode switches raise non-recoverable validation errors before prompting.

  When a mode is explicitly requested without a permission resolver, the headless permission fallback now defaults to deny so confinement is not bypassed by automatic escalation approval.

  Details: `RunOptions.mode` / `AgentOptions.mode` / `InteractiveSessionOptions.mode`, `SessionHandle.modes`/`setMode()`, `InteractiveSession.modes`/`setMode()`, `ToolPolicy.defaultOutcome`, live `current_mode_update` tracking, and `session/set_mode` flipped to "driven" in the coverage manifest. Resume compatibility: `mode` joins the journal identity hash ONLY when set, so journals written before session modes existed keep replaying for mode-less calls.

## 0.8.0

### Minor Changes

- cd20994: Script crashes are now labeled `SCRIPT_ERROR`, and a run-scoped `unhandledRejection` tripwire contains floating script promises (WE-3 embedding safety).

  - New `WorkflowErrorCode.SCRIPT_ERROR`: an uncaught throw or unhandled promise rejection inside the script body. Previously a script crash surfaced as `WORKFLOW_ABORTED` (`recoverable: true`) — wrong on both counts: nobody cancelled anything, and rerunning a deterministic crash crashes again. `WORKFLOW_ABORTED` is now reserved for actual cancellation; a bare error at the manager layer falls back to `UNKNOWN`.
  - Rejection tripwire: every promise the script can float is attributable to its run by REALM identity — script-created promises natively, engine-returned promises because `agent()`/`parallel()`/etc. are adopted into the script's realm at the context boundary (bonus: `agent(...) instanceof Promise` is now true inside scripts), and `.then()` chains off either. A tripped run fails with `SCRIPT_ERROR` ("Unhandled promise rejection in workflow script: …"), its in-flight agents are cancelled through a run-scoped fault signal so a zombie script stops spending tokens, and a one-macrotask drain after script completion catches trailing floats. Rejections no active realm owns preserve platform semantics: a host `unhandledRejection` listener stays in charge; with no host listener the reason is rethrown so the process fails exactly as it would have without the tripwire.

### Patch Changes

- cd20994: Integrator hygiene: `recoverStaleRuns()` is now gated on the manager's `journaling` default — a `journaling: false` WorkflowManager (host keeps its own transcript/audit store) never rewrites persisted run state that belongs to journaling processes. All five published manifests now declare `engines.node >= 22` (previously only the private workspace root did).

## 0.7.0

### Minor Changes

- 96c6429: Integrator surface, milestone 1: client-side fs/terminal interposition, image prompts, and backend-declared capability negotiation.

  - **Client-side fs/terminal handlers** (`createAcpRunner({ clientHandlers })`): register `fs.readTextFile` / `fs.writeTextFile` (per-method) and `terminal` (all five methods or nothing — validated at construction). `initialize` now advertises `clientCapabilities` computed from exactly what was registered, and the agent's `fs/*` / `terminal/*` requests route to the handlers with an `AcpSessionContext` (`sessionId`, the session's **own** `cwd`, `label`, `runId`). Unregistered methods are rejected with a JSON-RPC method-not-found error instead of the SDK's silent `{}` coalescing. Confinement (worktree roots, symlink resolution, env scoping, output caps, timeouts) is explicitly the consumer's job.
  - **Image prompts** (`RunOptions.images`, new `PromptImage` type in shared-types): base64 image `ContentBlock`s appended to the first prompt turn; `SessionHandle.prompt` widened to `string | ContentBlock[]`. Content adapts to the negotiated `promptCapabilities`: agents that don't advertise `image` get a bracketed text note per attachment (never an error, never silently dropped). Repair turns stay text-only.
  - **Backend-declared custom-capability gating**: the codex-specific `_meta` gating is generalized — each `Backend` (and each custom registry entry via `customCapabilities: { namespace, gatedKeys }`, options or `AGENTPRISM_BACKENDS`) declares which `agentCapabilities._meta` namespace it negotiates and which bare `_meta` keys are gated. Codex declares the existing fork trio (wire behavior unchanged); no declaration = never gated. `negotiateCapabilities` takes the declaration; `gateCustomMeta` takes the gated-key list (defaulted for source compatibility).

## 0.6.0

### Minor Changes

- e560e70: Negotiate ACP capabilities on the `initialize` handshake instead of reading a single field.

  The pooled ACP connection now parses the whole `InitializeResponse` (protocol version, `agentCapabilities`, `agentInfo`, `sessionCapabilities.close`, and the agent's custom `_meta` advertisement) into a `NegotiatedCapabilities` record exposed on `PooledConnection.capabilities`, and gates what the client sends on what the connected agent actually advertised:

  - **Protocol version**: if the agent selects a version this client cannot speak, the connection is closed (the process is killed and the pool evicts it) with a legible error, per the ACP spec — instead of proceeding on an unspoken protocol.
  - **Custom `_meta` keys**: the client now READS a `@automatalabs/codex-acp` advertisement — under the `agentCapabilities._meta["@automatalabs/codex-acp"]` namespace, which of its bare `_meta` inputs (`outputSchema`, `baseInstructions`, `developerInstructions`) the agent honors — and suppresses any of those keys the agent did not advertise. The pinned fork `@automatalabs/codex-acp` 1.3.0 advertises all three, so the Codex path negotiates end-to-end; when no advertisement is present the client falls back to today's legacy passthrough. New shared constant `CODEX_CUSTOM_CAPABILITY_NAMESPACE` pins the namespace.
  - **MCP transports**: a client-provided `http`/`sse` MCP server whose transport the agent did not advertise via `mcpCapabilities` is rejected fast and non-recoverably (`SCRIPT_VALIDATION_ERROR`); `stdio` is always allowed.

  Gating is **lenient for legacy agents**: an agent that advertises nothing (fork releases ≤ 1.2.0, `claude-agent-acp`, or an arbitrary minimal ACP server) keeps today's send-everything behavior, so this is fully back-compatible. `clientCapabilities` stays truthfully empty (the client implements no `fs`/`terminal` methods).

## 0.5.0

### Minor Changes

- a8c5453: Script-declared backends (`meta.backends`) — a workflow script can now declare the custom ACP backends it needs, making workflows self-contained artifacts and letting agent-authored workflows bring their own ACP servers.

  - **`meta.backends`**: `{ <name>: { command, args?, env?, sessionMeta? } }` in the script's meta block; route with `agent(p, { model: "<name>" })` or `"<name>/<inner-model>"`. The engine parses and validates the block but NEVER acts on it — script backends are inert until a composition root approves them (secure-by-default at every layer). Host-registered names always win on conflict.
  - **SDK approval**: `runDynamicWorkflow(script, { allowScriptBackends: true })` or a per-backend callback; unapproved declarations throw with guidance and a declined backend aborts the run (never a silent reroute). Lower-level callers thread pre-approved registries via `exec.scriptBackends`.
  - **MCP server approval**: clients that advertise the elicitation capability are asked to approve each unique spawn config (command/args/env shown; approvals session-sticky; an elicitation failure is a deny). Non-eliciting clients get an informative tool error naming the `AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1` env opt-in.
  - **Pool correctness**: pooled connections are now keyed by spawn-config hash (`Backend.poolKey`), so two runs declaring the same backend NAME with different COMMANDS never share a process.
  - **Handshake deadline**: the one-time ACP `initialize` now has a timeout (`AGENTPRISM_ACP_INIT_TIMEOUT_MS`, default 60s) — a configured command that is not an ACP server fails fast with a legible error instead of hanging the first call.

## 0.4.0

### Minor Changes

- 3395bbf: Custom ACP backends + generic `_meta` passthrough — run **any** ACP agent as an `agent()` target, not just the built-in Claude/Codex pair.

  - **Backend registry**: register named ACP backends via `createAcpRunner({ backends: { name: { command, args?, env?, sessionMeta? } } })` or the `AGENTPRISM_BACKENDS` env var (JSON, same shape; the programmatic option wins per name; `claude`/`codex` reserved). Registered names route `model`/`tier` specs **before** the built-in heuristics: `model: "browser"` routes to the backend; `model: "browser/vision-large"` additionally selects `vision-large` from the agent's config-option catalog. `AGENTPRISM_DEFAULT_BACKEND` may name a registered backend. Custom backends speak the published generic dialect: a `schema` is forwarded as turn-level `_meta.outputSchema` (plain JSON Schema) and the result is JSON-parsed off the final assistant message, with the client-side validate/re-prompt ladder as the repair path.
  - **Generic `_meta` passthrough**: `RunOptions.meta` / `RunOptions.promptMeta` (script-level `agent(p, { meta, promptMeta })`) merge into the outgoing ACP `session/new` / `session/prompt` `_meta`, so workflows can drive any ACP agent's custom extension surface. Precedence: a custom backend's static `sessionMeta` defaults < per-call `meta` < backend protocol-critical keys (schema channels, Codex instruction forwards) < the engine `runId` stamp. Both fields are additive run inputs and never enter the resume identity hash — resume keys stay stable across meta changes.

## 0.3.1

### Patch Changes

- 087e566: Docs-only: refresh package READMEs so npmjs.org reflects the current state — drop stale
  "pre-release / install from source" framing (the packages are published), and complete the
  `RunOptions` field lists (`baseInstructions` / `developerInstructions` on shared-types, `runId`
  on acp-agents). No code or API changes.

## 0.3.0

### Minor Changes

- f2948b3: Drop the `agentprism/` prefix from the ACP `_meta` keys — use bare, standard names.

  `META_KEYS.outputSchema` is now `"outputSchema"` (was `"agentprism/outputSchema"`) and
  `META_KEYS.runId` is now `"runId"` (was `"agentprism/runId"`), mirroring the target Codex param
  names and the bare-key convention already used by `baseInstructions` / `developerInstructions` /
  upstream `additionalRoots`. The now-unused `META_NS` export is removed.

  BREAKING (wire): the Codex schema forward rides `_meta.outputSchema` and the run-correlation
  stamp rides `_meta.runId`. `@automatalabs/acp-agents` bumps its `@automatalabs/codex-acp` dependency
  to `1.2.0`, which reads the bare `_meta.outputSchema` key — the exact pin keeps the pair in sync.
  Removed `META_NS` from the public API of `@automatalabs/shared-types`.

## 0.2.0

### Minor Changes

- 93e4906: Add Codex `baseInstructions` / `developerInstructions` session overrides to the AgentRunner seam.

  `RunOptions` gains two optional, additive Codex-only fields: `baseInstructions` (replaces Codex's
  built-in base system prompt for the session) and `developerInstructions` (injects developer-role
  instructions on top of it). The `CodexBackend` forwards them as bare `session/new` `_meta` keys,
  which the `@automatalabs/codex-acp` adapter threads into
  `thread/start.{baseInstructions,developerInstructions}`. They are ignored by the Claude backend
  (no analog) and are never part of the resume identity hash. Distinct from `instructions`, which is
  folded into the prompt text for either backend.

  Requires `@automatalabs/codex-acp` >= 1.1.0 installed for the keys to take effect end-to-end;
  against older codex-acp the keys are a harmless no-op.

## 0.1.2

### Patch Changes

- f65e7a7: Per-package READMEs; mcp-server now consumes the @automatalabs/workflows SDK.

## 0.1.1

### Patch Changes

- b8303f6: Validate the OIDC trusted-publishing release pipeline (no functional changes).
