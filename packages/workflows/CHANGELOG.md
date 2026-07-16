# @automatalabs/workflows

## 0.36.0

### Minor Changes

- aac11d8: Add absolute `scriptPath` delivery, persistence-backed workflow script resources and lineage links, full resource subscription/list-change capabilities, and the `workflow` tool's durable `stop` action. Gate workflow VM execution on durable resource readback, preserve engine-owned content-free resume ancestry across run deletion, expose manager deletion observability for resource consumers, and publish exact structured-output variants.

### Patch Changes

- Updated dependencies [aac11d8]
  - @automatalabs/workflow-engine@0.25.0

## 0.35.0

### Minor Changes

- 2a411c3: Add content-addressed incremental resume for manager-owned `resumeFromRunId` executions.

  - `@automatalabs/shared-types` adds the optional safety, replay-provenance, call-decision, and
    `WorkflowResumeReport` contracts; checkpoint-capable `inputsHash` documentation; and additive
    `WorkflowCallRecord` / `WorkflowRunResult` fields. Old object literals and persisted JSON remain
    readable because every new field is optional and omitted when unset.
  - `@automatalabs/workflow-engine` adds identity-v1 format admission, durable candidate seeds,
    exact path/hash plus unique content matching, filesystem/worktree barriers, checkpoint-options
    fingerprints, logical replay budget debit, current-index agent-session rebinding, and
    manager-owned `resumeFromRunId` / `resumePolicy` preparation and reports.
  - `@automatalabs/workflows` adds the DSL `agent({ resume: { filesystem: "read-only" } })` safety
    declaration, public execution options, and facade re-exports for resume reports and reason
    catalogs.
  - `@automatalabs/mcp-server` accepts optional `resumePolicy`, delegates source hydration and
    checkpoint reply mapping to the manager, returns structured resume reports with compact text
    counts, and ships regenerated identity-resume authoring guidance.

  For identity-v1-capable sources, the default policy now replays uniquely corresponding safe calls
  non-contiguously instead of stopping at the first positional miss. Cached identity hits preserve
  their source logical debit in script-visible budget gates while adding zero current provider usage,
  and replayed session records rebind to the current call index, label, and phase. New-format sources
  must pass exact cwd, Node/V8/runtime-format, terminal-environment, manifest, and seed admission;
  unsafe non-git executions without a trustworthy terminal host identity run entirely live.

  The positional escape hatch remains an index/prefix matcher, with these hardened observable rules:
  nested workflows close the parent prefix before child execution; positional cache hits emit fresh
  current-run journal/call observations; new-format positional hits require equal agent/checkpoint
  input fingerprints and proven host checkpoint decisions; and only marker-less or permanently
  legacy sources retain historical hash-only serving without the new environment facts.

  Two fail-safe compatibility changes are intentional. The common terminal gate now rejects aborted
  or `abortSignaled` marker-less/legacy sources instead of serving their cache. Terminal compaction
  also drops inherited positional suffix rows the current run never visited, so a double-hop pause
  runs that bridged tail live on the second hop rather than replaying data absent from the immediate
  source manifest. That compaction applies to every new run seeded from a prior journal — including
  low-level embedder runs supplied a manual `exec.resumeJournal` — not only manager-owned
  `resumeFromRunId` executions, keeping later hops self-contained in both entry paths.

### Patch Changes

- Updated dependencies [8f2c109]
- Updated dependencies [2a411c3]
  - @automatalabs/acp-agents@0.28.1
  - @automatalabs/shared-types@0.23.0
  - @automatalabs/workflow-engine@0.24.0

## 0.34.0

### Minor Changes

- f93fcf3: Export the exact ACP-specialized `WorkflowRunEvent` union, payload maps, and durable event
  read/watch seam through the SDK facade. Typed manager events now expose nested `scope`, and
  `agentEvent` repeats optional `callIndex` so hosts can correlate live ACP updates directly by
  `(scope, callIndex)` while the existing `AgentEventPayload` compatibility alias remains available.

### Patch Changes

- Updated dependencies [f93fcf3]
- Updated dependencies [f93fcf3]
- Updated dependencies [f93fcf3]
  - @automatalabs/acp-agents@0.28.0
  - @automatalabs/shared-types@0.22.0
  - @automatalabs/workflow-engine@0.23.0

## 0.33.1

### Patch Changes

