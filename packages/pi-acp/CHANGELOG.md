# @automatalabs/pi-acp

## 0.6.2

### Patch Changes

- 661d9d1: Keep workflow run control reachable across daemon version succession. Run leases now expose opaque owner identity, managers can safely cold-stop lease-free persisted runs, and daemon successors persist and forward authenticated stop/cancel operations to predecessor execution owners with an explicit fenced force escalation.

  Update the embedded Pi runtime packages to 0.84.4. The release changes an unused agent-loop hook ordering and otherwise delivers compatible session, compaction, provider-stream, and Windows abort fixes; the provider error-classification strings remain unchanged.

## 0.6.1

### Patch Changes

- 9ddec60: Update the monolithic Model Context Protocol TypeScript SDK to 1.30.0, MCP Apps to 1.7.5, the workspace Zod floor to 4.2, and the wrapped Claude Agent SDK runtime to 0.3.248 before the separately gated SDK v2 migration.

## 0.6.0

### Minor Changes

- 4be0807: Replace the REPL's state-dependent `followUp`/steering behavior with strict active-turn steering and durable queued turns. Agent handles now expose `steer`, `queue`, and `cancel`; `followUp` is removed. `steer` never starts or queues work and resolves only `injected`, `idle`, or `unsupported`. `queue` creates an independently awaitable, addressable FIFO turn on the same ACP session with exact cancellation, persistence, restore, and concurrency semantics.

  Make ACP extension metadata transport transparent. `customCapabilities` metadata gates and the derived steering/loaded-turn capability booleans are removed. Interactive steering returns the complete raw extension response, prompt turns expose their underlying `PromptResponse`, and extension owners interpret raw initialize metadata at the point of use.

  Pi ACP and Codex ACP now implement strict active-turn steering only. Idle or settlement-raced steering returns `promptRequired/noRunningTurn`; steering can no longer create a backend turn. REPL guest snapshots and call ledgers from the previous format are intentionally invalidated and auto-reset without executing old guest code.

## 0.5.1

### Patch Changes

- cad804a: Sync the Codex ACP fork with upstream `main` through `50f69e5`, preserving the full non-squashed upstream history and AgentPrism fork extensions. The upstream changes add ACP v1 permission presentation/lifecycle handling and expose permission-mode kinds while retaining the existing mode IDs.

  Update the embedded Pi runtime packages to 0.84.3. The release keeps model selection session-scoped by default, retains the existing steering APIs, and leaves provider-error classification unchanged.

## 0.5.0

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

## 0.4.1

### Patch Changes

- 3ebbfc3: ACP maintenance: bump the pi runtime to 0.84.2 (`pi-ai`, `pi-coding-agent`, `pi-agent-core`, exact pins).

  0.84.2 is a mechanical patch — no breaking changes. Its entries are additive features (fullscreen
  transcript search, a `defaultTools` setting, `--use-theme`, extension `expandPromptTemplates`,
  `createGatewayBindingFetch`, `AssistantMessage.endTurn`) and fixes (TUI rendering/mouse/LaTeX, a
  native Mistral Chat Completions transport replacing the SDK one, Google/Vertex tool-call stop
  handling, and a JSON/RPC `message_update` cumulative-usage streaming fix). None touch the pi-acp
  integration surface: pi-acp is a headless ACP server, so the TUI/mouse/LaTeX work is irrelevant; we
  import no renamed or removed symbol; and the npm diff is confined to the internal
  `@earendil-works/pi-*` family pins moving 0.84.1 -> 0.84.2.

  The classifier fixtures re-verify byte-identically against the installed pi v0.84.2 runtime (E1
  green — `auth-guidance.js` still emits `No API key found for ${providerDisplay}.` over
  `getProviderLoginHelp()`, and `agent-session.js` still carries the "Authentication failed for" /
  "Run '/login" / "to re-authenticate" prose the classifier keys on; pi-ai's
  retry/overflow/error-body/provider-retry util dists are unchanged), so only the pinned versions
  move: `FIXTURE_PI_PIN` and the exact-pin map in `packaging.test.ts`.

## 0.4.0

