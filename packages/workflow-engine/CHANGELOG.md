# @automatalabs/workflow-engine

## 0.39.0

### Minor Changes

- 2e87092: Automatically select and persist a no-prompt readiness-based default backend for model-less MCP workflow calls when no operator default is configured. Add host-pinned `defaultModel` execution/validation support and a probe-free mock routing-discovery option.

## 0.38.0

### Minor Changes

- 6821b31: Migrate the MCP server to the official split TypeScript SDK v2 packages and serve both the legacy 2025 protocol and modern `2026-07-28` protocol. Preserve sessionful legacy daemon behavior while adding SDK-native HTTP/stdio era negotiation, modern multi-round-trip checkpoint and backend approval handling, subscriptions, request-scoped Apps capability projection, and restart-safe request-state verification.

  Add the workflow-engine `pauseOnCheckpoint` host seam so protocol adapters can turn a live checkpoint into the existing durable checkpoint/resume flow without changing authored headless behavior. Expose the optional checkpoint `timeoutMs` through shared checkpoint context and MCP result/event projections.

  Refresh the wrapped Claude Agent SDK runtime to 0.3.250; 0.3.249 and 0.3.250 are parity-only releases with no integrated API or wire changes.

### Patch Changes

- Updated dependencies [6821b31]
  - @automatalabs/shared-types@0.32.0

## 0.37.2

### Patch Changes

- ea0b68c: Make agent configuration fail closed and fully discoverable. Config probes now return effective ACP session modes, including config-option fallback normalization and explicit `null` for unsupported modes; workflow preflight rejects guessed or unadvertised modes before admission. Workflow `agent()` rejects unknown option keys before allocation, while REPL rejects reserved `configOptions.model` with modelSpec-native guidance and preserves independent mode failures instead of falsely blaming carried config keys. Static external MCP resources now accept subscribe/unsubscribe as no-ops.

## 0.37.1

### Patch Changes

- affc0fe: Document the exact `meta.phases` entry shape in the MCP tool-local authoring contract and return indexed, actionable parser diagnostics for invalid phase metadata.

## 0.37.0

### Minor Changes

- de4e704: Make the workflow MCP surface self-contained: add protocol-native live backend/config discovery, automatically run zero-token static and mocked validation before admission, return bounded structured rejection diagnostics without creating a run, and publish compact DSL guidance directly in the tool description and bundled authoring prompt. Reuse the server's live ACP runner for probes, including approved run-scoped backend definitions, without disposing host-owned runners.

## 0.36.1

### Patch Changes

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

- Updated dependencies [205d110]
  - @automatalabs/shared-types@0.31.0

## 0.36.0

### Minor Changes

- c4c5a09: Redesign the interactive REPL around `eval` and `interrupt`. `eval` now waits up to its soft
  bound, returns either `{ output, result }`, `{ output, running }`, or `{ output }`, and supports an
  empty-string polling call. Workspace inspection and teardown move into the guest as `workspace()`,
  `agents()`, and `reset()`; printing uses the depth-limited repr and `_` retains the previous
  completion value. Dispatches beyond the workspace concurrency limit queue in order, follow-up turns
  return their answers, invalid backend/options fail at admission, snapshots that cannot be restored
  auto-reset with a recovery notice, and reconcile/drain details move under workspace diagnostics.

  This is a breaking removal of the workflow execution `tokenBudget` option, the script-visible
  `budget` global, and the per-phase `phase(title, { budget })` option from both
  `@automatalabs/workflows` and `@automatalabs/workflow-engine`. Workflow scripts must use explicit
  loop bounds; `phase()` now accepts only its title. Agent-count, concurrency, timeout, and inspection
  limits remain available.

  ACP assistant message chunks are now joined with a blank line, preventing adjacent chunks from
  being concatenated into a single malformed sentence.

## 0.35.3

### Patch Changes

- Updated dependencies [4f18373]
  - @automatalabs/shared-types@0.30.0

## 0.35.2

### Patch Changes

