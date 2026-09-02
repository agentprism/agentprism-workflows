# @automatalabs/mcp-server

## 1.0.1

### Patch Changes

- 5764dba: Improve agent-facing workflow lifecycle guidance: distinguish conservative fallback routing from actual model-less calls, label resume admission predictions separately from observed replay, render durable latest activity in status text, suggest exact routed models after failed probes, and add a compact run/status/result/resume quickstart.

## 1.0.0

### Major Changes

- c562237: Remove model-facing agent execution timeout fields, idle-watchdog callbacks, and timeout error codes from the shared runtime contract.

  Remove total-wall and idle agent timers from workflow execution while preserving explicit call and run cancellation and compatibility reads for historical timeout records.

  Remove the ACP runner activity/interaction callbacks that existed only to drive the engine idle watchdog.

  Remove agent execution limits and configurable config-probe timing from the workflow SDK surface.

  Remove agent and probe timeout inputs and timeout projections from the MCP workflow tool schema and status output.

- c562237: Publish the workflow tool as a strict seven-action discriminated JSON Schema whose runtime validator rejects cross-action fields, while retaining unadvertised migration normalization for omitted-action run and retired inspect/await requests.

### Minor Changes

- c562237: Consolidate workflow run observation under the canonical `status` action with optional request-bounded `waitMs`, while normalizing legacy `inspect` and `await` requests during migration.
- c562237: Add the stored-content workflow resume action and allow completed calls from supported aborted source recordings to replay.
- c562237: Remove obsolete workflow token-budget and debit metadata from current SDK and MCP limits, call records, resume provenance and reports, durable events, and isolation admission. Historical persisted fields remain readable as ignored compatibility input, while provider usage telemetry remains available.
- c562237: Expose each durable workflow events URI and labelled resource link on admitted and observable runs, and add bounded per-call latest activity to status without copying the detailed transcript into tool results.

### Patch Changes

- c562237: Stop advertising the events resource for integrity-unsafe runs. A run whose journal append faulted mid-run persists `eventLogIncomplete` and its event read/watch seam fails closed, so `eventsUri`, the labelled events resource link, `latestActivity`, and the events resource listing now omit it — matching the existing legacy/stream-less and durable-stop handling — while status, result, and the immutable snapshot stay available.
- Updated dependencies [c562237]
- Updated dependencies [c562237]
  - @automatalabs/shared-types@1.0.0
  - @automatalabs/workflows@1.0.0
  - @automatalabs/repl-engine@0.4.14

## 0.38.2

### Patch Changes

- @automatalabs/repl-engine@0.4.13
- @automatalabs/workflows@0.58.1

## 0.38.1

### Patch Changes

- cc8306d: Expose completed workflow outputs through durable exact result resources, content-first text compatibility for small results, and bounded UTF-8 result paging for large outputs.

## 0.38.0

### Minor Changes

- 06725fd: Add live workflow permission brokering and explicit first-class mode defaults. MCP inspect/await now expose pending ACP permission requests through a credential-redacted 64 KiB projection that omits private session ids while preserving the complete ordered exact option set or failing closed. Elicitation-capable clients can answer those options, and other clients can use the new `permissions-response` action; public responses forbid caller metadata and route to the daemon generation that owns execution. Permission waits suspend idle detection without stopping the total-wall clock. Config output now preserves harness mode names, descriptions, metadata, and reports the AgentPrism defaults (`auto`, `agent`, `build`, or none). Replace the inaccurate permission-persistence helpers with exact advertised-option selection while retaining deprecated source-compatible shims.

### Patch Changes

- Updated dependencies [06725fd]
  - @automatalabs/shared-types@0.34.0
  - @automatalabs/workflows@0.58.0
  - @automatalabs/repl-engine@0.4.12

## 0.37.1

### Patch Changes

- @automatalabs/repl-engine@0.4.11
- @automatalabs/workflows@0.57.1

## 0.37.0

### Minor Changes

- 1452e15: Add an opt-in per-attempt idle watchdog that resets on real backend activity, cancels wedged turns through the existing wind-down path, retries with a fresh clock, and reports `AGENT_IDLE_TIMEOUT` distinctly across SDK, persistence, inspection, and MCP surfaces.

### Patch Changes

- Updated dependencies [1452e15]
  - @automatalabs/shared-types@0.33.0
  - @automatalabs/workflows@0.57.0
  - @automatalabs/repl-engine@0.4.10

## 0.36.0

### Minor Changes

- 661d9d1: Keep workflow run control reachable across daemon version succession. Run leases now expose opaque owner identity, managers can safely cold-stop lease-free persisted runs, and daemon successors persist and forward authenticated stop/cancel operations to predecessor execution owners with an explicit fenced force escalation.

  Update the embedded Pi runtime packages to 0.84.4. The release changes an unused agent-loop hook ordering and otherwise delivers compatible session, compaction, provider-stream, and Windows abort fixes; the provider error-classification strings remain unchanged.

### Patch Changes

- Updated dependencies [661d9d1]
  - @automatalabs/workflows@0.56.0
  - @automatalabs/repl-engine@0.4.9

## 0.35.0

### Minor Changes

- 2e87092: Automatically select and persist a no-prompt readiness-based default backend for model-less MCP workflow calls when no operator default is configured. Add host-pinned `defaultModel` execution/validation support and a probe-free mock routing-discovery option.

### Patch Changes

- Updated dependencies [2e87092]
  - @automatalabs/workflows@0.55.0
  - @automatalabs/repl-engine@0.4.8

## 0.34.1

### Patch Changes

- @automatalabs/repl-engine@0.4.7
- @automatalabs/workflows@0.54.1

## 0.34.0

### Minor Changes

- 6821b31: Migrate the MCP server to the official split TypeScript SDK v2 packages and serve both the legacy 2025 protocol and modern `2026-07-28` protocol. Preserve sessionful legacy daemon behavior while adding SDK-native HTTP/stdio era negotiation, modern multi-round-trip checkpoint and backend approval handling, subscriptions, request-scoped Apps capability projection, and restart-safe request-state verification.

  Add the workflow-engine `pauseOnCheckpoint` host seam so protocol adapters can turn a live checkpoint into the existing durable checkpoint/resume flow without changing authored headless behavior. Expose the optional checkpoint `timeoutMs` through shared checkpoint context and MCP result/event projections.

  Refresh the wrapped Claude Agent SDK runtime to 0.3.250; 0.3.249 and 0.3.250 are parity-only releases with no integrated API or wire changes.

### Patch Changes

- Updated dependencies [6821b31]
  - @automatalabs/shared-types@0.32.0
  - @automatalabs/workflows@0.54.0
  - @automatalabs/repl-engine@0.4.6

## 0.33.3

### Patch Changes

- 3faed31: Validate the official legacy MCP Apps client capability shape before exposing the run-monitor surface, reject experimental or malformed lookalikes, and document the boundary between legacy initialize negotiation and the separately gated modern `server/discover` path.

## 0.33.2

### Patch Changes

- 9ddec60: Update the monolithic Model Context Protocol TypeScript SDK to 1.30.0, MCP Apps to 1.7.5, the workspace Zod floor to 4.2, and the wrapped Claude Agent SDK runtime to 0.3.248 before the separately gated SDK v2 migration.
  - @automatalabs/repl-engine@0.4.5
  - @automatalabs/workflows@0.53.2

## 0.33.1

### Patch Changes

- @automatalabs/repl-engine@0.4.4
- @automatalabs/workflows@0.53.1

## 0.33.0

### Minor Changes

- ea0b68c: Add a model-facing `docs` tool that returns version-matched workflow and REPL authoring documentation one bounded topic at a time as an embedded MCP resource, with byte-identical static resources and a compact index. Decouple the server from the optional authoring skill and replace the giant `author-workflow` prompt injection with selective topic guidance.

### Patch Changes

- ea0b68c: Make agent configuration fail closed and fully discoverable. Config probes now return effective ACP session modes, including config-option fallback normalization and explicit `null` for unsupported modes; workflow preflight rejects guessed or unadvertised modes before admission. Workflow `agent()` rejects unknown option keys before allocation, while REPL rejects reserved `configOptions.model` with modelSpec-native guidance and preserves independent mode failures instead of falsely blaming carried config keys. Static external MCP resources now accept subscribe/unsubscribe as no-ops.
- Updated dependencies [ea0b68c]
- Updated dependencies [ea0b68c]
  - @automatalabs/workflows@0.53.0
  - @automatalabs/repl-engine@0.4.3

## 0.32.1

### Patch Changes

- affc0fe: Document the exact `meta.phases` entry shape in the MCP tool-local authoring contract and return indexed, actionable parser diagnostics for invalid phase metadata.
  - @automatalabs/workflows@0.52.1
  - @automatalabs/repl-engine@0.4.2

## 0.32.0

### Minor Changes

- de4e704: Make the workflow MCP surface self-contained: add protocol-native live backend/config discovery, automatically run zero-token static and mocked validation before admission, return bounded structured rejection diagnostics without creating a run, and publish compact DSL guidance directly in the tool description and bundled authoring prompt. Reuse the server's live ACP runner for probes, including approved run-scoped backend definitions, without disposing host-owned runners.

### Patch Changes

- Updated dependencies [de4e704]
  - @automatalabs/workflows@0.52.0
  - @automatalabs/repl-engine@0.4.1

## 0.31.0

### Minor Changes

- 4be0807: Replace the REPL's state-dependent `followUp`/steering behavior with strict active-turn steering and durable queued turns. Agent handles now expose `steer`, `queue`, and `cancel`; `followUp` is removed. `steer` never starts or queues work and resolves only `injected`, `idle`, or `unsupported`. `queue` creates an independently awaitable, addressable FIFO turn on the same ACP session with exact cancellation, persistence, restore, and concurrency semantics.

  Make ACP extension metadata transport transparent. `customCapabilities` metadata gates and the derived steering/loaded-turn capability booleans are removed. Interactive steering returns the complete raw extension response, prompt turns expose their underlying `PromptResponse`, and extension owners interpret raw initialize metadata at the point of use.

  Pi ACP and Codex ACP now implement strict active-turn steering only. Idle or settlement-raced steering returns `promptRequired/noRunningTurn`; steering can no longer create a backend turn. REPL guest snapshots and call ledgers from the previous format are intentionally invalidated and auto-reset without executing old guest code.

### Patch Changes

- Updated dependencies [4be0807]
  - @automatalabs/repl-engine@0.4.0
  - @automatalabs/workflows@0.51.0

## 0.30.1

### Patch Changes

- @automatalabs/repl-engine@0.3.4
- @automatalabs/workflows@0.50.1

## 0.30.0

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

- 0cf5bc5: Daemon lifecycle: superseded daemons now actually exit, and the two distributions of the server stop superseding each other.

  - **One identity for one code version.** `@automatalabs/workflows`' bundled `mcp-server.js` reported the _workflows_ package version as the server version (its `require("../package.json")` resolved the wrong manifest), so a client using `npx @automatalabs/workflows` and one using `@automatalabs/mcp-server` saw each other's daemon as "stale" and superseded it on every connect — leaving a lame-duck daemon behind each time. The bundle now bakes in the mcp-server version at build time (`__AGENTPRISM_MCP_SERVER_VERSION__`).
  - **Version is a total order.** A shim supersedes only a daemon strictly _older_ than itself and adopts an equal or newer one, so an old client migrating off a lame duck can never resurrect its old code and flip discovery back.
  - **Env families instead of env supersession.** Clients are keyed by their env fingerprint (`~/.agentprism/workflows/daemons/<fingerprint>.json`, plus `instances/<pid>.json` per live daemon); different env → different daemon, never contending.
  - **Lame ducks drain and exit.** A superseded daemon closes its idle sessions (their shims transparently re-initialize on the successor; sessions with a request in flight, an active run, or a REPL workspace mid-turn are kept), and exits on the next reaper tick once nothing is busy — it no longer waits for the idle TTL, even when idle shutdown is disabled.
  - **Dead-client sessions are collected in 5 minutes** (`AGENTPRISM_SESSION_TTL_MS`, was 2 h); the REPL client-presence drain keeps its 2 h bound under its own knob, `AGENTPRISM_REPL_DRAIN_BOUND_MS`.
  - **Shim recovery.** A lame duck's 503, the 404 of a closed session, a network error, or the standalone GET stream failing all take the same recovery path, now triggered proactively (not only on the client's next frame). Requests that were in flight when their session was lost are answered with a JSON-RPC error instead of hanging the host forever; recovery that loops is rate-limited.
  - **Ops.** `daemon status` lists every daemon on the machine (current, draining, other env families, legacy `daemon.json` ones) with in-flight request counts; `daemon stop --all` stops them all; a successor honours an explicit `--port`; the "port taken by another process" log names a draining daemon of ours when that is what holds it.

### Patch Changes

- Updated dependencies [205d110]
- Updated dependencies [0cf5bc5]
  - @automatalabs/workflows@0.50.0
  - @automatalabs/shared-types@0.31.0
  - @automatalabs/repl-engine@0.3.3

## 0.29.2

### Patch Changes

