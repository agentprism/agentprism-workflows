# @automatalabs/mcp-server

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