- Updated dependencies [0ff724b]
  - @automatalabs/acp-agents@0.27.1

## 0.33.0

### Minor Changes

- 805b51f: Replace shared error-message matching with adapter-owned structured provider-limit classification, carry typed reset metadata through workflow errors and the top-level SDK, and reserve abort classification for structured cancellation. Closes #149.

### Patch Changes

- Updated dependencies [805b51f]
  - @automatalabs/shared-types@0.21.0
  - @automatalabs/acp-agents@0.27.0
  - @automatalabs/workflow-engine@0.22.0

## 0.32.1

### Patch Changes

- 7b00535: Validate nondeterministic workflow APIs from executable AST call nodes so API names in prompts, descriptions, templates, and comments remain valid, and align workflow-validator guidance with the AST-aware behavior.
- Updated dependencies [7b00535]
  - @automatalabs/workflow-engine@0.21.1

## 0.32.0

### Minor Changes

- 134dffc: Expose ACP session config options as a verbatim per-call authoring surface, add routed no-prompt
  catalog probing to the runner and workflow validator, and preserve existing replay hash bytes when
  the new option bag is absent or empty.

### Patch Changes

- Updated dependencies [134dffc]
  - @automatalabs/acp-agents@0.26.0
  - @automatalabs/workflow-engine@0.21.0
  - @automatalabs/shared-types@0.20.0

## 0.31.0

### Minor Changes

- ef2c64b: Add the ACP-defaulted `runIsolation` SDK wrapper with owned-runner disposal and script-backend approval, and re-export `createReplayRunner` plus the isolation report, target, runner, call-manifest, recorded-error, and checkpoint-context types.

### Patch Changes

- Updated dependencies [ef2c64b]
- Updated dependencies [ef2c64b]
  - @automatalabs/shared-types@0.19.0
  - @automatalabs/workflow-engine@0.20.0
  - @automatalabs/acp-agents@0.25.1

## 0.30.1

### Patch Changes

- c81df46: Replace client-side model matching and modifier handling with deterministic registered-prefix routing and verbatim model selection by the serving ACP harness.
- Updated dependencies [c81df46]
  - @automatalabs/acp-agents@0.25.0
  - @automatalabs/workflow-engine@0.19.1

## 0.30.0

### Minor Changes

- f0f30ad: Add replay-neutral `fallbacks` and `checkpointsTaken` observability to terminal workflow results,
  persist both audit trails for cold reads, and expose them in foreground and await MCP outcomes.

### Patch Changes

- Updated dependencies [f0f30ad]
  - @automatalabs/shared-types@0.18.0
  - @automatalabs/workflow-engine@0.19.0
  - @automatalabs/acp-agents@0.24.9

## 0.29.0

### Minor Changes

- 123e1b3: Add reusable and sequenced dry-run mock answers to the validator SDK and CLI, with deterministic label-glob selection, strict schema enforcement, attribution, and unused-fixture reporting. Refresh the MCP authoring prompt with the new validator guidance.

## 0.28.0

### Minor Changes

- 86c17a8: Expose each fulfilled `gate()` result's exact last validator verdict, preserve producer and structured-verdict inference in the ambient DSL, support boolean and null verdicts, and refresh the bundled MCP authoring guidance.

### Patch Changes

- Updated dependencies [86c17a8]
  - @automatalabs/workflow-engine@0.18.0

## 0.27.1

### Patch Changes

- 7172960: Emit cumulative token-usage snapshots after live attempts and seed background runs with their complete replay journal before initial persistence; carry the replay-safe background lifecycle through the SDK facade; and add MCP background admission, bounded await, terminal outcome reconstruction, and the four-run process-local cap.
- Updated dependencies [7172960]
  - @automatalabs/workflow-engine@0.17.0

## 0.27.0

### Minor Changes

- a4a5397: Add shared workflow run inspection, log-tail, truncation, and journal-attribution contracts; implement the safe engine projector and persisted terminal causes; publish the SDK facade surface; and add the MCP `action: "inspect"` branch with terminal log-tail rendering.

### Patch Changes

- Updated dependencies [a4a5397]
  - @automatalabs/shared-types@0.17.0
  - @automatalabs/workflow-engine@0.16.0
  - @automatalabs/acp-agents@0.24.8

## 0.26.7

### Patch Changes

- Updated dependencies [346671d]
  - @automatalabs/acp-agents@0.24.7

## 0.26.6