- c90fef0: `config` / `validate`: summarize oversized model catalogs instead of dumping them, and add
  `config <harness> --models[=<filter>]` to reach the leaves.

  Harnesses with large model catalogs (pi and opencode advertise hundreds) were printing every model
  id inline in the `config` / `validate` option tables — and in `--json` — which floods an authoring
  agent's context. Now any select option above 24 leaf choices (in practice the `model` option) is
  rendered as a grouped summary (total + per-provider/group counts) on BOTH the human table and
  `--json`; small catalogs (claude, codex, and every effort/mode/boolean option) are unchanged and
  print verbatim. The grouping uses the harness-advertised optgroup names when present, else the model
  id's first `/`-segment.

  The full list is reachable only through the new `--models` flag: `config <harness> --models` prints
  the provider/group breakdown (no leaf ids), and `config <harness> --models=<provider|substring|/regex/>`
  prints the matching leaf ids. There is deliberately no unfiltered full-leaf dump on any surface, so
  neither `--json` nor `--models` can flood context. The in-memory report and the programmatic
  `probeHarnessConfig()` / `validateWorkflowScript()` returns stay complete — the collapse happens only
  at the CLI print boundary — so `configOptions` validation still checks against every advertised model.

- Updated dependencies [c90fef0]
  - @automatalabs/workflows@0.49.0
  - @automatalabs/repl-engine@0.3.2

## 0.29.1

### Patch Changes

- @automatalabs/repl-engine@0.3.1
- @automatalabs/workflows@0.48.1

## 0.29.0

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

### Patch Changes

- Updated dependencies [c4c5a09]
  - @automatalabs/repl-engine@0.3.0
  - @automatalabs/workflows@0.48.0

## 0.28.4

### Patch Changes

- @automatalabs/repl-engine@0.2.4
- @automatalabs/workflows@0.47.6

## 0.28.3

### Patch Changes

- Updated dependencies [4f18373]
  - @automatalabs/shared-types@0.30.0
  - @automatalabs/repl-engine@0.2.3
  - @automatalabs/workflows@0.47.5

## 0.28.2

### Patch Changes

- @automatalabs/repl-engine@0.2.2
- @automatalabs/workflows@0.47.4

## 0.28.1

### Patch Changes

- @automatalabs/repl-engine@0.2.1
- @automatalabs/workflows@0.47.3

## 0.28.0

### Minor Changes

- 0ddce7b: mcp-server: add tool-use instructions and server instructions.

  The `repl` tool description now explains how a calling agent writes the eval `code`: the in-VM bridge (`agent()`, `checkpoint()`/`checkpoint.answer()`, `console` with addressable `$N` slices, handle methods `followUp`/`steer`/`cancel`), the guest library (`parallel`/`pipeline`/`verify`/`judgePanel`/`gate`/`retry`/`loopUntilDry`), started-not-awaited handles, stable call ids, and the `eval`/`wait`/`status`/`interrupt`/`reset` loop — alongside the existing persistence/reconciliation notes.

  The server now returns MCP `instructions` in its initialize response, orienting a host/agent to the two model-facing tools and when to reach for each: `workflow` for deterministic, resumable batch orchestration and `repl` for interactive, stateful orchestration.

### Patch Changes

- 0ddce7b: repl: emit `console.log` output and eval results up to the result byte budget instead of clamping every string to a 200-char preview.

  A directly emitted top-level string — a `console.log` argument or the eval result — is output the orchestrator asked to see, not a preview of a value's shape, so it is now carried whole up to the byte budget ("200 chars OR the KB max, whichever is greater") rather than head/tail-elided at 200 characters. A subagent's answer comes back whole in one call instead of forcing creative slice-by-slice extraction. The tool-result caps rise to **4000 lines / 50 KB** (from 256 / 10 KB), so a multi-line answer fits; only strings past the budget head/tail-elide (keeping their `$N` ref for the remainder). Nested and property strings are unchanged — they stay preview-short.

- Updated dependencies [0ddce7b]
- Updated dependencies [0ddce7b]
  - @automatalabs/repl-engine@0.2.0
  - @automatalabs/workflows@0.47.2

## 0.27.1

### Patch Changes

- 217ba32: Fix a race that could leave a freshly connected client with no `workflow` tool.

  Registration was gated on `notifications/initialized`, but a notification carries no
  ordering guarantee against the requests that follow it — and over the stdio shim each
  frame becomes its own HTTP POST to the daemon. A client that pipelined `initialized` with
  its first `tools/list` or `tools/call` could reach a server with nothing registered,
  surfacing as an empty tool list or a tool-not-found result on the first call.

  The `workflow` tool is now registered at server construction, so it exists for the whole
  life of the session. Capability negotiation is unchanged for the MCP Apps surface: the
  panel resource, the app-only `workflow-events` tool, and the tool's UI metadata are still
  added only for a client that advertised `io.modelcontextprotocol/ui`, and the resulting
  `tools/list_changed` prompts a capable client to re-list.

  The shim now also forwards client frames in the order they were sent; previously each
  frame was dispatched without sequencing, so consecutive frames could race as concurrent
  POSTs and arrive out of order.

- Updated dependencies [217ba32]
  - @automatalabs/workflows@0.47.1
  - @automatalabs/repl-engine@0.1.8

## 0.27.0

### Minor Changes

- 4a7e4b5: Run-monitor panel rebuilt on the MCP Apps negotiation model: UI-enabled registration
  (the panel resource, the workflow tool's UI metadata, and the app-only workflow-events
  tool) now requires the client to advertise the io.modelcontextprotocol/ui extension
  capability; all other clients get the identical text-only workflow tool. The panel
  updates itself by polling the app-only workflow-events tool (the spec's Interactive
  Updates pattern) and informs the model via ui/message for exactly three event families:
  phase changes, pauses (permission/attention needed), and terminal states.

### Patch Changes

- Updated dependencies [4a7e4b5]
  - @automatalabs/workflows@0.47.0
  - @automatalabs/repl-engine@0.1.7

## 0.26.7

### Patch Changes

- d4a0682: Revert the run-monitor panel pi push-channel change that shipped in
  mcp-server@0.26.6 / workflows@0.46.9 (owner decision: wrong implementation;
  a spec-compliant approach to app-resource-less hosts will follow). Restores
  the prior panel read path.
- Updated dependencies [d4a0682]
  - @automatalabs/workflows@0.46.10
  - @automatalabs/repl-engine@0.1.6

## 0.26.6

### Patch Changes

- f44d3dd: Run-monitor panel: live updates on pi via its native server→app push channel, and graceful behavior
  on hosts that do not serve app-originated resource reads.

  pi's MCP-Apps host bridge never implemented `resources/read` for app-originated requests (it answers
  with JSON-RPC `-32601`), so the panel's event-poll resource read cannot work there. Instead of
  degrading into a permanent "reconnecting…"/"disconnected" latch, the panel now resolves a live-update
  channel per host:

  - **pi (eager stream)** — the `workflow` (and app-only `workflow-events`) tool declares
    `_meta.ui["pi-mcp-adapter.streamMode"] = "eager"`. pi then stamps a per-call stream token onto the
    `tools/call`; the server reads it and pushes cursor-bearing, self-contained event windows to the
    panel as `notifications/pi-mcp-adapter/result-patch` frames (an initial checkpoint baseline, live
    patches with periodic checkpoint resync baselines, and a single terminal frame). The panel folds
    the pushed windows into the same model the resource poll feeds, handling out-of-order delivery and
    replay. This channel is invisible to the host: no narration, no agent turn, and no app-originated
    tool polling.
  - **resource-capable hosts** — unchanged. The events resource poll remains the primary channel and is
    byte-for-byte identical where reads succeed.
  - **hosts with neither** — the panel classifies the `-32601` read failure as a permanent host property
    (never a transient fault), stops polling for good, and renders an honest "live updates aren't
    supported by this host" state seeded from the tool delivery — never the reconnect spinner. The
    DetailView script read degrades the same graceful way.

  Also: a truly-unknown run's events read now carries a matchable `RUN_NOT_FOUND` token so the panel
  routes it to its fatal path immediately instead of spinning ~42s; reads for runs that do exist are
  untouched.

  - @automatalabs/repl-engine@0.1.5
  - @automatalabs/workflows@0.46.9

## 0.26.5

### Patch Changes

- @automatalabs/repl-engine@0.1.4
- @automatalabs/workflows@0.46.8

## 0.26.4

### Patch Changes

- 1a2f27d: Generate the run-monitor MCP App panel at build time instead of committing it.

  `packages/mcp-server/src/generated/run-monitor-html.ts` (the Vite single-file build of the
  `ui://` run-monitor panel, exported as `RUN_MONITOR_HTML`) is no longer checked in — it is a build
  product, now gitignored and produced by a single shared, idempotent generator
  (`scripts/ensure-run-monitor-html.mjs`). The package's `build`, `test`, `typecheck`, and
  `prepublishOnly` scripts each run the generator first, and the root `postinstall` runs it too, so a
  pristine checkout, a cold `test`/`typecheck`, and the publish path all get a correct artifact with
  no manual `build:ui` step. The generator rebuilds only when the UI sources change (content-hash
  staleness check) and no-ops otherwise. `build:ui` remains as a force-rebuild convenience.

  No user-facing behavior change: the served resource content and its `ui://agentprism-workflow/run-monitor.html`
  URI are unchanged. This removes a staleness footgun where the committed panel could drift from the
  UI sources because nothing in the build, publish, or CI paths regenerated it.

- Updated dependencies [1a2f27d]
  - @automatalabs/workflows@0.46.7
  - @automatalabs/repl-engine@0.1.3

## 0.26.3

### Patch Changes

- dbddbce: Give the bounded `await` drain loop an in-loop deadline check.

  `waitForTerminal` relied solely on a `setTimeout(waitMs)` to end a bounded `await`. When the event
  watcher's catch-up monopolized the event loop, that timer could not fire and the `await` overran
  its `waitMs` badly. The catch-up itself is now bounded (see `@automatalabs/workflow-engine`), and
  the drain loop additionally checks the deadline each iteration, so the `await` returns within its
  bound even if the timer callback is briefly starved. Adds an automated `/healthz`-under-drain
  acceptance test on a real daemon at the ≥20,000-record / ≥5,000-record-lag magnitude. No contract
  change.

- f7d5c61: Daemon succession: new clients supersede a stale daemon, and stale daemons drain and exit.

  Previously, when a stdio shim's version/env fingerprint diverged from the live daemon, it
  restarted the daemon only while it was idle; a **busy** divergent daemon was adopted with just
  a warning. Because every new client added a session and reset the daemon's idle clock, new
  clients were precisely what kept a superseded daemon alive — so it never died and served
  out-of-date code to those clients indefinitely.

  Now a shim whose fingerprint diverges from the live daemon **never adopts it** (busy or idle).
  It spawns a current-version successor on an ephemeral port, atomically repoints `daemon.json`
  at the successor, and connects there. The superseded daemon — whose pid no longer matches
  `daemon.json` — becomes a **lame duck**: it rejects new MCP sessions at admission with a clear
  error, keeps serving its existing sessions and running workflows to completion, and exits once
  idle within the existing idle-TTL bound (lame-duck status neither resets nor extends the TTL).
  If discovery is ever repointed back at it, it resumes normal service.

  `/healthz` (and `daemon status`) now report the daemon's `version` and `lameDuck` status, and
  the shim logs succession loudly (old version/pid → new version/pid, with the reason). The
  divergent-but-busy adoption warning is gone because the adoption path is gone. Split-brain
  safety is unchanged: the pid-guarded `daemon.json` and per-run leases keep two live daemons
  over one run store safe, and the successor never disturbs the predecessor's in-flight runs or
  sessions.

  - @automatalabs/workflows@0.46.6
  - @automatalabs/repl-engine@0.1.2

## 0.26.2

### Patch Changes

- 9fc2c65: Run-monitor panel: quieter, self-terminating live polling.

  - The panel now stays live by **reading the events resource** (`workflow://runs/{runId}/events?after=N&limit=M&streamId=S`) instead of calling the app-only `workflow-events` tool. Some Apps-capable hosts narrate every app-originated `tools/call` into the model's conversation but leave resource reads silent, so a 2s poll was flooding an affected agent's turn with no-op echoes. The `workflow-events` tool stays registered with an unchanged contract for other clients; only the panel's transport changed.
  - **Adaptive idle backoff**: a poll that brings no new events doubles the next delay (2s → 4s → 8s → 15s cap) and resets to 2s the moment new events arrive; `hasMore` catch-up pages still reschedule immediately.
  - **Dead-run reconciliation on the events read path**: `readEventsPage`/`readEventsTail` now reconcile a run orphaned by a dead daemon (the same seam `workflow` action `await`/`stop` already use), so a run left `status: "running"` with a frozen journal flips to a finalized state and the panel stops polling it forever.
  - **Bounded error retries**: after a bounded run of consecutive read faults the panel gives up for good and renders a disconnected/stale state instead of retrying a long-gone run at the backoff cap indefinitely.
  - **Deferred first model-context push**: the panel holds every `ui/update-model-context` push until it has folded at least one events page, so it no longer pushes an empty seed snapshot (workflow name falling back to "workflow", agents-settled 0/0) before real data lands.
  - Added `annotations: { readOnlyHint: true }` to the `workflow-events` tool registration. This is metadata only — it lets hosts that gate on the hint treat the tool as read-only (e.g. VS Code skips its pre-run confirmation; ChatGPT dev mode stops classifying it as a write action). It does not change how any host narrates app-originated calls.

## 0.26.1

### Patch Changes

- Updated dependencies [c6a896c]
  - @automatalabs/workflows@0.46.5
  - @automatalabs/repl-engine@0.1.1

## 0.26.0

### Minor Changes

