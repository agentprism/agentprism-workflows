# @automatalabs/workflows

## 0.15.0

### Minor Changes

- 8768dc5: Serve ACP elicitation — agents can now ask the human structured questions mid-turn. `elicitation/create` (form mode with a primitive-typed property schema, or URL mode) routes by session to an `onElicitation` resolver: runner-wide (`AcpRunnerOptions.onElicitation`) or session-scoped (`InteractiveSessionOptions.onElicitation`, session wins), with parked requests settled as `cancel` on session cancel/release/connection death so a turn can never hang on an unanswered question; a rejecting resolver settles as cancel and the turn continues. No resolver ⇒ auto-decline AND no advertisement — capabilities stay truthful (`elicitation: { form, url }` is advertised only when a runner-wide responder exists), because advertising with a stub would make claude-agent-acp enable `AskUserQuestion` into a void. On Claude-family agents a wired resolver is exactly what enables `AskUserQuestion`, the refusal-fallback dialog, and MCP-elicitation forwarding. New typed bus events `elicitation_pending` / `elicitation_request` / `elicitation_complete` (forwarded through the facade `agentEvent` bridge); `elicitation/create` + `elicitation/complete` flip to "served" in the coverage manifest (client side now 11/14). Note: the elicitation surface is marked UNSTABLE/@experimental in the ACP SDK — wire shapes may evolve with the protocol; our SDK-bump discipline and tests catch drift.

### Patch Changes

- Updated dependencies [8768dc5]
  - @automatalabs/acp-agents@0.15.0

## 0.14.0

### Minor Changes

- f1a42fb: Add driven ACP session lifecycle wrappers for listing, deleting, loading, and resuming sessions. Reattached sessions return live `InteractiveSession`s, accumulate replayed load history, adopt response modes/config options, and route permissions through the normal session router.

  Guard raw passthrough for session-stateful methods that would create or reopen unregistered sessions (`session/new`, `session/load`, `session/resume`, `session/fork`) and add the protocol coverage tier `guarded`.

### Patch Changes

- Updated dependencies [f1a42fb]
  - @automatalabs/acp-agents@0.14.0

## 0.13.0

### Minor Changes

- 8fea18f: Promote ACP session modes to a driven public surface. Runs and interactive sessions can now request strict agent-advertised modes, mode catalogs stay visible and live-updated, and unsupported or failed mode switches raise non-recoverable validation errors before prompting.

  When a mode is explicitly requested without a permission resolver, the headless permission fallback now defaults to deny so confinement is not bypassed by automatic escalation approval.

  Details: `RunOptions.mode` / `AgentOptions.mode` / `InteractiveSessionOptions.mode`, `SessionHandle.modes`/`setMode()`, `InteractiveSession.modes`/`setMode()`, `ToolPolicy.defaultOutcome`, live `current_mode_update` tracking, and `session/set_mode` flipped to "driven" in the coverage manifest. Resume compatibility: `mode` joins the journal identity hash ONLY when set, so journals written before session modes existed keep replaying for mode-less calls.

### Patch Changes

- Updated dependencies [8fea18f]
  - @automatalabs/shared-types@0.9.0
  - @automatalabs/acp-agents@0.13.0
  - @automatalabs/workflow-engine@0.8.0

## 0.12.0

### Minor Changes

- d637882: Full-ACP-spec groundwork: typed protocol passthrough + spec-drift tripwire. `PooledConnection` and `InteractiveSession` gain raw `request()`/`notify()` escape hatches mirroring the SDK's typed overloads (method-literal typed + generic for extension methods), raced against process death — every ACP spec method (`session/set_mode`, `session/fork`, `authenticate`, …) is now reachable without waiting for a named wrapper; named wrappers remain the blessed paths that preserve engine semantics (drain accumulation, usage recording). `AGENT_METHODS`/`CLIENT_METHODS` constants and the passthrough parameter/response map types are re-exported so consumers need no direct SDK dependency. New `CLIENT_METHOD_COVERAGE`/`AGENT_METHOD_COVERAGE` manifests classify every method constant in the installed SDK (served/pending, driven/passthrough), enforced twice: the `Record` keying breaks the build when an SDK bump adds methods, and a tripwire test fails on any unclassified or stale entry — "full spec support" is now a checked invariant, not a claim.

