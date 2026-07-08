# @automatalabs/acp-agents

## 0.20.4

### Patch Changes

- e1339e0: Bump the bundled `@agentclientprotocol/claude-agent-acp` adapter 0.56.0 → 0.57.0
  (release-policy currency bump; advertised capabilities verified unchanged — auth.logout,
  loadSession, session lifecycle, HTTP/SSE MCP, no providers/\*).

## 0.20.3

### Patch Changes

- 5b15082: Normalize Claude `outputFormat` schemas to the JSON-Schema subset Anthropic structured outputs accepts (`toAnthropicJsonSchema`): `additionalProperties: false` forced on every object, unsupported validation keywords / formats / regex features stripped, `oneOf` → `anyOf`, authored `required` preserved. Previously the schema was sent verbatim, so an Anthropic-incompatible schema (e.g. one missing `additionalProperties: false`) made the SDK's native constraint fail and silently degraded schema runs to unconstrained text plus the repair ladder. Also fixes both normalizers to treat `properties`/`$defs` names as data rather than keywords — a property literally named `format` or `title` no longer vanishes from the wire schema.

## 0.20.2

### Patch Changes

- 68c0cff: Raise the @agentclientprotocol/sdk floor to ^1.2.1 (routine ACP dependency refresh; spec-drift tripwire green against 1.2.1).

## 0.20.1

### Patch Changes

- c5f65ec: Fix cross-session structured-output leakage on agents with instance-global MCP registries (OpenCode): concurrent schema runs on one pooled connection could capture another session's StructuredOutput tool call because every registered tool is visible to every live session on the process. Injected-tool schema runs are now serialized per pooled connection (the constant server name makes each registration replace the previous, so the single live registration always belongs to the active run). Scale schema-run parallelism with AGENTPRISM_ACP_POOL_SIZE — one registry per process — rather than concurrent sessions.

## 0.20.0

### Minor Changes

- c55b5bf: Add OpenCode as a first-class ACP backend with `opencode` model routing, OpenCode spawn overrides, config-option mode fallback, and StructuredOutput MCP tool support.

## 0.19.1

### Patch Changes

- Updated dependencies [037ba2c]
  - @automatalabs/shared-types@0.12.1

## 0.19.0

### Minor Changes

- fea0254: Add client-hosted StructuredOutput MCP tool injection for custom ACP backends that opt in and negotiate HTTP MCP support, preserving native Claude/Codex structured-output channels while giving schema runs a validated tool-capture path before falling back to final-text JSON recovery.

## 0.18.0

### Minor Changes

- 1b89287: Close out the remaining audit findings: dead-code removal, two small architecture seams, and a docs-truth pass with enforcement.

  - **workflow-engine**: `WorkflowManagerOptions.persistence` — inject a custom `RunPersistence` implementation (default filesystem behavior unchanged). New manager-level `journal` event (`{ runId, entry }`) streams journal entries as they append — the ingest seam for hosts that want live deltas instead of re-reading files; events are observation, so they emit even under `journaling: false` (which still writes no files and still disallows resume). Removed dead Pi-era exports: `DEFAULT_TOKEN_BUDGET`, keyword-trigger constants.
  - **acp-agents**: `AcpAgentRunner` now implements `Symbol.asyncDispose` (`await using` works); ownership rule documented (whoever constructs the runner disposes it). Removed the dead `ModelRoute.useRegex` flag.
  - **shared-types**: `ClaudeCodeSessionMeta` lost its phantom `model` member (nothing implemented it — Claude model selection rides `session/set_config_option`) and now actually types the Claude backend's session meta.
  - **workflows**: re-exports `RunPersistence` for embedders.
  - **mcp-server**: the MCP initialize response now reports the real package version instead of `0.0.0`.
  - Docs: corrected the root README's false claim that `cwd` isn't a script-level `agent()` option, the phantom Claude `_meta` model channel, stale Node 18/adapter-version references, missing elicitation events in event tables, and the acp-agents README's export list — now enforced by a docs-drift tripwire test that pins event tables and version citations to the code.

### Patch Changes

- Updated dependencies [1b89287]
  - @automatalabs/shared-types@0.12.0

## 0.17.0

### Minor Changes