- acc4b6b: REPL orchestrator phase E: the `repl` tool's daemon-boundary suite — the tool registered alongside `workflow` exercised against a REAL daemon instance (`createDaemon` on an ephemeral loopback port with StreamableHTTPClientTransport clients, the `_http-harness` pattern).

  - **Tool schema**: `repl` advertises exactly the doc's action enum (`eval` / `wait` / `status` / `interrupt` / `reset`) and field set on the wire — snapshotting stays implicit, there is no user-facing snapshot action; `projectDir` must be absolute; `timeoutMs` is bounded to [0, 120 000].
  - **Daemon-mode actions**: projectDir is required on the shared daemon for every stateful action; eval / wait / status / interrupt / reset round-trip over HTTP; wait is bounded ("still running" on timeout) and absorbs a mid-wait backend settlement; a named `status` is a first touch exactly like the other stateful actions (restore/reconcile included); status without projectDir lists every known context and never creates one.
  - **Project keying**: two projectDirs on one daemon are fully isolated — separate VMs, separate per-project `repl/` stores (one enveloped snapshot each), and a `reset` of one never touches the other.
  - **MCP-session churn**: a client disconnect + fresh-client reconnect never touches the workspace — bindings stay live in the VM.
  - **Lifecycle drain via the session registry**: last-client disconnect (the daemon's `onLastConnectionClosed`) drains the in-flight subagent turn to completion, closes the idle child, and the next connect's `followUp` lazily re-attaches the recorded backend session (`loadSession` with the same session id).
  - **Output caps on the wire**: an eval-through-MCP round trip applies the doc's 256-line / 10 KB caps (whichever trips first) to the tool result, and the `$N` refs the kept lines carry reach the truncated values in later evals (the cap costs reads, never data).

- 529e954: REPL orchestrator phase-E review fixes (daemon/tool side):

  - **Interrupt breaks the RUNNING eval**: `interrupt` without an id is now described and exercised as interrupting the in-flight eval — the armed signal is consumed by the running eval's execution (a suspended eval's continuation is broken by the quickjs interrupt handler when it runs; a later eval is unaffected), while a synchronous top-level runaway stays bounded by the per-eval deadline (the daemon is single-threaded; the deadline makes a currently-running runaway always breakable).
  - **Connection-open presence**: the session registry now signals `onConnectionOpened` (and `onSessionDeleted`) alongside `onLastConnectionClosed`, and the daemon wires them to the REPL presence ledger. The ledger RETAINS a session's project affinity across a transient last-connection drop, so a reconnect of the SAME live session re-adds its presence without a new tool call — the already-scheduled drain aborts and children stay warm while the client is connected. A session deletion drops the affinity (a re-initialized client carries a new session id).
  - **Reset keeps presence**: `reset` no longer clears the project's client set — presence is connection liveness, not workspace state, and clearing it desynced the state from the ledger (a resetting client's later disconnect could drain post-reset work while another project client was still connected). The drain decision reads the ledger's own per-project set.
  - **Output caps on the FINAL result**: the doc's 256-line / 10 KB caps (whichever trips first) now apply to the assembled tool result — console lines, the result line, pending ids, checkpoints, completed ids, the wait timeout note, and status output — with a truncation marker that always ships (its budget reserved inside the caps). Metadata-heavy results are capped too.

- 142a23e: REPL orchestrator phase D, review round 6 at the daemon boundary: the client-presence drain aborts when a client reconnects mid-drain (children stay warm), and a failed drain is surfaced loudly and retained for retry.

  - **Mid-drain reconnect aborts the drain** (review: presence was checked only before the drain started, then the broker's release phase closed every child unconditionally — directly contradicting the doc's "children remain warm while any client is connected"; `repl-presence.ts` documented the contradictory behavior instead of preventing it). `drainReplProject` now passes the project's live client set as the broker's abort probe; the drain consults it every iteration and before every destructive phase. A project whose client set is non-empty again keeps its children warm, and the next disconnect drains again.
  - **A failed drain is never silent** (review: the ledger swallowed drain failures, including snapshot-flush failures, and the store cleared its dirty boundary before the write succeeded — a failed last-disconnect snapshot was neither surfaced loudly nor retained for retry). The failure is recorded on the project state (`drainError`), surfaced in every repl tool result (`status` reports `LAST DRAIN FAILED`; eval/wait results carry a warn line), and the drain latch stays clear so the next disconnect retries. `ReplWorkspaceStore`'s snapshot writer clears the dirty boundary only after the write succeeds, so the next flush — the next burst or the retried drain — persists the SAME state.

- 2e4bb60: The `repl` tool's `status {projectDir}` action is now a first touch exactly like the stateful actions (phase-D review round 5): it creates the project's REPL state, marks the client present, and runs the restore path before rendering — so on a fresh daemon whose project already has a stored snapshot, the FIRST repl call may be `status {projectDir}` and still restore the VM, run the three-way reconciliation (settle from the store / re-attach via `session/load` / re-issue), surface a hash-mismatch or version refusal loudly, and return the workspace manifest (bindings with provenance, task, and wall-clock, live agents, logs, pending calls). The projectDir-less list form stays lightweight (no first touch).
- bd28cd9: The `repl` status renderer exposes the workspace manifest's full provenance surface (phase-D review round 3): each binding line now renders "from what task, when" — `· task "<task>"` (the founding `agent()` call's task text for `worker cN` and agent-handle bindings) and `· at <ISO wall clock>` (`provenanceAtMs`) — and the live-agent lines carry their task (`agent c1: running — task: "…"`), which the renderer previously omitted despite `LiveAgentInfo` already carrying it. Metadata, never content: value fragments still never leak into the render.
- af917eb: The `repl` MCP tool and the REPL workspace's daemon wiring (REPL orchestrator phase D): one persistent QuickJS-in-WASM VM per project context, addressed by the same validated `projectDir` the `workflow` tool uses.

  - **The `repl` tool** (roadmap doc's Surface section): `eval` (top-level-await semantics, captured console output, pending/checkpoint/completed summaries), `wait` (bounded server-side pump — "still running" on timeout), `status` (workspaces, live agents, pending ops), `interrupt` (ACP `session/cancel` for one call id, or the per-project eval-break signal — single-threaded semantics documented: the signal breaks the next VM execution that runs with it armed), and `reset` (teardown + store clear).
  - **Per-project persistence wiring** (phase-D review: `ReplWorkspaceStore` used to be exported/tested only): each daemon project context opens the `repl/` store under `workflowHomeDir()/projects/<key>/repl`, attaches the broker's state-changing-boundary sink (a snapshot after every eval and every settlement drain that changed VM state — atomic tmp+rename, debounced per drain burst), and on FIRST TOUCH restores the stored workspace from the enveloped snapshot (wasm-hash-verified, version-checked) and runs the three-way reconcile — or creates a fresh workspace. The workspace survives MCP-session churn and daemon restarts.
  - **Contained snapshot refusals**: a stored snapshot that refuses (corrupt/truncated, format-version bump, wasm-hash mismatch naming both hashes) is surfaced loudly in every `repl` result and cleared by `reset` — the daemon never crash-loops on a bad store and never silently discards the data.
  - `WorkflowProjectRegistry.disposeReplStates()` (wired into the daemon's close path) releases every held ACP session at shutdown; the registry exports the new `repl` state types.

- 73cc45b: REPL orchestrator phase D, review round 7: daemon shutdown is bounded end to end — the teardown after a failed or deadline-expired client-presence drain races the remaining shutdown bound instead of hanging on the hung backend the drain already caught.

  - `WorkflowProjectRegistry.disposeReplStates(boundMs?)` now spans ONE deadline across each workspace's drain AND its broker teardown: a drain that fails or consumes the whole bound leaves the teardown only the remaining time, and an expired deadline skips straight to the disposal's bookkeeping clear. A failed teardown is contained (the persistence failure was already loud from the drain; the disk keeps the last good snapshot).
  - `disposeReplProjectState` and `resetReplProjectState` pass a bound through to the broker's bounded disposal (default: the daemon's shutdown deadline), so the `reset` tool cannot hang on a hung backend either.

- 1b9b23f: REPL orchestrator phase D, review round 10: the bounded drain settles every outstanding restored call, the restore fence detaches its releases, and reset/dispose detach a parked first touch.

  - **The bound's forced stop settles every outstanding restored call** (review: the reconciliation registers calls in the opening-call registry only as its serialized loop reaches them — parked on the FIRST pending call's never-resolving `loadSession`, it never processed the entries behind it, so a bounded disconnect settled only that one call and reported drained while the later registry entries stayed pending and uncancelable; and a load that later landed let the resumed loop initiate SUBSEQUENT loads after the drain/disposal generation bump — children opening and running after the last client disconnected). `drainForDisconnect`'s forced stop now also settles every untracked pending registry entry at the bound: completed-while-down entries from the store (the store arm's semantics, first-wins), agent entries with the recoverable `AGENT_CANCELLED`, steers with the honest `failed`, and pending checkpoints the parked reconcile never reached are re-surfaced into the checkpoint table so answering still works. `reconcileAgentCall` refuses to initiate any load or re-issue while the broker is draining/disposed — the resumed loop settles the recorded completions from the store and opens nothing. Regression: multiple pending restored calls with a never-resolving first load, bounded drain, late landing — no pending entry, no second load, exactly-one release.
  - **The restore-time teardown fences detach their best-effort releases** (review: the late-load fences awaited `session.release()` with no deadline — a custom backend with a hung release kept the reconciliation, and with it the daemon's first touch, pending indefinitely, reintroducing the unbounded-teardown defect). The fence releases in `reconcileAgentCall` (both arms), `doLazyReattach` and `runAgentTask`'s stopped-open path are fire-and-forget with catch handlers attached. Regression: a late-landing restore load whose release hangs — the reconciliation completes promptly and the release was issued exactly once.
  - **reset/dispose detach a parked first-touch flight** (review: `disposeReplProjectState`/`resetReplProjectState` left `state.firstTouch` in place — the generation check ran only after `broker.reconcile()` resolved, so with a never-resolving restore-time load every subsequent touch returned the stale promise and hung forever). Both teardown paths drop the flight from the state (a fresh touch starts a new first touch) and mark its eventual rejection handled — the stale touch still aborts loudly for its original caller when the parked load lands. Regression: parked restore load → reset → fresh touch completes on a fresh workspace; the late-loaded session is released exactly once and the stale touch aborts naming the teardown.

- 0c29a86: REPL orchestrator phase F, review round 2: authoritative re-attachment/completion for ALL four built-ins, the out-of-band eval-break relay, and addressable truncation references.

  **acp-agents — the observation path for backends without the `_session/loaded_turn` extension** (the built-in claude and opencode backends today; also the fallback when an extension backend's query wire fails). The old degradation — reject with the non-re-armable `LoadedTurnStillRunningError` so the broker releases the loaded session and re-issues the call — could duplicate a still-running backend turn. The seam now classifies the loaded session's founding turn authoritatively: the post-load continuation watch (`AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS`, default 1 s — any CONTENT update after the load boundary is live continuation, the still-running signal) plus the replay probe under the CONNECTION-DEATH CONTRACT (live-verified: claude-agent-acp and pi-acp exit on connection close and cancel their turns, `opencode acp` exits on stdin EOF, codex-acp ends/kills the codex process, and their persisted transcripts hold only completed messages — so at restore the founding turn is never still running and the replay's trailing content is authoritative: an assistant message is the turn's terminal message (completed-while-down, settled from the transcript), anything else means it died mid-way (the safe-re-issue class — nothing running, no duplication)). Live continuation flips the classification to the keep-attached wait (bounded, re-armable). The `_session/loaded_turn` extension path is unchanged. Tests pin the seam-less completed/interrupted/still-running classifications end to end through the real adapter.

  **repl-engine — a possibly-running call is never re-issued** (the broker's restore/re-attach arm): every `LoadedTurnStillRunningError` — re-armable and non-re-armable forms alike — keeps the loaded session attached and re-arms the seam on it (the doc's re-attach-to-a-still-running-task arm); re-issue is reserved for the observably-dead classes (interrupted classification, a transcript that never received its prompt, a dead/released session, a third-party adapter with no seam at all). Also new: **the out-of-band eval-break channel** (`EvalBreakChannel` / `createEvalBreakChannel`) — a worker-thread relay with a loopback HTTP break endpoint and a shared-memory (SAB + Atomics) break flag. The interrupt tool's no-id path becomes deliverable to a SYNCHRONOUSLY running eval: a never-yielding eval blocks the daemon's single thread, so the request itself cannot be processed — the relay (a separate thread) arms the flag, and every eval execution's quickjs interrupt handler consumes it mid-run with the arm-after-start rule (a stale break — armed while the workspace was idle — is dropped on first observation and never breaks a later eval). `BrokerOptions.evalBreakChannel` wires it; the broker reports consumed out-of-band breaks to the tool for the honest outcome.

  **mcp-server — the daemon wiring for both**: `run-daemon` creates the channel and advertises its URL in daemon.json (`replBreakUrl`); the stdio shim fires the relay automatically when it forwards a `repl` interrupt without an id (before forwarding, so the break lands while the daemon is wedged); the interrupt tool reports the honest out-of-band outcome (and clears the flag once its own processing owns the break). And **the structured-output cap's continuation references**: the aggregate 10 KB cap previously discarded the tail entries of elided arrays (pending ids, checkpoint questions, completion ids, status metadata) keeping only counts — the omitted values had no address and repeated reads could never recover them. Every elision now snapshots the dropped entries in the workspace's `TruncationRefStore` under a ref id that the `truncated` record carries (`{ elided, ref }`), and a later eval/wait/status call's optional `refs` parameter reads them back under `referenced` (a referenced read is itself capped, chaining fresh refs) — the cap costs reads, never data, for every omitted field. The truncation marker text now names both the `$N` refs and the structured continuation refs.

- 0baa82c: REPL orchestrator phase-E review round 2 fixes:

  - **The eval-break interrupt targets the RUNNING eval** (`mcp-server` + `repl-engine`): `interrupt` without an id no longer arms a project-wide "next VM execution" boolean. The broker now tracks the suspended eval's completion (retained at suspension, released when the continuation completes or is broken) and `Broker.armEvalBreak()` refuses — an honest "no running eval to interrupt" no-op, nothing armed — when no eval is in flight. When an eval IS in flight, the armed signal is scoped to it and consulted ONLY by settlement drains (the executions that resume suspended-eval continuations), never by a fresh eval's own code or its own job drain — an unrelated eval can neither consume the signal nor be broken by it, and the signal is cleared when its targets settle or the drain it broke reports the interruption (a continuation broken by the quickjs interrupt never settles its engine wrapper — verified against the shipped binary — so the drain-interruption path releases the tracking). An idle workspace's next eval runs normally.
  - **Lexical provenance re-attributes on worker settlement** (`repl-engine`): the provenance registry now tracks global lexical bindings by VALUE — the host reads each binding's current value through the internal global-var object and hands it to the pass, which re-attributes a changed value (SameValue) to the operation that produced it. A `let` binding assigned a worker result, or a suspended `const finding = await research` whose continuation assigned the settled value, now reports `via worker cN` with the founding task and the attribution wall clock instead of the declaring eval's label with no task. A registry whose record closure predates the feature degrades to first-sight-only attribution (an older snapshot is served as-is).
  - **Size metadata for EVERY manifest binding** (`repl-engine`): the manifest token now carries the byte-size estimate for undefined, null, numbers, booleans, bigints, symbols, functions, plain promises, and agent handles — and the broker-enriched binding exposes it as its own `sizeBytes` field (the doc's name/type/size contract; 0 only for the unreadable accessor/sabotage cases). The `status` tool renders it through the tokens.

- 1aacc26: REPL orchestrator phase-E review round 3 fixes — the interrupt breaks a currently-executing runaway, the wait never holds the broker chain, workflow calls register project presence, and daemon idleness counts active REPL drains.

  - **The no-id interrupt breaks an EXECUTING runaway eval** (`repl-engine` + `mcp-server`): the eval-break signal is now consulted by EVERY execution that resumes the running eval's continuation — the settlement drains AND a direct eval's own drain (a suspended eval's continuation can be resumed by a SYNCHRONOUS host-callback settlement — `checkpoint.answer` in a later eval — and that execution runs inside the answering eval's own drain, where the old settlement-drain-only signal was blind; the runaway burned the eval deadline instead of being broken by the interrupt). `runEval` composes the signal as the drain-phase handler (`drainInterruptHandler`, a new vm-level option — the eval's own CODE still never consults it, so an unrelated eval's code is never broken), and an eval whose own drain was interrupted releases the tracked running eval exactly like the pump path (`interruptedInDrain` → `noteInterruptedDrain`) — a broken target can never linger as a stale arm target. The tool's result text and docs now state the real semantics: an eval that yields (suspends on a call) is interruptible at its next execution, mid-run; a fully synchronous runaway is bounded by the per-eval wall-clock deadline (the request cannot physically arrive while the single-threaded daemon executes it).
  - **`waitForCalls` releases the broker serialization chain between its pumps** (`repl-engine`): the wait used to hold the chain across its whole bounded poll (each sleep included), so a concurrent `interrupt` — `cancelCall` or `armEvalBreak` — queued behind it and could not cancel or break until the wait finished or timed out (up to 120 s), by which point the target could already have completed. Each pump is now its own serialized unit; between pumps other operations interleave, so an interrupt lands promptly mid-wait and the wait's very next pump breaks the armed target mid-run. The target set is captured at entry (with other operations interleaving, "every pending call" can only mean "the calls pending when the wait started"), each pump runs under the REMAINING wait time (the wait's bound is absolute for the guest drain, same posture as the disconnect drain), and a mid-wait pump-drain interruption is honest output in the wait's result. The daemon and engine suites now exercise the interrupt mid-wait and the mid-run break of an eval that keeps executing across drains (a runaway loop over subagent calls), plus a concurrent cancelCall completing during a live wait.
  - **The workflow tool registers REPL project presence** (`mcp-server`): the workflow handler resolves the same per-project context the repl tool addresses, and a session that calls it is now registered on the project's repl presence — a workflow-only client B staying connected keeps the workspace warm (children open) when repl-client A disconnects; the drain fires only when the LAST project client of either kind disconnects. A pure-workflow project keeps a stateless repl context (no VM is created — the workspace is materialized only on the first repl tool touch). The presence ledger is now created once per server and shared by both tools.
  - **Daemon idleness counts active REPL drains** (`mcp-server`): the idle reaper's busy check now includes `activeReplDrainCount()` (the presence ledger's scheduled/in-flight drains) alongside sessions and workflow runs — a last-client-disconnect drain may legitimately run for the full session-eviction TTL after the final session is gone, and the default idle shutdown can no longer fire mid-drain and replace its bound with the five-second shutdown deadline. In-flight turns are guaranteed to drain to completion under the documented session-eviction-TTL bound.

- c663a86: REPL orchestrator phase-E review round 3b fixes — the eval-break signal is keyed to the armed target's continuation (unrelated drains neither fire nor consume it), the tool returns the doc's machine-readable shapes as structuredContent with a published output schema, and the bounded wait sleeps only for its remaining budget.

  - **The eval-break signal targets the armed eval's continuation, not whichever drain runs next** (`repl-engine`): the carried defect — the drain-phase interrupt handler was installed on every later eval's drain without checking whether that drain resumed an armed target, so an unrelated finite eval (or an unrelated settlement drain) was interrupted and the interrupted-drain release cleared the target's tracking while its checkpoint stayed pending and uninterruptible. The armed identity is now the union of the armed evals' OWN suspension-time calls (pending at suspension minus the pre-eval baseline — the calls the eval issued itself, whose settlement queues its continuation; a later eval's snapshot never inherits an earlier eval's still-pending calls). Every VM operation maintains a settlement accumulator (`opSettledCalls`, appended by every settlement route and seeded by the pump/reconcile/disconnect drains with the settlements that triggered them), and the signal fires only while that accumulator intersects the armed deps — the currently-executing drain BELONGS to the armed target. An unrelated drain neither fires nor consumes it, and the armed state survives intact. The interrupted-drain release (`noteInterruptedDrain`) is gated the same way: exactly the tracked evals whose own resume keys the interrupted operation settled are released (a deadline-broken resumed runaway releases its tracked eval even when no signal was armed — a stale target would make a later arm target a dead eval), and an unrelated interrupted drain leaves the armed state and every tracked eval intact. A no-id interrupt with NOTHING breakable — no eval in flight, or every in-flight eval suspended on no OWN pending call (a never-settling local promise, or an `await p` on an earlier eval's binding) — refuses and arms nothing.
  - **The `repl` tool returns the doc's machine-readable shapes** (`mcp-server`): the carried defect — eval/wait/status were flattened into text-only MCP content with no output schema, mixing guest output and trusted orchestration metadata into one flat string. The tool now publishes an `outputSchema` (the workflow tool's oneOf-branch pattern) and every result carries `structuredContent`: eval/wait return the doc's `{ output, result?, pending, checkpoints, completed }` (plus `outputTruncated` and the wait-only `drained`/`timedOut` flags), status returns the structured workspaces surface (workspace state, the reconcile summary, the workspace MANIFEST with name/token/size/provenance/task per binding, the live agents, the pending ops, child warmth, a retained drain failure), interrupt returns its honest outcome (`targeted`/`refused-idle`/`cancelled`/`idle`/`failed`/`none`), reset the `dropped` acknowledgement, and the refusal paths a structured `error` variant. Guest output and orchestration metadata stay separate fields, and every structured field is bounded metadata (output capped by the broker, checkpoint questions previewed, manifest tokens structure-only). Status checkpoint questions are now previewed in the text surface too (the doc's previewed-question rule).
  - **The bounded wait sleeps only for the REMAINING budget** (`repl-engine`): the carried defect — the unconditional 50 ms inter-pump sleep made every sub-50 ms `timeoutMs` take ~51 ms, violating the bounded-wait contract. The sleep is now `min(50, deadline - now)`, matching the disconnect drain's pump discipline.
  - **The pending surface reports the WHOLE guest registry** (`repl-engine`): the trap-free reader's generic 256-element array cap silently truncated the guest surface's `pending()` list, and its `[ArrayTruncated]` marker mapped to `undefined` in the broker's id lists — a hole in the structured `pending` field. `readValue` takes an explicit array bound (the preview read is unchanged at 256); the surface read passes `SURFACE_READ_MAX_LEN` (16 384 — the registry is the host's own reconciliation metadata, bounded by VM memory).