### Minor Changes

- 142a23e: The `_session/loaded_turn/ended` push is ORDERED behind the session's update pump (phase-D review round 6): a turn's final deltas are only enqueued (the pump delivers them asynchronously), and the ended notification was sent synchronously at turn finish — the terminal marker could reach the ACP client before the last chunk, and the re-attach seam settles with the accumulated text at the marker, durably recording PARTIAL output. The push now awaits the update pump (best-effort) before notifying, so the turn's final text always precedes its terminal marker on the wire.
- bd28cd9: The `_session/loaded_turn` vendor extension (the `_session/steering` precedent): turn-TERMINAL state for loaded sessions — the re-attach arm's authoritative completion evidence. Advertised at initialize as `_meta: { steering: { supported: true }, loadedTurn: { supported: true } }`; `_session/loaded_turn/query { sessionId }` answers whether the loaded session's founding turn is still running right now — `running` while a turn executes in this process (arming a one-shot watch that pushes `_session/loaded_turn/ended { sessionId, stopReason? | error? }` when that turn finishes), `completed` when the session journal's last message entry is an assistant message (pi persists every complete LLM message atomically at `message_end`, so a completed turn always leaves an assistant leaf and the replay's trailing assistant message is the turn's FINAL message — authoritative), and `interrupted` otherwise (an interrupted/abandoned turn — nothing is running, so re-issue is safe). Strict request parsing and `unknown_session` for unknown ids, mirroring the steering surface.

### Patch Changes

- fac9d5d: ACP maintenance: bump the pi runtime to 0.84.1 (`pi-ai`, `pi-coding-agent`, `pi-agent-core`).

  0.84.1 is a mechanical patch — it ships **no breaking changes** (unlike 0.84.0). Its entries are
  additive features (Qwen Token Plan Individual provider, `pi auth check`, fullscreen mouse/word
  selection and half-page scrolling, extension `tool_call` `terminate`) and fixes (Bun standalone
  startup, extension TUI wrapper recursion, Windows fullscreen paste, `Agent.reset()` now rejecting
  during active runs, LaTeX spacing, tmux/Zellij/Screen mouse volume). None touch the pi-acp
  integration surface: pi-acp is a headless ACP server, so the TUI/mouse/LaTeX work is irrelevant; we
  import no renamed/removed symbol; `Agent.reset()` is never called; and the npm dep diff is confined
  to the internal `@earendil-works/pi-*` family pins moving `^0.84.0` → `^0.84.1`. Typecheck is clean
  and the pi-acp packaging and classifier tests pass against the installed 0.84.1 dists; the ACP
  freshness gate reports `@earendil-works/pi-*` at `0.84.1 == latest`, and the live acp-agents steering
  e2e is green.

  The classifier fixtures re-verify byte-identically against the installed pi v0.84.1 runtime (E1
  green — the auth-guidance and provider-error prose still classify unchanged), so only the pinned
  versions move: `FIXTURE_PI_PIN` and the exact-pin map in `packaging.test.ts`.

## 0.3.2

### Patch Changes

- f9936cc: ACP maintenance: bump the pi runtime to 0.84.0 (`pi-ai`, `pi-coding-agent`, `pi-agent-core`).

  0.84.0 is a feature+breaking release (fullscreen TUI, Mermaid/LaTeX, per-directory context
  overrides, custom sampling params, Baseten provider). Its breaking items — renamed
  `ModelsStreamTransforms`, cumulative `message`/`partial` fields removed from `message_update`,
  signature changes to `getApiKeyAndHeaders()` / `refresh()` / `setRuntimeApiKey()` — do not
  touch the pi-acp integration surface: typecheck and the full suite are clean, and we read only
  `assistantMessageEvent.delta`, not the removed cumulative fields.

  The three auth guidance strings the classifier fixtures pin moved from literal `"anthropic"`
  forms to `${provider}` template literals in 0.84.0, but the classifier matches the stable
  substrings those templates resolve to, so E1's classification expectations are unchanged. Only
  the `FIXTURE_PI_PIN` moves, plus the exact-pin map in `packaging.test.ts`.