### Patch Changes

- Updated dependencies [d637882]
  - @automatalabs/acp-agents@0.12.0

## 0.11.0

### Minor Changes

- efa034a: Per-run `cwd` on `ExecOptions` — the missing piece for worktree-per-run hosts. `startInBackground(script, args, { cwd })` / `runSync(...)` now run every subagent ACP session in that directory, overriding the manager's constructor `cwd` (which remains the key for run STATE, so `listRuns()`/`resume()` survive the run directory's deletion). The per-run cwd is persisted with the run and `resume()` re-runs in the SAME directory (e.g. the same worktree) unless explicitly overridden — confinement no longer rides on every script remembering `agent({ cwd })`. Also ships `docs/api.md`, the API reference covering the manager surface (options, ExecOptions, lifecycle, events + payload shapes), the runner surface (RunOptions, model routing, event bus, interactive sessions, capabilities), backend resolution + environment variables, and the WorkflowError code table.

### Patch Changes

- Updated dependencies [efa034a]
  - @automatalabs/workflow-engine@0.7.0

## 0.10.1

### Patch Changes

- Updated dependencies [0ce9aa1]
  - @automatalabs/acp-agents@0.11.0

## 0.10.0

### Minor Changes

- cd20994: Script crashes are now labeled `SCRIPT_ERROR`, and a run-scoped `unhandledRejection` tripwire contains floating script promises (WE-3 embedding safety).

  - New `WorkflowErrorCode.SCRIPT_ERROR`: an uncaught throw or unhandled promise rejection inside the script body. Previously a script crash surfaced as `WORKFLOW_ABORTED` (`recoverable: true`) — wrong on both counts: nobody cancelled anything, and rerunning a deterministic crash crashes again. `WORKFLOW_ABORTED` is now reserved for actual cancellation; a bare error at the manager layer falls back to `UNKNOWN`.
  - Rejection tripwire: every promise the script can float is attributable to its run by REALM identity — script-created promises natively, engine-returned promises because `agent()`/`parallel()`/etc. are adopted into the script's realm at the context boundary (bonus: `agent(...) instanceof Promise` is now true inside scripts), and `.then()` chains off either. A tripped run fails with `SCRIPT_ERROR` ("Unhandled promise rejection in workflow script: …"), its in-flight agents are cancelled through a run-scoped fault signal so a zombie script stops spending tokens, and a one-macrotask drain after script completion catches trailing floats. Rejections no active realm owns preserve platform semantics: a host `unhandledRejection` listener stays in charge; with no host listener the reason is rethrown so the process fails exactly as it would have without the tripwire.

### Patch Changes

- cd20994: Integrator hygiene: `recoverStaleRuns()` is now gated on the manager's `journaling` default — a `journaling: false` WorkflowManager (host keeps its own transcript/audit store) never rewrites persisted run state that belongs to journaling processes. All five published manifests now declare `engines.node >= 22` (previously only the private workspace root did).
- Updated dependencies [cd20994]
- Updated dependencies [cd20994]
- Updated dependencies [cd20994]
  - @automatalabs/acp-agents@0.10.0
  - @automatalabs/shared-types@0.8.0
  - @automatalabs/workflow-engine@0.6.0

## 0.9.0

### Minor Changes

- 1597c87: Fix: the run's base cwd (`WorkflowRunOptions.cwd` / `WorkflowManagerOptions.cwd`) now reaches every subagent ACP session. Previously the engine only passed a session cwd for worktree-isolated agents, so non-isolated agents silently ran in the HOST process's cwd — wrong whenever the embedder's process does not live at the project root. Precedence: worktree isolation > per-agent `agent({ cwd })` (new `AgentOptions.cwd`; relative resolves against the run cwd) > run cwd > `process.cwd()`. Like `mcpServers`, cwd is additive — never part of the resume identity hash. The SDK exposes it as `runDynamicWorkflow(script, { cwd })`.

### Patch Changes

- Updated dependencies [1597c87]
- Updated dependencies [1597c87]
  - @automatalabs/workflow-engine@0.5.0

## 0.8.1

### Patch Changes