- f04776d: repl phase-E review round 4: the eval-break interrupt is keyed to the calls the running eval AWAITS. The engine now instruments top-level awaits (`await x` → `await __replAwait(x)`, acorn-based, guest library 0.2.0) and attributes each suspended eval's resume keys from the guest's await log — an unawaited sibling call's settlement no longer fires or consumes the armed signal (its own `.then` continuation runs to completion), an eval awaiting an EARLIER eval's binding stays targetable, and the wait tool's serialization-chain acquisition is bounded by its absolute deadline. The pending-call registry and provenance reads are now COMPLETE trap-free reads (no 16 384-element array cap, no 256-property object cap) — the whole registry and every binding's provenance survive eval output and restore reconciliation. The repl tool's input is action-discriminated (exact per-action field sets, extraneous fields rejected), the structured manifest gains machine-readable type + live-handle status/call fields, and guest-derived structured status fields (agent task) are capped at the engine seam.
- f17212a: repl phase-E review round 5: the eval-break interrupt now carries a genuine per-eval CONTINUATION IDENTITY. The guest library (0.3.0) wraps every instrumented top-level await (`await x` → `await this["__replAwait"](x, TOKEN)` — a hygienic seam: the `this` keyword base is unshadowable, and no helper binding is injected into the persistent global lexical record) and sets a continuation lease in the job immediately before the eval's continuation segment; the drain loop mirrors the lease per job, so the armed signal fires only while the armed eval's own continuation executes. An unawaited sibling `.then` registered before the target's await can neither fire nor consume the signal (the carried defect broke the sibling's job and let the target run later unbroken), and indirect waits (`await Promise.all([q])`) are targetable through the promise graph (the 0.2.0 log-only identity refused them). The interrupted-drain release is exact the same way (the interrupted job's lease names the eval). A zero `timeoutMs` wait performs one immediately available state read (idle workspaces drain, pending calls report), the top-level-await instrumenter's injected seam can no longer be shadowed by guest identifiers, the workspace manifest enumerates user bindings that SHADOW or OVERWRITE baseline globals (`const Math = 42` is listed with full metadata and provenance — the provenance registry captures the baseline type tokens and its own intrinsics, so host bookkeeping survives lexical shadows of `Math`/`Object`), the repl tool accepts empty `code` strings (valid JavaScript resolving with `undefined`), and the per-backend steering mechanism table is now a GENERATED artifact gated by a test (`docs/steering-mechanism-table.md`, regenerated from `ACP_EXTENSION_SUPPORT_MATRIX` via `generate:steering-table`).
- d24372f: repl phase-E review round 6: three carried-defect fixes. (1) The eval-break continuation lease is now associated with the ACTUAL CONTINUATION JOB, not the next job: the guest library (0.3.1) registers the lease-setting reaction on the awaited value's WRAPPER promise itself — immediately before the await machinery's own reaction — so the wrapper's settlement queues the lease-setting job directly before the continuation job, and a sibling `q.then(...)` registered after the eval started awaiting `q` can no longer run with the lease set (the 0.3.0 reaction ran on the value's settlement, so the sibling consumed the armed signal and the target's continuation ran later unprotected). (2) The for-await ITERABLE wrap preserves the iterable protocol: the new `__replAwaitIterable(value, token)` global returns an async-iterable wrapper (resolved exactly like `for await` resolves an iterable) whose per-`next()` results are lease-wrapped promises, so `for await (const x of [1, 2])` iterates normally through the broker while a running loop stays breakable mid-iteration; the instrumenter gates for-await sites on the new `supportsIterableLease` surface flag, and `for await (... of await y)` is left unwrapped (its own await is instrumented normally). (3) Same-type baseline-global overwrites are tracked and attributed: the provenance registry captures the ORIGINAL baseline values at creation (they travel inside snapshots and are never updated on attribution) and re-attributes known names on SameValue difference, so `Math = { userOwned: true }` is listed in the workspace manifest with `object` type and full provenance even though the type token never changes; the manifest's changed-binding filter consults the registry's changed-known read alongside the host-side token check.
- 9404d4a: repl phase-E review round 7 (the reviewer's rejection of the previous attempt): five defect fixes. (1) The for-await iterable wrap preserves AsyncFromSyncIterator semantics: `__replAwaitIterable` now awaits and unwraps a SYNC iterator's result VALUE (`for await (const x of [Promise.resolve(1)])` yields `1`, never the promise object — the old wrapper resolved with the raw iterator result, and because the wrapper is an async iterable the machinery used the value as-is), while an async iterator's results pass through untouched. (2) Iterable ACQUISITION errors propagate exactly once: resolving `@@asyncIterator`/`@@iterator` follows GetIterator/GetMethod semantics (a present-but-not-callable `@@asyncIterator` is a TypeError, never a fallback) and a throwing getter runs a single time reporting its ORIGINAL error — the old degrade-to-unwrapped made the machinery acquire the iterable a second time (`boom2` instead of native `boom1`). (3) The instrumentation surface runs on CAPTURED pristine Promise intrinsics (`P`/`PResolve`/`PReject`/`pThen`, bound at installation): replacing `Promise.prototype.then`, overwriting `Promise.resolve`, or shadowing `Promise` lexically cannot change the instrumented `await 40` (still `40`) or skip the continuation-lease setting; the same hardening applies to the host-thenable forwarding in `issueHostCall`, which otherwise silently killed every call settlement under a replaced prototype. (4) Provenance recording reads descriptors off the CAPTURED global object: a top-level lexical `const globalThis = 7` no longer blanks every binding's provenance (`var userValue = 42` reaches the manifest with producer/task/time metadata). (5) The broker's continuation-lease availability check is VERSION-GATED on >= 0.3.1: a restored 0.3.0 library (whose lease-setting reaction still runs on the awaited VALUE's settlement — the carried sibling-reaction interrupt-targeting defect) reports `supportsContinuationLease: true` but is now served WITHOUT instrumentation and the eval-break interrupt refuses honestly — the flag alone re-armed the original defect on a supported older snapshot. Regressions cover every finding at the guest-library and broker boundaries, including a restored-0.3.0 snapshot whose sibling reaction never observes a continuation lease.
- 5f1cdba: repl phase-E review round 8 (the reviewer's rejection of the previous attempt): the two remaining defects fixed. (1) `interrupt { id }` (and the guest handle's `cancel()`) now cancels a call whose `openSession()` is still pending: the `cancelCall` decision's new opening arm fences the call in `stoppedOpens`, settles it DURABLY as the recoverable `AGENT_CANCELLED` (recorded first, guest-settled first-wins, concurrency token released, one drain fires the settlement's guest reactions) and returns `cancelled` — the old decision skipped `openingCalls` entirely, returned `none`, and the eventual open resolved into a prompted, supposedly-interrupted call. A late landing closes the child immediately without ever prompting; a daemon restart settles the call from the store. Regressions at the broker boundary (delayed-open cancel + handle cancel + slot release under a cap of one) and a full daemon regression with a delayed `openSession()`. (2) The doc's 256-line/10 KB tool-result cap now applies to `structuredContent` as an AGGREGATE serialized-size cap, not only to the bounded text: the modelSpec is previewed at the ENGINE seam (head+tail 200 chars, the task bound), and a new `capStructuredResult` pass elides the largest lists (head prefix kept) with an explicit path-keyed `truncated` record of elided counts — elision is never a silent hole (the round-4 registry-read defect) and the wire's serialized structured result always fits the 10 KB bound (a 20,000-character model spec and 16,500 pending ids previously crossed uncapped; the 16,500-checkpoint daemon test now pins the bounded, flagged, size-checked wire plus the full registry surviving in the VM across a restart).
- 3b30612: repl phase-E review round 9 (the reviewer's rejection of the previous attempt): four defects fixed. (1) The opening-call cancellation (`interrupt { id }` on a call whose `openSession()` is still pending) is a settlement drain that changed VM state but never fired the per-settlement provenance pass or the state-changing boundary: `cancelCall`'s opening arm now runs `provenancePass('settlement', [callId])` and `sink.boundary('settlement')` after its drain (the boundary still fires on a `DrainJobError`, mirroring the pump), so the manifest immediately attributes the settlement's continuation bindings to the cancelled worker and the daemon's snapshot writer persists the settled workspace before the interrupt's promise resolves — a kill right after the interrupt (no eval or wait in between) restores the SETTLED snapshot, never the pre-settlement one. (2) The opening-cancel's concurrency-slot release now runs the global queued-delivery kick (`kickQueuedDeliveries`, exactly like every other slot-free transition): a cap-pressure follow-up queued on an idle session starts its delivery turn the moment the opening call is cancelled. (3) The GENERATED steering mechanism table is corrected and re-pinned: the `cancel()`-while-opening case was documented as a no-op returning `failed` while the call continues, contradicting the implementation (which cancels the opening call and returns `cancelled`); the generator's case table and the broker module docs now say the opening call is fenced and settled durably as cancelled, the checked-in artifact is regenerated, and the gate test pins the corrected row (and asserts the stale no-op claim is gone). (4) The generator emitted TWO terminal newlines, so `git diff --check` failed with "new blank line at EOF" on the checked-in artifact; the generator now emits exactly one terminal newline and the gate test pins it. Regressions: broker-boundary tests for the immediate-after-interrupt snapshot/restart with a recording sink (exactly `['settlement']` fired, no intervening eval, provenance + store-arm assertions across the restore), the cap-1 queued-follow-up kick, and a daemon regression that kills the daemon IMMEDIATELY after the interrupt (no eval or wait — the round-8 test masked the defect by performing both before restart) and asserts the restart's reconcile has nothing for the store arm and the manifest provenance traveled inside the interrupt's own snapshot.

### Patch Changes

- a2a76bc: Docs-only: document the `repl` MCP tool and sweep repl-orchestrator-stale documentation.

  - **`packages/mcp-server/README.md`** — full user-facing `repl` tool section at the depth of the `workflow` section: the structured-output `oneOf` union documented as the shapes the tool **emits at runtime** (eval/wait/status/interrupt/reset/error — the error branch's enum lists all five `action` values, but at runtime only the four stateful actions `eval`/`wait`/`interrupt`/`reset` ever emit it; `status` never does), with the interfaces distinguished from the **looser published `outputSchema`** — the generated JSON Schema permits `referenced` on every branch (its forbidden-field vocabulary omits it) and types `reset`'s `dropped` as `boolean` rather than the literal `true`, though no runtime path emits either looser shape. The nested `WorkspaceStatus`, `ReconcileReport`, `ManifestBinding`, `LiveAgent`, `CheckpointSummary`, and `TruncatedRecord` shapes are documented too. `wait` is noted to return the eval shape but **never carry `result`** (`Broker.renderWaitResult` renders settlement + drained output, never a completion value). `result` is documented as present **when the eval resolves to a value** (a guest `undefined` renders as the string `"undefined"`) and **absent when the eval suspends** (a subagent call, a `checkpoint()`, or any other unsettled promise) **or throws, rejects, syntax-errors, or is interrupted** — not "absent only when it suspends". Refusal routing is code-exact: a refused snapshot returns the `isError` error variant on `eval`/`wait`/`interrupt`, a **named `status`** reports the same refusal through its status variant (`state: "refused"`, `restoreError`), and `reset` returns the error variant only for a missing project context. `status` never takes the missing-context error path — a project-less `status` lists known workspaces (empty when none) and a named `status` creates the context. `LiveAgent.modelSpec` is noted as head+tail-capped to 200 chars (like `task`). The structured-cap note is honest: ref-captured array elisions "cost reads, not data" — but the read-back re-enters the same 10 KB structured cap and can emit a _fresh_ continuation ref, so a large tail drains across chained reads (one ref per round), not a single call; the `strings` backstop and ref-store-less array drops lose data. The worked-example timeline matches outputs the current engine actually produces (a settled agent handle is `151B` and stays an `idle` entry in `liveAgents`; the shared `c1`/`c2`/… id sequence; double-quoted previewer strings with unquoted property names and collapsed `Array(N)` brand tokens; `eval N` provenance; `formatByteSize` tokens; both interrupt paths incl. the no-id `refused-idle` case). Also documented the caps (text = 256 physical lines / 10 KB; `structuredContent` = 10 KB serialized JSON only), the continuation-ref lifetime (workspace-namespaced, in-memory, reset-cleared, restart-lost), the lifecycle (named `status` materializes; lazy first-touch restore; drain bounded by the session TTL with `AGENT_CANCELLED` and reconnect-abort), the honest interrupt limits (not "always breakable"; HTTP lacks the out-of-band relay), the un-clamped `AGENTPRISM_REPL_EVAL_TIMEOUT_MS`, and the programmatic-use exports. The composition-root diagram now shows `createAcpRunner()` feeding the workflow engine only — each REPL workspace's broker owns its own `AcpAgentRunner` by default (overridable via `CreateWorkflowServerOptions.replRunner`), not one shared runner injected into both tools. Immediate eval errors are documented rendering in `output` as a plain `Name: message` line (the `error:` prefix is reserved for a late uncaught rejection bridged through `console.error`), and the `$N` console capture is documented as `structuredClone` with a typed-marker fallback (`{ __unclonable__: … }`) for non-cloneable values (functions, symbols, promises, weak collections, unfreezable graphs) — so only cloneable data is preserved whole.
  - **`docs/api.md`** — REPL output union made code-exact: the `wait` variant is spelled out in full, the error branch includes `action: "reset"`, `ManifestBinding.task` / `LiveAgent.modelSpec` / `LiveAgent.task` carry the ≤ 200-char head+tail bound, `result` presence/absence is corrected the same way as the server README (immediate errors render as a plain `Name: message` line, not an `error:` line), the missing-context error variant is scoped to the four stateful actions (`status` never takes it), the continuation-ref read-back is noted to re-enter the 10 KB cap (chained reads), and the `mcp-server` package row's `workflow` action inventory adds the implemented `stop` action.
  - **`docs/roadmap/repl-orchestrator.md`** — the eval `result` contract corrected the same way, the "cost reads, never data" cap claim qualified honestly (ref-captured array elisions only, with the read-back re-cap/chained-read note; the string backstop and ref-store-less drops lose data), the output-addressing example uses the implemented collapsed CDP preview (unquoted keys, `Array(N)` brand tokens) and the `structuredClone`-plus-marker-fallback capture (only cloneable data preserved whole), and the snapshot-compatibility claim is retargeted from the npm package version to the `quickjs.wasm` SHA-256 + envelope format version.
  - **`packages/repl-engine/README.md`** — the restore/re-attach description corrected to the implemented **observation path**: a built-in backend without the `_session/loaded_turn` extension (claude, opencode) is classified by the post-load continuation watch + connection-death replay probe (never a blind possibly-running re-issue, never a permanent pending hold); a non-re-armable third-party still-running seam stays attached until terminal/cancel/release/drain; only a seam-less third-party adapter falls back to re-issue. The error-variant routing was corrected the same way (a named `status` reports refusal via its status variant and never takes the missing-context error path; `reset` returns the error variant only for a missing project context). Snapshot compatibility is corrected to be enforced on the `quickjs.wasm` SHA-256 + envelope format version, **not** the npm package version (a package bump that ships the same binary keeps old snapshots restorable), the `$N` console capture gains the `structuredClone`-plus-typed-marker-fallback qualification, and the continuation-ref read-back is noted to re-enter the 10 KB cap (chained reads for a large tail).
  - **`docs/design-notes.md`** — the §1 protocol diagram now shows both registered tools (`workflow` and `repl`) and both execution routes (the deterministic engine for `workflow`, the per-project QuickJS broker for `repl`); §2/§4 package/tool-surface prose swept. The §2 package graph now draws a labeled `mcp-server → repl-engine` edge (and drops the incorrect `mcp-server → acp-agents` edge — `mcp-server` depends directly on `repl-engine`, `workflows`, and `shared-types`), and the packaging line reads "a pnpm monorepo of **nine** published packages — **eight** released to npm; `repl-engine` publishable but not yet released, at `0.0.0`" (the wording the docs-drift inventory assertion pins).
  - **Root `README.md`** — the internal-packages prose no longer claims all five are "composed by the SDK": `repl-engine` depends on the SDK and is composed by the MCP server (which registers its `repl` tool), and `codex-acp` is spawned by `acp-agents`. The ninth package `@automatalabs/codex-acp` is in the accounting and the `workflow` input table carries `stop`/`scriptPath`/`projectDir`/`callIndex`.
  - Repository sweep for other claims the branch made stale: `CONTRIBUTING.md` (mcp-server exposes `workflow` + `repl` and no auth tools; `repl-engine` is not a leaf and its `repl` tool is implemented), the `agentprism-workflow-authoring` skill (`reference.md` "whole tool surface" and `mcp-server-setup.md` "single `workflow` tool" qualified for the two-tool surface), and the present-tense MCP-auth-surface claims in `docs/specs/acp-auth-spec.md`, `docs/roadmap/validate-mcp-action.md`, `docs/specs/pause-recovery-continuation-spec.md`, and `docs/specs/issue-131-agent-feedback/*` marked historical. `workflow_auth_status` / `workflow_authenticate` were never registered; the shipped model-facing tools are `workflow` and `repl`.
  - **`packages/mcp-server/src/generated/authoring-prompt-content.ts`** — regenerated from the swept skill sources via `node scripts/generate-authoring-prompt.mjs` (never hand-edited) so the self-contained MCP `author-workflow` prompt carries the two-tool wording (`reference.md`'s "whole _workflow_ surface" and the separate `repl` tool note, `mcp-server-setup.md`'s qualified `workflow` tool line). This keeps the generated artifact byte-for-byte in sync with its sources, as the `authoring-prompt` drift test enforces.

- bcede5b: REPL orchestrator phase F, review round 3 — the full-repo verification's carried defects, all closed:

  - **ACP freshness gate green**: the `packages/codex-acp` subtree is re-synced with upstream `agentclientprotocol/codex-acp@main` (ea57892 — the goal-extension `resume` action and the v1.1.11–1.1.13 releases) via a true non-squashed merge commit; the fork's `package.json` version line wins, the package lockfile stays deleted, and the imported upstream head is recorded in the attribution allowlist.
  - **The observation path's replay classification is restricted to the verified built-ins** (acp-agents): a CUSTOM backend's quiet observation window is not terminal evidence — its connection-death behavior is not live-verified — so its loaded session stays attached and the seam waits for the authoritative terminal state (the re-armable still-running rejection) instead of settling stale/partial replay or re-issuing a possibly-running call.
  - **Non-re-armable seam rejections are never re-invoked** (repl-engine): the broker kept recursing into a seam that rejects with `LoadedTurnStillRunningError` and `rearmable: false`, spinning in an unbounded microtask/warning loop that starved cancellation, drain, and every other task. The broker now keeps the loaded session attached and waits for the terminal state from the session-level `_session/loaded_turn/ended` surface, the call's cancel (settled as the recoverable `AGENT_CANCELLED`), the session's release (the safe-re-issue class), or the drain's forced stop.
  - **The interrupt is implemented in the in-process/library mode too** (mcp-server): the single-project server now owns an eval-break channel by default and exposes its relay (`replBreakUrl()`); the stdio transport's stdin reader lives on a worker thread that fires the relay for no-id `repl` interrupts, so a synchronous `while(true)` eval is breakable mid-run exactly like in daemon mode. The relay keys are realpath'd on every fire side (shim and in-process reader), so symlinked or non-normalized projectDirs interrupt correctly.
  - **Break targeting has no clock-resolution window** (repl-engine): the eval-break channel now orders arms against execution starts on a shared monotonic arm-sequence counter instead of millisecond `Date.now()` stamps — a break arriving in the same millisecond as the execution start is delivered, never consumed as stale and lost. The channel's slots also GROW on demand (no fixed workspace ceiling) and are released on broker teardown for reuse.
  - **The structured-output cap's continuation refs are cumulative, namespaced, and never evicted** (mcp-server): repeated halving of one field chains every dropped chunk into the advertised ref (earlier tails stay addressable); ref ids carry the workspace's project key so a ref from one project can never resolve in another's store; the store retains every ref until `reset` (which now clears it); and the `wait` result variant accepts `referenced` (the handler attached it, the validator forbade it).
  - Documentation and the phase-F changeset re-worded: the `repl-engine` dependency line and the shipped-tool status are stated as they are, and the changeset no longer carries the banned marker strings.

- 1db93d4: REPL orchestrator phase F, review round 4 — the five carried defects from the full-repo verification's clause checklist, all closed with regressions:

  - **The in-process no-id interrupt honors the documented optional `projectDir`** (mcp-server): the single-project `repl` tool resolves an omitted `projectDir` to the server's own adopted project, and the relay transport's stdin-reader worker now fires the out-of-band eval-break with that same key (exposed as `replDefaultProjectDir()` on the server control, wired into the worker's `workerData`). An omitted-`projectDir` interrupt during a synchronous `while(true)` eval previously skipped the relay entirely, ran to the per-eval deadline, and then reported `refused-idle`; the new e2e pins the out-of-band break.
  - **Streaming UTF-8 decoding in the relay reader** (mcp-server): the worker now decodes the raw stdin byte stream through a `StringDecoder` (`RelayFrameSplitter`), never per-chunk `Buffer.toString("utf8")` — a multibyte character split across reads used to be replaced with U+FFFD, so the claimed byte-identical MCP forwarding was false (a built-server repro changed an expected string length). Unit tests feed a JSON-RPC frame one byte at a time and pin the verbatim decode.
  - **Acknowledged, generation-safe eval-break slot lifecycle** (repl-engine): `EvalBreakChannel.register` now returns a promise the relay worker acknowledges (`{ type: "ack", key, slot, gen }`) only after applying the key→slot mapping, and every serialized broker operation awaits the ack before touching the VM (`runSerialized`) — a first interrupt can no longer 404 against an unapplied mapping and lose the break. Slot assignments carry generations: the worker stamps each arm with the arming key's generation (release order, before the flag), `unregister` clears the flag and invalidates the slot's generation word, the worker clears the flag when a mapping takes a slot over, and `consumeBreak` drops any consumed flag whose generation does not match the consuming key's current one — a stale arm for a released incarnation can never break the workspace that reuses the slot. The channel's worker-message listener is attached only while booting or awaiting acks (Node re-refs the worker port while a message listener is attached; the round-3 code left it attached forever and every server-owning test suite hung on exit).
  - **Cumulative truncation refs preserve verbatim order** (mcp-server): the elision record's chained continuation ref now assembles `[...newestDropped, ...priorDropped]` — the halving pass always drops from the current array's tail, so the newest chunk precedes the older ones in the original array. The advertised ref used to concatenate chunks in reverse (`[4…7,2…3]` after two drops instead of the verbatim tail `[2…7]`); the unit test pins head+ref reassembling the original list exactly.
  - **`send` completion means flushed** (mcp-server): `ReplRelayStdioTransport.send` now awaits the stdout `drain` event when `write()` reports backpressure, exactly like the `StdioServerTransport` it replaces — the old fire-and-forget write resolved immediately, allowing unbounded buffering against a slow client for all in-process MCP traffic. Unit tests drive a fake stdout seam through backpressure and drain.

- Updated dependencies [a2a76bc]
- Updated dependencies [6a7ea36]
- Updated dependencies [05a8e0f]
- Updated dependencies [62c01d5]
- Updated dependencies [529e954]
- Updated dependencies [bd28cd9]
- Updated dependencies [2e4bb60]
- Updated dependencies [142a23e]
- Updated dependencies [1b9b23f]
- Updated dependencies [21f2747]
- Updated dependencies [73cc45b]
- Updated dependencies [af917eb]
- Updated dependencies [af9c9d5]
- Updated dependencies [0c29a86]
- Updated dependencies [0baa82c]
- Updated dependencies [1aacc26]
- Updated dependencies [c663a86]
- Updated dependencies [f04776d]
- Updated dependencies [f17212a]
- Updated dependencies [d24372f]
- Updated dependencies [9404d4a]
- Updated dependencies [5f1cdba]
- Updated dependencies [3b30612]
- Updated dependencies [149b606]
- Updated dependencies [bcede5b]
- Updated dependencies [1db93d4]
- Updated dependencies [4c046ab]
  - @automatalabs/workflows@0.46.4
  - @automatalabs/repl-engine@0.1.0

## 0.25.1

### Patch Changes

- @automatalabs/workflows@0.46.3

## 0.25.0

### Minor Changes

- 8ecd7a6: Run monitor: push `ui/update-model-context` at milestones only

  The MCP Apps run-monitor panel mirrored run status into the host's model context on nearly
  every fold of its event stream — agent starts, banner changes, and token/cost tallies all moved
  the push signature, so a run with N agents produced ~2N pushes plus steady churn while nothing
  decision-relevant had happened. Each push also enumerated per-agent failure text, turning a
  context-mirroring channel into a log feed. In hosts that treat a context update as
  conversational input, every one of those pushes reached the agent.

  Pushes are now limited to three milestones: an agent call going terminal (done or error), a
  phase start (carrying the phase title and its ordinal), and the run reaching a paused or
  terminal state. Live-view detail — agent starts, banners, progress rows, transcript tokens,
  token/cost totals — no longer pushes on its own; it stays in the panel and the event log, which
  the agent can read on demand. Push content is now shaped as YAML frontmatter plus a prose
  sentence per the MCP Apps context pattern, and failure detail is summarized to the first
  failure with a remaining count instead of enumerated.

  Also fixes two leaks in the same channel: the panel's `onteardown` handler was a no-op, so a
  dismissed or replaced panel kept polling the app-only events tool and kept pushing context from
  a detached iframe; teardown now latches both channels off permanently. The event poll interval
  moves from 1s to 2s, matching the cadence in the MCP Apps "polling for live data" pattern.

## 0.24.7

### Patch Changes

- @automatalabs/workflows@0.46.2

## 0.24.6

### Patch Changes

- @automatalabs/workflows@0.46.1

## 0.24.5

### Patch Changes

- Updated dependencies [ffd83d1]
  - @automatalabs/workflows@0.46.0

## 0.24.4

### Patch Changes

- @automatalabs/workflows@0.45.8

## 0.24.3

### Patch Changes

- f150805: Repository metadata now points at `agentprism/agentprism-workflows` — the monorepo transferred from `VikashLoomba` to the `agentprism` GitHub organization. No runtime changes.
- Updated dependencies [f150805]
  - @automatalabs/shared-types@0.29.1
  - @automatalabs/workflows@0.45.7

## 0.24.2

### Patch Changes

- @automatalabs/workflows@0.45.6

## 0.24.1

### Patch Changes

- @automatalabs/workflows@0.45.5

## 0.24.0

### Minor Changes

- fc50fae: Keep agents from re-rendering the MCP Apps run-monitor by polling: the panel now mirrors run status into the host's model context via `ui/update-model-context` (throttled, overwrite semantics, immediate on pauses/terminal states), the `workflow` tool description and background-admission text steer agents to a single bounded `await` instead of `inspect` polling (and document `_meta.progressToken` support), and `inspect`/`await` text summaries carry `annotations.audience: ["assistant"]`. README documents the upstream per-call rendering limitation (ext-apps#430).

## 0.23.1

### Patch Changes

- @automatalabs/workflows@0.45.4

## 0.23.0

### Minor Changes

- bcc443f: Skeleton-first run-monitor graph: the MCP App panel now parses the admitted workflow script (acorn, client-side) into its structural skeleton — agent/checkpoint/workflow call sites, parallel/pipeline groups, loop containers, phase markers, and engine-stdlib fan-out sites (verify/judgePanel/completenessCheck) — and renders it muted from the first frame. Runtime agents attach to their call sites by the engine's structural call path, which `agentStart` events now carry (additive `path` field, captured pre-limiter, never truncated — an oversized capture is dropped). Loops display one iteration at a time with a selector; checkpoint sites activate from settlement callRecords; nested workflow() agents cluster under a labeled bracket; pathless agents stay visible in an unmapped cluster rather than being guessed onto a site. Runs without a fetchable/parseable script fall back to the previous timing-based wave layout.

### Patch Changes

- Updated dependencies [bcc443f]
  - @automatalabs/shared-types@0.29.0
  - @automatalabs/workflows@0.45.3

## 0.22.2

### Patch Changes

- @automatalabs/workflows@0.45.2

## 0.22.1

### Patch Changes

- c32c4d0: Rewrite the workflow-authoring skill (and the `author-workflow` prompt generated from it)
  around the script API, run operations, and resume rules, in plain simplified-technical-English
  prose. Prescriptive prompting methodology (the source contract, review-lens design, the
  long-running-train playbook, and the implementation-train example) moves out of the skill to
  `docs/patterns/` in the repository. Duplicated content between the guide documents and the
  reference is consolidated to one canonical home per fact; the events resource gets a dedicated
  operations section. Backend `mode` documentation now defers to the live config probe instead of
  enumerating catalog values that drift, and the validator's dry run is described accurately as a
  mocked control-flow run, not an execution of the workflow. The generated prompt shrinks by
  roughly 30%.
  - @automatalabs/workflows@0.45.1

## 0.22.0

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

### Patch Changes

- Updated dependencies [fdfa8f0]
  - @automatalabs/workflows@0.45.0

## 0.21.0

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
  - @automatalabs/workflows@0.44.1

## 0.20.0

### Minor Changes

- 3d80c62: Add an MCP Apps run-monitor panel to the `workflow` tool. The tool now declares
  `_meta.ui.resourceUri` (with the legacy `ui/resourceUri` mirror) and the server advertises
  the `io.modelcontextprotocol/ui` extension in its capabilities, so MCP Apps-capable hosts
  render a live panel for workflow calls: a phase/agent graph with per-node log drill-in,
  live token/cost totals, and a Stop control. The panel (React,
  `@modelcontextprotocol/ext-apps/react`) derives the runId from the call arguments
  (inspect/await/stop) or the execute result (immediately for background admissions) and keeps
  itself current by polling the new app-only `workflow-events` cursor tool
  (`visibility: ["app"]`), which shares its page builder with the
  `workflow://runs/{runId}/events` resource; that document now also carries `workflowName`.
  Hosts without MCP Apps support ignore the UI metadata and keep the exact text/structured
  output as before.

### Patch Changes

- Updated dependencies [3d80c62]
  - @automatalabs/workflows@0.44.0

## 0.19.1

### Patch Changes

- Updated dependencies [359046e]
  - @automatalabs/workflows@0.43.0

## 0.19.0

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
  - @automatalabs/workflows@0.42.0

## 0.18.2

### Patch Changes

- @automatalabs/workflows@0.41.1

## 0.18.1

### Patch Changes

- b2273e3: Authoring guide: the MCP `workflow` tool now leads everywhere the SDK previously appeared first — the hosts section opens with the MCP route as the canonical way agents run authored scripts (the SDK follows as the embedding alternative), and the live-checkpoint-channel and script-backend-approval parity notes name MCP elicitation before `ExecOptions.confirm` / `allowScriptBackends`. Ordering only; no behavioral guidance changed.

## 0.18.0

### Minor Changes

- 895a4ff: Harden the workflow-authoring skill (and the served `author-workflow` prompt) with rules distilled from observed authoring failures: an explicit execution-environment contract for mutating workflows (verify an args-supplied workroot or create a persistent workspace idempotently — never treat the run cwd as disposable), a checkpoint required before the first commit into a user-owned checkout, per-model/per-provider-variant catalog probing via validate's per-pair echo, the corrected `"fast-mode"` config-option id (previously mis-documented as `fast_mode`), a generalized every-referenced-path-has-a-writer rule, values-not-attestations SHA discipline (`headSha`/`reviewedHeadSha` compared in script code), an explicit `status` enum for STOP-and-report, shared-tree fan-out guidance (serialize or isolate run-things reviewers; `git ls-remote` over `git fetch`), spec snapshotting for mutable external contracts, source-lean handling for open decisions, plan gating with a schema-carried source diff, and shipping mock-answer fixtures beside the script. The `implementation-train` example demonstrates all of it.

## 0.17.0

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
  - @automatalabs/workflows@0.41.0

## 0.16.9

### Patch Changes

- 30fbeee: Dispose pooled ACP backend process trees when the stdio MCP server receives a signal or client disconnect, including stale connections already removed from pool admission.
  - @automatalabs/workflows@0.40.6

## 0.16.8

### Patch Changes

- f2dbaa5: Declare ordered versus exact-set thought-level semantics for every built-in ACP backend. Derive
  missing ordered domains from model-specific zero-token catalogs, clamp recognized values safely,
  and exact-reject OpenCode, custom, oversized, or inconsistent catalogs.
- Updated dependencies [f2dbaa5]
  - @automatalabs/workflows@0.40.5

## 0.16.7

### Patch Changes

- 5cf8f96: Advertise Pi thinking levels per selected model, reject unrecognized values, and clamp recognized
  model gaps through Pi's SDK. Validate workflow thought levels against each call's selected model,
  including explicit clamp warnings and safe handling for backends without recognized-domain metadata.
- Updated dependencies [5cf8f96]
  - @automatalabs/workflows@0.40.4

## 0.16.6

### Patch Changes

- 2561f67: Honor durable `checkpointReplies` when resuming a positional (non-`resume`-declared) run. Previously a background run paused at a durable `checkpoint(..., { headless: "pause" })` could not be continued: resuming with `resumeFromRunId` + `checkpointReplies` took the positional fallback, re-ran the whole agent prefix live, re-reached the checkpoint, and re-paused. The recorded reply is now applied after the live prefix, matched to the checkpoint's exact call path-hash so a reply only ever applies to the occurrence it targeted.

  The resume report and the MCP workflow result now surface a `checkpointReply` outcome: `applied` (with the current call index), or `not-applied` with a safe reason (`checkpoint-identity-mismatch` or `checkpoint-not-reached-at-recorded-call-site`). The not-applied report never echoes the supplied decision value.

- Updated dependencies [2561f67]
  - @automatalabs/shared-types@0.26.2
  - @automatalabs/workflows@0.40.3

## 0.16.5

### Patch Changes

- 6f47267: Persist terminal-shaped interruption rows for every allocated call when a run halts, and retain non-result identity blockers so completed calls remain safely replayable across usage, auth, checkpoint, and host interruptions.
- Updated dependencies [6f47267]
  - @automatalabs/shared-types@0.26.1
  - @automatalabs/workflows@0.40.2

## 0.16.4

### Patch Changes

- @automatalabs/workflows@0.40.1

## 0.16.3

### Patch Changes

- 82ede81: Add the executable built-in backend registry and generated dependency manifest, expose recursively
  frozen initialize metadata on session refs and events, preserve generic ACP extension passthrough,
  and document the registry-driven onboarding and routing contract.
- Updated dependencies [82ede81]
  - @automatalabs/shared-types@0.26.0
  - @automatalabs/workflows@0.40.0

## 0.16.2

### Patch Changes

- @automatalabs/workflows@0.39.2

## 0.16.1

### Patch Changes

- 58606fa: Admit resume sources across current-environment and Node/V8 drift while preserving format, manifest, and per-call safety checks. Resume eligibility now reports typed runtime and environment provenance changes through SDK and MCP result surfaces.
- Updated dependencies [58606fa]
  - @automatalabs/shared-types@0.25.1
  - @automatalabs/workflows@0.39.1

## 0.16.0

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
  - @automatalabs/workflows@0.39.0

## 0.15.4

### Patch Changes

- @automatalabs/workflows@0.38.4

## 0.15.3

### Patch Changes

- 3f8eb0e: Ship Pi's complete MCP client, standard StructuredOutput injection, configured model catalog,
  provider-error pin guard, tracked child cleanup, and end-to-end caller quarantine/timeout propagation.
- Updated dependencies [3f8eb0e]
  - @automatalabs/workflows@0.38.3

## 0.15.2

### Patch Changes

- @automatalabs/workflows@0.38.2

## 0.15.1

### Patch Changes

- @automatalabs/workflows@0.38.1

## 0.15.0

### Minor Changes

- 2beca1e: Promote Pi to a first-class built-in backend with exact-prefix model routing, native structured
  output, categorical provider errors, complete auth descriptors, bundled spawning, configuration
  discovery, and credential-free plus opt-in live end-to-end coverage. Update pi-acp's exact-pinned pi
  runtime and hermetic test dependencies to 0.80.9.

### Patch Changes

- Updated dependencies [2beca1e]
  - @automatalabs/workflows@0.38.0

## 0.14.0

### Minor Changes

- 023f552: Continue eligible usage-limit and authentication-paused agent turns from their recorded ACP sessions, with fail-to-fresh gates, durable diagnostics, and MCP output support.

### Patch Changes

- Updated dependencies [023f552]
  - @automatalabs/shared-types@0.24.0
  - @automatalabs/workflows@0.37.1

## 0.13.1

### Patch Changes

- f6d96bc: The `author-workflow` prompt now teaches harness config discovery: regenerated guide content covers the new `agentprism-workflows config` command, and the closing instruction tells the assistant to read the live catalog before pinning models, efforts, or configOptions — instead of guessing ids or probing with a throwaway workflow.
- Updated dependencies [f6d96bc]
  - @automatalabs/workflows@0.37.0

## 0.13.0

### Minor Changes

- aac11d8: Add absolute `scriptPath` delivery, persistence-backed workflow script resources and lineage links, full resource subscription/list-change capabilities, and the `workflow` tool's durable `stop` action. Gate workflow VM execution on durable resource readback, preserve engine-owned content-free resume ancestry across run deletion, expose manager deletion observability for resource consumers, and publish exact structured-output variants.

### Patch Changes

- Updated dependencies [aac11d8]
  - @automatalabs/workflows@0.36.0

## 0.12.0

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
  - @automatalabs/workflows@0.35.0

## 0.11.7

### Patch Changes

- f93fcf3: Tail durable event logs for bounded background awaits and emit monotonic coarse phase and distinct
  started/ended-call progress when the await request carries a progress token. Background-start
  requests still return without an enduring progress channel or any notification after return, and
  legacy/inconsistent-log polling fallback emits no progress notifications. Tool schemas are
  unchanged; refresh the bundled workflow-authoring prompt and host guidance accordingly.
- Updated dependencies [f93fcf3]
- Updated dependencies [f93fcf3]
  - @automatalabs/shared-types@0.22.0
  - @automatalabs/workflows@0.34.0

## 0.11.6

### Patch Changes

- @automatalabs/workflows@0.33.1

## 0.11.5

### Patch Changes

- Updated dependencies [805b51f]
  - @automatalabs/shared-types@0.21.0
  - @automatalabs/workflows@0.33.0

## 0.11.4

### Patch Changes

- 7b00535: Validate nondeterministic workflow APIs from executable AST call nodes so API names in prompts, descriptions, templates, and comments remain valid, and align workflow-validator guidance with the AST-aware behavior.
- Updated dependencies [7b00535]
  - @automatalabs/workflows@0.32.1

## 0.11.3

### Patch Changes

- 134dffc: Expose ACP session config options as a verbatim per-call authoring surface, add routed no-prompt
  catalog probing to the runner and workflow validator, and preserve existing replay hash bytes when
  the new option bag is absent or empty.
- Updated dependencies [134dffc]
  - @automatalabs/workflows@0.32.0
  - @automatalabs/shared-types@0.20.0

## 0.11.2

### Patch Changes

- Updated dependencies [ef2c64b]
- Updated dependencies [ef2c64b]
  - @automatalabs/shared-types@0.19.0
  - @automatalabs/workflows@0.31.0

## 0.11.1

### Patch Changes

- c81df46: Replace client-side model matching and modifier handling with deterministic registered-prefix routing and verbatim model selection by the serving ACP harness.
- Updated dependencies [c81df46]
  - @automatalabs/workflows@0.30.1

## 0.11.0

### Minor Changes

- f0f30ad: Add replay-neutral `fallbacks` and `checkpointsTaken` observability to terminal workflow results,
  persist both audit trails for cold reads, and expose them in foreground and await MCP outcomes.

### Patch Changes

- Updated dependencies [f0f30ad]
  - @automatalabs/shared-types@0.18.0
  - @automatalabs/workflows@0.30.0

## 0.10.3

### Patch Changes

- 7f7abcb: Document how changed workflow args interact with journal identity and longest-prefix replay, including an args-controlled loop-cap resume example in the bundled authoring prompt.

## 0.10.2

### Patch Changes

- 123e1b3: Add reusable and sequenced dry-run mock answers to the validator SDK and CLI, with deterministic label-glob selection, strict schema enforcement, attribution, and unused-fixture reporting. Refresh the MCP authoring prompt with the new validator guidance.
- Updated dependencies [123e1b3]
  - @automatalabs/workflows@0.29.0

## 0.10.1

### Patch Changes

- 86c17a8: Expose each fulfilled `gate()` result's exact last validator verdict, preserve producer and structured-verdict inference in the ambient DSL, support boolean and null verdicts, and refresh the bundled MCP authoring guidance.
- Updated dependencies [86c17a8]
  - @automatalabs/workflows@0.28.0

## 0.10.0

### Minor Changes

- 7172960: Emit cumulative token-usage snapshots after live attempts and seed background runs with their complete replay journal before initial persistence; carry the replay-safe background lifecycle through the SDK facade; and add MCP background admission, bounded await, terminal outcome reconstruction, and the four-run process-local cap.

### Patch Changes

- Updated dependencies [7172960]
  - @automatalabs/workflows@0.27.1

## 0.9.0

### Minor Changes

- a4a5397: Add shared workflow run inspection, log-tail, truncation, and journal-attribution contracts; implement the safe engine projector and persisted terminal causes; publish the SDK facade surface; and add the MCP `action: "inspect"` branch with terminal log-tail rendering.

### Patch Changes

- Updated dependencies [a4a5397]
  - @automatalabs/shared-types@0.17.0
  - @automatalabs/workflows@0.27.0

## 0.8.3

### Patch Changes

- @automatalabs/workflows@0.26.7

## 0.8.2

### Patch Changes

- 9343e89: No runtime changes — verifies the app-token release automation (Version PR authored by the release app, CI-gated auto-merge, publish leg) end to end.

## 0.8.1

### Patch Changes

- @automatalabs/workflows@0.26.6

## 0.8.0

### Minor Changes

- 3872fd0: New `author-workflow` MCP prompt: prompt-capable hosts (e.g. Claude Code, where it surfaces as a slash command) get the complete workflow-authoring guide served by the server itself — the published `agentprism-workflow-authoring` skill's guide, the exhaustive DSL reference tables, and a complete validated example script, bundled self-contained (every same-directory pointer rewritten) and version-matched to the installed engine. Pass the optional `task` argument to close the guide with a concrete authoring assignment that ends by running the `workflow` tool. Prompts are a user-controlled MCP primitive, so the model-facing tool surface stays exactly the single `workflow` tool. Content is generated from the skill sources by `scripts/generate-authoring-prompt.mjs` with a CI drift guard.

## 0.7.0

### Minor Changes

- b269a8f: The MCP server's tool surface is now the single `workflow` tool. The `workflow_auth_status`, `workflow_authenticate`, `workflow_providers`, `workflow_set_provider`, and `workflow_disable_provider` tools and the `AGENTPRISM_MCP_INLINE_AUTH` elicitation bridge are no longer part of the server: backend auth belongs to the agents' own CLI credential stores (`claude /login`, `codex login`, `opencode auth login`), which the server's host-side bookkeeping cannot see — so an auth-status surface could only report "unauthenticated" on fully logged-in machines, which MCP hosts read as a blocker and then refused to run workflows. A run that genuinely hits ACP `AUTH_REQUIRED` still pauses with the non-secret `authContext`; its guidance now directs an out-of-band CLI login followed by re-calling `workflow` with `resumeFromRunId`. Programmatic credential injection and provider routing remain available as `@automatalabs/workflows` runner APIs (`completeAuth`, `listProviders` / `setProvider` / `disableProvider`) for embedding hosts, and the acp-agents lost-providers-capability error now points at the runner's `disableProvider` API.

### Patch Changes

- @automatalabs/workflows@0.26.5

## 0.6.5

### Patch Changes

- 171d686: Fix the `agentprism-workflow` executable exiting before the MCP initialize response when launched through an npm/pnpm bin shim (`npx @automatalabs/mcp-server` from Codex CLI or any MCP host reported "connection closed: initialize response"). The package bin now points at a dedicated `dist/cli.js` that starts the stdio server unconditionally, matching the MCP reference-server layout; `dist/index.js` remains runnable for documented direct-path registrations, with its entry-point guard made symlink-safe via realpath.

## 0.6.4

### Patch Changes

- b2b1a38: Fail loudly when a fresh agent process stops advertising the `providers` capability while gateway provider routing is still configured. Previously the initialize-time replay was advertise-gated but the connection was stamped current unconditionally, so a fresh process that no longer advertised `providers` (an npx-resolved backend version change, a command override/wrapper, or a startup-dependent advertisement) was silently marked up-to-date with no routing applied — subsequent runs then sent traffic direct-to-provider instead of through the configured gateway. `applyProviderIntents` now throws a non-recoverable `WorkflowError` in that case, naming the backend and both operator exits (restore the backend, or disable the provider via `workflow_disable_provider` / the runner's `disableProvider` API), replacing the silent skip-and-stamp. A backend with no recorded routing — including after a disable emptied the intents — is unaffected and stays byte-identical to the default-OFF baseline.
  - @automatalabs/workflows@0.26.4

## 0.6.3

### Patch Changes

- @automatalabs/workflows@0.26.3

## 0.6.2

### Patch Changes

- @automatalabs/workflows@0.26.2

## 0.6.1

### Patch Changes

- @automatalabs/workflows@0.26.1

## 0.6.0

### Minor Changes

- 13687bc: Surface the ACP `providers/*` options end-to-end (codex-acp 1.6.0 advertises them; the surface is base-spec generic for any agent advertising `agentCapabilities.providers`):

  - **acp-agents**: `setProvider()` now records a durable routing intent in the new `ProviderStore` (exported, with `ProviderIntent`) and recycles the pool; every fresh connection — pooled, dedicated, interactive — replays the recorded `providers/set` at the end of its `initialize` handshake, and pool selection is generation-gated so no session runs under stale routing. This is the providers/\* sibling of the dispose-after-authenticate fix: provider config is in-process agent state for codex-acp, so without record → recycle → replay a configured gateway silently applied to a throwaway process only. A replay failure fails the connection loudly instead of mis-routing traffic; `disableProvider()` drops the intent and recycles. New `ProviderCapableRunner` structural interface (implemented by `AcpAgentRunner`) for hosts that duck-type the provider surface.
  - **workflows**: re-export `ProviderCapableRunner`.
  - **mcp-server**: three new conditional tools registered when the injected runner is provider-capable (independent of the auth-tool gate): `workflow_providers` (read-only, redacted to non-secret routing — never headers, never `_meta`; unsupported backends report `providersSupported: false` instead of failing), `workflow_set_provider` (SECRET `headers` never echoed, journaled, or logged; durable via the runner's record → recycle → replay), and `workflow_disable_provider` (idempotent). Shapes/projections exported from `provider-tool-io`.

  Also verified against codex-acp 1.6.0's capitalized reasoning-effort display names: effort selection matches config option **values** (still lowercase), so `model[effort]` brackets are unaffected — covered by test fixtures mirroring the 1.6.0 catalog shape.

### Patch Changes

- Updated dependencies [13687bc]
  - @automatalabs/workflows@0.26.0

## 0.5.2

### Patch Changes

- @automatalabs/workflows@0.25.2

## 0.5.1

### Patch Changes

- @automatalabs/workflows@0.25.1

## 0.5.0

### Minor Changes

- b256305: Add durable paused checkpoints. Workflows can opt into `headless: "pause"`, expose a non-secret `checkpointContext`, and resume with a journaled `checkpointReplies` decision that survives cold restarts.

  Expose the checkpoint context through the shared and workflows type barrels, persist and classify `CHECKPOINT_REQUIRED` runs in the engine, and add the MCP pause-and-resume wire flow for clients without elicitation.

### Patch Changes

- Updated dependencies [b256305]
  - @automatalabs/shared-types@0.16.0
  - @automatalabs/workflows@0.25.0

## 0.4.5

### Patch Changes

- Updated dependencies [754eaab]
  - @automatalabs/shared-types@0.15.0
  - @automatalabs/workflows@0.24.1

## 0.4.4

### Patch Changes

- Updated dependencies [74623a9]
  - @automatalabs/workflows@0.24.0

## 0.4.3

### Patch Changes

- Updated dependencies [5349c81]
  - @automatalabs/workflows@0.23.3

## 0.4.2

### Patch Changes

- @automatalabs/workflows@0.23.2

## 0.4.1

### Patch Changes

- @automatalabs/workflows@0.23.1

## 0.4.0

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

### Patch Changes

- Updated dependencies [b70293b]
- Updated dependencies [fecf517]
- Updated dependencies [266beb2]
- Updated dependencies [80586e4]
  - @automatalabs/shared-types@0.14.0
  - @automatalabs/workflows@0.23.0

## 0.3.26

### Patch Changes

- @automatalabs/workflows@0.22.2

## 0.3.25

### Patch Changes

- @automatalabs/workflows@0.22.1

## 0.3.24

### Patch Changes

- Updated dependencies [e97b142]
  - @automatalabs/shared-types@0.13.0
  - @automatalabs/workflows@0.22.0

## 0.3.23

### Patch Changes

- Updated dependencies [e1339e0]
- Updated dependencies [e1339e0]
  - @automatalabs/workflows@0.21.0

## 0.3.22

### Patch Changes

- @automatalabs/workflows@0.20.3

## 0.3.21

### Patch Changes

- @automatalabs/workflows@0.20.2

## 0.3.20

### Patch Changes

- Updated dependencies [c5f65ec]
  - @automatalabs/workflows@0.20.1

## 0.3.19

### Patch Changes

- Updated dependencies [c55b5bf]
  - @automatalabs/workflows@0.20.0

## 0.3.18

### Patch Changes

- Updated dependencies [037ba2c]
  - @automatalabs/shared-types@0.12.1
  - @automatalabs/workflows@0.19.1

## 0.3.17

### Patch Changes

- Updated dependencies [fea0254]
  - @automatalabs/workflows@0.19.0

## 0.3.16

### Patch Changes

- 1b89287: Close out the remaining audit findings: dead-code removal, two small architecture seams, and a docs-truth pass with enforcement.

  - **workflow-engine**: `WorkflowManagerOptions.persistence` — inject a custom `RunPersistence` implementation (default filesystem behavior unchanged). New manager-level `journal` event (`{ runId, entry }`) streams journal entries as they append — the ingest seam for hosts that want live deltas instead of re-reading files; events are observation, so they emit even under `journaling: false` (which still writes no files and still disallows resume). Removed dead Pi-era exports: `DEFAULT_TOKEN_BUDGET`, keyword-trigger constants.
  - **acp-agents**: `AcpAgentRunner` now implements `Symbol.asyncDispose` (`await using` works); ownership rule documented (whoever constructs the runner disposes it). Removed the dead `ModelRoute.useRegex` flag.
  - **shared-types**: `ClaudeCodeSessionMeta` lost its phantom `model` member (nothing implemented it — Claude model selection rides `session/set_config_option`) and now actually types the Claude backend's session meta.
  - **workflows**: re-exports `RunPersistence` for embedders.
  - **mcp-server**: the MCP initialize response now reports the real package version instead of `0.0.0`.
  - Docs: corrected the root README's false claim that `cwd` isn't a script-level `agent()` option, the phantom Claude `_meta` model channel, stale Node 18/adapter-version references, missing elicitation events in event tables, and the acp-agents README's export list — now enforced by a docs-drift tripwire test that pins event tables and version citations to the code.

- e1c0612: Fix five audited half-wired behaviors:

  - `runDynamicWorkflow` now disposes the runner it creates internally (callers' injected runners are never disposed), eliminating a pooled-backend process leak for repeated calls in long-lived hosts.
  - `WorkflowRunOptions.instructions` is now actually prepended to every subagent's composed instructions, as documented. Unset behavior is byte-identical to before.
  - `AgentOptions.tier` now resolves through the model-tiers config (loaded once per run), with `WorkflowRunOptions.mainModel` as the documented fallback when a tier has no configured model; explicit models still win, and an unresolvable tier passes through raw so runner fallback signaling is unchanged. Journals from runs that never set `tier`/`mainModel` remain replay-compatible.
  - MCP checkpoint `confirm` now honors `kind: "select"` (enum form over `choices`), `kind: "input"` (string form), and `timeoutMs` (races elicitation and falls back to the checkpoint's headless default), instead of always eliciting a boolean.

- Updated dependencies [1b89287]
- Updated dependencies [e1c0612]
  - @automatalabs/shared-types@0.12.0
  - @automatalabs/workflows@0.18.0

## 0.3.15

### Patch Changes

- Updated dependencies [b94b824]
  - @automatalabs/shared-types@0.11.0
  - @automatalabs/workflows@0.17.0

## 0.3.14

### Patch Changes

- Updated dependencies [f743d0f]
  - @automatalabs/shared-types@0.10.0
  - @automatalabs/workflows@0.16.0

## 0.3.13

### Patch Changes

- Updated dependencies [8768dc5]
  - @automatalabs/workflows@0.15.0

## 0.3.12

### Patch Changes

- Updated dependencies [f1a42fb]
  - @automatalabs/workflows@0.14.0

## 0.3.11

### Patch Changes

- Updated dependencies [8fea18f]
  - @automatalabs/shared-types@0.9.0
  - @automatalabs/workflows@0.13.0

## 0.3.10

### Patch Changes

- Updated dependencies [d637882]
  - @automatalabs/workflows@0.12.0

## 0.3.9

### Patch Changes

- Updated dependencies [efa034a]
  - @automatalabs/workflows@0.11.0

## 0.3.8

### Patch Changes

- @automatalabs/workflows@0.10.1

## 0.3.7

### Patch Changes

- cd20994: Integrator hygiene: `recoverStaleRuns()` is now gated on the manager's `journaling` default — a `journaling: false` WorkflowManager (host keeps its own transcript/audit store) never rewrites persisted run state that belongs to journaling processes. All five published manifests now declare `engines.node >= 22` (previously only the private workspace root did).
- Updated dependencies [cd20994]
- Updated dependencies [cd20994]
  - @automatalabs/shared-types@0.8.0
  - @automatalabs/workflows@0.10.0

## 0.3.6

### Patch Changes

- Updated dependencies [1597c87]
  - @automatalabs/workflows@0.9.0

## 0.3.5

### Patch Changes

- @automatalabs/workflows@0.8.1

## 0.3.4

### Patch Changes

- Updated dependencies [dab0568]
  - @automatalabs/workflows@0.8.0

## 0.3.3

### Patch Changes

- Updated dependencies [bb771df]
  - @automatalabs/workflows@0.7.0

## 0.3.2

### Patch Changes

- Updated dependencies [96c6429]
  - @automatalabs/shared-types@0.7.0
  - @automatalabs/workflows@0.6.2

## 0.3.1

### Patch Changes

- Updated dependencies [e560e70]
  - @automatalabs/shared-types@0.6.0
  - @automatalabs/workflows@0.6.1

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
  - @automatalabs/workflows@0.6.0

## 0.2.1

### Patch Changes

- @automatalabs/workflows@0.5.1

## 0.2.0

### Minor Changes

- 3395bbf: Custom ACP backends + generic `_meta` passthrough — run **any** ACP agent as an `agent()` target, not just the built-in Claude/Codex pair.

  - **Backend registry**: register named ACP backends via `createAcpRunner({ backends: { name: { command, args?, env?, sessionMeta? } } })` or the `AGENTPRISM_BACKENDS` env var (JSON, same shape; the programmatic option wins per name; `claude`/`codex` reserved). Registered names route `model`/`tier` specs **before** the built-in heuristics: `model: "browser"` routes to the backend; `model: "browser/vision-large"` additionally selects `vision-large` from the agent's config-option catalog. `AGENTPRISM_DEFAULT_BACKEND` may name a registered backend. Custom backends speak the published generic dialect: a `schema` is forwarded as turn-level `_meta.outputSchema` (plain JSON Schema) and the result is JSON-parsed off the final assistant message, with the client-side validate/re-prompt ladder as the repair path.
  - **Generic `_meta` passthrough**: `RunOptions.meta` / `RunOptions.promptMeta` (script-level `agent(p, { meta, promptMeta })`) merge into the outgoing ACP `session/new` / `session/prompt` `_meta`, so workflows can drive any ACP agent's custom extension surface. Precedence: a custom backend's static `sessionMeta` defaults < per-call `meta` < backend protocol-critical keys (schema channels, Codex instruction forwards) < the engine `runId` stamp. Both fields are additive run inputs and never enter the resume identity hash — resume keys stay stable across meta changes.

### Patch Changes

- Updated dependencies [3395bbf]
  - @automatalabs/shared-types@0.4.0
  - @automatalabs/workflows@0.5.0

## 0.1.6

### Patch Changes

- 087e566: Docs-only: refresh package READMEs so npmjs.org reflects the current state — drop stale
  "pre-release / install from source" framing (the packages are published), and complete the
  `RunOptions` field lists (`baseInstructions` / `developerInstructions` on shared-types, `runId`
  on acp-agents). No code or API changes.
- Updated dependencies [087e566]
  - @automatalabs/shared-types@0.3.1
  - @automatalabs/workflows@0.4.1

## 0.1.5

### Patch Changes

- Updated dependencies [f2948b3]
  - @automatalabs/shared-types@0.3.0
  - @automatalabs/workflows@0.4.0

## 0.1.4

### Patch Changes

- Updated dependencies [93e4906]
  - @automatalabs/shared-types@0.2.0
  - @automatalabs/workflows@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [548815f]
  - @automatalabs/workflows@0.2.0

## 0.1.2

### Patch Changes

- f65e7a7: Per-package READMEs; mcp-server now consumes the @automatalabs/workflows SDK.
- Updated dependencies [f65e7a7]
  - @automatalabs/shared-types@0.1.2
  - @automatalabs/workflows@0.1.2

## 0.1.1

### Patch Changes

- b8303f6: Validate the OIDC trusted-publishing release pipeline (no functional changes).
- Updated dependencies [b8303f6]
  - @automatalabs/shared-types@0.1.1
  - @automatalabs/workflow-engine@0.1.1
  - @automatalabs/acp-agents@0.1.1
