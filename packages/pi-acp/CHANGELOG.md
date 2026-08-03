# @automatalabs/pi-acp

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