- dbddbce: Bound the run event log's read and watch paths so a large journal no longer blocks the daemon.

  Previously every `readEvents` re-read and re-parsed the whole `events.jsonl` — a fatal UTF-8
  decode, `JSON.parse`, a canonical re-`stringify` comparison, per-record shape validation, and a
  stateful semantic pass over _every_ record — and `watchEvents` did one such full re-parse per
  record it yielded. On a real 9.7 MB / 18,193-record incident journal that measured ≈270 ms for a
  single read and ≈115.8 s of synchronous main-thread work to catch a watcher up by 500 records,
  which starved bounded `await`s and the daemon's `/healthz` probe and drove two daemon respawns.

  The writer now keeps a per-run, fully validated in-memory view of its own journal, advanced in
  O(bytes-written) on `appendEvent`, and `readEvents`/`watchEvents` serve from it: a read re-reads
  the file and verifies the already-validated prefix with a cheap rolling fingerprint, parsing only
  the never-before-seen suffix; a watcher yields cached records in O(1) each and is woken in-process
  by the writer instead of re-parsing per record. Durability is unchanged — torn-tail repair,
  stream-id and sequence checks, canonical-form and redaction validation, snapshot-watermark and
  `reconcileExternallyDeadRun` behavior all still run, and a run this process never wrote is fully
  validated once cold before any cached fast path is trusted. A long backlog drain now yields the
  event loop on a time bound so `/healthz` and `await` timers stay answerable. No public contract,
  event type, or file format changed. On a 20,000-record journal a 5,000-record watcher catch-up
  drops from a projected ~865 s to ~3 ms.

## 0.35.1

### Patch Changes

- f150805: Repository metadata now points at `agentprism/agentprism-workflows` — the monorepo transferred from `VikashLoomba` to the `agentprism` GitHub organization. No runtime changes.
- Updated dependencies [f150805]
  - @automatalabs/shared-types@0.29.1

## 0.35.0

### Minor Changes

- bcc443f: Skeleton-first run-monitor graph: the MCP App panel now parses the admitted workflow script (acorn, client-side) into its structural skeleton — agent/checkpoint/workflow call sites, parallel/pipeline groups, loop containers, phase markers, and engine-stdlib fan-out sites (verify/judgePanel/completenessCheck) — and renders it muted from the first frame. Runtime agents attach to their call sites by the engine's structural call path, which `agentStart` events now carry (additive `path` field, captured pre-limiter, never truncated — an oversized capture is dropped). Loops display one iteration at a time with a selector; checkpoint sites activate from settlement callRecords; nested workflow() agents cluster under a labeled bracket; pathless agents stay visible in an unmapped cluster rather than being guessed onto a site. Runs without a fetchable/parseable script fall back to the previous timing-based wave layout.

### Patch Changes

- Updated dependencies [bcc443f]
  - @automatalabs/shared-types@0.29.0

## 0.34.0

### Minor Changes

- fdfa8f0: Workflow execution moves into a shared per-user local daemon serving spec-compliant
  Streamable HTTP (MCP 2025-11-25) on loopback, so runs survive MCP clients killing their
  server processes (session end, restarts, tool timeouts).

  - The stdio entries (`agentprism-workflow`, `agentprism-workflows mcp`) are now thin shims
    that auto-start the daemon and proxy stdio↔HTTP; existing host registrations keep working
    unchanged. `--in-process` restores the previous single-process stdio server.
  - **New `projectDir` tool argument** (absolute path): every `run` names its project, selecting
    the project-scoped run store and default execution cwd. Required on the daemon — one
    registration, even in global MCP settings, serves every project concurrently; optional on
    an in-process server, defaulting to its own project. `inspect`/`await`/`stop`/
    `resumeFromRunId` take only a runId and locate its project store automatically (live
    contexts first, then the on-disk `project.json` store manifests the engine now writes).
    Cross-project resume redirects with an explicit error naming the right projectDir.
  - New `daemon <start|stop|status|url|run|logs>` commands; `daemon url` prints direct HTTP
    registration snippets for Claude Code and Codex (a bare URL — no headers, no per-project
    registration).
  - Spec transport contract throughout: per-session `Mcp-Session-Id`, SSE resumability with
    priming events and `Last-Event-ID` replay (dropped connections recover missed messages,
    including tool responses), `DELETE` termination, 404-driven re-initialize (handled
    transparently by the shim, including across daemon restarts and daemon death), mandatory
    Origin validation, loopback-only binding.
  - The daemon idles out after 15 minutes with no sessions and no active runs
    (`AGENTPRISM_DAEMON_IDLE_TTL_MS`), evicts dead-client sessions without touching their runs,
    and records discovery info in `~/.agentprism/workflows/daemon.json`.
  - `MAX_BACKGROUND_RUNS` is now a per-project cap shared across sessions. `WorkflowManager`
    exposes `readonly cwd`. `@automatalabs/workflows` re-exports `workflowHomeDir`,
    `workflowProjectKey`, `workflowProjectPaths`, and `WORKFLOW_PROJECTS_SUBDIR`;
    `@automatalabs/mcp-server` exports the daemon building blocks (`createDaemon`, `runShim`,
    `ensureDaemonRunning`, `WorkflowProjectRegistry`, `BoundedEventStore`, `validateRequest`,
    `BackgroundRunRegistry`, …) for hosts that mount the tool on their own transport.