- b94b824: Drive ACP auth + providers — the protocol's login story, and the last product-relevant passthrough group. `runner.authMethods()` surfaces the backend's advertised auth methods (env_var / terminal shapes) without opening a session — the discovery call a host's onboarding UI needs; `runner.authenticate({ methodId })` drives the login flow; `listProviders`/`setProvider`/`disableProvider`/`logout` manage multi-provider agents (gated on `agentCapabilities.providers` / `auth.logout` where the protocol advertises; `authenticate` has no advertisement — method-not-found surfaces legibly naming backend + method). New `WorkflowErrorCode.AUTH_REQUIRED` (non-recoverable): an expired/missing agent login on session/new or prompt now fails with the backend named and the advertised method ids in the message ("run authenticate() with one of: …") instead of a generic execution error — classification requires BOTH the ACP auth-required code (-32000) and its message shape, so unrelated server errors can't masquerade. Coverage: all five flip to "driven" (agent side now 15 driven / 1 guarded). Adapter reality: both claude-agent-acp and codex-acp implement authenticate + logout (codex advertises api-key / chat-gpt methods); neither implements providers/\* yet.

### Patch Changes

- Updated dependencies [b94b824]
  - @automatalabs/shared-types@0.11.0

## 0.16.0

### Minor Changes

- f743d0f: Serve MCP-over-ACP — the client-side ACP surface is now COMPLETE (14/14 methods served). Hosts can proxy in-process MCP servers over the ACP connection: declare `{ type: "acp", name, serverId }` in `mcpServers` and provide `clientHandlers.mcp` (`connect`/`message`/`disconnect`, all-or-nothing like terminal handlers) — payloads stay opaque, so any MCP implementation plugs in. Requests route with per-session context (`connectionId`→session tracked; the client allocates `McpConnectionId`), and live MCP connections are best-effort disconnected on session release/connection death — never leaked. The ACP transport is gated strictly on BOTH sides before any tokens are spent: the agent must advertise `mcpCapabilities.acp` AND the client must have `mcp` handlers wired; a declaration either side can't serve fails fast with a distinct message. Note: neither claude-agent-acp 0.56 nor codex-acp 1.4 advertises the ACP transport yet — coverage is protocol-complete and fixture-verified; the gate protects against declaring it prematurely.

### Patch Changes

- Updated dependencies [f743d0f]
  - @automatalabs/shared-types@0.10.0

## 0.15.0

### Minor Changes

- 8768dc5: Serve ACP elicitation — agents can now ask the human structured questions mid-turn. `elicitation/create` (form mode with a primitive-typed property schema, or URL mode) routes by session to an `onElicitation` resolver: runner-wide (`AcpRunnerOptions.onElicitation`) or session-scoped (`InteractiveSessionOptions.onElicitation`, session wins), with parked requests settled as `cancel` on session cancel/release/connection death so a turn can never hang on an unanswered question; a rejecting resolver settles as cancel and the turn continues. No resolver ⇒ auto-decline AND no advertisement — capabilities stay truthful (`elicitation: { form, url }` is advertised only when a runner-wide responder exists), because advertising with a stub would make claude-agent-acp enable `AskUserQuestion` into a void. On Claude-family agents a wired resolver is exactly what enables `AskUserQuestion`, the refusal-fallback dialog, and MCP-elicitation forwarding. New typed bus events `elicitation_pending` / `elicitation_request` / `elicitation_complete` (forwarded through the facade `agentEvent` bridge); `elicitation/create` + `elicitation/complete` flip to "served" in the coverage manifest (client side now 11/14). Note: the elicitation surface is marked UNSTABLE/@experimental in the ACP SDK — wire shapes may evolve with the protocol; our SDK-bump discipline and tests catch drift.

## 0.14.0

### Minor Changes

- f1a42fb: Add driven ACP session lifecycle wrappers for listing, deleting, loading, and resuming sessions. Reattached sessions return live `InteractiveSession`s, accumulate replayed load history, adopt response modes/config options, and route permissions through the normal session router.

  Guard raw passthrough for session-stateful methods that would create or reopen unregistered sessions (`session/new`, `session/load`, `session/resume`, `session/fork`) and add the protocol coverage tier `guarded`.

## 0.13.0

### Minor Changes

