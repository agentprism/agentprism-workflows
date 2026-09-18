# @automatalabs/pi-acp

## 0.9.2

### Patch Changes

- 21bb2ca: Remove the `repl` MCP tool and the `@automatalabs/repl-engine` package behind it.

  The MCP server's model-facing surface is now the `workflow` tool plus the capability-gated `workflow_monitor` view (and the app-only `workflow-events`, `workflow-runs`, `workflow-notifications` tools). The interactive per-project QuickJS REPL, its broker, its snapshot store, and everything in the server that existed only to serve it are gone. `@automatalabs/repl-engine` is deleted from the workspace and will receive no further releases; no other package imported it.

  **`@automatalabs/mcp-server` (breaking)**

  - The `repl` tool is no longer registered; `SERVER_INSTRUCTIONS` describes `workflow` only.
  - Removed exports: `replToolInputShape`, `replToolOutputShape`, `ReplToolOptions`, `createReplProjectState`, `ensureReplWorkspace`, `disposeReplProjectState`, `resetReplProjectState`, `renameAsideNeverOverwriting`, `ReplProjectState`, `ReplPresenceLedger`.
  - `CreateWorkflowServerOptions` drops `replRunner`, `replPresence`, `replEvalBreakChannel`, `replDrainBoundMs` and `disconnectReplClientOnClose`. `replClientId` had one non-REPL job — scoping `workflow_monitor` notification claims per legacy-era MCP client — and is kept under its honest name, `clientId`.
  - `WorkflowServerControl` drops `replBreakUrl()` (previously required), `replDefaultProjectDir()` and `disposeReplEvalBreakChannel()`. The shutdown hook the stdio entry used through the last of those is now the generic optional `dispose()`.
  - The in-process stdio entry serves over the SDK's `StdioServerTransport`; the worker-thread relay transport that existed to break a synchronous eval out of band is removed, and the shim no longer intercepts `tools/call` to fire it.
  - The daemon drops the REPL client-presence ledger and drain: `CreateDaemonOptions.replRunner` / `replDrainBoundMs` / `sessionTtlMs` / `evalBreakChannel`, `DaemonHandle.activeReplDrainCount()`, `WorkflowProjectRegistry.disposeReplStates()`, `ProjectContext.repl`, `DaemonInfo.replBreakUrl`, the `SessionRegistry` presence hooks (`onConnectionOpened`, `onLastConnectionClosed`, `onSessionDeleted`) and `evictDrainable`'s `keep` veto. Daemon idleness is sessions, runs and in-flight requests.
  - Removed environment knobs: `AGENTPRISM_REPL_EVAL_TIMEOUT_MS`, `AGENTPRISM_REPL_DRAIN_BOUND_MS`.
  - Existing per-project `repl/` stores on disk are left untouched and are no longer read.

  **`@automatalabs/workflows` (breaking)**

  - The MCP server bundled behind `npx @automatalabs/workflows mcp` no longer serves the `repl` tool, and the package no longer depends on `@automatalabs/repl-engine`. The programmatic SDK is unchanged.

  **`@automatalabs/acp-agents`, `@automatalabs/pi-acp`**

  - Documentation only: comments and README passages that attributed `InteractiveSession.awaitCurrentTurn()`, the `_session/loaded_turn` extension, the turn-text passthroughs, `onHandoff` and `runner.defaultBackendId()` to "the REPL broker" now describe them as the host re-attach surface they are. Those SDK and wire surfaces are unchanged and remain supported.

## 0.9.1

### Patch Changes