## 0.33.0

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

### Patch Changes

- Updated dependencies [13fe0d7]
  - @automatalabs/shared-types@0.28.0

## 0.32.0

### Minor Changes

- 3d80c62: Persist per-tool results in agent transcripts. Terminal ACP `tool_call_update` notifications
  carrying displayable content now map to a new `tool-result` observability activity
  (`@automatalabs/workflows` adapter) and are published as durable `toolResult` transcript
  entries — redacted and byte-capped like every other transcript record — instead of being
  collapsed into a bare content boundary. Non-terminal and content-less updates keep the
  previous boundary behavior. The run event persistence schema accepts the new entry shape
  (`kind: "toolResult"`, optional `toolName`, optional `isError: true`).

## 0.31.0

### Minor Changes

- d4c6e60: Make incremental resume journal-correspondence based and world-neutral. Completed matching agent
  and checkpoint calls now replay without filesystem-safety annotations or environment-stability
  gates; live calls, nested workflows, host checkpoints, and worktree degradation no longer clear
  unrelated candidates. Current-format crash residue keeps identity replay, and usage/auth recovery
  replays its completed prefix before reattaching the interrupted ACP session. Legacy safety fields
  and reason literals remain readable as diagnostic compatibility metadata, and format-1 interrupted
  sessions use their legacy input fingerprint when crossing into the format-2 engine.

### Patch Changes

- Updated dependencies [d4c6e60]
  - @automatalabs/shared-types@0.27.1

## 0.30.0

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

### Patch Changes

- Updated dependencies [0a56f82]
  - @automatalabs/shared-types@0.27.0

## 0.29.2

### Patch Changes

- 2561f67: Honor durable `checkpointReplies` when resuming a positional (non-`resume`-declared) run. Previously a background run paused at a durable `checkpoint(..., { headless: "pause" })` could not be continued: resuming with `resumeFromRunId` + `checkpointReplies` took the positional fallback, re-ran the whole agent prefix live, re-reached the checkpoint, and re-paused. The recorded reply is now applied after the live prefix, matched to the checkpoint's exact call path-hash so a reply only ever applies to the occurrence it targeted.

  The resume report and the MCP workflow result now surface a `checkpointReply` outcome: `applied` (with the current call index), or `not-applied` with a safe reason (`checkpoint-identity-mismatch` or `checkpoint-not-reached-at-recorded-call-site`). The not-applied report never echoes the supplied decision value.

- Updated dependencies [2561f67]
  - @automatalabs/shared-types@0.26.2

## 0.29.1

### Patch Changes

- 6f47267: Persist terminal-shaped interruption rows for every allocated call when a run halts, and retain non-result identity blockers so completed calls remain safely replayable across usage, auth, checkpoint, and host interruptions.
- Updated dependencies [6f47267]
  - @automatalabs/shared-types@0.26.1

## 0.29.0

### Minor Changes

- 82ede81: Add the executable built-in backend registry and generated dependency manifest, expose recursively
  frozen initialize metadata on session refs and events, preserve generic ACP extension passthrough,
  and document the registry-driven onboarding and routing contract.

### Patch Changes

- Updated dependencies [82ede81]
  - @automatalabs/shared-types@0.26.0

## 0.28.0

### Minor Changes

- 58606fa: Admit resume sources across current-environment and Node/V8 drift while preserving format, manifest, and per-call safety checks. Resume eligibility now reports typed runtime and environment provenance changes through SDK and MCP result surfaces.

### Patch Changes

- Updated dependencies [58606fa]
  - @automatalabs/shared-types@0.25.1

## 0.27.0

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

### Patch Changes

- Updated dependencies [a3d5613]
- Updated dependencies [a3d5613]
- Updated dependencies [a3d5613]
- Updated dependencies [a3d5613]
  - @automatalabs/shared-types@0.25.0

