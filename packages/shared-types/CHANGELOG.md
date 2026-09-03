# @automatalabs/shared-types

## 1.1.0

### Minor Changes

- 620c9ca: Continue MCP workflows in place under their existing run ID with durable canonical agent configuration, cumulative usage and events, and first-answer-wins checkpoint decisions. Make the MCP lifecycle strict by removing replay/fork inputs, action aliases, and status waiting, improve bounded redacted configuration and permission elicitation, and add an app-only multi-run monitor dashboard shared by the supported legacy and modern protocol eras.

## 1.0.0

### Major Changes

- c562237: Remove model-facing agent execution timeout fields, idle-watchdog callbacks, and timeout error codes from the shared runtime contract.

  Remove total-wall and idle agent timers from workflow execution while preserving explicit call and run cancellation and compatibility reads for historical timeout records.

  Remove the ACP runner activity/interaction callbacks that existed only to drive the engine idle watchdog.

  Remove agent execution limits and configurable config-probe timing from the workflow SDK surface.

  Remove agent and probe timeout inputs and timeout projections from the MCP workflow tool schema and status output.

### Minor Changes

- c562237: Remove obsolete workflow token-budget and debit metadata from current SDK and MCP limits, call records, resume provenance and reports, durable events, and isolation admission. Historical persisted fields remain readable as ignored compatibility input, while provider usage telemetry remains available.

## 0.34.0

### Minor Changes

- 06725fd: Add live workflow permission brokering and explicit first-class mode defaults. MCP inspect/await now expose pending ACP permission requests through a credential-redacted 64 KiB projection that omits private session ids while preserving the complete ordered exact option set or failing closed. Elicitation-capable clients can answer those options, and other clients can use the new `permissions-response` action; public responses forbid caller metadata and route to the daemon generation that owns execution. Permission waits suspend idle detection without stopping the total-wall clock. Config output now preserves harness mode names, descriptions, metadata, and reports the AgentPrism defaults (`auto`, `agent`, `build`, or none). Replace the inaccurate permission-persistence helpers with exact advertised-option selection while retaining deprecated source-compatible shims.

## 0.33.0

### Minor Changes

- 1452e15: Add an opt-in per-attempt idle watchdog that resets on real backend activity, cancels wedged turns through the existing wind-down path, retries with a fresh clock, and reports `AGENT_IDLE_TIMEOUT` distinctly across SDK, persistence, inspection, and MCP surfaces.

## 0.32.0

### Minor Changes

- 6821b31: Migrate the MCP server to the official split TypeScript SDK v2 packages and serve both the legacy 2025 protocol and modern `2026-07-28` protocol. Preserve sessionful legacy daemon behavior while adding SDK-native HTTP/stdio era negotiation, modern multi-round-trip checkpoint and backend approval handling, subscriptions, request-scoped Apps capability projection, and restart-safe request-state verification.

  Add the workflow-engine `pauseOnCheckpoint` host seam so protocol adapters can turn a live checkpoint into the existing durable checkpoint/resume flow without changing authored headless behavior. Expose the optional checkpoint `timeoutMs` through shared checkpoint context and MCP result/event projections.

  Refresh the wrapped Claude Agent SDK runtime to 0.3.250; 0.3.249 and 0.3.250 are parity-only releases with no integrated API or wire changes.

## 0.31.0

### Minor Changes