### Patch Changes

- Updated dependencies [3705b7b]
  - @automatalabs/acp-agents@0.24.6

## 0.26.5

### Patch Changes

- Updated dependencies [b269a8f]
  - @automatalabs/acp-agents@0.24.5

## 0.26.4

### Patch Changes

- Updated dependencies [b2b1a38]
  - @automatalabs/acp-agents@0.24.4

## 0.26.3

### Patch Changes

- Updated dependencies [4e12336]
  - @automatalabs/acp-agents@0.24.3

## 0.26.2

### Patch Changes

- Updated dependencies [ca1659d]
  - @automatalabs/acp-agents@0.24.2

## 0.26.1

### Patch Changes

- Updated dependencies [44bead8]
  - @automatalabs/acp-agents@0.24.1

## 0.26.0

### Minor Changes

- 13687bc: Surface the ACP `providers/*` options end-to-end (codex-acp 1.6.0 advertises them; the surface is base-spec generic for any agent advertising `agentCapabilities.providers`):

  - **acp-agents**: `setProvider()` now records a durable routing intent in the new `ProviderStore` (exported, with `ProviderIntent`) and recycles the pool; every fresh connection — pooled, dedicated, interactive — replays the recorded `providers/set` at the end of its `initialize` handshake, and pool selection is generation-gated so no session runs under stale routing. This is the providers/\* sibling of the dispose-after-authenticate fix: provider config is in-process agent state for codex-acp, so without record → recycle → replay a configured gateway silently applied to a throwaway process only. A replay failure fails the connection loudly instead of mis-routing traffic; `disableProvider()` drops the intent and recycles. New `ProviderCapableRunner` structural interface (implemented by `AcpAgentRunner`) for hosts that duck-type the provider surface.
  - **workflows**: re-export `ProviderCapableRunner`.
  - **mcp-server**: three new conditional tools registered when the injected runner is provider-capable (independent of the auth-tool gate): `workflow_providers` (read-only, redacted to non-secret routing — never headers, never `_meta`; unsupported backends report `providersSupported: false` instead of failing), `workflow_set_provider` (SECRET `headers` never echoed, journaled, or logged; durable via the runner's record → recycle → replay), and `workflow_disable_provider` (idempotent). Shapes/projections exported from `provider-tool-io`.

  Also verified against codex-acp 1.6.0's capitalized reasoning-effort display names: effort selection matches config option **values** (still lowercase), so `model[effort]` brackets are unaffected — covered by test fixtures mirroring the 1.6.0 catalog shape.

### Patch Changes

- Updated dependencies [13687bc]
  - @automatalabs/acp-agents@0.24.0

## 0.25.2

### Patch Changes

- Updated dependencies [feadc4e]
- Updated dependencies [feadc4e]
  - @automatalabs/acp-agents@0.23.3

## 0.25.1

### Patch Changes

- Updated dependencies [3241620]
  - @automatalabs/acp-agents@0.23.2

## 0.25.0

### Minor Changes

- b256305: Add durable paused checkpoints. Workflows can opt into `headless: "pause"`, expose a non-secret `checkpointContext`, and resume with a journaled `checkpointReplies` decision that survives cold restarts.

  Expose the checkpoint context through the shared and workflows type barrels, persist and classify `CHECKPOINT_REQUIRED` runs in the engine, and add the MCP pause-and-resume wire flow for clients without elicitation.

### Patch Changes

- Updated dependencies [b256305]
  - @automatalabs/shared-types@0.16.0
  - @automatalabs/workflow-engine@0.15.0
  - @automatalabs/acp-agents@0.23.1

## 0.24.1

### Patch Changes

- Updated dependencies [754eaab]
  - @automatalabs/acp-agents@0.23.0
  - @automatalabs/shared-types@0.15.0
  - @automatalabs/workflow-engine@0.14.1

## 0.24.0

### Minor Changes

- 74623a9: Formalize persisted agent and journal session records and add `getPersistedAgentSessions` so hosts can depend on `AgentSessionRecord` surviving persistence for cold-restart session recovery.

  Re-export the persisted run and agent state types from the workflows SDK facade.

### Patch Changes

- Updated dependencies [74623a9]
  - @automatalabs/workflow-engine@0.14.0

## 0.23.3

### Patch Changes

- 5349c81: Add `resumeInBackground` so hosts can observe when an accepted resumed workflow actually settles.

  Keep per-execution ACP events connected for the full lifetime of resumed SDK runs, then release the bridge after settlement.

- Updated dependencies [5349c81]
  - @automatalabs/workflow-engine@0.13.0

## 0.23.2

### Patch Changes

- Updated dependencies [879edd2]
  - @automatalabs/acp-agents@0.22.2

## 0.23.1

### Patch Changes

- Updated dependencies [50af559]
  - @automatalabs/acp-agents@0.22.1

## 0.23.0

### Minor Changes

- 266beb2: MCP server auth tools (§4.3). Two additive, read-only/action tools register alongside the
  single `workflow` tool — but only when the injected runner duck-types as auth-capable
  (`describeAuthMethods`/`completeAuth`/`listBackends`/`auth`); a plain `AgentRunner` still gets
  `workflow` alone, so `createWorkflowServer(runner)` is unchanged and default behavior is
  byte-identical. `workflow_auth_status` reports each backend's redacted state + advertised
  methods (ids/types/names/labels/flags only — never a value; enumerates every registered backend
  when `backend` is omitted). `workflow_authenticate` maps `env`/`meta` (SECRET — handed straight
  to the runner, never echoed, journaled, or logged) into an `AuthResolution`; a browser/TTY-only
  interactive method returns `cancelled` with an explanation rather than a silent no-op. The
  paused-run summary reads the structured `authContext` (never the message string) and points at
  `workflow_authenticate` + `resumeFromRunId`. An opt-in inline elicitation resolver
  (`createDeferredMcpAuthResolver`, env-gated OFF via `AGENTPRISM_MCP_INLINE_AUTH`) collects
  env/gateway values through masked forms; the default headless path stays pure pause-and-resume.
  The `@automatalabs/workflows` facade re-exports the runner-facing auth TYPES (§4.2 sequencing)
  so `@automatalabs/mcp-server` can compile against them.
- 80586e4: SDK facade auth exports (§4.2). `@automatalabs/workflows` now re-exports the
  `isAuthRequired(error)` VALUE guard next to `isProviderUsageLimit`, resolving through the
  `@automatalabs/workflow-engine` chain threaded in the error-taxonomy work, so an embedder can
  classify an `AUTH_REQUIRED` fault (and read the non-secret `WorkflowError.authContext`) with the
  same one-liner it already uses for usage limits. The runner-facing auth TYPE surface
  (`AuthResolver`, `AuthContext`, `AuthResolution`, `AuthMethodDescriptor`, `CompleteAuthOptions`,
  `AuthOutcome`, `AuthController`, `AuthStatusSnapshot`, `AuthCapableRunner`, `AuthErrorContext`)
  is already surfaced through the facade. No new behavior and no runtime change: `createAcpRunner`
  and `runDynamicWorkflow` already spread `authCapabilities`/`onAuth` through, so this PR is a
  pure export-surface addition.

### Patch Changes

- Updated dependencies [b70293b]
- Updated dependencies [c746290]
- Updated dependencies [f489b17]
- Updated dependencies [fecf517]
- Updated dependencies [90b63bf]
  - @automatalabs/shared-types@0.14.0
  - @automatalabs/acp-agents@0.22.0
  - @automatalabs/workflow-engine@0.12.0

## 0.22.2

### Patch Changes

- Updated dependencies [2ec8093]
  - @automatalabs/acp-agents@0.21.2

## 0.22.1

### Patch Changes

- Updated dependencies [1d4199e]
  - @automatalabs/acp-agents@0.21.1

## 0.22.0

### Minor Changes

- e97b142: Session hand-off from one-shot runs: `run()` now surfaces the ACP session identity out-of-band via `RunOptions.onSessionOpen` (an `AgentSessionRef` — sessionId, backend routing id, cwd, and the agent-advertised `reopen` capabilities), and `keepSession: true` skips the release-time best-effort `session/close` so the agent-persisted session stays re-openable via the existing `runner.loadSession()`/`resumeSession()`. Workflow runs record one `AgentSessionRecord` per live agent() call — on `WorkflowRunResult.agentSessions` (present even with `journaling: false`), in journal entries (restored on resume replay), and on the `agentEnd` event/snapshot — and scripts can opt in per call with `agent(prompt, { keepSession: true })`. `InteractiveSession` gains the same `keepSession` option plus a `sessionRef` getter so held-open sessions can be persisted and re-opened later. Previously the one-shot path discarded the session id at release, making completed agents unrecoverable even though the protocol and agents support re-attach.

### Patch Changes

- Updated dependencies [e97b142]
- Updated dependencies [24079f8]
  - @automatalabs/shared-types@0.13.0
  - @automatalabs/acp-agents@0.21.0
  - @automatalabs/workflow-engine@0.11.0

## 0.21.0

### Minor Changes

- e1339e0: Add token-free workflow-script validation: the new package bin `agentprism-workflows`
  (`npx @automatalabs/workflows validate <file>`) statically parses a script (meta literal,
  syntax, determinism blocklist) and then dry-runs it in the real engine realm against an
  in-process mock AgentRunner that fabricates schema-conforming results — no ACP process is
  spawned, no tokens are spent, and no backend auth is needed. Checkpoints resolve to their
  headless defaults, script-declared `meta.backends` are treated as approved (with a warning
  that real runs require approval), and the report lists every agent call with backend
  attribution plus warnings (phase mismatches, `headless: "abort"` checkpoints, agent-less
  scripts). Exit codes: 0 valid, 1 parse failure, 2 dry-run failure, 3 usage error.

  Programmatic API: `validateWorkflowScript(script, { args, dryRun, cwd, tokenBudget,
maxAgents, timeoutMs })` plus `fabricateFromSchema`, `formatValidateReport`,
  `MOCK_TOKENS_PER_AGENT`, and the `ValidateWorkflowOptions` / `ValidateWorkflowReport` /
  `ValidatedAgentCall` / `ValidatedCheckpoint` types.

- e1339e0: Add `openWorkflowDir` — a read-only, per-call-fresh view over folders of versioned
  workflow scripts, for integrators who keep their workflows in a directory instead of
  hand-rolling `readFileSync` plumbing. Construction does no I/O; every method reads the
  filesystem at call time so the view always reflects the current working tree. The
  filename stem is the workflow name (`review-pr.workflow.js` ⇒ `review-pr`; first dir
  wins across dirs, `.workflow.js` beats `.js` within one). Surface: `dirs`, `list()`
  (parsed `meta` per file), `read(name)` (throws with searched dirs + did-you-mean), and
  `resolve(name)` — the exact `loadSavedWorkflow` contract, with strict name-shape
  validation so inline nested scripts fall through and path traversal is impossible.

  `runDynamicWorkflow` gains a `workflows` option (a `WorkflowDir` view or dir path(s)):
  the first argument may then be a workflow NAME, and nested `workflow("<name>")` calls
  resolve from the same view — previously impossible through the one-shot path, which
  never wired `loadSavedWorkflow`. The validator gains the same power via
  `ValidateWorkflowOptions.workflows` and `agentprism-workflows validate <file-or-name>
--workflows-dir <dir>` (repeatable); without it, a dry-run failure caused by a nested
  bare name now carries a warning naming the fix.

### Patch Changes

- Updated dependencies [e1339e0]
- Updated dependencies [e1339e0]
  - @automatalabs/acp-agents@0.20.4
  - @automatalabs/workflow-engine@0.10.0

## 0.20.3

### Patch Changes

- Updated dependencies [5b15082]
  - @automatalabs/acp-agents@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [68c0cff]
  - @automatalabs/acp-agents@0.20.2

## 0.20.1

### Patch Changes

- c5f65ec: Fix cross-session structured-output leakage on agents with instance-global MCP registries (OpenCode): concurrent schema runs on one pooled connection could capture another session's StructuredOutput tool call because every registered tool is visible to every live session on the process. Injected-tool schema runs are now serialized per pooled connection (the constant server name makes each registration replace the previous, so the single live registration always belongs to the active run). Scale schema-run parallelism with AGENTPRISM_ACP_POOL_SIZE — one registry per process — rather than concurrent sessions.
- Updated dependencies [c5f65ec]
  - @automatalabs/acp-agents@0.20.1

## 0.20.0

### Minor Changes

- c55b5bf: Add OpenCode as a first-class ACP backend with `opencode` model routing, OpenCode spawn overrides, config-option mode fallback, and StructuredOutput MCP tool support.

### Patch Changes

- Updated dependencies [c55b5bf]
  - @automatalabs/acp-agents@0.20.0

## 0.19.1

### Patch Changes

- Updated dependencies [037ba2c]
  - @automatalabs/shared-types@0.12.1
  - @automatalabs/workflow-engine@0.9.1
  - @automatalabs/acp-agents@0.19.1

## 0.19.0

### Minor Changes

- fea0254: Add client-hosted StructuredOutput MCP tool injection for custom ACP backends that opt in and negotiate HTTP MCP support, preserving native Claude/Codex structured-output channels while giving schema runs a validated tool-capture path before falling back to final-text JSON recovery.

### Patch Changes

- Updated dependencies [fea0254]
  - @automatalabs/acp-agents@0.19.0

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

- e1c0612: Fix five audited half-wired behaviors:

  - `runDynamicWorkflow` now disposes the runner it creates internally (callers' injected runners are never disposed), eliminating a pooled-backend process leak for repeated calls in long-lived hosts.
  - `WorkflowRunOptions.instructions` is now actually prepended to every subagent's composed instructions, as documented. Unset behavior is byte-identical to before.
  - `AgentOptions.tier` now resolves through the model-tiers config (loaded once per run), with `WorkflowRunOptions.mainModel` as the documented fallback when a tier has no configured model; explicit models still win, and an unresolvable tier passes through raw so runner fallback signaling is unchanged. Journals from runs that never set `tier`/`mainModel` remain replay-compatible.
  - MCP checkpoint `confirm` now honors `kind: "select"` (enum form over `choices`), `kind: "input"` (string form), and `timeoutMs` (races elicitation and falls back to the checkpoint's headless default), instead of always eliciting a boolean.

- Updated dependencies [1b89287]
- Updated dependencies [e1c0612]
  - @automatalabs/workflow-engine@0.9.0
  - @automatalabs/acp-agents@0.18.0
  - @automatalabs/shared-types@0.12.0

## 0.17.0

### Minor Changes

- b94b824: Drive ACP auth + providers — the protocol's login story, and the last product-relevant passthrough group. `runner.authMethods()` surfaces the backend's advertised auth methods (env_var / terminal shapes) without opening a session — the discovery call a host's onboarding UI needs; `runner.authenticate({ methodId })` drives the login flow; `listProviders`/`setProvider`/`disableProvider`/`logout` manage multi-provider agents (gated on `agentCapabilities.providers` / `auth.logout` where the protocol advertises; `authenticate` has no advertisement — method-not-found surfaces legibly naming backend + method). New `WorkflowErrorCode.AUTH_REQUIRED` (non-recoverable): an expired/missing agent login on session/new or prompt now fails with the backend named and the advertised method ids in the message ("run authenticate() with one of: …") instead of a generic execution error — classification requires BOTH the ACP auth-required code (-32000) and its message shape, so unrelated server errors can't masquerade. Coverage: all five flip to "driven" (agent side now 15 driven / 1 guarded). Adapter reality: both claude-agent-acp and codex-acp implement authenticate + logout (codex advertises api-key / chat-gpt methods); neither implements providers/\* yet.

### Patch Changes

- Updated dependencies [b94b824]
  - @automatalabs/shared-types@0.11.0
  - @automatalabs/acp-agents@0.17.0
  - @automatalabs/workflow-engine@0.8.2

## 0.16.0

### Minor Changes

- f743d0f: Serve MCP-over-ACP — the client-side ACP surface is now COMPLETE (14/14 methods served). Hosts can proxy in-process MCP servers over the ACP connection: declare `{ type: "acp", name, serverId }` in `mcpServers` and provide `clientHandlers.mcp` (`connect`/`message`/`disconnect`, all-or-nothing like terminal handlers) — payloads stay opaque, so any MCP implementation plugs in. Requests route with per-session context (`connectionId`→session tracked; the client allocates `McpConnectionId`), and live MCP connections are best-effort disconnected on session release/connection death — never leaked. The ACP transport is gated strictly on BOTH sides before any tokens are spent: the agent must advertise `mcpCapabilities.acp` AND the client must have `mcp` handlers wired; a declaration either side can't serve fails fast with a distinct message. Note: neither claude-agent-acp 0.56 nor codex-acp 1.4 advertises the ACP transport yet — coverage is protocol-complete and fixture-verified; the gate protects against declaring it prematurely.

### Patch Changes

- Updated dependencies [f743d0f]
  - @automatalabs/shared-types@0.10.0
  - @automatalabs/acp-agents@0.16.0
  - @automatalabs/workflow-engine@0.8.1

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