## 0.26.0

### Minor Changes

- 023f552: Continue eligible usage-limit and authentication-paused agent turns from their recorded ACP sessions, with fail-to-fresh gates, durable diagnostics, and MCP output support.

### Patch Changes

- Updated dependencies [023f552]
  - @automatalabs/shared-types@0.24.0

## 0.25.0

### Minor Changes

- aac11d8: Add absolute `scriptPath` delivery, persistence-backed workflow script resources and lineage links, full resource subscription/list-change capabilities, and the `workflow` tool's durable `stop` action. Gate workflow VM execution on durable resource readback, preserve engine-owned content-free resume ancestry across run deletion, expose manager deletion observability for resource consumers, and publish exact structured-output variants.

## 0.24.0

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

- Updated dependencies [2a411c3]
  - @automatalabs/shared-types@0.23.0

## 0.23.0

### Minor Changes

- f93fcf3: Add typed manager event overloads and the lease-owned durable run-event stream: a new per-run
  `.events.jsonl` sidecar, mandatory write-time redaction and record bounds, listener delivery after
  durable append, nested `scope` fields, stream-generation-pinned read/watch cursors, fail-closed
  incomplete-log handling, and lease-protected deletion with no post-delete durable resurrection.

  `stop()` on a warm paused run now reacquires and revalidates the lease-protected snapshot, so it can
  return `false` when a competing process already resumed the run. Post-release execution settlement
  also no longer rewrites the snapshot, preventing stale settlement from clobbering a newer owner.

### Patch Changes

- Updated dependencies [f93fcf3]
  - @automatalabs/shared-types@0.22.0

## 0.22.0

### Minor Changes

- 805b51f: Replace shared error-message matching with adapter-owned structured provider-limit classification, carry typed reset metadata through workflow errors and the top-level SDK, and reserve abort classification for structured cancellation. Closes #149.

### Patch Changes

- Updated dependencies [805b51f]
  - @automatalabs/shared-types@0.21.0

## 0.21.1

### Patch Changes

- 7b00535: Validate nondeterministic workflow APIs from executable AST call nodes so API names in prompts, descriptions, templates, and comments remain valid, and align workflow-validator guidance with the AST-aware behavior.

## 0.21.0

### Minor Changes

- 134dffc: Expose ACP session config options as a verbatim per-call authoring surface, add routed no-prompt
  catalog probing to the runner and workflow validator, and preserve existing replay hash bytes when
  the new option bag is absent or empty.

### Patch Changes

- Updated dependencies [134dffc]
  - @automatalabs/shared-types@0.20.0

## 0.20.0

### Minor Changes

- ef2c64b: Add call identity, per-call manifests and sealed telemetry, honest persisted run typing, budget-trajectory replay, and the backend-neutral isolation runner/report surface.

  This release also includes the complete set of observable behavior fixes made by that substrate:

  1. Throwing terminal observers are now logged and swallowed; they never retry or fail the call.
  2. Agent results and checkpoint replies must be strict-JSON snapshots; lossy values now fail with a typed error instead of being persisted in coerced form.
  3. Journal and event payloads are frozen snapshots, so listener mutation no longer reaches persistence.
  4. For strict-JSON args, persisted `args` is the pre-execution snapshot on all three run-creation paths and the VM receives an independent clone.
  5. Post-terminal events from floated calls are dropped.
  6. The VM compile filename is sanitized.
  7. Sequential nested siblings receive distinct child run IDs, observable at the runner seam and in ACP session metadata.
  8. `agentEnd` and `agentHistory` snapshot rows match by `(scope, callIndex)`, fixing duplicate-label and nested mis-attribution.
  9. Non-strict-JSON args still execute verbatim, but are marked `argsUnreplayable` and refused as isolation baselines; they are not rejected at run time.
  10. Timed-out attempts are actively aborted through a per-attempt signal.
  11. Run-ID starts acquire the lease before checking existence, closing the cross-process overwrite race.

### Patch Changes

- Updated dependencies [ef2c64b]
  - @automatalabs/shared-types@0.19.0

## 0.19.1

### Patch Changes

- c81df46: Replace client-side model matching and modifier handling with deterministic registered-prefix routing and verbatim model selection by the serving ACP harness.

## 0.19.0

### Minor Changes

- f0f30ad: Add replay-neutral `fallbacks` and `checkpointsTaken` observability to terminal workflow results,
  persist both audit trails for cold reads, and expose them in foreground and await MCP outcomes.