- 8fea18f: Promote ACP session modes to a driven public surface. Runs and interactive sessions can now request strict agent-advertised modes, mode catalogs stay visible and live-updated, and unsupported or failed mode switches raise non-recoverable validation errors before prompting.

  When a mode is explicitly requested without a permission resolver, the headless permission fallback now defaults to deny so confinement is not bypassed by automatic escalation approval.

  Details: `RunOptions.mode` / `AgentOptions.mode` / `InteractiveSessionOptions.mode`, `SessionHandle.modes`/`setMode()`, `InteractiveSession.modes`/`setMode()`, `ToolPolicy.defaultOutcome`, live `current_mode_update` tracking, and `session/set_mode` flipped to "driven" in the coverage manifest. Resume compatibility: `mode` joins the journal identity hash ONLY when set, so journals written before session modes existed keep replaying for mode-less calls.

### Patch Changes

- Updated dependencies [8fea18f]
  - @automatalabs/shared-types@0.9.0

## 0.12.0

### Minor Changes

- d637882: Full-ACP-spec groundwork: typed protocol passthrough + spec-drift tripwire. `PooledConnection` and `InteractiveSession` gain raw `request()`/`notify()` escape hatches mirroring the SDK's typed overloads (method-literal typed + generic for extension methods), raced against process death — every ACP spec method (`session/set_mode`, `session/fork`, `authenticate`, …) is now reachable without waiting for a named wrapper; named wrappers remain the blessed paths that preserve engine semantics (drain accumulation, usage recording). `AGENT_METHODS`/`CLIENT_METHODS` constants and the passthrough parameter/response map types are re-exported so consumers need no direct SDK dependency. New `CLIENT_METHOD_COVERAGE`/`AGENT_METHOD_COVERAGE` manifests classify every method constant in the installed SDK (served/pending, driven/passthrough), enforced twice: the `Record` keying breaks the build when an SDK bump adds methods, and a tripwire test fails on any unclassified or stale entry — "full spec support" is now a checked invariant, not a claim.

## 0.11.0

### Minor Changes

- 0ce9aa1: `@automatalabs/codex-acp` 1.4.0 (upstream sync: codex 0.142.5, boolean Fast-mode config options, message IDs on text chunks, goal-change session metadata, completed image-generation items) + first-class boolean session config options. The client now advertises `session.configOptions.boolean` at initialize, so agents may ship `type: "boolean"` catalog entries; the `model[fast]` spec bracket drives both the new boolean Fast-mode shape (wire request carries the `type: "boolean"` discriminator) and the legacy on/off select. Fast mode is matched by its stable `fast-mode` id — upstream moved the option's category to `model_config`, which the old category-based match would have missed.

## 0.10.0

### Minor Changes

- cd20994: Finish the fluent `client()` migration: the pooled ACP connection is now built with the SDK's `client({ name }).onRequest(...).onNotification(...).connect(stream)` builder instead of the deprecated `ClientSideConnection`, and the dependency moved from the exact `1.1.0` pin to `^1.2.0` (no more dual-install/`overrides` headache for consumers on current SDK releases); `@agentclientprotocol/claude-agent-acp` bumped to 0.56.0. The accumulation-feeding notifications (`session/update`, `_claude/sdkMessage`) are registered FIRST — the SDK runs only the first matching handler synchronously inside the read-loop turn, and that ordering is what preserves the drain contract (every update for a turn is folded into its accumulator before that turn's `prompt()` resolves). Breaking for deep integrators only: `PooledConnection.rpc` (the raw `ClientSideConnection`) is gone; `session/prompt` and `session/set_config_option` are now typed methods on `PooledConnection` (`prompt()`, `setSessionConfigOption()`), both raced against process death.

### Patch Changes

- cd20994: Integrator hygiene: `recoverStaleRuns()` is now gated on the manager's `journaling` default — a `journaling: false` WorkflowManager (host keeps its own transcript/audit store) never rewrites persisted run state that belongs to journaling processes. All five published manifests now declare `engines.node >= 22` (previously only the private workspace root did).
- Updated dependencies [cd20994]
- Updated dependencies [cd20994]
  - @automatalabs/shared-types@0.8.0

## 0.9.1

### Patch Changes

- 738672f: Publish the `ACP_CROSS_CUTTING_EVENT_NAMES` export (added alongside the milestone-3 event forwarding, but the package was not republished with it). `@automatalabs/workflows` 0.8.0 imports it at runtime, so this release repairs the pairing; `workflows` picks up a dependency-cascade patch pointing at the fixed version.

