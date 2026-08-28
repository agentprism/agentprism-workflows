# @automatalabs/workflows

## 0.55.0

### Minor Changes

- 2e87092: Automatically select and persist a no-prompt readiness-based default backend for model-less MCP workflow calls when no operator default is configured. Add host-pinned `defaultModel` execution/validation support and a probe-free mock routing-discovery option.

### Patch Changes

- Updated dependencies [2e87092]
  - @automatalabs/workflow-engine@0.39.0
  - @automatalabs/repl-engine@0.4.8

## 0.54.1

### Patch Changes

- Updated dependencies [7f67500]
  - @automatalabs/acp-agents@0.41.4
  - @automatalabs/repl-engine@0.4.7

## 0.54.0

### Minor Changes

- 6821b31: Migrate the MCP server to the official split TypeScript SDK v2 packages and serve both the legacy 2025 protocol and modern `2026-07-28` protocol. Preserve sessionful legacy daemon behavior while adding SDK-native HTTP/stdio era negotiation, modern multi-round-trip checkpoint and backend approval handling, subscriptions, request-scoped Apps capability projection, and restart-safe request-state verification.

  Add the workflow-engine `pauseOnCheckpoint` host seam so protocol adapters can turn a live checkpoint into the existing durable checkpoint/resume flow without changing authored headless behavior. Expose the optional checkpoint `timeoutMs` through shared checkpoint context and MCP result/event projections.

  Refresh the wrapped Claude Agent SDK runtime to 0.3.250; 0.3.249 and 0.3.250 are parity-only releases with no integrated API or wire changes.

### Patch Changes

- Updated dependencies [6821b31]
  - @automatalabs/acp-agents@0.41.3
  - @automatalabs/shared-types@0.32.0
  - @automatalabs/workflow-engine@0.38.0
  - @automatalabs/repl-engine@0.4.6

## 0.53.2

### Patch Changes

- Updated dependencies [9ddec60]
  - @automatalabs/acp-agents@0.41.2
  - @automatalabs/repl-engine@0.4.5

## 0.53.1

### Patch Changes

- @automatalabs/acp-agents@0.41.1
- @automatalabs/repl-engine@0.4.4

## 0.53.0

### Minor Changes

- ea0b68c: Add a model-facing `docs` tool that returns version-matched workflow and REPL authoring documentation one bounded topic at a time as an embedded MCP resource, with byte-identical static resources and a compact index. Decouple the server from the optional authoring skill and replace the giant `author-workflow` prompt injection with selective topic guidance.
- ea0b68c: Make agent configuration fail closed and fully discoverable. Config probes now return effective ACP session modes, including config-option fallback normalization and explicit `null` for unsupported modes; workflow preflight rejects guessed or unadvertised modes before admission. Workflow `agent()` rejects unknown option keys before allocation, while REPL rejects reserved `configOptions.model` with modelSpec-native guidance and preserves independent mode failures instead of falsely blaming carried config keys. Static external MCP resources now accept subscribe/unsubscribe as no-ops.

### Patch Changes

- Updated dependencies [ea0b68c]
- Updated dependencies [ea0b68c]
  - @automatalabs/acp-agents@0.41.0
  - @automatalabs/workflow-engine@0.37.2
  - @automatalabs/repl-engine@0.4.3

## 0.52.1

### Patch Changes

- Updated dependencies [affc0fe]
  - @automatalabs/workflow-engine@0.37.1
  - @automatalabs/repl-engine@0.4.2

## 0.52.0

### Minor Changes

- de4e704: Make the workflow MCP surface self-contained: add protocol-native live backend/config discovery, automatically run zero-token static and mocked validation before admission, return bounded structured rejection diagnostics without creating a run, and publish compact DSL guidance directly in the tool description and bundled authoring prompt. Reuse the server's live ACP runner for probes, including approved run-scoped backend definitions, without disposing host-owned runners.