### Patch Changes

- Updated dependencies [f0f30ad]
  - @automatalabs/shared-types@0.18.0

## 0.18.0

### Minor Changes

- 86c17a8: Expose each fulfilled `gate()` result's exact last validator verdict, preserve producer and structured-verdict inference in the ambient DSL, support boolean and null verdicts, and refresh the bundled MCP authoring guidance.

## 0.17.0

### Minor Changes

- 7172960: Emit cumulative token-usage snapshots after live attempts and seed background runs with their complete replay journal before initial persistence; carry the replay-safe background lifecycle through the SDK facade; and add MCP background admission, bounded await, terminal outcome reconstruction, and the four-run process-local cap.

## 0.16.0

### Minor Changes

- a4a5397: Add shared workflow run inspection, log-tail, truncation, and journal-attribution contracts; implement the safe engine projector and persisted terminal causes; publish the SDK facade surface; and add the MCP `action: "inspect"` branch with terminal log-tail rendering.

### Patch Changes

- Updated dependencies [a4a5397]
  - @automatalabs/shared-types@0.17.0

## 0.15.0

### Minor Changes

- b256305: Add durable paused checkpoints. Workflows can opt into `headless: "pause"`, expose a non-secret `checkpointContext`, and resume with a journaled `checkpointReplies` decision that survives cold restarts.

  Expose the checkpoint context through the shared and workflows type barrels, persist and classify `CHECKPOINT_REQUIRED` runs in the engine, and add the MCP pause-and-resume wire flow for clients without elicitation.

### Patch Changes

- Updated dependencies [b256305]
  - @automatalabs/shared-types@0.16.0

## 0.14.1

### Patch Changes

- Updated dependencies [754eaab]
  - @automatalabs/shared-types@0.15.0

## 0.14.0

### Minor Changes

- 74623a9: Formalize persisted agent and journal session records and add `getPersistedAgentSessions` so hosts can depend on `AgentSessionRecord` surviving persistence for cold-restart session recovery.

  Re-export the persisted run and agent state types from the workflows SDK facade.

## 0.13.0

### Minor Changes

- 5349c81: Add `resumeInBackground` so hosts can observe when an accepted resumed workflow actually settles.

  Keep per-execution ACP events connected for the full lifetime of resumed SDK runs, then release the bridge after settlement.

## 0.12.0

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

### Patch Changes

- Updated dependencies [b70293b]
- Updated dependencies [fecf517]
  - @automatalabs/shared-types@0.14.0

## 0.11.0

### Minor Changes

- e97b142: Session hand-off from one-shot runs: `run()` now surfaces the ACP session identity out-of-band via `RunOptions.onSessionOpen` (an `AgentSessionRef` — sessionId, backend routing id, cwd, and the agent-advertised `reopen` capabilities), and `keepSession: true` skips the release-time best-effort `session/close` so the agent-persisted session stays re-openable via the existing `runner.loadSession()`/`resumeSession()`. Workflow runs record one `AgentSessionRecord` per live agent() call — on `WorkflowRunResult.agentSessions` (present even with `journaling: false`), in journal entries (restored on resume replay), and on the `agentEnd` event/snapshot — and scripts can opt in per call with `agent(prompt, { keepSession: true })`. `InteractiveSession` gains the same `keepSession` option plus a `sessionRef` getter so held-open sessions can be persisted and re-opened later. Previously the one-shot path discarded the session id at release, making completed agents unrecoverable even though the protocol and agents support re-attach.

### Patch Changes

- Updated dependencies [e97b142]
  - @automatalabs/shared-types@0.13.0

## 0.10.0

### Minor Changes

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

## 0.9.1

### Patch Changes

- 037ba2c: Backfill version bumps for the StructuredOutput tool-injection slice: shared-types gained the optional `WorkflowBackendConfig.structuredOutputTool` field and workflow-engine validates it in script `meta.backends`. Both changes shipped in the repo at v0.19.0 of the SDK but were not version-bumped; this republishes so the published types and validation match source.
- Updated dependencies [037ba2c]
  - @automatalabs/shared-types@0.12.1

## 0.9.0

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
  - @automatalabs/shared-types@0.12.0

## 0.8.2

### Patch Changes

- Updated dependencies [b94b824]
  - @automatalabs/shared-types@0.11.0

## 0.8.1