## 0.9.0

### Minor Changes

- bb771df: Integrator surface, milestone 2: interactive multi-turn sessions and human-in-the-loop permissions.

  - **Interactive sessions** (`runner.openSession(options)` → `InteractiveSession`): a held-open, multi-turn ACP session backed by a **dedicated** agent process (never a pool slot — a long-lived chat loop cannot starve one-shot `run()` calls). One prompt turn at a time (`prompt(content, { images?, promptMeta? })` → `{ stopReason, text }` with per-turn text); per-session filtered event subscriptions (`session.on(...)`, auto-removed on release); `cancel()` for the in-flight turn; idempotent `release()` that closes the session and disposes the process. Process death auto-releases the session (observable via `session_close`; in-flight prompts reject), dedicated processes are covered by a process-exit kill net, `runner.dispose()` releases open sessions first, and held-open sessions don't accumulate completed-turn text/history (`retainSessionLog: false` internally).
  - **Async permission resolver** (`createAcpRunner({ onPermissionRequest })`, per-session override via `openSession({ onPermissionRequest })`): parks permission requests for a human decision instead of the sync `ToolPolicy` path. Every parked request is guaranteed to settle with the ACP `cancelled` outcome on session release, turn cancel, or connection death — a parked request can never strand an agent turn. New additive `permission_pending` event fires when a request parks (the existing `permission_request` still fires exactly once with the final outcome).
  - `@automatalabs/workflows` now re-exports the full documented surface: `InteractiveSession` / `InteractiveSessionOptions` / `InteractiveTurn`, `PermissionResolver`, and the milestone-1 types (`ClientHandlers`, `FsHandlers`, `TerminalHandlers`, `AcpSessionContext`, `clientCapabilitiesFor`, `NegotiatedCapabilities`, `adaptPromptContent`).
  - `openSession` surfaces model routing via `onModelResolved` / `onModelFallback` like `run()`.

## 0.8.0

### Minor Changes

- 96c6429: Integrator surface, milestone 1: client-side fs/terminal interposition, image prompts, and backend-declared capability negotiation.

  - **Client-side fs/terminal handlers** (`createAcpRunner({ clientHandlers })`): register `fs.readTextFile` / `fs.writeTextFile` (per-method) and `terminal` (all five methods or nothing — validated at construction). `initialize` now advertises `clientCapabilities` computed from exactly what was registered, and the agent's `fs/*` / `terminal/*` requests route to the handlers with an `AcpSessionContext` (`sessionId`, the session's **own** `cwd`, `label`, `runId`). Unregistered methods are rejected with a JSON-RPC method-not-found error instead of the SDK's silent `{}` coalescing. Confinement (worktree roots, symlink resolution, env scoping, output caps, timeouts) is explicitly the consumer's job.
  - **Image prompts** (`RunOptions.images`, new `PromptImage` type in shared-types): base64 image `ContentBlock`s appended to the first prompt turn; `SessionHandle.prompt` widened to `string | ContentBlock[]`. Content adapts to the negotiated `promptCapabilities`: agents that don't advertise `image` get a bracketed text note per attachment (never an error, never silently dropped). Repair turns stay text-only.
  - **Backend-declared custom-capability gating**: the codex-specific `_meta` gating is generalized — each `Backend` (and each custom registry entry via `customCapabilities: { namespace, gatedKeys }`, options or `AGENTPRISM_BACKENDS`) declares which `agentCapabilities._meta` namespace it negotiates and which bare `_meta` keys are gated. Codex declares the existing fork trio (wire behavior unchanged); no declaration = never gated. `negotiateCapabilities` takes the declaration; `gateCustomMeta` takes the gated-key list (defaulted for source compatibility).

### Patch Changes

- Updated dependencies [96c6429]
  - @automatalabs/shared-types@0.7.0

## 0.7.0

### Minor Changes