### Patch Changes

- Updated dependencies [de4e704]
  - @automatalabs/acp-agents@0.40.0
  - @automatalabs/workflow-engine@0.37.0
  - @automatalabs/repl-engine@0.4.1

## 0.51.0

### Minor Changes

- 4be0807: Replace the REPL's state-dependent `followUp`/steering behavior with strict active-turn steering and durable queued turns. Agent handles now expose `steer`, `queue`, and `cancel`; `followUp` is removed. `steer` never starts or queues work and resolves only `injected`, `idle`, or `unsupported`. `queue` creates an independently awaitable, addressable FIFO turn on the same ACP session with exact cancellation, persistence, restore, and concurrency semantics.

  Make ACP extension metadata transport transparent. `customCapabilities` metadata gates and the derived steering/loaded-turn capability booleans are removed. Interactive steering returns the complete raw extension response, prompt turns expose their underlying `PromptResponse`, and extension owners interpret raw initialize metadata at the point of use.

  Pi ACP and Codex ACP now implement strict active-turn steering only. Idle or settlement-raced steering returns `promptRequired/noRunningTurn`; steering can no longer create a backend turn. REPL guest snapshots and call ledgers from the previous format are intentionally invalidated and auto-reset without executing old guest code.

### Patch Changes

- Updated dependencies [4be0807]
  - @automatalabs/acp-agents@0.39.0
  - @automatalabs/repl-engine@0.4.0

## 0.50.1

### Patch Changes

- @automatalabs/acp-agents@0.38.1
- @automatalabs/repl-engine@0.3.4

## 0.50.0

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
- Updated dependencies [205d110]
  - @automatalabs/acp-agents@0.38.0
  - @automatalabs/shared-types@0.31.0
  - @automatalabs/workflow-engine@0.36.1
  - @automatalabs/repl-engine@0.3.3

## 0.49.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [4b27257]
  - @automatalabs/acp-agents@0.37.4
  - @automatalabs/repl-engine@0.3.2

## 0.48.1

### Patch Changes

- Updated dependencies [dfe3c34]
- Updated dependencies [2137490]
  - @automatalabs/acp-agents@0.37.3
  - @automatalabs/repl-engine@0.3.1

## 0.48.0

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
  - @automatalabs/workflow-engine@0.36.0
  - @automatalabs/acp-agents@0.37.2

## 0.47.6

### Patch Changes

- Updated dependencies [216bc1c]
  - @automatalabs/acp-agents@0.37.1
  - @automatalabs/repl-engine@0.2.4

## 0.47.5

### Patch Changes

- Updated dependencies [4f18373]
  - @automatalabs/acp-agents@0.37.0
  - @automatalabs/shared-types@0.30.0
  - @automatalabs/repl-engine@0.2.3
  - @automatalabs/workflow-engine@0.35.3

## 0.47.4

### Patch Changes

- Updated dependencies [471de39]
  - @automatalabs/acp-agents@0.36.5
  - @automatalabs/repl-engine@0.2.2

## 0.47.3

### Patch Changes

- Updated dependencies [0c33e65]
  - @automatalabs/acp-agents@0.36.4
  - @automatalabs/repl-engine@0.2.1

## 0.47.2

### Patch Changes

- 0ddce7b: repl: emit `console.log` output and eval results up to the result byte budget instead of clamping every string to a 200-char preview.

  A directly emitted top-level string — a `console.log` argument or the eval result — is output the orchestrator asked to see, not a preview of a value's shape, so it is now carried whole up to the byte budget ("200 chars OR the KB max, whichever is greater") rather than head/tail-elided at 200 characters. A subagent's answer comes back whole in one call instead of forcing creative slice-by-slice extraction. The tool-result caps rise to **4000 lines / 50 KB** (from 256 / 10 KB), so a multi-line answer fits; only strings past the budget head/tail-elide (keeping their `$N` ref for the remainder). Nested and property strings are unchanged — they stay preview-short.