## 0.3.1

### Patch Changes

- ec21260: Update the direct pi runtime (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, dev `@earendil-works/pi-agent-core`) to 0.83.0, and map the new `"pending"` StopReason explicitly: a resolved turn whose terminal assistant message is still `"pending"` now fails through a named diagnostic instead of the generic unknown-stop-reason error. The provider-error classifier fixture pin was re-verified byte-identical against the 0.83.0 dists (auth guidance, agent-session auth prose, and pi-ai retry/overflow/error-body are unchanged). pi 0.83.0's TypeBox 1.3.7 alias upgrade removes only APIs this package never used; the pinned `typebox@1.3.2` type surface still checks clean.

## 0.3.0

### Minor Changes

- ffd83d1: Add first-class, capability-negotiated steering for held-open ACP sessions. Claude, Codex, and Pi
  support native `_session/steering`; OpenCode rejects it with a typed validation error. Expose the
  privacy-safe steering event through the workflows facade. Pi steering is codex-shaped: a live turn
  gets the content injected natively; an idle session (or a steer that races the end of a turn) runs
  it as a fire-and-forget `startedNewTurn` turn instead of erroring or leaking it into the next
  prompt; a steer racing a cancel resolves `failed` and never restarts cancelled generation.

## 0.2.8

### Patch Changes

- f150805: Repository metadata now points at `agentprism/agentprism-workflows` — the monorepo transferred from `VikashLoomba` to the `agentprism` GitHub organization. No runtime changes.

## 0.2.7

### Patch Changes

- 2859f7a: Cover the three teardown paths the `session_shutdown` fix left unverified: the failed-open branch (`FailedOpenCleanup`, which owns cleanup when pi exists but the session never became publishable), asynchronous extension handlers (proving disposal awaits `emit()` rather than racing past it), and many sessions in one process — the pooled/parallel shape the leak actually threatened. Each fails without the fix; with the emit removed all five children in the multi-session case survive, which is the per-process accumulation the bug caused.

## 0.2.6

### Patch Changes

- c384332: Shut pi down the way pi shuts itself down: emit `session_shutdown` before `AgentSession.dispose()`.

  `AgentSession.dispose()` aborts in-flight work and marks the extension context stale — it never tells extensions the session is over. Pi's own hosts do not call it bare; the interactive mode exits through `AgentSessionRuntime.dispose()`, which emits `session_shutdown` first. That event is pi's **only** extension-cleanup contract (`Extension` has no dispose hook, just a handler map), and it is where an extension releases what it owns, including any process it spawned.

  pi-acp called `dispose()` alone, so extension cleanup never ran and those processes outlived the session. Because pi-acp embeds pi **in-process**, an unreaped grandchild is our grandchild: its `ChildProcess` handle keeps the host's event loop alive, so a pi-acp process can stop exiting on its own and has to be reaped by the pool's SIGKILL escalation instead. The out-of-process backends (claude, codex, opencode) never showed this — the OS reaps their trees. Both disposal paths (normal and failed-open) now go through `shutdownPiSession`, which never throws, so a broken extension handler cannot strand cleanup.

  `PiAcpDeps` gains **`agentDir`**, the directory pi's settings, extensions, and MCP servers are loaded from. It defaults to pi's own `getAgentDir()` (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`), so a running server picks up the operator's real pi configuration exactly as before — user pi config stays fully live. It is injectable because `newSession()` reads it _before_ `createAgentSession`: the settings manager and resource loader are built from it, and the loader loads and starts the user's extensions at that point. A caller that stubs `createAgentSession` alone therefore still inherited the ambient configuration and everything it spawned, with no session runtime left to shut any of it down — which made the adapter's own suite load the developer's extensions and hang the test runner at exit on any machine with pi extensions configured. The field is **optional**, so the frozen `new PiAcpAgent(deps)` contract (pi-acp spec §4.1) stays source compatible: a hand-built deps object that omits it falls back to `getAgentDir()` and behaves exactly as before. `resolveDeps` always populates it, and a guard test keeps the adapter's own harness pinned to an isolated directory so the fallback cannot quietly return there.

## 0.2.5

### Patch Changes

- 3a55679: ACP dependency maintenance (2026-07-25). Bump the Pi SDK lockstep family
  (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`)
  to 0.82.1 — a patch release (Claude Opus 5 catalog entries, `ANTHROPIC_AUTH_TOKEN` gateway
  bearer auth, `If-None-Match` catalog revalidation) that changes no surface pi-acp integrates
  against; the provider-error fixture strings are re-verified byte-identical against the
  installed 0.82.1 dists.

  Also lifts the wrapped Claude runtime to npm `latest` with a root `pnpm.overrides` pin of
  `@anthropic-ai/claude-agent-sdk` to 0.3.220, because `@agentclientprotocol/claude-agent-acp@0.62.0`
  still exact-pins 0.3.219. That override is repository-local — it changes no published
  manifest — and goes away once the adapter catches up.