- e560e70: Negotiate ACP capabilities on the `initialize` handshake instead of reading a single field.

  The pooled ACP connection now parses the whole `InitializeResponse` (protocol version, `agentCapabilities`, `agentInfo`, `sessionCapabilities.close`, and the agent's custom `_meta` advertisement) into a `NegotiatedCapabilities` record exposed on `PooledConnection.capabilities`, and gates what the client sends on what the connected agent actually advertised:

  - **Protocol version**: if the agent selects a version this client cannot speak, the connection is closed (the process is killed and the pool evicts it) with a legible error, per the ACP spec — instead of proceeding on an unspoken protocol.
  - **Custom `_meta` keys**: the client now READS a `@automatalabs/codex-acp` advertisement — under the `agentCapabilities._meta["@automatalabs/codex-acp"]` namespace, which of its bare `_meta` inputs (`outputSchema`, `baseInstructions`, `developerInstructions`) the agent honors — and suppresses any of those keys the agent did not advertise. The pinned fork `@automatalabs/codex-acp` 1.3.0 advertises all three, so the Codex path negotiates end-to-end; when no advertisement is present the client falls back to today's legacy passthrough. New shared constant `CODEX_CUSTOM_CAPABILITY_NAMESPACE` pins the namespace.
  - **MCP transports**: a client-provided `http`/`sse` MCP server whose transport the agent did not advertise via `mcpCapabilities` is rejected fast and non-recoverably (`SCRIPT_VALIDATION_ERROR`); `stdio` is always allowed.

  Gating is **lenient for legacy agents**: an agent that advertises nothing (fork releases ≤ 1.2.0, `claude-agent-acp`, or an arbitrary minimal ACP server) keeps today's send-everything behavior, so this is fully back-compatible. `clientCapabilities` stays truthfully empty (the client implements no `fs`/`terminal` methods).

### Patch Changes

- e560e70: Bump the ACP protocol deps to current: `@agentclientprotocol/sdk` `1.0.0` → `1.1.0`, `@agentclientprotocol/claude-agent-acp` `0.53.0` → `0.55.0`, and `@automatalabs/codex-acp` `1.2.0` → `1.3.0` (the fork release that merges upstream v1.1.0 and advertises its custom capabilities).

  No source changes were needed: the SDK's generated protocol type surface (`InitializeRequest`/`InitializeResponse`, `ClientCapabilities`, `AgentCapabilities`, `PromptCapabilities`, `McpCapabilities`, `SessionCapabilities`, `Implementation`) is byte-identical between `1.0.0` and `1.1.0` — the only `1.1.0` addition is a `requestId` (`JsonRpcId`) on the SDK's agent/client request-handler contexts, which the client seam does not touch. `claude-agent-acp@0.55.0`'s `initialize` response is identical to `0.53.0`'s (it just re-pins its own SDK to `1.1.0` and bumps the Claude Agent SDK). The `acp-agents` public API (including the SDK-derived `AcpSessionUpdate` / event payload types) is therefore unchanged.

- Updated dependencies [e560e70]
  - @automatalabs/shared-types@0.6.0

## 0.6.0

### Minor Changes

- a8c5453: Script-declared backends (`meta.backends`) — a workflow script can now declare the custom ACP backends it needs, making workflows self-contained artifacts and letting agent-authored workflows bring their own ACP servers.

  - **`meta.backends`**: `{ <name>: { command, args?, env?, sessionMeta? } }` in the script's meta block; route with `agent(p, { model: "<name>" })` or `"<name>/<inner-model>"`. The engine parses and validates the block but NEVER acts on it — script backends are inert until a composition root approves them (secure-by-default at every layer). Host-registered names always win on conflict.
  - **SDK approval**: `runDynamicWorkflow(script, { allowScriptBackends: true })` or a per-backend callback; unapproved declarations throw with guidance and a declined backend aborts the run (never a silent reroute). Lower-level callers thread pre-approved registries via `exec.scriptBackends`.
  - **MCP server approval**: clients that advertise the elicitation capability are asked to approve each unique spawn config (command/args/env shown; approvals session-sticky; an elicitation failure is a deny). Non-eliciting clients get an informative tool error naming the `AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1` env opt-in.
  - **Pool correctness**: pooled connections are now keyed by spawn-config hash (`Backend.poolKey`), so two runs declaring the same backend NAME with different COMMANDS never share a process.
  - **Handshake deadline**: the one-time ACP `initialize` now has a timeout (`AGENTPRISM_ACP_INIT_TIMEOUT_MS`, default 60s) — a configured command that is not an ACP server fails fast with a legible error instead of hanging the first call.

### Patch Changes

- Updated dependencies [a8c5453]
  - @automatalabs/shared-types@0.5.0

## 0.5.1

### Patch Changes

- ce3da69: Custom backends: embed the JSON Schema in the prompt text on schema runs. Found by a live e2e against opencode's ACP server: an agent that ignores the `_meta.outputSchema` forward returned well-formed JSON with invented keys, and the repair ladder can never converge on a contract the model was never shown. Custom backends now state the schema in the final-output contract (belt-and-braces: the meta forward for agents that honor it, the prompt for agents that don't). Built-in Claude/Codex backends are unchanged — their native constraint channel is authoritative.