- 0ddce7b: mcp-server: add tool-use instructions and server instructions.

  The `repl` tool description now explains how a calling agent writes the eval `code`: the in-VM bridge (`agent()`, `checkpoint()`/`checkpoint.answer()`, `console` with addressable `$N` slices, handle methods `followUp`/`steer`/`cancel`), the guest library (`parallel`/`pipeline`/`verify`/`judgePanel`/`gate`/`retry`/`loopUntilDry`), started-not-awaited handles, stable call ids, and the `eval`/`wait`/`status`/`interrupt`/`reset` loop — alongside the existing persistence/reconciliation notes.

  The server now returns MCP `instructions` in its initialize response, orienting a host/agent to the two model-facing tools and when to reach for each: `workflow` for deterministic, resumable batch orchestration and `repl` for interactive, stateful orchestration.

- Updated dependencies [0ddce7b]
  - @automatalabs/repl-engine@0.2.0

## 0.47.1

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

  - @automatalabs/repl-engine@0.1.8

## 0.47.0

### Minor Changes

- 4a7e4b5: Run-monitor panel rebuilt on the MCP Apps negotiation model: UI-enabled registration
  (the panel resource, the workflow tool's UI metadata, and the app-only workflow-events
  tool) now requires the client to advertise the io.modelcontextprotocol/ui extension
  capability; all other clients get the identical text-only workflow tool. The panel
  updates itself by polling the app-only workflow-events tool (the spec's Interactive
  Updates pattern) and informs the model via ui/message for exactly three event families:
  phase changes, pauses (permission/attention needed), and terminal states.

### Patch Changes

- @automatalabs/repl-engine@0.1.7

## 0.46.10

### Patch Changes

- d4a0682: Revert the run-monitor panel pi push-channel change that shipped in
  mcp-server@0.26.6 / workflows@0.46.9 (owner decision: wrong implementation;
  a spec-compliant approach to app-resource-less hosts will follow). Restores
  the prior panel read path.
  - @automatalabs/repl-engine@0.1.6

## 0.46.9

### Patch Changes

- Updated dependencies [7e1f1db]
  - @automatalabs/acp-agents@0.36.3
  - @automatalabs/repl-engine@0.1.5

## 0.46.8

### Patch Changes

- Updated dependencies [05af591]
  - @automatalabs/acp-agents@0.36.2
  - @automatalabs/repl-engine@0.1.4

## 0.46.7

### Patch Changes

- 1a2f27d: Ensure the run-monitor panel is generated before the MCP entry bundle is built.

  `@automatalabs/workflows` `build` bundles `../mcp-server/src/entry.ts` with esbuild, whose import
  graph reaches the mcp-server run-monitor panel module. That module is now generated at build time
  (no longer committed), so the `build` script first runs the shared, idempotent generator
  (`scripts/ensure-run-monitor-html.mjs`) — the same one mcp-server's build invokes. This guarantees
  the artifact exists when esbuild bundles it, in any package build order and in a fresh clone,
  without introducing a package dependency edge (mcp-server already depends on workflows; the reverse
  would be a cycle).

  No user-facing behavior change: the emitted `dist/mcp-server.js` bundle and the served panel are
  unchanged.

  - @automatalabs/repl-engine@0.1.3

## 0.46.6

### Patch Changes

- Updated dependencies [dbddbce]
  - @automatalabs/workflow-engine@0.35.2
  - @automatalabs/repl-engine@0.1.2

## 0.46.5

### Patch Changes