- Updated dependencies [738672f]
  - @automatalabs/acp-agents@0.9.1

## 0.8.0

### Minor Changes

- dab0568: Integrator surface, milestone 3: live event forwarding, embeddable persistence, and script-fault guarantees.

  - **`agentEvent` live stream** (`@automatalabs/workflows` WorkflowManager): every runner ACP event — streaming text, tool calls, permissions (including the parked `permission_pending` phase), session lifecycle — is forwarded through the manager as `agentEvent { name, event, sessionId, backendId, label?, runId? }`, so hosts can render live progress per agent. Bridged runners are reference-counted: per-exec runners unsubscribe when their run settles; the manager's own runner unsubscribes on `dispose()`.
  - **Manager events are now uniformly best-effort**: a throwing host observer on ANY manager event (`agentStart`, `log`, `agentEvent`, …) is isolated and can never fail, pause, or mask cleanup for a run.
  - **`persistenceRoot` option** (+ `AGENTPRISM_PERSISTENCE_ROOT` env; precedence option > env > home default) relocates run state + logs to a host-chosen root, resolved exactly once at manager construction. **`journaling: false`** (manager-wide or per-exec) skips journal/log/run-state writes for hosts that keep their own transcript store — resume for such runs fails with a legible "journaling disabled" error (explicit trade-off), while run leases (cross-process double-execution protection) and on-disk run listing are unaffected.
  - **Script-fault containment pinned by tests**: an uncaught throw in a workflow script — sync `Error`, thrown string, thrown object (including throwing `message` getters and circular objects), or post-`await` rejection — always surfaces as a `failed` result with a legible reason, releases the run lease, and never escapes as an unhandled rejection (direct and `startInBackground` paths).

### Patch Changes

- Updated dependencies [dab0568]
  - @automatalabs/workflow-engine@0.4.0

## 0.7.0

### Minor Changes

- bb771df: Integrator surface, milestone 2: interactive multi-turn sessions and human-in-the-loop permissions.

  - **Interactive sessions** (`runner.openSession(options)` → `InteractiveSession`): a held-open, multi-turn ACP session backed by a **dedicated** agent process (never a pool slot — a long-lived chat loop cannot starve one-shot `run()` calls). One prompt turn at a time (`prompt(content, { images?, promptMeta? })` → `{ stopReason, text }` with per-turn text); per-session filtered event subscriptions (`session.on(...)`, auto-removed on release); `cancel()` for the in-flight turn; idempotent `release()` that closes the session and disposes the process. Process death auto-releases the session (observable via `session_close`; in-flight prompts reject), dedicated processes are covered by a process-exit kill net, `runner.dispose()` releases open sessions first, and held-open sessions don't accumulate completed-turn text/history (`retainSessionLog: false` internally).
  - **Async permission resolver** (`createAcpRunner({ onPermissionRequest })`, per-session override via `openSession({ onPermissionRequest })`): parks permission requests for a human decision instead of the sync `ToolPolicy` path. Every parked request is guaranteed to settle with the ACP `cancelled` outcome on session release, turn cancel, or connection death — a parked request can never strand an agent turn. New additive `permission_pending` event fires when a request parks (the existing `permission_request` still fires exactly once with the final outcome).
  - `@automatalabs/workflows` now re-exports the full documented surface: `InteractiveSession` / `InteractiveSessionOptions` / `InteractiveTurn`, `PermissionResolver`, and the milestone-1 types (`ClientHandlers`, `FsHandlers`, `TerminalHandlers`, `AcpSessionContext`, `clientCapabilitiesFor`, `NegotiatedCapabilities`, `adaptPromptContent`).
  - `openSession` surfaces model routing via `onModelResolved` / `onModelFallback` like `run()`.

### Patch Changes

- Updated dependencies [bb771df]
  - @automatalabs/acp-agents@0.9.0

## 0.6.2

### Patch Changes

- Updated dependencies [96c6429]
  - @automatalabs/acp-agents@0.8.0
  - @automatalabs/shared-types@0.7.0
  - @automatalabs/workflow-engine@0.3.2

## 0.6.1

### Patch Changes

