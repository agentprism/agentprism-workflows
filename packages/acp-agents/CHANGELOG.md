# @automatalabs/acp-agents

## 0.34.16

### Patch Changes

- Updated dependencies [2859f7a]
  - @automatalabs/pi-acp@0.2.7

## 0.34.15

### Patch Changes

- Updated dependencies [c384332]
  - @automatalabs/pi-acp@0.2.6

## 0.34.14

### Patch Changes

- Updated dependencies [3a55679]
  - @automatalabs/pi-acp@0.2.5

## 0.34.13

### Patch Changes

- Updated dependencies [bcc443f]
  - @automatalabs/shared-types@0.29.0

## 0.34.12

### Patch Changes

- 8b78eef: Dependency-gate maintenance: bump @agentclientprotocol/claude-agent-acp to 0.62.0 (wraps the
  current @anthropic-ai/claude-agent-sdk 0.3.219, retiring the root pnpm override) and
  @automatalabs/codex-acp to 1.6.12 (fork resynced with upstream's models-availability e2e fix).
- 8b78eef: Isolate every spawned `opencode acp` process behind fresh per-spawn XDG data/state/cache trees
  with the user's credentials seeded in (and autoupdate disabled for the child). Concurrent
  OpenCode instances share the sqlite database, snapshot git index, log, and auth.json, and
  interfere across sessions (anomalyco/opencode#31307, #29395, #21215, #38366, #37059) — observed
  as mid-run "ACP connection closed" once process-exclusive injected pooling overlapped opencode
  processes. Isolating only OPENCODE_DB is insufficient (#33321). User config (XDG_CONFIG_HOME)
  stays shared; an explicitly exported OPENCODE_DB passes through. Cross-process session reattach
  for opencode now falls back to the runner's fresh-session path.
- 8b78eef: Replace per-connection serialization for injected StructuredOutput runs with process-exclusive
  elastic pooling, including idle surplus reaping and full disposal coverage.

## 0.34.11

### Patch Changes

- Updated dependencies [c32c4d0]
  - @automatalabs/pi-acp@0.2.4

## 0.34.10

### Patch Changes

- Updated dependencies [13fe0d7]
  - @automatalabs/shared-types@0.28.0

## 0.34.9

### Patch Changes

- 3d80c62: Refresh ACP dependency pins: `@agentclientprotocol/claude-agent-acp` 0.61.0 (its own pin
  advances `@anthropic-ai/claude-agent-sdk` to 0.3.217; the root override advances the
  installed runtime to 0.3.218) and `@automatalabs/codex-acp` 1.6.11 (fork resynced with
  upstream v1.1.7: codex 0.145.0, plan-mode content emission fix, e2e fix). Doc citations
  updated in lockstep.

## 0.34.8

### Patch Changes

- d4c6e60: Refresh the release-gated ACP dependency train. Pi now ships the 0.81.1 runtime packages with
  their compaction-retry, model-catalog, startup, and compatibility fixes; the Codex backend advances
  to the newly upstream-synchronized Automata Labs fork release.
- Updated dependencies [d4c6e60]
- Updated dependencies [d4c6e60]
  - @automatalabs/pi-acp@0.2.3
  - @automatalabs/shared-types@0.27.1

## 0.34.7

### Patch Changes

- b46c70f: ACP dependency maintenance: pi runtime 0.81.0 (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, dev `@earendil-works/pi-agent-core`), `@agentclientprotocol/sdk` 1.3.0, and `@automatalabs/codex-acp` 1.6.9 (fork re-synced with upstream: MCP config-layer conflict fix, clearer config-load errors). Adapted pi-acp tests to pi-agent-core 0.81.0's required `streamFunction` option (renamed from `streamFn`); re-verified every pinned provider-error fixture string byte-identical against the 0.81.0 dists.
- Updated dependencies [b46c70f]
  - @automatalabs/pi-acp@0.2.2

## 0.34.6

### Patch Changes

- Updated dependencies [0a56f82]
  - @automatalabs/shared-types@0.27.0

## 0.34.5

### Patch Changes

- 30fbeee: Dispose pooled ACP backend process trees when the stdio MCP server receives a signal or client disconnect, including stale connections already removed from pool admission.

## 0.34.4

### Patch Changes

- f2dbaa5: Declare ordered versus exact-set thought-level semantics for every built-in ACP backend. Derive
  missing ordered domains from model-specific zero-token catalogs, clamp recognized values safely,
  and exact-reject OpenCode, custom, oversized, or inconsistent catalogs.

## 0.34.3

### Patch Changes

- 5cf8f96: Advertise Pi thinking levels per selected model, reject unrecognized values, and clamp recognized
  model gaps through Pi's SDK. Validate workflow thought levels against each call's selected model,
  including explicit clamp warnings and safe handling for backends without recognized-domain metadata.
- Updated dependencies [5cf8f96]
  - @automatalabs/pi-acp@0.2.1

## 0.34.2

### Patch Changes

- Updated dependencies [2561f67]
  - @automatalabs/shared-types@0.26.2

## 0.34.1

### Patch Changes

- Updated dependencies [6f47267]
  - @automatalabs/shared-types@0.26.1

## 0.34.0

### Minor Changes

- db208dd: Bump `@agentclientprotocol/claude-agent-acp` to 0.60.0 (configurable LLM providers) and
  `@automatalabs/codex-acp` to 1.6.8 (upstream codex 0.144.6 fork sync). Record and replay the
  durable Vertex routing config (`_meta.claudeCode.vertex.{projectId,region}`) so a `providers/set`
  for the Claude agent's `vertex` apiType survives pooled-connection replay; generic request-scoped
  `_meta` stays request-scoped as before.

## 0.33.0

### Minor Changes

- 82ede81: Add the executable built-in backend registry and generated dependency manifest, expose recursively
  frozen initialize metadata on session refs and events, preserve generic ACP extension passthrough,
  and document the registry-driven onboarding and routing contract.

### Patch Changes

- Updated dependencies [82ede81]
  - @automatalabs/shared-types@0.26.0

## 0.32.2

### Patch Changes

- 5aae083: Track `@anthropic-ai/claude-agent-sdk` 0.3.215 through the wrapped Claude runtime override.

## 0.32.1

### Patch Changes

- Updated dependencies [58606fa]
  - @automatalabs/shared-types@0.25.1

## 0.32.0

### Minor Changes

- a3d5613: Recover persisted pending and running workflows whose owning process has exited into an
  interrupted, resumable pause during construction and cold lookups. Crash snapshots with a
  journaled prefix use the `crash-residue` positional bridge when the admission environment is
  stable, while environment drift keeps the run all-live.
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

## 0.31.1

### Patch Changes

- 0e13e79: Refresh the wrapped `@anthropic-ai/claude-agent-sdk` runtime override to 0.3.214.

## 0.31.0

### Minor Changes

- 3f8eb0e: Ship Pi's complete MCP client, standard StructuredOutput injection, configured model catalog,
  provider-error pin guard, tracked child cleanup, and end-to-end caller quarantine/timeout propagation.

### Patch Changes

- Updated dependencies [3f8eb0e]
  - @automatalabs/pi-acp@0.2.0

## 0.30.2

### Patch Changes

- 660983b: Daily ACP dependency maintenance: codex-acp fork pin 1.6.7 (upstream sync, CI-only change) and root override advancing the wrapped `@anthropic-ai/claude-agent-sdk` runtime to 0.3.212.

## 0.30.1

### Patch Changes

- 0470ed1: Bump the codex-acp fork pin to 1.6.6 (upstream sync: CI-only publish-workflow change; no adapter behavior change).
- Updated dependencies [0470ed1]
  - @automatalabs/pi-acp@0.1.3

## 0.30.0

### Minor Changes

- 2beca1e: Promote Pi to a first-class built-in backend with exact-prefix model routing, native structured
  output, categorical provider errors, complete auth descriptors, bundled spawning, configuration
  discovery, and credential-free plus opt-in live end-to-end coverage. Update pi-acp's exact-pinned pi
  runtime and hermetic test dependencies to 0.80.9.

### Patch Changes

- 805c7b1: Declare the built-in `@automatalabs/pi-acp` dependency via the `workspace:*` protocol (exact version stamped at publish) so joint release PRs resolve before the new pi-acp version is published; the ACP dep gate no longer tracks the workspace sibling and docs cite it unversioned.
- Updated dependencies [2beca1e]
  - @automatalabs/pi-acp@0.1.2

## 0.29.0

### Minor Changes

- 023f552: Continue eligible usage-limit and authentication-paused agent turns from their recorded ACP sessions, with fail-to-fresh gates, durable diagnostics, and MCP output support.

### Patch Changes

- Updated dependencies [023f552]
  - @automatalabs/shared-types@0.24.0

## 0.28.1

### Patch Changes

- 8f2c109: Bump `@automatalabs/codex-acp` to 1.6.5 (upstream sync: Codex subagent activity over ACP merged into the fork).
- Updated dependencies [2a411c3]
  - @automatalabs/shared-types@0.23.0

## 0.28.0

### Minor Changes

- f93fcf3: Add optional `AcpEventContext.callIndex` correlation and thread it through session state,
  tombstones, and every contextual runner event. The value echoes `RunOptions.callIndex` when
  supplied; it is never sent on the ACP wire, placed in `_meta`, or used as session identity.

### Patch Changes

- Updated dependencies [f93fcf3]
  - @automatalabs/shared-types@0.22.0

## 0.27.1

### Patch Changes

- 0ff724b: Bump `@automatalabs/codex-acp` to 1.6.4 (upstream sync: plan and goal command actions merged into the fork).

## 0.27.0

### Minor Changes

- 805b51f: Replace shared error-message matching with adapter-owned structured provider-limit classification, carry typed reset metadata through workflow errors and the top-level SDK, and reserve abort classification for structured cancellation. Closes #149.

### Patch Changes

- Updated dependencies [805b51f]
  - @automatalabs/shared-types@0.21.0

## 0.26.0

### Minor Changes

- 134dffc: Expose ACP session config options as a verbatim per-call authoring surface, add routed no-prompt
  catalog probing to the runner and workflow validator, and preserve existing replay hash bytes when
  the new option bag is absent or empty.

### Patch Changes

- Updated dependencies [134dffc]
  - @automatalabs/shared-types@0.20.0

## 0.25.1

### Patch Changes

- Updated dependencies [ef2c64b]
  - @automatalabs/shared-types@0.19.0

## 0.25.0

### Minor Changes

- c81df46: Replace client-side model matching and modifier handling with deterministic registered-prefix routing and verbatim model selection by the serving ACP harness.

## 0.24.9

### Patch Changes

- Updated dependencies [f0f30ad]
  - @automatalabs/shared-types@0.18.0

## 0.24.8

### Patch Changes

- Updated dependencies [a4a5397]
  - @automatalabs/shared-types@0.17.0

## 0.24.7

### Patch Changes

- 346671d: Bump `@automatalabs/codex-acp` to 1.6.3 (fork release carrying the upstream codex 0.144.4 bump).

## 0.24.6

### Patch Changes

- 3705b7b: Bump `@automatalabs/codex-acp` to 1.6.2 (fork release carrying CI-workflow maintenance only; no runtime changes).

## 0.24.5

### Patch Changes

- b269a8f: The MCP server's tool surface is now the single `workflow` tool. The `workflow_auth_status`, `workflow_authenticate`, `workflow_providers`, `workflow_set_provider`, and `workflow_disable_provider` tools and the `AGENTPRISM_MCP_INLINE_AUTH` elicitation bridge are no longer part of the server: backend auth belongs to the agents' own CLI credential stores (`claude /login`, `codex login`, `opencode auth login`), which the server's host-side bookkeeping cannot see — so an auth-status surface could only report "unauthenticated" on fully logged-in machines, which MCP hosts read as a blocker and then refused to run workflows. A run that genuinely hits ACP `AUTH_REQUIRED` still pauses with the non-secret `authContext`; its guidance now directs an out-of-band CLI login followed by re-calling `workflow` with `resumeFromRunId`. Programmatic credential injection and provider routing remain available as `@automatalabs/workflows` runner APIs (`completeAuth`, `listProviders` / `setProvider` / `disableProvider`) for embedding hosts, and the acp-agents lost-providers-capability error now points at the runner's `disableProvider` API.

## 0.24.4

### Patch Changes

- b2b1a38: Fail loudly when a fresh agent process stops advertising the `providers` capability while gateway provider routing is still configured. Previously the initialize-time replay was advertise-gated but the connection was stamped current unconditionally, so a fresh process that no longer advertised `providers` (an npx-resolved backend version change, a command override/wrapper, or a startup-dependent advertisement) was silently marked up-to-date with no routing applied — subsequent runs then sent traffic direct-to-provider instead of through the configured gateway. `applyProviderIntents` now throws a non-recoverable `WorkflowError` in that case, naming the backend and both operator exits (restore the backend, or disable the provider via `workflow_disable_provider` / the runner's `disableProvider` API), replacing the silent skip-and-stamp. A backend with no recorded routing — including after a disable emptied the intents — is unaffected and stays byte-identical to the default-OFF baseline.

## 0.24.3

### Patch Changes

- 4e12336: Classify provider usage-limit walls carried in an ACP `RequestError` `.data` payload. Codex-acp reports a quota/usage-limit exhaustion as a JSON-RPC internal error (code `-32603`, message `"Internal error"`) with the real provider text — including any reset time — only in `.data.message`, which the ACP SDK reconstructs verbatim on the client. `errorText()` previously read only `.message`, so the wall classified as a recoverable `AGENT_EXECUTION_ERROR` and the engine retried into the same wall. It now folds string text from `.data.message`/`.data.details` into the classifiable text, so it matches as non-recoverable `PROVIDER_USAGE_LIMIT` with a `resetHint`, restoring the documented pause/resume behavior on the Codex backend. Backend-generic: any ACP agent that stuffs detail into `.data` benefits, and plain-message classification (the Claude path) is unchanged.

## 0.24.2

### Patch Changes

- ca1659d: Bump `@agentclientprotocol/claude-agent-acp` to 0.59.0 and `@automatalabs/codex-acp` to 1.6.1 (fork synced with upstream: fallback session titles, retryable turn errors as session status, context-compaction lifecycle, `request_user_input` elicitation, unregistered slash-command forwarding). Both adapters newly advertise the `additionalDirectories` session capability; all previously documented capability claims verified unchanged.

## 0.24.1

### Patch Changes

- 44bead8: Model catalog matching now tries the provider-prefixed spec with its `[effort]` bracket stripped (e.g. `zai/glm-5.2[max]` → `zai/glm-5.2`) before any fuzzy fallback. Previously a bracketed spec never exact-matched its own provider's catalog entry, so the substring fallback could select a cross-provider lookalike serving the same model name (OpenCode's catalog lists e.g. `huggingface/zai-org/GLM-5.2` ahead of `zai/glm-5.2`), silently routing the call — and its token limits — through the wrong provider.

## 0.24.0

### Minor Changes

- 13687bc: Surface the ACP `providers/*` options end-to-end (codex-acp 1.6.0 advertises them; the surface is base-spec generic for any agent advertising `agentCapabilities.providers`):

  - **acp-agents**: `setProvider()` now records a durable routing intent in the new `ProviderStore` (exported, with `ProviderIntent`) and recycles the pool; every fresh connection — pooled, dedicated, interactive — replays the recorded `providers/set` at the end of its `initialize` handshake, and pool selection is generation-gated so no session runs under stale routing. This is the providers/\* sibling of the dispose-after-authenticate fix: provider config is in-process agent state for codex-acp, so without record → recycle → replay a configured gateway silently applied to a throwaway process only. A replay failure fails the connection loudly instead of mis-routing traffic; `disableProvider()` drops the intent and recycles. New `ProviderCapableRunner` structural interface (implemented by `AcpAgentRunner`) for hosts that duck-type the provider surface.
  - **workflows**: re-export `ProviderCapableRunner`.
  - **mcp-server**: three new conditional tools registered when the injected runner is provider-capable (independent of the auth-tool gate): `workflow_providers` (read-only, redacted to non-secret routing — never headers, never `_meta`; unsupported backends report `providersSupported: false` instead of failing), `workflow_set_provider` (SECRET `headers` never echoed, journaled, or logged; durable via the runner's record → recycle → replay), and `workflow_disable_provider` (idempotent). Shapes/projections exported from `provider-tool-io`.

  Also verified against codex-acp 1.6.0's capitalized reasoning-effort display names: effort selection matches config option **values** (still lowercase), so `model[effort]` brackets are unaffected — covered by test fixtures mirroring the 1.6.0 catalog shape.

## 0.23.3

### Patch Changes

- feadc4e: Bump `@automatalabs/codex-acp` to 1.6.0 (upstream sync: codex 0.144.1, configurable LLM providers — the fork now advertises `providers` and implements `providers/list|set|disable` — and capitalized reasoning-effort labels).
- feadc4e: Structured output now reads the turn's FINAL assistant message instead of scanning the whole turn's concatenated text. Codex applies the `outputSchema` Responses-API constraint to every sampled assistant message in the turn (field report), so intermediate progress messages come back schema-shaped too — the previous first-balanced-JSON scan over the full turn could return a progress object instead of the result. `SessionState` now segments the final message at tool_call / tool_call_update / agent_thought_chunk / plan / user_message_chunk boundaries, `StructuredSource` gains `finalMessageText()`, and the Codex/OpenCode/custom backends plus the repair ladder's prose extraction all read it.

## 0.23.2

### Patch Changes

- 3241620: Bump the pinned `@agentclientprotocol/claude-agent-acp` to 0.58.1. The updated adapter now advertises `sessionCapabilities.fork`, so `runner.forkSession()` works live against Claude Code as well as OpenCode (verified: the forked session carries the source conversation's context).

## 0.23.1

### Patch Changes

- Updated dependencies [b256305]
  - @automatalabs/shared-types@0.16.0

## 0.23.0

### Minor Changes

- 754eaab: Add a driven `runner.forkSession({ sessionId, cwd, ... })` API — ACP `session/fork` through the full managed lifecycle (capability-gated on `sessionCapabilities.fork`, routed under the response's new session id, permissions/modes/configOptions adopted, normal `InteractiveSession` semantics including `keepSession`). Closes the last guarded hole in driven agent-method coverage (16 driven / 0 guarded); the raw escape hatch stays blocked for session-stateful methods. `AgentSessionRef.reopen` gains an optional `fork` flag mirroring the agent's advertisement (absent on records written before this field existed). Verified live against OpenCode, which advertises fork today.

### Patch Changes

- Updated dependencies [754eaab]
  - @automatalabs/shared-types@0.15.0

## 0.22.2

### Patch Changes

- 879edd2: Bump the pinned `@automatalabs/codex-acp` to 1.5.3 (upstream sync: Codex CLI 0.144.0 pairing, ACP SDK 1.2.1, MCP elicitation support, agent message phases). Restores structured output on the default-backend routing path with current Codex CLI installs.

## 0.22.1

### Patch Changes

- 50af559: Bump the exact `@automatalabs/codex-acp` pin to 1.5.2: client fs routing is scoped to reads — file-change diff content comes through the client's `fs/read_text_file` when advertised (unsaved-buffer-accurate diffs, disk fallback); file writes are codex-internal, as the app-server protocol delegates no file IO to the client.

## 0.22.0

### Minor Changes

- b70293b: Error taxonomy for ACP auth: classify `AUTH_REQUIRED` code-first on `-32000` (reserved
  exclusively for `authRequired`) so localized/rephrased auth messages no longer misroute
  into the retry ladder, plus a guarded prose fallback for non-conformant agents (a different
  reserved code that merely mentions the phrase never mis-routes). Adds a structured,
  non-secret `AuthErrorContext` (`backendId` + advertised method `{id,type,name}[]`) carried on
  `WorkflowError.authContext`, and an `isAuthRequired` type guard re-exported through
  `@automatalabs/workflow-engine`. Behavior-preserving for the three first-class agents.
- c746290: Client auth capability advertisement (§1.2), default-OFF. `AcpRunnerOptions` gains
  `authCapabilities?: { terminal?; gateway? }`, threaded through the pool and every dedicated
  connection into the one-time `initialize` handshake. When set, the client advertises
  `clientCapabilities.auth.terminal` + the top-level `_meta["terminal-auth"]` channel (terminal
  logins) and/or `auth._meta.gateway` (Claude/Codex gateway methods). When unset, the `auth`
  capability is **omitted entirely** — spec-"unsupported" — so runtime behavior is byte-identical
  to today until a host opts in. Adds a symmetric `describeClientAuthAdvertisement` diagnostic and a
  build-time drift tripwire (`assertAuthCapabilityShape` + compile-time type pins) over the SDK's
  UNSTABLE `AuthCapabilities` surface.
- f489b17: Auth contracts + `AuthStore` lifecycle + resolver + runner auth API (§1.3, §2, §4.1) — the core
  correctness PR (closes gap 3: the credential a `runner.authenticate()` stored on a dedicated
  connection no longer dies when that connection is disposed).

  New `packages/acp-agents/src/auth/{auth-types,auth-store}.ts`: the type-dispatched
  `AuthMethodDescriptor`/`AuthResolution`/`AuthContext`/`AuthResolver` contracts and the pure,
  agent-agnostic `buildAuthDescriptors` dispatcher (§1.3); the single per-runner `AuthStore`, its
  per-`poolKey` generation-stamped `BackendAuthMachine`, and the immutable `AuthIntent` that is the
  ONLY home for credential material (§2). Credentials live in the store, not on a connection: every
  connection pulls the current intent at the end of `initialize` (in-process gateway creds are
  replayed via `authenticate`; disk/spawn-env creds are only stamped), and the pool's
  `selectConnection` is generation-gated so no session is ever opened under stale auth — stale-busy
  connections drain, stale-idle ones recycle.

  Runner API (§4.1): `AcpRunnerOptions.onAuth` (inline resolve-and-retry-once at the run seam; the
  run never pauses when set), the `onAuth`-derived `authCapabilities` default `{ terminal:false,
gateway:true }`, `describeAuthMethods`/`completeAuth`, the `runner.auth` controller
  (`methods`/`authenticate`/`logout`/`status`/`canResume`), `listBackends`, and the
  `AuthCapableRunner` detection interface. Legacy `authenticate()`/`logout()` are rebuilt off
  dispose-after onto the `AuthStore` + pool recycle. A spawn-env overlay injects collected `env_var`
  values at spawn, and `stderrTail` is run through a secret-redaction pass.

  Default-OFF and byte-identical: a host that sets neither `onAuth` nor `authCapabilities` gets the
  exact pre-auth wire behavior. Ships the profile-less conformant `fake-auth-agent.mjs` fixture (§3.5)
  and its integration suite (the executable Principle-1 proof), plus descriptor/store/secret unit
  tests. Per-agent `AuthProfile`s and the engine pause-for-auth path remain PR7/PR4.

- 90b63bf: Per-agent auth profiles + codex spawn channel + `_meta` matrix tripwire + permission
  `_meta.persist` (§3, §2.8, §3.6). Adds `packages/acp-agents/src/auth/auth-profiles.ts` with one
  pure-data `AuthProfile` per built-in backend (`claudeAuthProfile`/`codexAuthProfile`/
  `opencodeAuthProfile`); a custom backend supplies none and runs the type-driven base flow verbatim
  (conformance-by-absence, §3.5). Each profile only refines client auth capabilities per backend
  (`clientAuthCapabilities`), relabels descriptors (`describe`, identity for built-ins), and reshapes
  the gateway payload (`buildMeta`, identity) — it never gates the flow (Principle 1). `codexAuthProfile`
  additionally carries the `spawnAuthEnv` lever that emits `DEFAULT_AUTH_REQUEST` for `api-key`/`gateway`
  intents, layered on top of the universal post-`initialize` replay (never required for correctness,
  §2.8/§3.3). The runner consults `profile.describe`/`buildMeta` and the connection refines
  `clientCapabilities.auth` through `profile.clientAuthCapabilities`; default-OFF stays byte-identical.

  Widens the permission outcome with an optional Codex tool-approval persistence directive: new
  `resolvePermission`/`withPersist` helpers and `PermissionResolution`/`PermissionPersist` types, plus
  `ToolPolicy.persist`, echo `_meta.persist` on the `RequestPermission` response (agents without the
  capability ignore it, Principle 3). Lands the full §3.6 `_meta` support matrix as executable
  drift-tripwire data (`AUTH_META_MATRIX`, `HANDLED_AUTH_METHOD_TYPES`, `AUTH_META_CONVENTION_KEYS`,
  `CODEX_SPAWN_AUTH_ENV`, `ACP_AUTH_REQUIRED_CODE_EXCLUSIVE`) with compile-time `AuthMethod`-union pins,
  installed-dist probes, and a spec-§3.6 lockstep assertion, so an SDK/agent bump that moves a `_meta`
  surface fails the build. Adds the env-gated `auth.live.e2e.test.ts` covering claude, codex, and
  opencode with equal structural depth.

### Patch Changes

- Updated dependencies [b70293b]
- Updated dependencies [fecf517]
  - @automatalabs/shared-types@0.14.0

## 0.21.2

### Patch Changes

- 2ec8093: Bump the exact `@automatalabs/codex-acp` pin to 1.5.1 (fork release-automation rollout; adapter code unchanged from 1.5.0).

## 0.21.1

### Patch Changes

- 1d4199e: Bump the exact `@automatalabs/codex-acp` pin to 1.5.0: the Codex adapter now routes file reads/writes through the client's `fs/read_text_file` / `fs/write_text_file` when — and only when — the client advertises `fs` capabilities. Inert for consumers that register no fs handlers (our advertisement is derived from the registered handler set).

## 0.21.0

### Minor Changes

- e97b142: Session hand-off from one-shot runs: `run()` now surfaces the ACP session identity out-of-band via `RunOptions.onSessionOpen` (an `AgentSessionRef` — sessionId, backend routing id, cwd, and the agent-advertised `reopen` capabilities), and `keepSession: true` skips the release-time best-effort `session/close` so the agent-persisted session stays re-openable via the existing `runner.loadSession()`/`resumeSession()`. Workflow runs record one `AgentSessionRecord` per live agent() call — on `WorkflowRunResult.agentSessions` (present even with `journaling: false`), in journal entries (restored on resume replay), and on the `agentEnd` event/snapshot — and scripts can opt in per call with `agent(prompt, { keepSession: true })`. `InteractiveSession` gains the same `keepSession` option plus a `sessionRef` getter so held-open sessions can be persisted and re-opened later. Previously the one-shot path discarded the session id at release, making completed agents unrecoverable even though the protocol and agents support re-attach.

### Patch Changes

- 24079f8: Bump `@automatalabs/codex-acp` to 1.4.1. The 1.4.0 release was cut from the fork's `main` branch, which was missing the `agentCapabilities._meta` custom-capability advertisement that shipped in 1.3.0; 1.4.1 re-lands it, so the client's declared-capability gating for `outputSchema`/`baseInstructions`/`developerInstructions` operates on a real advertisement again instead of legacy passthrough. Docs updated to cite 1.4.1.
- Updated dependencies [e97b142]
  - @automatalabs/shared-types@0.13.0

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