- 205d110: ACP dependency maintenance with a protocol surface change: `@agentclientprotocol/sdk` 1.3.0 -> 1.4.0
  (acp-agents `^1.4.0`, pi-acp exact `1.4.0`, codex-acp `^1.4.0` via the upstream sync) brings ACP
  schema 1.21.0, which **removed the `env_var` authentication method from the protocol**
  (agentclientprotocol/agent-client-protocol #1796 "removes the env var variant as it proved not really
  adopted… the providers API will probably replace this" and #2000 "stabilize terminal authentication").
  `AuthMethod` is now `agent | terminal`, the `AuthEnvVar` / `AuthMethodEnvVar` types no longer exist, and
  the SDK's lenient parser reads any `env_var`-shaped method as a bare `agent` method — so the variant
  cannot be emitted or observed by any SDK >= 1.4.0 peer. We adapted on the same bump rather than holding
  the pin back (CONTRIBUTING "When the dependency gate blocks"):

  - `@automatalabs/acp-agents` (minor, public types shrink): the `env_var` `AuthMethodDescriptor` variant,
    `AuthMethodType` `"env_var"`, the `"spawn-env"` `CredentialClass` (its only producer was `env_var`),
    `HANDLED_AUTH_METHOD_TYPES` `"env_var"`, and the `AuthEnvVar`/`AuthMethodEnvVar` re-exports are removed.
    `AuthResolution { outcome: "env", values }` is retained for `agent` methods whose credential is read
    from the spawn environment (codex `api-key`); the spawn-env overlay is unchanged. The §4.6.4 drift
    tripwires are retargeted to the two-variant union plus a new compile-time pin that `env_var` stays
    absent. `PI_ACP_PROTOCOL_CONTRACT.authMethodIds` is now `["pi-stored-credentials"]`.
  - `@automatalabs/pi-acp` (minor, advertised surface shrinks): advertises only `pi-stored-credentials`;
    the five provider API-key methods (`anthropic-api-key`, `openai-api-key`, `gemini-api-key`,
    `xai-api-key`, `openrouter-api-key`) were `env_var`-typed and are retired — they now reject with
    `unknown_auth_method`. Provider keys are still read from the server's environment exactly as before.
  - `@automatalabs/workflows` (minor): drops the `AuthEnvVar`/`AuthMethodEnvVar` facade re-exports.
  - `@automatalabs/shared-types` (minor): `AuthErrorContext.methods[].type` is `"agent" | "terminal"`.
  - `@automatalabs/mcp-server` (minor): the `workflow` tool's `auth_required` output schema enum loses
    `"env_var"`.
  - `@automatalabs/workflow-engine` (patch): persisted `authContext` validation accepts only
    `agent`/`terminal` method types.

  Also carried by SDK 1.4.0 / schema 1.21.0:

  - Two new UNSTABLE `sessionUpdate` kinds, `compaction_update` and `compaction_summary_chunk` (session
    context compaction, agent-client-protocol #2002). `AcpUpdateKind` / `AcpRunnerEventMap` derive from the
    SDK type, so `@automatalabs/acp-agents` now emits them as per-kind runner events (and under the
    `session_update` catch-all) with no code change; they are bookkeeping kinds for the workflows
    projection (not turn content). The completeness tripwires list them explicitly.
  - The elicitation stabilization (`unstable_createElicitation`/`unstable_completeElicitation` ->
    `createElicitation`/`completeElicitation`) touches only the test fixture's agent side; the client
    binds the method constants, which are unchanged.

## 0.30.0

### Minor Changes

- 4f18373: Adopt codex-acp's negotiated typed-session-failures extension (AIR) in the codex backend. The
  backend now advertises the capability in `initialize.clientCapabilities._meta`, and the session
  accumulator consumes both delivery channels the server opens in response: the terminal failure on
  `PromptResponse._meta` and the asynchronous one on a `session_info_update`. Category + `retryable`
  drive the seam classification — `auth_required` becomes `AUTH_REQUIRED` with the advertised-method
  auth context, `rate_limited`/`quota_exhausted` become the resumable `PROVIDER_USAGE_LIMIT`, and
  every other category becomes an `AGENT_EXECUTION_ERROR` whose recoverability is the server's own
  `retryable` flag, so a `context_exhausted`/`policy_denied`/`bad_request` wall fails fast instead of
  burning the engine's retry budget. Suggested actions ride the error's `details` and message. The
  `cleared` phase retires a latched failure and a stale revision can never override newer state.

  This closes a real gap the extension opens: with the capability negotiated the server stops
  rejecting the request and stops streaming provider prose as assistant output, so a walled turn
  would otherwise have looked like a successful empty one. An asynchronous failure is only applied to
  a turn that produced no assistant text, so a late unattributed error never retroactively fails a
  turn that answered.

  `@automatalabs/shared-types` gains `CODEX_AIR_META_KEYS` / `CODEX_AIR_EXTENSION_VERSION`, the
  mirrored wire names for the extension (source of truth: `packages/codex-acp/src/AirExtension.ts`).
  Older codex-acp servers ignore the advertisement and keep their exact legacy error behavior, and
  no other backend advertises or is affected.

## 0.29.1

### Patch Changes

- f150805: Repository metadata now points at `agentprism/agentprism-workflows` — the monorepo transferred from `VikashLoomba` to the `agentprism` GitHub organization. No runtime changes.

## 0.29.0

### Minor Changes

- bcc443f: Skeleton-first run-monitor graph: the MCP App panel now parses the admitted workflow script (acorn, client-side) into its structural skeleton — agent/checkpoint/workflow call sites, parallel/pipeline groups, loop containers, phase markers, and engine-stdlib fan-out sites (verify/judgePanel/completenessCheck) — and renders it muted from the first frame. Runtime agents attach to their call sites by the engine's structural call path, which `agentStart` events now carry (additive `path` field, captured pre-limiter, never truncated — an oversized capture is dropped). Loops display one iteration at a time with a selector; checkpoint sites activate from settlement callRecords; nested workflow() agents cluster under a labeled bracket; pathless agents stay visible in an unmapped cluster rather than being guessed onto a site. Runs without a fetchable/parseable script fall back to the previous timing-based wave layout.

## 0.28.0

### Minor Changes

- 13fe0d7: Inspection of a live run now surfaces its in-flight agent calls. `projectWorkflowRunStatus`
  previously built `calls` from the resume journal (settled calls only) plus terminal failed
  agents, so `workflow` `action:"inspect"` reported "recent calls (0 of 0 matching)" while
  agents were actively running. Queued/running agents without a journal row are now projected
  with a new optional `WorkflowRunCallStatus.status` field (`"queued" | "running"`, present
  only while the call is in flight — settled rows are unchanged), gated on the run itself
  being pending/running so stale persisted agent rows on dead runs cannot appear as phantom
  in-flight calls. The MCP inspection text renders these as `(running)`/`(queued)` in place
  of a result preview.

## 0.27.1

### Patch Changes

- d4c6e60: Make incremental resume journal-correspondence based and world-neutral. Completed matching agent
  and checkpoint calls now replay without filesystem-safety annotations or environment-stability
  gates; live calls, nested workflows, host checkpoints, and worktree degradation no longer clear
  unrelated candidates. Current-format crash residue keeps identity replay, and usage/auth recovery
  replays its completed prefix before reattaching the interrupted ACP session. Legacy safety fields
  and reason literals remain readable as diagnostic compatibility metadata, and format-1 interrupted
  sessions use their legacy input fingerprint when crossing into the format-2 engine.

## 0.27.0

### Minor Changes

- 0a56f82: Add default-on live observability for journaling workflow runs. The additive
  `agentProgress` and `agentTranscript` events persist redacted, per-scalar-bounded content while an
  agent is still running; consumers with exhaustive event switches must accept both new members.

  Expose the append-only stream through the subscribable
  `workflow://runs/{runId}/events` MCP resource with generation-pinned cursor paging,
  constant-space notification coalescing, and explicit integrity-error mapping. Same-ID resume now
  durably saves the running snapshot before publishing `resumed` or starting execution, and a
  post-crash start opens a fresh validation partition without making the abandoned execution's
  records unreadable.

## 0.26.2

### Patch Changes

- 2561f67: Honor durable `checkpointReplies` when resuming a positional (non-`resume`-declared) run. Previously a background run paused at a durable `checkpoint(..., { headless: "pause" })` could not be continued: resuming with `resumeFromRunId` + `checkpointReplies` took the positional fallback, re-ran the whole agent prefix live, re-reached the checkpoint, and re-paused. The recorded reply is now applied after the live prefix, matched to the checkpoint's exact call path-hash so a reply only ever applies to the occurrence it targeted.

  The resume report and the MCP workflow result now surface a `checkpointReply` outcome: `applied` (with the current call index), or `not-applied` with a safe reason (`checkpoint-identity-mismatch` or `checkpoint-not-reached-at-recorded-call-site`). The not-applied report never echoes the supplied decision value.

## 0.26.1

### Patch Changes

- 6f47267: Persist terminal-shaped interruption rows for every allocated call when a run halts, and retain non-result identity blockers so completed calls remain safely replayable across usage, auth, checkpoint, and host interruptions.

## 0.26.0

### Minor Changes

- 82ede81: Add the executable built-in backend registry and generated dependency manifest, expose recursively
  frozen initialize metadata on session refs and events, preserve generic ACP extension passthrough,
  and document the registry-driven onboarding and routing contract.

## 0.25.1

### Patch Changes

- 58606fa: Admit resume sources across current-environment and Node/V8 drift while preserving format, manifest, and per-call safety checks. Resume eligibility now reports typed runtime and environment provenance changes through SDK and MCP result surfaces.

## 0.25.0

### Minor Changes

- a3d5613: Treat timeout, retry, and concurrency controls as replay-neutral operational bounds; bridge
  format-1 input fingerprints and chained ancestor journals through positional replay; persist
  producing engine-version diagnostics; and expose one resume-eligibility summary across background
  admission, foreground results, await, and inspection.
- a3d5613: Recover persisted pending and running workflows whose owning process has exited into an
  interrupted, resumable pause during construction and cold lookups. Crash snapshots with a
  journaled prefix use the `crash-residue` positional bridge when the admission environment is
  stable, while environment drift keeps the run all-live.
- a3d5613: Cancel one in-flight agent by call index without aborting its workflow run, settle ignored aborts
  through an engine-owned latch, persist `AGENT_CANCELLED` visibility, and bypass retries while
  completed siblings and resume replay continue normally.
- a3d5613: Enforce run-level agent timeouts as unbypassable total-wall-clock ceilings per attempt, with
  per-call deadlines only able to tighten them and every retry receiving a fresh clock. Persist and
  report resolved timeout limits and failures, and close/recycle ACP children that ignore
  cancellation.

## 0.24.0

### Minor Changes

- 023f552: Continue eligible usage-limit and authentication-paused agent turns from their recorded ACP sessions, with fail-to-fresh gates, durable diagnostics, and MCP output support.

## 0.23.0

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

## 0.22.0

### Minor Changes

- f93fcf3: Export the typed live `RunEvent` union and payload maps, persisted event projections, versioned
  JSONL record shapes, origin scopes, and strict-JSON error records so hosts can consume one stable
  run-observability contract without inferring manager callback types.

## 0.21.0

### Minor Changes

- 805b51f: Replace shared error-message matching with adapter-owned structured provider-limit classification, carry typed reset metadata through workflow errors and the top-level SDK, and reserve abort classification for structured cancellation. Closes #149.

## 0.20.0

### Minor Changes

- 134dffc: Expose ACP session config options as a verbatim per-call authoring surface, add routed no-prompt
  catalog probing to the runner and workflow validator, and preserve existing replay hash bytes when
  the new option bag is absent or empty.

## 0.19.0

### Minor Changes

- ef2c64b: Add the isolation/replay seam contract: per-call identity and provenance callbacks, frozen call-manifest and recorded-error types, journal metadata, honest run-result fields, and the `RECORDING_UNUSABLE`, `REPLAY_TARGET_INVALID`, and `REPLAY_DIVERGENCE` error codes.

## 0.18.0

### Minor Changes

- f0f30ad: Add replay-neutral `fallbacks` and `checkpointsTaken` observability to terminal workflow results,
  persist both audit trails for cold reads, and expose them in foreground and await MCP outcomes.

## 0.17.0

### Minor Changes

- a4a5397: Add shared workflow run inspection, log-tail, truncation, and journal-attribution contracts; implement the safe engine projector and persisted terminal causes; publish the SDK facade surface; and add the MCP `action: "inspect"` branch with terminal log-tail rendering.

## 0.16.0

### Minor Changes

- b256305: Add durable paused checkpoints. Workflows can opt into `headless: "pause"`, expose a non-secret `checkpointContext`, and resume with a journaled `checkpointReplies` decision that survives cold restarts.

  Expose the checkpoint context through the shared and workflows type barrels, persist and classify `CHECKPOINT_REQUIRED` runs in the engine, and add the MCP pause-and-resume wire flow for clients without elicitation.

## 0.15.0

### Minor Changes

- 754eaab: Add a driven `runner.forkSession({ sessionId, cwd, ... })` API — ACP `session/fork` through the full managed lifecycle (capability-gated on `sessionCapabilities.fork`, routed under the response's new session id, permissions/modes/configOptions adopted, normal `InteractiveSession` semantics including `keepSession`). Closes the last guarded hole in driven agent-method coverage (16 driven / 0 guarded); the raw escape hatch stays blocked for session-stateful methods. `AgentSessionRef.reopen` gains an optional `fork` flag mirroring the agent's advertisement (absent on records written before this field existed). Verified live against OpenCode, which advertises fork today.

## 0.14.0

### Minor Changes

- b70293b: Error taxonomy for ACP auth: classify `AUTH_REQUIRED` code-first on `-32000` (reserved
  exclusively for `authRequired`) so localized/rephrased auth messages no longer misroute
  into the retry ladder, plus a guarded prose fallback for non-conformant agents (a different
  reserved code that merely mentions the phrase never mis-routes). Adds a structured,
  non-secret `AuthErrorContext` (`backendId` + advertised method `{id,type,name}[]`) carried on
  `WorkflowError.authContext`, and an `isAuthRequired` type guard re-exported through
  `@automatalabs/workflow-engine`. Behavior-preserving for the three first-class agents.
- fecf517: Engine pause-for-auth + cold-resume re-arm. `WorkflowManager` generalizes the
  `PROVIDER_USAGE_LIMIT` pause branch so an `AUTH_REQUIRED` fault **checkpoints the run as
  paused** (`reason: "auth_required"`) instead of failing it — the journal is preserved and
  `resume()` can finish once the host completes auth. The pause persists the structured,
  non-secret `authContext` (`backendId` + advertised method `{id,type,name}[]`) and carries it
  on the `paused` event and the composed `WorkflowRunResult`; the intent's secret payload
  (`authenticateMeta`/`envValues`) is never journaled, logged, or emitted (Principle 9).
  `resume()` re-arms cold: for an `"auth_required"` pause it consults the injected runner's
  `runner.auth.canResume(backendId)` (duck-typed — no package import) and immediately re-pauses
  with `re-supply credentials for <backend> via runner auth before resuming` when an in-process
  (gateway) / spawn-env intent was lost to a fresh process, while disk-backed intents (and warm
  same-process resume) proceed. `WorkflowRunResult.authContext` and
  `PersistedRunState.authContext` are added (both non-secret); `pauseReason` is already
  free-form so no migration. Default-off is preserved: a run that never hits `AUTH_REQUIRED`
  sees byte-identical behavior, and a runner with no `auth` controller re-pauses rather than
  re-running into the same wall.

## 0.13.0

### Minor Changes

- e97b142: Session hand-off from one-shot runs: `run()` now surfaces the ACP session identity out-of-band via `RunOptions.onSessionOpen` (an `AgentSessionRef` — sessionId, backend routing id, cwd, and the agent-advertised `reopen` capabilities), and `keepSession: true` skips the release-time best-effort `session/close` so the agent-persisted session stays re-openable via the existing `runner.loadSession()`/`resumeSession()`. Workflow runs record one `AgentSessionRecord` per live agent() call — on `WorkflowRunResult.agentSessions` (present even with `journaling: false`), in journal entries (restored on resume replay), and on the `agentEnd` event/snapshot — and scripts can opt in per call with `agent(prompt, { keepSession: true })`. `InteractiveSession` gains the same `keepSession` option plus a `sessionRef` getter so held-open sessions can be persisted and re-opened later. Previously the one-shot path discarded the session id at release, making completed agents unrecoverable even though the protocol and agents support re-attach.

## 0.12.1

### Patch Changes

- 037ba2c: Backfill version bumps for the StructuredOutput tool-injection slice: shared-types gained the optional `WorkflowBackendConfig.structuredOutputTool` field and workflow-engine validates it in script `meta.backends`. Both changes shipped in the repo at v0.19.0 of the SDK but were not version-bumped; this republishes so the published types and validation match source.

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