## 0.5.0

### Minor Changes

- 3395bbf: Custom ACP backends + generic `_meta` passthrough — run **any** ACP agent as an `agent()` target, not just the built-in Claude/Codex pair.

  - **Backend registry**: register named ACP backends via `createAcpRunner({ backends: { name: { command, args?, env?, sessionMeta? } } })` or the `AGENTPRISM_BACKENDS` env var (JSON, same shape; the programmatic option wins per name; `claude`/`codex` reserved). Registered names route `model`/`tier` specs **before** the built-in heuristics: `model: "browser"` routes to the backend; `model: "browser/vision-large"` additionally selects `vision-large` from the agent's config-option catalog. `AGENTPRISM_DEFAULT_BACKEND` may name a registered backend. Custom backends speak the published generic dialect: a `schema` is forwarded as turn-level `_meta.outputSchema` (plain JSON Schema) and the result is JSON-parsed off the final assistant message, with the client-side validate/re-prompt ladder as the repair path.
  - **Generic `_meta` passthrough**: `RunOptions.meta` / `RunOptions.promptMeta` (script-level `agent(p, { meta, promptMeta })`) merge into the outgoing ACP `session/new` / `session/prompt` `_meta`, so workflows can drive any ACP agent's custom extension surface. Precedence: a custom backend's static `sessionMeta` defaults < per-call `meta` < backend protocol-critical keys (schema channels, Codex instruction forwards) < the engine `runId` stamp. Both fields are additive run inputs and never enter the resume identity hash — resume keys stay stable across meta changes.

### Patch Changes

- Updated dependencies [3395bbf]
  - @automatalabs/shared-types@0.4.0

## 0.4.1

### Patch Changes

- 087e566: Docs-only: refresh package READMEs so npmjs.org reflects the current state — drop stale
  "pre-release / install from source" framing (the packages are published), and complete the
  `RunOptions` field lists (`baseInstructions` / `developerInstructions` on shared-types, `runId`
  on acp-agents). No code or API changes.
- Updated dependencies [087e566]
  - @automatalabs/shared-types@0.3.1

## 0.4.0

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

### Patch Changes

- Updated dependencies [f2948b3]
  - @automatalabs/shared-types@0.3.0

## 0.3.0

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

### Patch Changes

- Updated dependencies [93e4906]
  - @automatalabs/shared-types@0.2.0

## 0.2.0

### Minor Changes

- 548815f: Add a typed ACP event bus to `AcpAgentRunner`. `createAcpRunner().on(name, listener)` bubbles up the live ACP stream of every run: each `session/update` (typed by its `sessionUpdate` discriminant — `agent_message_chunk`, `tool_call`, `usage_update`, …) plus the cross-cutting `session_update` catch-all, `permission_request`, `raw_message`, `session_open`/`session_close`, and `backend_error`. Every event carries a `{ sessionId, backendId, label?, runId? }` context envelope so a pooled runner's concurrent runs are disambiguable; `on()`/`once()` return an unsubscribe thunk and listeners are isolated (a throwing listener never affects the run). Exported from `@automatalabs/acp-agents` (`TypedEventEmitter`, `AcpRunnerEventMap`, …) and re-exported from `@automatalabs/workflows`.

## 0.1.2

### Patch Changes

- f65e7a7: Per-package READMEs; mcp-server now consumes the @automatalabs/workflows SDK.
- Updated dependencies [f65e7a7]
  - @automatalabs/shared-types@0.1.2

## 0.1.1

### Patch Changes

- b8303f6: Validate the OIDC trusted-publishing release pipeline (no functional changes).
- Updated dependencies [b8303f6]
  - @automatalabs/shared-types@0.1.1