- c6a896c: Fix a fresh-install crash: declare the `@automatalabs/repl-engine` runtime dependency.

  `@automatalabs/workflows` ships its MCP entry by bundling the mcp-server source with esbuild under
  `--external:@automatalabs/*`, so every `@automatalabs/*` import in that source stays a bare runtime
  import in `dist/mcp-server.js` and is resolved from the installed `@automatalabs/workflows` package.
  The REPL-orchestrator work added `@automatalabs/repl-engine` imports to the bundled source, but this
  package's manifest never declared the dependency (mcp-server's did). Workspace symlinks resolved it
  locally, so CI, the unit tests and the pre-push e2e stayed green — but a fresh registry install had no
  `@automatalabs/repl-engine` on disk, and `npx -y @automatalabs/workflows mcp` threw
  `ERR_MODULE_NOT_FOUND` for '@automatalabs/repl-engine' imported from `dist/mcp-server.js` on the first
  run of every clean machine. The fix declares `@automatalabs/repl-engine` in `dependencies` so the
  package manager installs it alongside `@automatalabs/workflows`.

  A new build-time gate (`scripts/check-workflows-bundle-deps.mjs`, run at the end of the package
  `build` and therefore in CI, the pre-push hook, and release) parses the built `dist/mcp-server.js` and
  requires every external bare `@automatalabs/*` specifier in it — in `import`/`export … from`,
  side-effect `import`, dynamic `import()`, and `require()`/esbuild's `__require()` positions — to be
  either this package's own name (a Node self-reference whose used subpath is covered by the `exports`
  map) or declared in this package's `dependencies` (only `dependencies`, since `optionalDependencies`
  and `peerDependencies` are not guaranteed installed), so this specific class of undeclared-bundled-import
  regression cannot ship again.

- Updated dependencies [db7b927]
  - @automatalabs/acp-agents@0.36.1
  - @automatalabs/repl-engine@0.1.1

## 0.46.4

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

- Updated dependencies [30f3aa5]
- Updated dependencies [bd28cd9]
- Updated dependencies [af917eb]
- Updated dependencies [fac9d5d]
- Updated dependencies [0c29a86]
- Updated dependencies [149b606]
- Updated dependencies [bcede5b]
  - @automatalabs/acp-agents@0.36.0

## 0.46.3

### Patch Changes

- @automatalabs/acp-agents@0.35.3

## 0.46.2

### Patch Changes

- Updated dependencies [193714b]
  - @automatalabs/acp-agents@0.35.2

## 0.46.1

### Patch Changes

- Updated dependencies [ec21260]
  - @automatalabs/acp-agents@0.35.1

## 0.46.0

### Minor Changes

- ffd83d1: Add first-class, capability-negotiated steering for held-open ACP sessions. Claude, Codex, and Pi
  support native `_session/steering`; OpenCode rejects it with a typed validation error. Expose the
  privacy-safe steering event through the workflows facade. Pi steering is codex-shaped: a live turn
  gets the content injected natively; an idle session (or a steer that races the end of a turn) runs
  it as a fire-and-forget `startedNewTurn` turn instead of erroring or leaking it into the next
  prompt; a steer racing a cancel resolves `failed` and never restarts cancelled generation.

### Patch Changes

- Updated dependencies [ffd83d1]
  - @automatalabs/acp-agents@0.35.0

## 0.45.8

### Patch Changes

- Updated dependencies [cf8ad1b]
  - @automatalabs/acp-agents@0.34.18

## 0.45.7

### Patch Changes

- f150805: Repository metadata now points at `agentprism/agentprism-workflows` — the monorepo transferred from `VikashLoomba` to the `agentprism` GitHub organization. No runtime changes.
- Updated dependencies [f150805]
- Updated dependencies [f150805]
  - @automatalabs/acp-agents@0.34.17
  - @automatalabs/shared-types@0.29.1
  - @automatalabs/workflow-engine@0.35.1

## 0.45.6

### Patch Changes

- @automatalabs/acp-agents@0.34.16

## 0.45.5

### Patch Changes

- @automatalabs/acp-agents@0.34.15

## 0.45.4

### Patch Changes

- @automatalabs/acp-agents@0.34.14

## 0.45.3

### Patch Changes