### Patch Changes

- Updated dependencies [f743d0f]
  - @automatalabs/shared-types@0.10.0

## 0.8.0

### Minor Changes

- 8fea18f: Promote ACP session modes to a driven public surface. Runs and interactive sessions can now request strict agent-advertised modes, mode catalogs stay visible and live-updated, and unsupported or failed mode switches raise non-recoverable validation errors before prompting.

  When a mode is explicitly requested without a permission resolver, the headless permission fallback now defaults to deny so confinement is not bypassed by automatic escalation approval.

  Details: `RunOptions.mode` / `AgentOptions.mode` / `InteractiveSessionOptions.mode`, `SessionHandle.modes`/`setMode()`, `InteractiveSession.modes`/`setMode()`, `ToolPolicy.defaultOutcome`, live `current_mode_update` tracking, and `session/set_mode` flipped to "driven" in the coverage manifest. Resume compatibility: `mode` joins the journal identity hash ONLY when set, so journals written before session modes existed keep replaying for mode-less calls.

### Patch Changes

- Updated dependencies [8fea18f]
  - @automatalabs/shared-types@0.9.0

## 0.7.0

### Minor Changes

- efa034a: Per-run `cwd` on `ExecOptions` — the missing piece for worktree-per-run hosts. `startInBackground(script, args, { cwd })` / `runSync(...)` now run every subagent ACP session in that directory, overriding the manager's constructor `cwd` (which remains the key for run STATE, so `listRuns()`/`resume()` survive the run directory's deletion). The per-run cwd is persisted with the run and `resume()` re-runs in the SAME directory (e.g. the same worktree) unless explicitly overridden — confinement no longer rides on every script remembering `agent({ cwd })`. Also ships `docs/api.md`, the API reference covering the manager surface (options, ExecOptions, lifecycle, events + payload shapes), the runner surface (RunOptions, model routing, event bus, interactive sessions, capabilities), backend resolution + environment variables, and the WorkflowError code table.

## 0.6.0

### Minor Changes

- cd20994: Script crashes are now labeled `SCRIPT_ERROR`, and a run-scoped `unhandledRejection` tripwire contains floating script promises (WE-3 embedding safety).

  - New `WorkflowErrorCode.SCRIPT_ERROR`: an uncaught throw or unhandled promise rejection inside the script body. Previously a script crash surfaced as `WORKFLOW_ABORTED` (`recoverable: true`) — wrong on both counts: nobody cancelled anything, and rerunning a deterministic crash crashes again. `WORKFLOW_ABORTED` is now reserved for actual cancellation; a bare error at the manager layer falls back to `UNKNOWN`.
  - Rejection tripwire: every promise the script can float is attributable to its run by REALM identity — script-created promises natively, engine-returned promises because `agent()`/`parallel()`/etc. are adopted into the script's realm at the context boundary (bonus: `agent(...) instanceof Promise` is now true inside scripts), and `.then()` chains off either. A tripped run fails with `SCRIPT_ERROR` ("Unhandled promise rejection in workflow script: …"), its in-flight agents are cancelled through a run-scoped fault signal so a zombie script stops spending tokens, and a one-macrotask drain after script completion catches trailing floats. Rejections no active realm owns preserve platform semantics: a host `unhandledRejection` listener stays in charge; with no host listener the reason is rethrown so the process fails exactly as it would have without the tripwire.

### Patch Changes

- cd20994: Integrator hygiene: `recoverStaleRuns()` is now gated on the manager's `journaling` default — a `journaling: false` WorkflowManager (host keeps its own transcript/audit store) never rewrites persisted run state that belongs to journaling processes. All five published manifests now declare `engines.node >= 22` (previously only the private workspace root did).
- Updated dependencies [cd20994]
- Updated dependencies [cd20994]
  - @automatalabs/shared-types@0.8.0

## 0.5.0

### Minor Changes

- 1597c87: Fix: the run's base cwd (`WorkflowRunOptions.cwd` / `WorkflowManagerOptions.cwd`) now reaches every subagent ACP session. Previously the engine only passed a session cwd for worktree-isolated agents, so non-isolated agents silently ran in the HOST process's cwd — wrong whenever the embedder's process does not live at the project root. Precedence: worktree isolation > per-agent `agent({ cwd })` (new `AgentOptions.cwd`; relative resolves against the run cwd) > run cwd > `process.cwd()`. Like `mcpServers`, cwd is additive — never part of the resume identity hash. The SDK exposes it as `runDynamicWorkflow(script, { cwd })`.