- 76bbf8f: AcpAgent SDK round 2: per-agent traits, `INVALID_ARGUMENT` for SDK misuse, system-prompt discovery,
  the message-level transcript (`turn.messages` / `agent.messages`), `stream()`, client-side function
  tools, the `permissions` rename, mid-session model switching (`setModel()` / a per-turn `model`), the
  opt-in `schemaRetries` structured repair ladder, transcript-carrying cold forks, and live Codex forks.

  `@automatalabs/shared-types`

  - New `WorkflowErrorCode.INVALID_ARGUMENT`: an SDK call (the `AcpAgent` surface) received invalid
    options or arguments, or was made in an invalid state such as after `close()`. Non-recoverable and
    distinct from `SCRIPT_VALIDATION_ERROR`, which stays the code for workflow scripts and for the
    one-shot runner / `InteractiveSession`.

  `@automatalabs/acp-agents`

  - **Breaking:** every error the `AcpAgent` surface raises for caller misuse now carries
    `INVALID_ARGUMENT` instead of `SCRIPT_VALIDATION_ERROR` — the constructor's pre-spawn guards (cwd,
    the reserved `"model"` config id, a malformed registry, `clientHandlers`, an unsupported
    `systemPrompt`), unknown config-option ids and modes, the per-turn schema gate, prompt images, the
    fork and cold-reopen routing rules, the lifecycle capability gates, `steer()` with no turn in
    flight, and any operation after `close()` / abort / process death. A shared validator's
    `SCRIPT_VALIDATION_ERROR` is re-coded at the agent boundary with its message, `recoverable=false`,
    `agentLabel`, and `details` preserved; the runner and `InteractiveSession` are unchanged.
  - New `AcpAgentTraits` / `describeBackendTraits(backend, registry, live?)`, `agent.traits`, and the
    spawn-free static `AcpAgent.traits(spec?, { backends? })`: `backendId`, `custom`, `defaultModeId`,
    the `fork` row, `systemPrompt` (`replace` / `append` plus `source`: `table` / `advertised` /
    `none` — a custom backend is `none` before open, since `CustomAcpBackend` carries no channel),
    `steering` / `loadedTurn` (`supported` / `not-advertised` / `unknown`),
    `structuredOutput` (`session-meta` / `turn-meta` / `client-tool`, derived from the `Backend`
    object's behavior), and `promptUsage`. The executable protocol-coverage tables answer before the
    agent opens; once the connection is up, the agent's initialize advertisements win — pi's bare
    `_meta.systemPrompt` block, the Codex fork's `agentCapabilities._meta["@automatalabs/codex-acp"]`
    block, and `initializeMeta.steering` / `loadedTurn`. The pre-open validators still read the tables.
  - Discovery carries traits: `ProbedConfigOptions.traits` (`AcpAgentRunner.probeConfigOptions` and
    the SDK probe runner) and `ValidateHarnessOptions.traits` on every probed harness of
    `probeHarnessConfig` / `AcpAgent.probe()`, computed from the live probe connection. The MCP
    byte-budgeted projection is unchanged and does not carry it.
  - Docs: the system-prompt tables now say what survives `replace` on each backend (Claude: nothing
    of the `claude_code` preset; pi: the append entries, project context files, skills, and cwd line;
    Codex: its other instruction layers, per the app-server protocol's documented field semantics).
  - New `AcpAgentMessage` and the message-level transcript: `turn.messages` (folded from the turn's
    update records) and `agent.messages` (the retained log — cumulative, a `load` replay included with
    its user prompts, seeded from the parent's snapshot on a live fork exactly like `history`/`text`,
    only the latest turn under `retainHistory: false`). `{ role: "user" | "assistant", content,
toolCalls, thoughts, receivedAt }`: the assistant-message boundary is exactly the `text` fold's
    (a `tool_call` / `tool_call_update` / `agent_thought_chunk` / `plan*` / `user_message_chunk`
    event or a changed ACP `messageId`), so `turn.text` is the text-bearing assistant messages joined
    by a blank line; consecutive text chunks fold into one text block; tool calls attach to the
    assistant message in progress (opening one when none is — a tool-first turn has a leading
    message with no text); thoughts attach to the assistant message that receives the next assistant
    content; a run of `user_message_chunk`s is one user message. `turn.toolCalls` is now the
    flattening of `messages[*].toolCalls` — one fold, same order and contents as before.
  - New `agent.stream(content, options?)`: the same turn as `prompt()` (same FIFO position, options,
    and `AcpAgentTurn`) as an `AcpAgentStream` — an async iterable that is its own iterator — of
    `AcpAgentStreamEvent`s: every bus event of THIS turn tagged `type` (an update once, under its
    `sessionUpdate` kind; never the `session_update` catch-all; permission / elicitation /
    raw_message and a concurrent `steer()`'s `steering` included), then the terminal
    `{ type: "turn", turn }`. The observer is attached the instant the turn is dequeued, so a queued
    stream never sees the previous turn's events; events are buffered without dropping; a rejected
    turn yields its buffered events and then throws that error once; leaving early (`break`,
    `return()`, `throw()`) drops a not-yet-started turn without going on the wire and sends the one
    `session/cancel` (plus the agent's escalation) to one in flight, resolving only once it settled.

  - **Breaking:** `AcpAgentOptions.tools` (the headless `ToolPolicy` allow/deny auto-policy) is renamed
    `permissions`; forks inherit it as before. There is no alias. The policy is consulted only when no
    `onPermissionRequest` resolver is installed — a resolver answers every request (the runner's
    default precedence); the docs previously claimed explicit lists beat the resolver and now describe
    the real order.
  - New client-side function tools: `AcpAgentOptions.tools?: AcpAgentToolDefinition[]` —
    `{ name, description, inputSchema (a typebox object schema), execute(input, ctx) }`, with
    `defineTool()` to infer the input type, `AcpAgentToolContext` (`sessionId`, `backendId`, `label?`,
    a best-effort `toolCallId?`, `signal`) and `AcpAgentToolResult` (a string, MCP content blocks —
    `@modelcontextprotocol/sdk`'s `ContentBlock`, the `tools/call` result shape, not ACP's — or
    `{ content, isError? }`). Every agent with tools runs its own local tool host (`AgentToolHost`,
    the `StructuredOutputToolHost` pattern generalized over a shared `LocalMcpHttpHost` base): an
    in-process Streamable HTTP MCP server on `127.0.0.1` behind an unguessable token path serving
    `tools/list` and `tools/call`, injected into `mcpServers` as `agent_tools` (`agent_tools_2`, … on a
    caller-name collision; `AGENT_TOOLS_SERVER_NAME`) on `session/new|resume|load|fork` and the id-only
    fork's reattach, separate from and coexisting with the `structured_output` host. Arguments are
    validated with typebox Convert + Check before `execute`; a validation failure or a thrown
    `execute` answers the agent with an `isError: true` result carrying the message, never a
    transport error. Names (`^[A-Za-z0-9_-]{1,64}$`, unique; `AGENT_TOOL_NAME_PATTERN`) and the
    object-typed `inputSchema` (`type: "object"` — MCP `tools/call` arguments are an object) are
    validated in the constructor (`INVALID_ARGUMENT` before any spawn); an agent that does not advertise
    `mcpCapabilities.http` fails the open with `INVALID_ARGUMENT` naming the backend — tools are never
    silently dropped. `ctx.signal` aborts on `cancel()`, a per-call signal, the agent's signal, and
    close; forks inherit the tools on a host of their own; the host closes with the agent, waiting up
    to one second for in-flight calls to flush. Calls surface through the backend's normal
    `tool_call` / `tool_call_update` events (pi: `mcp__agent_tools__<name>`).
  - Both local MCP hosts now close without waiting on a peer's keep-alive socket: idle connections
    are closed at once, requests still being answered get a bounded grace, then the rest are torn down.
    A close that lands while the host is still binding waits for the bind to settle and closes the
    socket it produced, so no listening socket outlives `dispose()`; the racing `listen()` rejects.
  - `StructuredOutputToolHost.dispose()` — the host the one-shot runner uses for the injected
    StructuredOutput tool, not only the agent's — now shares the local MCP host's close semantics:
    idle connections closed, a one-second drain grace for requests mid-answer, then the remaining
    connections force-closed, instead of awaiting `server.close()` indefinitely.
  - New mid-session model switching: `agent.setModel(spec)` (queued in the FIFO like `setMode`;
    sticky) and `AcpAgentPromptOptions.model` (applied before that turn, ahead of its
    `configOptions` and `mode` — open's order; sticky). The spec is resolved with the rule `fork()`
    applies to a `model` override — the runner's routing grammar, and it must route to this agent's
    backend and poolKey (`"<backendId>/<model id>"`) — otherwise `INVALID_ARGUMENT` naming both
    backends before anything is sent — `setModel` resolves the route before queueing the operation,
    so a refused spec on an agent that has not opened yet spawns nothing, and the per-turn message
    names the entry point used (`AcpAgent.prompt({ model })` / `AcpAgent.stream({ model })`); a
    backend-only or blank spec is refused the same way (there is no wire form for "unselect"). The
    switch is applied exactly like open's selection
    (`SessionHandle.selectModel`: `session/set_config_option { configId: "model" }` with the routed
    remainder verbatim; no aliases, coercion, catalog matching, or fallback), a wire rejection maps
    through the normal error path with `model` unchanged, and on success `agent.model` (now a getter)
    is the routed spec, so later forks and a cold `AcpAgent.resume(ref, { model: agent.model })`
    inherit the switch. `"model"` stays reserved in `configOptions`.

  - New opt-in structured repair ladder: `AcpAgentOptions.schemaRetries` and
    `AcpAgentPromptOptions.schemaRetries` (integer ≥ 0, `INVALID_ARGUMENT` otherwise; the per-turn value
    wins; forks inherit; default `0` keeps `prompt()` exactly one turn). With a budget, a turn that
    ended `end_turn` with `structured` absent is followed inside the same queued operation by up to
    that many repair turns on the same session, each sending the runner's repair prompt (the
    StructuredOutput-tool variant when the injected tool is active, else the JSON variant, with the
    previous attempt's `structuredError` appended — one package-internal `repairPromptText` in
    `structured-output.ts` that the runner's ladder now selects through as well; nothing new is
    exported) with the same turn `_meta`, so the native channel stays authoritative. Every repair turn is a real turn (events,
    `stream()`, `usage`, `cancel()`/`steer()`); the resolved turn is the final attempt's plus the new
    `AcpAgentTurn.structuredAttempts` (1 + repairs run; absent without a schema). An attempt that ended
    `cancelled` / `refusal` / `max_tokens` / `max_turn_requests`, or was walled, ends the ladder.
  - Cold forks carry the transcript: `AcpAgent.fork(ref)` prefers `session/load` for the id-only
    reattach (the replay lands in the child's `history`/`text`/`messages`/`replay`) and falls back to
    `session/resume` only when load is not advertised. The live `agent.fork()` keeps its resume-first
    choreography (the child is seeded from the parent). `PooledConnection.openPreparedReattachedSession`
    and `acquireForkedSession` take a `ReattachPreference` (`"resume"` default — the runner's
    continuation path is unchanged).
  - **Breaking (tables):** the `codex` row of `FORK_SESSION_TRAITS` is now `live` / `none` / `free` —
    the workspace `@automatalabs/codex-acp` fork keeps the forked thread subscribed and publishes its
    startup state, so `agent.fork()` on Codex is the fork handle itself with no `session/resume`
    reattach. `agent.traits.fork`, `BUILTIN_PROTOCOL_COVERAGE.codex.fork`, and the docs follow; the
    dist probes now assert the ABSENCE of the post-fork `threadUnsubscribe` and of the fork publish
    gate, and that thread/fork spreads the instruction overrides like thread/start and thread/resume.
    A Codex fork's `systemPrompt` (inherited or overridden) rides the `session/fork` request's `_meta`
    (`baseInstructions` / `developerInstructions`), which the workspace fork threads into `thread/fork`
    — there is no reattach to carry it any more. A custom entry wrapping upstream codex-acp (which
    still unsubscribes) must declare `id-only`.

  `@automatalabs/codex-acp`

  - Live `session/fork`: `SessionFork` no longer calls `thread/unsubscribe` on the forked thread
    (`thread/fork` subscribes the connection exactly like `thread/resume`; the v2 protocol has no
    separate subscribe request), and `CodexAcpServer.tryCreateSession` drops the `operation !== "fork"`
    publish gate so a forked session publishes `available_commands_update` and MCP startup status like
    a resumed one. The returned session id is promptable at once. `session/fork` now forwards the
    request's `_meta.baseInstructions` / `_meta.developerInstructions` into `thread/fork` exactly as
    `session/new` and `session/resume` / `session/load` forward them into `thread/start` /
    `thread/resume` (the reader moved to `InstructionOverrides.ts`, shared by all four call sites);
    previously a fork silently ran on Codex's default instructions. Observed live: the forked thread
    honors `baseInstructions`; a `developerInstructions` override on `thread/fork` reached the wire
    but the fork kept its source thread's developer instructions (Codex app-server behavior). Because
    the forked thread is subscribed from the moment `thread/fork` returns, a failure between it and
    the session install (the auth-state read, for example) now releases that subscription through
    the same stale-open cleanup a failed `session/resume` uses, instead of leaving the thread
    subscribed with no session state.

  `@automatalabs/workflows`

  - The facade re-exports the rest of the AcpAgent SDK surface it had left out: `AcpAgentTraits` /
    `describeBackendTraits`, `AcpAgentMessage`, and `AcpAgentStream` / `AcpAgentStreamEvent` /
    `AcpAgentStreamEventName`, next to `defineTool` and the tool types.

  `@automatalabs/pi-acp`

  - README correction: a replaced system prompt drops pi's default instruction text (the tool list
    with snippets, its guidelines, the docs/examples paths); pi still appends the append entries, the
    project context files, the skills block, and the `Current working directory` line. The previous
    text wrongly claimed the tool snippets and guidelines were kept.

## 0.9.0

### Minor Changes

- 5311099: Backend-neutral system prompt instructions: one `systemPrompt: { replace?, append? }` option (`SystemPromptOptions`) on `RunOptions`, `InteractiveSessionOptions`, and `AcpAgentOptions`, validated against the routed backend before a session opens and carried on the session `_meta` in each backend's own dialect.

  - **shared-types (breaking):** `RunOptions.baseInstructions` / `developerInstructions` are removed and replaced by `systemPrompt?: SystemPromptOptions` (`replace` swaps the backend's built-in system prompt, `append` adds to it). New `META_KEYS.systemPrompt`, `ClaudeSystemPromptMeta` / `ClaudeCodeSessionMeta.systemPrompt`, and `PiSystemPromptMeta` wire types.
  - **acp-agents (breaking):** `AcpAgentOptions.instructions` (`{ base, developer }`) is replaced by `systemPrompt`; `RunOptions` / `InteractiveSessionOptions` / `AcpSessionOptions` / `SessionMetaInputs` drop the Codex-only fields for the same shape. Every backend declares what it carries (`Backend.systemPrompt`, the executable `SYSTEM_PROMPT_SUPPORT` table pinned against the installed adapter dists and the docs): Codex maps `replace` / `append` onto its bare `baseInstructions` / `developerInstructions` keys; **Claude** now drives `claude-agent-acp`'s `_meta.systemPrompt` (a string for `replace`, `{ append }` for `append`, one joined replacement string for both); **pi** sends `_meta.systemPrompt { replace?, append? }` to pi-acp; OpenCode and custom registry backends carry no channel. `assertSystemPromptSupported` (exported) runs in `prepareSession`, the `AcpAgent` constructor, `fork()`, and the cold statics: a field the backend cannot carry, an unknown field, or a blank string is a non-recoverable `SCRIPT_VALIDATION_ERROR` naming the backend — instructions are never silently dropped, on any backend (previously Claude, pi, and OpenCode ignored them). The instructions ride `session/new`, `session/resume`, `session/load`, and `session/fork` (so an id-only fork's reattach carries them too), win over the same key in `meta`, and are inherited by forks.
  - **pi-acp:** new session system-prompt channel. `_meta.systemPrompt` on `session/new` / `resume` / `load` / `fork` — a string or `{ replace?, append? }` — becomes pi's `DefaultResourceLoader` overrides (`replace` takes the custom-prompt slot, `append` lands after the operator's append entries); advertised at initialize as `_meta.systemPrompt: { replace: true, append: true }`. A malformed value is rejected with `-32602` / `errorKind: "invalid_system_prompt"` (`data.field` names the offender) before any session state exists.
  - **repl-engine / workflows / workflow-engine:** the broker's structural session-options type and the facade barrels follow the seam (`SystemPromptOptions` is re-exported; the README documents the option in place of the Codex-only pair). Workflow scripts' `agent()` option whitelist is unchanged.

## 0.8.0

### Minor Changes

- 954d1be: Advertise discovery preferences from merged Pi enabledModels settings using Pi's native pattern resolver, including ordered available model IDs and unmatched patterns. Preserve the complete supported model catalog and refresh preference metadata when configuration changes.

## 0.7.0

### Minor Changes

- b098a93: Update Claude ACP to 0.75.1 with Claude Agent SDK 0.3.265, including faster session loading, restored message-specific forks, compaction tool lifecycle events, and persistent shell working directories across turns. Update Pi to 0.85.1 for the refreshed model catalog and prompt-cache fixes, and remove the obsolete pi-server dependency now that the local SDK excludes experimental remote harness code. Re-verify provider error fixtures and keep backend freshness metadata aligned with the shipped runtimes.

## 0.6.3

### Patch Changes

- 18561da: Update Claude's ACP adapter to 0.74.0 and the wrapped Claude Agent SDK to 0.3.261. The adapter validates supplied gateway URLs and adds opt-in subscription restrictions; existing host routing and permission behavior remain unchanged.

  Update the Pi runtime and matching agent-core fixture dependency to 0.85.0. This brings provider-stream fixes, compaction-aware idle/cancellation, and corrected fork compaction boundaries while preserving the integration's session/config API. Reverify provider-error guidance and pause/retry classifications against the published runtime.

  Declare the Pi server runtime imported by the SDK but omitted from its upstream dependency metadata, and include it in dependency freshness checks. Verify the packed adapter's public import in clean npm and pnpm installations.

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