- Updated dependencies [bcc443f]
  - @automatalabs/shared-types@0.29.0
  - @automatalabs/workflow-engine@0.35.0
  - @automatalabs/acp-agents@0.34.13

## 0.45.2

### Patch Changes

- Updated dependencies [8b78eef]
- Updated dependencies [8b78eef]
- Updated dependencies [8b78eef]
  - @automatalabs/acp-agents@0.34.12

## 0.45.1

### Patch Changes

- @automatalabs/acp-agents@0.34.11

## 0.45.0

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
  - @automatalabs/workflow-engine@0.34.0

## 0.44.1

### Patch Changes

- Updated dependencies [13fe0d7]
  - @automatalabs/shared-types@0.28.0
  - @automatalabs/workflow-engine@0.33.0
  - @automatalabs/acp-agents@0.34.10

## 0.44.0

### Minor Changes

- 3d80c62: Persist per-tool results in agent transcripts. Terminal ACP `tool_call_update` notifications
  carrying displayable content now map to a new `tool-result` observability activity
  (`@automatalabs/workflows` adapter) and are published as durable `toolResult` transcript
  entries — redacted and byte-capped like every other transcript record — instead of being
  collapsed into a bare content boundary. Non-terminal and content-less updates keep the
  previous boundary behavior. The run event persistence schema accepts the new entry shape
  (`kind: "toolResult"`, optional `toolName`, optional `isError: true`).

### Patch Changes

- Updated dependencies [3d80c62]
- Updated dependencies [3d80c62]
  - @automatalabs/acp-agents@0.34.9
  - @automatalabs/workflow-engine@0.32.0

## 0.43.0

### Minor Changes

- 359046e: Add `npx -y @automatalabs/workflows mcp` to launch the embedded AgentPrism stdio MCP server without a separate `@automatalabs/mcp-server` install. The standalone server package remains independently available, and the embedded server reports the workflows package version in `serverInfo.version`.

## 0.42.0

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
- Updated dependencies [d4c6e60]
  - @automatalabs/acp-agents@0.34.8
  - @automatalabs/workflow-engine@0.31.0
  - @automatalabs/shared-types@0.27.1

## 0.41.1

### Patch Changes

- Updated dependencies [b46c70f]
  - @automatalabs/acp-agents@0.34.7

## 0.41.0

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
  - @automatalabs/workflow-engine@0.30.0
  - @automatalabs/acp-agents@0.34.6

## 0.40.6

### Patch Changes

- Updated dependencies [30fbeee]
  - @automatalabs/acp-agents@0.34.5

## 0.40.5

### Patch Changes

- f2dbaa5: Declare ordered versus exact-set thought-level semantics for every built-in ACP backend. Derive
  missing ordered domains from model-specific zero-token catalogs, clamp recognized values safely,
  and exact-reject OpenCode, custom, oversized, or inconsistent catalogs.
- Updated dependencies [f2dbaa5]
  - @automatalabs/acp-agents@0.34.4

## 0.40.4

### Patch Changes

- 5cf8f96: Advertise Pi thinking levels per selected model, reject unrecognized values, and clamp recognized
  model gaps through Pi's SDK. Validate workflow thought levels against each call's selected model,
  including explicit clamp warnings and safe handling for backends without recognized-domain metadata.
- Updated dependencies [5cf8f96]
  - @automatalabs/acp-agents@0.34.3

## 0.40.3

### Patch Changes

- Updated dependencies [2561f67]
  - @automatalabs/workflow-engine@0.29.2
  - @automatalabs/shared-types@0.26.2
  - @automatalabs/acp-agents@0.34.2

## 0.40.2

### Patch Changes

- 6f47267: Persist terminal-shaped interruption rows for every allocated call when a run halts, and retain non-result identity blockers so completed calls remain safely replayable across usage, auth, checkpoint, and host interruptions.
- Updated dependencies [6f47267]
  - @automatalabs/workflow-engine@0.29.1
  - @automatalabs/shared-types@0.26.1
  - @automatalabs/acp-agents@0.34.1