### Patch Changes

- 1597c87: Fix: `onProgress` snapshots now carry live derived counters. The manager's mutation sites only push/patch `snapshot.agents`, so `agentCount`/`runningCount`/`doneCount`/`errorCount` stayed frozen at their initial 0s and every consumer rendered "0/0 agents" for the whole run (the MCP shell was silently working around it by re-deriving counts from `agents[]`). The manager now recomputes the counters (via `recomputeWorkflowSnapshot`) before every emission.

## 0.4.0

### Minor Changes

- dab0568: Integrator surface, milestone 3: live event forwarding, embeddable persistence, and script-fault guarantees.

  - **`agentEvent` live stream** (`@automatalabs/workflows` WorkflowManager): every runner ACP event — streaming text, tool calls, permissions (including the parked `permission_pending` phase), session lifecycle — is forwarded through the manager as `agentEvent { name, event, sessionId, backendId, label?, runId? }`, so hosts can render live progress per agent. Bridged runners are reference-counted: per-exec runners unsubscribe when their run settles; the manager's own runner unsubscribes on `dispose()`.
  - **Manager events are now uniformly best-effort**: a throwing host observer on ANY manager event (`agentStart`, `log`, `agentEvent`, …) is isolated and can never fail, pause, or mask cleanup for a run.
  - **`persistenceRoot` option** (+ `AGENTPRISM_PERSISTENCE_ROOT` env; precedence option > env > home default) relocates run state + logs to a host-chosen root, resolved exactly once at manager construction. **`journaling: false`** (manager-wide or per-exec) skips journal/log/run-state writes for hosts that keep their own transcript store — resume for such runs fails with a legible "journaling disabled" error (explicit trade-off), while run leases (cross-process double-execution protection) and on-disk run listing are unaffected.
  - **Script-fault containment pinned by tests**: an uncaught throw in a workflow script — sync `Error`, thrown string, thrown object (including throwing `message` getters and circular objects), or post-`await` rejection — always surfaces as a `failed` result with a legible reason, releases the run lease, and never escapes as an unhandled rejection (direct and `startInBackground` paths).

## 0.3.2

### Patch Changes

- Updated dependencies [96c6429]
  - @automatalabs/shared-types@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [e560e70]
  - @automatalabs/shared-types@0.6.0

## 0.3.0

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

## 0.2.0

### Minor Changes

- 3395bbf: Custom ACP backends + generic `_meta` passthrough — run **any** ACP agent as an `agent()` target, not just the built-in Claude/Codex pair.

  - **Backend registry**: register named ACP backends via `createAcpRunner({ backends: { name: { command, args?, env?, sessionMeta? } } })` or the `AGENTPRISM_BACKENDS` env var (JSON, same shape; the programmatic option wins per name; `claude`/`codex` reserved). Registered names route `model`/`tier` specs **before** the built-in heuristics: `model: "browser"` routes to the backend; `model: "browser/vision-large"` additionally selects `vision-large` from the agent's config-option catalog. `AGENTPRISM_DEFAULT_BACKEND` may name a registered backend. Custom backends speak the published generic dialect: a `schema` is forwarded as turn-level `_meta.outputSchema` (plain JSON Schema) and the result is JSON-parsed off the final assistant message, with the client-side validate/re-prompt ladder as the repair path.
  - **Generic `_meta` passthrough**: `RunOptions.meta` / `RunOptions.promptMeta` (script-level `agent(p, { meta, promptMeta })`) merge into the outgoing ACP `session/new` / `session/prompt` `_meta`, so workflows can drive any ACP agent's custom extension surface. Precedence: a custom backend's static `sessionMeta` defaults < per-call `meta` < backend protocol-critical keys (schema channels, Codex instruction forwards) < the engine `runId` stamp. Both fields are additive run inputs and never enter the resume identity hash — resume keys stay stable across meta changes.

### Patch Changes

- Updated dependencies [3395bbf]
  - @automatalabs/shared-types@0.4.0

## 0.1.5

### Patch Changes

- Updated dependencies [087e566]
  - @automatalabs/shared-types@0.3.1

## 0.1.4

### Patch Changes

- Updated dependencies [f2948b3]
  - @automatalabs/shared-types@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [93e4906]
  - @automatalabs/shared-types@0.2.0

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