- Updated dependencies [e560e70]
- Updated dependencies [e560e70]
  - @automatalabs/acp-agents@0.7.0
  - @automatalabs/shared-types@0.6.0
  - @automatalabs/workflow-engine@0.3.1

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
  - @automatalabs/workflow-engine@0.3.0
  - @automatalabs/acp-agents@0.6.0

## 0.5.1

### Patch Changes

- Updated dependencies [ce3da69]
  - @automatalabs/acp-agents@0.5.1

## 0.5.0

### Minor Changes

- 3395bbf: Custom ACP backends + generic `_meta` passthrough — run **any** ACP agent as an `agent()` target, not just the built-in Claude/Codex pair.

  - **Backend registry**: register named ACP backends via `createAcpRunner({ backends: { name: { command, args?, env?, sessionMeta? } } })` or the `AGENTPRISM_BACKENDS` env var (JSON, same shape; the programmatic option wins per name; `claude`/`codex` reserved). Registered names route `model`/`tier` specs **before** the built-in heuristics: `model: "browser"` routes to the backend; `model: "browser/vision-large"` additionally selects `vision-large` from the agent's config-option catalog. `AGENTPRISM_DEFAULT_BACKEND` may name a registered backend. Custom backends speak the published generic dialect: a `schema` is forwarded as turn-level `_meta.outputSchema` (plain JSON Schema) and the result is JSON-parsed off the final assistant message, with the client-side validate/re-prompt ladder as the repair path.
  - **Generic `_meta` passthrough**: `RunOptions.meta` / `RunOptions.promptMeta` (script-level `agent(p, { meta, promptMeta })`) merge into the outgoing ACP `session/new` / `session/prompt` `_meta`, so workflows can drive any ACP agent's custom extension surface. Precedence: a custom backend's static `sessionMeta` defaults < per-call `meta` < backend protocol-critical keys (schema channels, Codex instruction forwards) < the engine `runId` stamp. Both fields are additive run inputs and never enter the resume identity hash — resume keys stay stable across meta changes.

### Patch Changes

- Updated dependencies [3395bbf]
  - @automatalabs/shared-types@0.4.0
  - @automatalabs/acp-agents@0.5.0
  - @automatalabs/workflow-engine@0.2.0

## 0.4.1

### Patch Changes

- Updated dependencies [087e566]
  - @automatalabs/shared-types@0.3.1
  - @automatalabs/acp-agents@0.4.1
  - @automatalabs/workflow-engine@0.1.5

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
  - @automatalabs/acp-agents@0.4.0
  - @automatalabs/workflow-engine@0.1.4

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
  - @automatalabs/acp-agents@0.3.0
  - @automatalabs/workflow-engine@0.1.3

## 0.2.0

### Minor Changes

- 548815f: Add a typed ACP event bus to `AcpAgentRunner`. `createAcpRunner().on(name, listener)` bubbles up the live ACP stream of every run: each `session/update` (typed by its `sessionUpdate` discriminant — `agent_message_chunk`, `tool_call`, `usage_update`, …) plus the cross-cutting `session_update` catch-all, `permission_request`, `raw_message`, `session_open`/`session_close`, and `backend_error`. Every event carries a `{ sessionId, backendId, label?, runId? }` context envelope so a pooled runner's concurrent runs are disambiguable; `on()`/`once()` return an unsubscribe thunk and listeners are isolated (a throwing listener never affects the run). Exported from `@automatalabs/acp-agents` (`TypedEventEmitter`, `AcpRunnerEventMap`, …) and re-exported from `@automatalabs/workflows`.

### Patch Changes

- Updated dependencies [548815f]
  - @automatalabs/acp-agents@0.2.0

## 0.1.2

### Patch Changes

- f65e7a7: Per-package READMEs; mcp-server now consumes the @automatalabs/workflows SDK.
- Updated dependencies [f65e7a7]
  - @automatalabs/shared-types@0.1.2
  - @automatalabs/workflow-engine@0.1.2
  - @automatalabs/acp-agents@0.1.2

## 0.1.1

### Patch Changes

- b8303f6: Validate the OIDC trusted-publishing release pipeline (no functional changes).
- Updated dependencies [b8303f6]
  - @automatalabs/shared-types@0.1.1
  - @automatalabs/workflow-engine@0.1.1
  - @automatalabs/acp-agents@0.1.1