## 0.40.1

### Patch Changes

- Updated dependencies [db208dd]
  - @automatalabs/acp-agents@0.34.0

## 0.40.0

### Minor Changes

- 82ede81: Add the executable built-in backend registry and generated dependency manifest, expose recursively
  frozen initialize metadata on session refs and events, preserve generic ACP extension passthrough,
  and document the registry-driven onboarding and routing contract.

### Patch Changes

- Updated dependencies [82ede81]
  - @automatalabs/acp-agents@0.33.0
  - @automatalabs/shared-types@0.26.0
  - @automatalabs/workflow-engine@0.29.0

## 0.39.2

### Patch Changes

- Updated dependencies [5aae083]
  - @automatalabs/acp-agents@0.32.2

## 0.39.1

### Patch Changes

- 58606fa: Admit resume sources across current-environment and Node/V8 drift while preserving format, manifest, and per-call safety checks. Resume eligibility now reports typed runtime and environment provenance changes through SDK and MCP result surfaces.
- Updated dependencies [58606fa]
  - @automatalabs/workflow-engine@0.28.0
  - @automatalabs/shared-types@0.25.1
  - @automatalabs/acp-agents@0.32.1

## 0.39.0

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
  - @automatalabs/workflow-engine@0.27.0
  - @automatalabs/acp-agents@0.32.0

## 0.38.4

### Patch Changes

- Updated dependencies [0e13e79]
  - @automatalabs/acp-agents@0.31.1

## 0.38.3

### Patch Changes

- 3f8eb0e: Ship Pi's complete MCP client, standard StructuredOutput injection, configured model catalog,
  provider-error pin guard, tracked child cleanup, and end-to-end caller quarantine/timeout propagation.
- Updated dependencies [3f8eb0e]
  - @automatalabs/acp-agents@0.31.0

## 0.38.2

### Patch Changes

- Updated dependencies [660983b]
  - @automatalabs/acp-agents@0.30.2

## 0.38.1

### Patch Changes

- Updated dependencies [0470ed1]
  - @automatalabs/acp-agents@0.30.1

## 0.38.0

### Minor Changes

- 2beca1e: Promote Pi to a first-class built-in backend with exact-prefix model routing, native structured
  output, categorical provider errors, complete auth descriptors, bundled spawning, configuration
  discovery, and credential-free plus opt-in live end-to-end coverage. Update pi-acp's exact-pinned pi
  runtime and hermetic test dependencies to 0.80.9.

### Patch Changes

- Updated dependencies [805c7b1]
- Updated dependencies [2beca1e]
  - @automatalabs/acp-agents@0.30.0

## 0.37.1

### Patch Changes

- Updated dependencies [023f552]
  - @automatalabs/shared-types@0.24.0
  - @automatalabs/acp-agents@0.29.0
  - @automatalabs/workflow-engine@0.26.0

## 0.37.0

### Minor Changes

- f6d96bc: New `agentprism-workflows config [harness ...]` CLI command and `probeHarnessConfig()` API — validate's sibling. It runs the same no-prompt, zero-token config probe standalone (no script required) and reports each routable harness's advertised config-option catalog verbatim: model ids (including bracket variants like `opus[1m]`), effort levels, modes, and boolean knobs. Defaults to the built-in harnesses plus every `AGENTPRISM_BACKENDS` custom; a harness that cannot spawn or authenticate (or times out, `--timeout-ms`, default 60s) reports `probed:false` and exits 1 without blocking the others. `--json` emits the machine-readable `HarnessConfigReport` (per-harness entries in the same shape as validate's `harnessOptions`). Also exports `formatHarnessConfigReport()` and the `ProbeHarnessConfigOptions` / `HarnessConfigReport` types.

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