## 0.2.4

### Patch Changes

- c32c4d0: Bump the Pi SDK lockstep family (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-agent-core`) to 0.82.0. Adapt the event translator for the new
  `bash_execution_update` session event (ignored, like other session-side informational events).
  Pi 0.82.0 reshapes builtin kimi thinking-level domains — `moonshotai/kimi-k3` now advertises
  `low`/`high`/`max` — so per-model advertisement and clamping tests re-anchor to the new catalog,
  with the capped-ladder fixture made synthetic so future catalog drift cannot silently change what
  the test proves. Provider-error fixture strings re-verified byte-identical against the installed
  0.82.0 dists and release-tagged source tests.

## 0.2.3

### Patch Changes

- d4c6e60: Refresh the release-gated ACP dependency train. Pi now ships the 0.81.1 runtime packages with
  their compaction-retry, model-catalog, startup, and compatibility fixes; the Codex backend advances
  to the newly upstream-synchronized Automata Labs fork release.

## 0.2.2

### Patch Changes

- b46c70f: ACP dependency maintenance: pi runtime 0.81.0 (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, dev `@earendil-works/pi-agent-core`), `@agentclientprotocol/sdk` 1.3.0, and `@automatalabs/codex-acp` 1.6.9 (fork re-synced with upstream: MCP config-layer conflict fix, clearer config-load errors). Adapted pi-acp tests to pi-agent-core 0.81.0's required `streamFunction` option (renamed from `streamFn`); re-verified every pinned provider-error fixture string byte-identical against the 0.81.0 dists.

## 0.2.1

### Patch Changes

- 5cf8f96: Advertise Pi thinking levels per selected model, reject unrecognized values, and clamp recognized
  model gaps through Pi's SDK. Validate workflow thought levels against each call's selected model,
  including explicit clamp warnings and safe handling for backends without recognized-domain metadata.

## 0.2.0

### Minor Changes

- 3f8eb0e: Ship Pi's complete MCP client, standard StructuredOutput injection, configured model catalog,
  provider-error pin guard, tracked child cleanup, and end-to-end caller quarantine/timeout propagation.

## 0.1.3

### Patch Changes

- 0470ed1: Bump the embedded pi runtime to `@earendil-works/pi-coding-agent@0.80.10` (lockstep dev deps `pi-agent-core`/`pi-ai` included). Catalog-only upstream release — provider model metadata for Kimi/Moonshot/xAI/openrouter; no §14-cited surface changed (spec §0.3 repin note).

## 0.1.2

### Patch Changes

- 2beca1e: Promote Pi to a first-class built-in backend with exact-prefix model routing, native structured
  output, categorical provider errors, complete auth descriptors, bundled spawning, configuration
  discovery, and credential-free plus opt-in live end-to-end coverage. Update pi-acp's exact-pinned pi
  runtime and hermetic test dependencies to 0.80.9.

## 0.1.1

### Patch Changes

- 03b10b2: README: the custom-backend registration guidance now describes the current integration state and links the tracked built-in-backend issue instead of referencing an unfiled follow-up.

## 0.1.0

### Minor Changes

- f4f0f44: Add the in-process ACP server and reusable library adapter for the pi coding agent, embedding pi runtime 0.80.8.
