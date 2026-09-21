# @automatalabs/acp-agents

## 3.3.0

### Minor Changes

- 3c2f672: Move to `@agentclientprotocol/sdk@^1.5.0` (ACP schema 1.23.0).

  The schema adds one UNSTABLE session update, `notice` — a fire-and-forget advisory (`severity`, `title`, optional `description`) an agent may send only to a client that advertises `clientCapabilities.session.notices`. AgentPrism does not advertise it, so no built-in agent sends one. Because event names are the ACP `sessionUpdate` discriminants verbatim, `notice` is now a typed event name on the runner and `AcpAgent` event buses and reaches the `session_update` catch-all like every other kind; the workflow activity projection counts it as backend activity, the same as the other non-content updates.

  The schema also stabilizes the tool-call `name` field (`ToolCall.name` / `ToolCallUpdate.name`), which AgentPrism already prefers for tool-policy matching. No request, response, or capability shape AgentPrism sends or reads changed.

### Patch Changes

- 3c2f672: Carry the wrapped Claude Code runtime to `@anthropic-ai/claude-agent-sdk@0.3.278` through the workspace override, ahead of `@agentclientprotocol/claude-agent-acp@0.79.0`'s own 0.3.274 pin. The SDK's type surface is byte-identical to 0.3.277. Claude Code 2.1.278 changes auto mode — the Claude backend's default mode — to run its permission classifier on the server for Claude API and Enterprise accounts and on Bedrock, Vertex, Foundry, and gateways, where it adds no classifier token overhead; `CLAUDE_CODE_AUTO_MODE_SERVER=0` opts out on the third-party platforms, and the runtime warns when it falls back to the billed client-side classifier.
- Updated dependencies [b0ee5e6]
- Updated dependencies [3c2f672]
  - @automatalabs/codex-acp@2.8.2
  - @automatalabs/pi-acp@0.9.3

## 3.2.1

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

- Updated dependencies [21bb2ca]
  - @automatalabs/pi-acp@0.9.2

## 3.2.0

### Minor Changes

- 71ab48d: A session reopened by its ref now comes back on the model it was running, on every backend.

  `AgentSessionRef` previously carried no model, and `AcpAgent.resume/load/fork(ref)` without a `model` option selected nothing, leaving the outcome to the agent. OpenCode, pi and Codex restore the session's own model; claude-agent-acp ranks `ANTHROPIC_MODEL` and the user's `settings.model` above the resumed transcript's model and re-asserts them on resume, so on a machine with such a pin a session opened on Haiku silently reopened on the pinned model.

  - `AgentSessionRef` gains an optional `model`: the routed spec (`<backendId>/<model id>`) of the model **selected** on the session when the ref was captured. `AcpAgent.sessionRef` reads it live (a `setModel()` or per-turn switch included) and keeps it after `close()`; `InteractiveSession.sessionRef` and the runner's `onSessionOpen` ref record it from `SessionHandle.selectedModel`. A session left on its backend's default records none.
  - `AcpAgent.resume(ref)`, `AcpAgent.load(ref)` and `AcpAgent.fork(ref)` default to `ref.model` and select it right after the reopen; an explicit `model` option still wins, and a ref without `model` selects nothing as before. A `model` that is present but not a non-empty string fails validation before any process spawns, and invalidates a recorded continuation session in the workflow engine.
  - So that the runner's ref can carry the model, `onSessionOpen` now fires once the model selection settled instead of just before it — still before config options, the mode, and the first prompt. A rejected selection still reports the session, without a `model`.
  - For `runner.loadSession()` / `resumeSession()` / `forkSession()`, which route by a `model` spec rather than a ref, pass `model: ref.model ?? ref.backendId`.

  Contract change: the previously documented and tested statement that "an `AgentSessionRef` carries no model" is replaced; the three tests that pinned it now pin the new contract, and the fork/resume live e2e asserts a reopen by ref alone lands on the ref's model.

### Patch Changes

- Updated dependencies [71ab48d]
  - @automatalabs/shared-types@3.3.0

## 3.1.0

### Minor Changes

- 4618813: Carry the wrapped Claude Code runtime to `@anthropic-ai/claude-agent-sdk@0.3.277` through a workspace override, ahead of `@agentclientprotocol/claude-agent-acp@0.79.0`'s own 0.3.274 pin, and stop counting a reopened or forked session's carried-over cost as new spend.

  **Cost accounting fix.** Per-turn and per-call cost is the growth of the agent's cumulative `usage_update.cost.amount` gauge, and that growth was measured from zero on every new handle. A gauge that carries the source session's total into a reopened or forked session therefore charged the whole earlier total to the first turn after the boundary. 0.3.277 makes Claude do exactly that on `session/resume` (a resumed session's `total_cost_usd` now continues from the earlier turns); OpenCode and pi already did it on resume, load, **and** fork, so the over-count predates this release for them. Now:

  - `AgentSessionRef` gains an optional `costGauge`: the session's latest cumulative cost gauge when the ref was captured. `AcpAgent.sessionRef` reads it live and keeps it after `close()`. `RunOptions` gains `onSessionCostGauge(amount)`, fired at most once at release next to `onUsage` (`onSessionOpen` fires before the first prompt and cannot carry it); the workflow engine folds it into the recorded `AgentSessionRecord`, so a paused call's gauge rides the `continueFromSession` directive on resume.
  - `UsageAccumulator.settleInheritedCost(seed?)` baselines the inherited total at the acquisition boundary, and every figure the accumulator reports (`baseline()`, `delta()`, `toAgentUsage()`) is the handle's own spend. `AcpAgent.resume/load/fork`, `agent.fork()`, and the runner's `continueFromSession` reattach seed it. A first reading below the seed proves the agent restarted its gauge, and nothing is subtracted; a reading that arrived during the reopen is itself the inherited total. `UsageAccumulator.costGauge` exposes the agent's cumulative figure for the ref.
  - New `COST_GAUGE_INHERITANCE` table (with `costGaugeInheritance()` and `COST_GAUGE_INHERITANCE_DEFAULT`) records, per built-in, whether the gauge `inherits` or `restarts` on reopen and on fork: Claude inherits on reopen and restarts on fork; OpenCode and pi inherit on both; Codex reports no cost; unknown and custom agents follow ACP's cumulative-session definition. The fork/resume live e2e asserts each installed agent against its row.
  - `AcpAgentTurn.usage.session.cost` is accordingly this agent's own spend rather than the raw gauge. A `costGauge` that is present but not a non-negative finite number fails `AcpAgent.resume/load/fork` validation and invalidates a recorded continuation session.

  **Runtime.** 0.3.275 fixes session history the adapter reads on `session/load` and fork (`getSessionMessages()` / `forkSession()` no longer miss a turn's assistant message right after its `result`, a queued message or task notification read while a tool was running comes back where it was read, `forkSession` accepts the id returned for a message sent mid-turn). 0.3.276 / Claude Code 2.1.276 fixes a 2.1.275 regression that failed every request with HTTP 400 behind an `ANTHROPIC_BASE_URL` gateway. 0.3.277 / 2.1.277 additionally reports an internal error and exits instead of hanging a headless session with no result, reads `AGENTS.md` in a project with no `CLAUDE.md`, and removes the deprecated `TaskOutput` tool.

### Patch Changes

- Updated dependencies [4618813]
- Updated dependencies [67668a6]
  - @automatalabs/shared-types@3.2.0
  - @automatalabs/codex-acp@2.8.1

## 3.0.2

### Patch Changes

- 3b9e249: Bump `@agentclientprotocol/claude-agent-acp` to 0.79.0. The adapter now pins `@anthropic-ai/claude-agent-sdk@0.3.274` itself, so the wrapped Claude Code runtime is unchanged and the workspace override that carried 0.3.274 ahead of the adapter is removed as redundant. Its one behavioral change is to shell-tool permission prompts (Bash and PowerShell): the permission `title` is the raw command rather than the tool's description, no longer whitespace-compacted or length-limited, and PowerShell gets the same `terminal_info` metadata as Bash. AgentPrism matches tool policy on the standard ACP `name` and uses `title` only as display decoration, so no adaptation is needed.
- Updated dependencies [7363614]
  - @automatalabs/codex-acp@2.8.0

## 3.0.1

### Patch Changes

- f6dddc1: Refresh the wrapped Claude Agent SDK runtime override to 0.3.274 (`@agentclientprotocol/claude-agent-acp` stays at 0.78.0, which pins 0.3.270). Mechanical: 0.3.274 / Claude Code 2.1.274 add only fields the adapter and AgentPrism do not read (`startup_failure_reason` on the stream-json error result, `mcpServer` / `source` on `canUseTool` options and MCP server status rows, the `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` and `CLAUDE_CODE_EMIT_STARTUP_TIMING` env opt-ins). The faster first turn still awaits `options.mcpServers`, where ACP-provided servers and AgentPrism's injected StructuredOutput / function-tool hosts ride, so structured output and function tools are unaffected; the `getSessionMessages()` fix means a `session/load` replay or a fork now includes a user message sent while a tool was running.

## 3.0.0

### Major Changes

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

### Patch Changes

- Updated dependencies [76bbf8f]
  - @automatalabs/shared-types@3.1.0
  - @automatalabs/pi-acp@0.9.1
  - @automatalabs/codex-acp@2.7.0

## 2.0.0

### Major Changes

- 5311099: Backend-neutral system prompt instructions: one `systemPrompt: { replace?, append? }` option (`SystemPromptOptions`) on `RunOptions`, `InteractiveSessionOptions`, and `AcpAgentOptions`, validated against the routed backend before a session opens and carried on the session `_meta` in each backend's own dialect.

  - **shared-types (breaking):** `RunOptions.baseInstructions` / `developerInstructions` are removed and replaced by `systemPrompt?: SystemPromptOptions` (`replace` swaps the backend's built-in system prompt, `append` adds to it). New `META_KEYS.systemPrompt`, `ClaudeSystemPromptMeta` / `ClaudeCodeSessionMeta.systemPrompt`, and `PiSystemPromptMeta` wire types.
  - **acp-agents (breaking):** `AcpAgentOptions.instructions` (`{ base, developer }`) is replaced by `systemPrompt`; `RunOptions` / `InteractiveSessionOptions` / `AcpSessionOptions` / `SessionMetaInputs` drop the Codex-only fields for the same shape. Every backend declares what it carries (`Backend.systemPrompt`, the executable `SYSTEM_PROMPT_SUPPORT` table pinned against the installed adapter dists and the docs): Codex maps `replace` / `append` onto its bare `baseInstructions` / `developerInstructions` keys; **Claude** now drives `claude-agent-acp`'s `_meta.systemPrompt` (a string for `replace`, `{ append }` for `append`, one joined replacement string for both); **pi** sends `_meta.systemPrompt { replace?, append? }` to pi-acp; OpenCode and custom registry backends carry no channel. `assertSystemPromptSupported` (exported) runs in `prepareSession`, the `AcpAgent` constructor, `fork()`, and the cold statics: a field the backend cannot carry, an unknown field, or a blank string is a non-recoverable `SCRIPT_VALIDATION_ERROR` naming the backend — instructions are never silently dropped, on any backend (previously Claude, pi, and OpenCode ignored them). The instructions ride `session/new`, `session/resume`, `session/load`, and `session/fork` (so an id-only fork's reattach carries them too), win over the same key in `meta`, and are inherited by forks.
  - **pi-acp:** new session system-prompt channel. `_meta.systemPrompt` on `session/new` / `resume` / `load` / `fork` — a string or `{ replace?, append? }` — becomes pi's `DefaultResourceLoader` overrides (`replace` takes the custom-prompt slot, `append` lands after the operator's append entries); advertised at initialize as `_meta.systemPrompt: { replace: true, append: true }`. A malformed value is rejected with `-32602` / `errorKind: "invalid_system_prompt"` (`data.field` names the offender) before any session state exists.
  - **repl-engine / workflows / workflow-engine:** the broker's structural session-options type and the facade barrels follow the seam (`SystemPromptOptions` is re-exported; the README documents the option in place of the Codex-only pair). Workflow scripts' `agent()` option whitelist is unchanged.

### Patch Changes

- Updated dependencies [5311099]
  - @automatalabs/shared-types@3.0.0
  - @automatalabs/pi-acp@0.9.0

## 1.3.0

### Minor Changes

- 07505a3: Add the `AcpAgent` SDK to `@automatalabs/acp-agents` (re-exported by `@automatalabs/workflows`
  together with `isAcpAgentTurnError` and the `AcpAgent*` types): a lazy, one-process-per-agent front
  door with FIFO turns (`prompt` returns the verbatim `PromptResponse` plus every session update, vendor
  notification, tool call, permission, this turn's usage and the agent's running session usage; a typed
  session failure rejects with the runner's mapped `WorkflowError` carrying the complete turn as
  `error.turn`), `steer`/`cancel`, live `fork()` (id-only backends are reattached automatically —
  `FORK_SESSION_TRAITS` pins claude/codex as `id-only` and opencode/pi as `live`, with dist probes;
  custom backends declare `fork: { disposition }`), cold `AcpAgent.resume/load/fork(ref)` routed by the
  ref's backend (never the default backend), `close({ keep })`, `Symbol.asyncDispose`, a single
  process-exit hook, and `AcpAgent.probe()` returning the harness config catalog plus a models view.

  - `agent.model` is the model the agent selects at open as a routing spec that leads back to the same
    backend (`<backendId>/<model id>`), or `undefined` when none was selected; forks inherit it. An
    `AgentSessionRef` carries no model, so a cold reopen keeps it only when passed back
    (`AcpAgent.resume(ref, { model: agent.model })`).
  - `PROMPT_USAGE_SCOPES` pins that every installed agent reports `PromptResponse.usage` per turn
    (dist-probed); `AcpAgent` sums turns into `usage.session` itself.
  - `SessionHandle.promptOutcome()` returns `{ response, failure? }` without throwing on a typed session
    failure; `prompt()` is unchanged. `StructuredOutputToolRegistration.takeCaptured()` returns and clears
    the capture.
  - `CustomBackendConfig.fork?: { disposition: "id-only" | "live", cwd?: "source-only" | "free" }`
    (`CustomBackendForkConfig`, validated at registry load) tells the SDK how a custom agent answers
    `session/fork`; entries wrapping claude-agent-acp or codex-acp must declare `id-only`.
  - The harness config catalog (`probeHarnessConfig`, `buildHarnessModelsView`, `buildModelFilter`,
    `buildHarnessConfigSummary`, `formatHarnessConfigSummary`, the select-choice helpers,
    `HarnessConfigReport`, `ValidateHarnessOptions`, `ValidateProbeRunner`) now lives in
    `@automatalabs/acp-agents`; `@automatalabs/workflows` re-exports the same names unchanged and keeps
    `formatHarnessConfigReport` and the `config` CLI.
  - `resolveModelRoute` / `ModelRoute` are exported from `@automatalabs/acp-agents` (moved out of the
    runner unchanged).
  - `redactText` and `truncateUtf8` moved to `@automatalabs/shared-types` (now byte-counting with
    `TextEncoder`, no Node globals); `@automatalabs/workflow-engine` and `@automatalabs/workflows`
    re-export them unchanged.
  - `Backend.rawMessagesMeta()` (optional) lets a backend switch its vendor notification stream on; the
    Claude backend implements it so schema-less `AcpAgent` sessions receive `_claude/sdkMessage` by
    default.
  - The fake ACP agent fixture gains fork knobs (`idOnly`, `replay`, `turns`) and `tool_call` name
    passthrough; the pre-push hook runs the new `AcpAgent` fork/resume live leg.

### Patch Changes

- Updated dependencies [07505a3]
  - @automatalabs/shared-types@2.3.0

## 1.2.7

### Patch Changes

- 82fc72e: Bump `@agentclientprotocol/claude-agent-acp` to 0.78.0 and refresh the wrapped Claude Agent SDK runtime override to 0.3.273 (0.78.0 pins 0.3.270). 0.77.0's breaking change removes the `claudeCode.options.agent` main-thread agent picker, which AgentPrism never sent. The adapter now sets the standard ACP `name` on every initial `tool_call` alongside `_meta.claudeCode.toolName`; AgentPrism prefers that standard field for tool-policy matching and history entries and keeps the vendor `_meta` key as the fallback (the same field the synced codex-acp 1.12 emits). Hosts can opt a session out of `bypassPermissions` via `claudeCode.options.allowDangerouslySkipPermissions: false` (not sent; bypass availability unchanged), replayed user messages on `session/load` no longer carry injected `<system-reminder>` blocks, and 0.78.0's experimental compaction updates are emitted only to clients that advertise `clientCapabilities.session.compaction`, which AgentPrism does not, so the update stream is unchanged; its AIR diff counts and checkpoint-derived file-change reports are additive `_meta`. Claude Code 2.1.269–2.1.273 change nothing on the adapter surface (resumed headless sessions keep a turn's replies across a mid-turn model switch or retry; auto-compaction no longer wedges on "Prompt is too long"; sub-agents whose final reply omitted usage or a model id are no longer reported as failed). Documentation now records that the adapter's `session/fork` returns an id-only fork that must be opened with `session/resume` or `session/load` before prompting.
- Updated dependencies [98bea95]
  - @automatalabs/codex-acp@2.6.0

## 1.2.6

### Patch Changes

- Updated dependencies [fef6ac6]
- Updated dependencies [fef6ac6]
  - @automatalabs/shared-types@2.2.0

## 1.2.5

### Patch Changes

- efe2c6e: Refresh the wrapped Claude Agent SDK runtime to 0.3.268 (workspace override; `@agentclientprotocol/claude-agent-acp` stays at 0.76.0, which still pins 0.3.257). The runtime's changes are additive or outside AgentPrism's integration surface: the new `result_index`, `local_command`, and `resume_reason` message fields and the `canUseTool` prompt hints (`defaultToNo`, `suppressAlwaysAllowRule`) are not read by the adapter; `setModel()` now confirms a model id the CLI does not know locally with the API on first use instead of refusing it, which AgentPrism never reaches because admission validates routed ids against the discovered catalog; and the task-tracking tools (TaskCreate/Get/Update/List, TodoWrite) are default tools only on Claude 3.x, Opus 4.0–4.7, Sonnet 4.0–4.6, and Haiku 4.5, so an agent definition that relies on them with a newer model must list them in `tools`. The new `verification_required` assistant error kind reaches AgentPrism as a generic provider error, exactly like `account_on_hold`; neither is a usage-limit pause. Claude Code 2.1.268 also fixes every turn failing with HTTP 400 on third-party Anthropic-compatible endpoints (`ANTHROPIC_BASE_URL`) since 2.1.265.

## 1.2.4

### Patch Changes

- 3448db1: Refresh `@agentclientprotocol/claude-agent-acp` to 0.76.0 and its wrapped Claude Agent SDK runtime to 0.3.267 (workspace override). The adapter now advertises the AIR recommended-config-value extension to clients that opt in; AgentPrism does not opt in, so no recommendation hint is received and explicit model routing is unchanged. The runtime records custom system prompts by default; AgentPrism folds instructions into the prompt text and never drives `systemPrompt`, so behavior is unchanged.
- Updated dependencies [d9ebf60]
  - @automatalabs/codex-acp@2.5.0

## 1.2.3

### Patch Changes

- Updated dependencies [954d1be]
- Updated dependencies [954d1be]
  - @automatalabs/shared-types@2.1.0
  - @automatalabs/pi-acp@0.8.0

## 1.2.2

### Patch Changes

- Updated dependencies [c1ceaec]
  - @automatalabs/shared-types@2.0.0

## 1.2.1

### Patch Changes

- 6005ed8: Update the wrapped Claude Agent SDK runtime to 0.3.266 and verify the ACP adapter against the current published runtime.

## 1.2.0

### Minor Changes

- b098a93: Update Claude ACP to 0.75.1 with Claude Agent SDK 0.3.265, including faster session loading, restored message-specific forks, compaction tool lifecycle events, and persistent shell working directories across turns. Update Pi to 0.85.1 for the refreshed model catalog and prompt-cache fixes, and remove the obsolete pi-server dependency now that the local SDK excludes experimental remote harness code. Re-verify provider error fixtures and keep backend freshness metadata aligned with the shipped runtimes.

### Patch Changes

- Updated dependencies [b098a93]
- Updated dependencies [b098a93]
  - @automatalabs/codex-acp@2.4.2
  - @automatalabs/pi-acp@0.7.0

## 1.1.3

### Patch Changes

- Updated dependencies [6a52287]
  - @automatalabs/codex-acp@2.4.1

## 1.1.2

### Patch Changes

- 18561da: Update Claude's ACP adapter to 0.74.0 and the wrapped Claude Agent SDK to 0.3.261. The adapter validates supplied gateway URLs and adds opt-in subscription restrictions; existing host routing and permission behavior remain unchanged.

  Update the Pi runtime and matching agent-core fixture dependency to 0.85.0. This brings provider-stream fixes, compaction-aware idle/cancellation, and corrected fork compaction boundaries while preserving the integration's session/config API. Reverify provider-error guidance and pause/retry classifications against the published runtime.

  Declare the Pi server runtime imported by the SDK but omitted from its upstream dependency metadata, and include it in dependency freshness checks. Verify the packed adapter's public import in clean npm and pnpm installations.

- Updated dependencies [18561da]
- Updated dependencies [18561da]
  - @automatalabs/codex-acp@2.4.0
  - @automatalabs/pi-acp@0.6.3

## 1.1.1

### Patch Changes

- 3a3932c: Refresh the wrapped Claude Agent SDK runtime override from 0.3.259 to 0.3.260. The update improves managed auto-mode settings, structured-output exhaustion diagnostics, rate-limit refresh events, rewind failure reporting, and remote-session telemetry without changing AgentPrism's terminal-result, usage, or host-brokered permission integration surfaces.

## 1.1.0

### Minor Changes

- 58b4a86: Add the AgentPrism ACP server package with negotiated discovery connections, connection-pinned backend proxying, transparent ACP V1 traffic forwarding, and shared raw backend-process access from acp-agents.

## 1.0.2

### Patch Changes

- Updated dependencies [81b2209]
  - @automatalabs/codex-acp@2.3.2

## 1.0.1

### Patch Changes

- 620c9ca: Refresh the wrapped Claude Agent SDK runtime override from 0.3.258 to 0.3.259. The update adds batched user-message correlation, an opt-in no-prompt permission policy, and Claude Code parity without changing AgentPrism's host-brokered permission, terminal-result, or usage integration surfaces.
- Updated dependencies [620c9ca]
  - @automatalabs/shared-types@1.1.0

## 1.0.0

### Major Changes

- c562237: Remove model-facing agent execution timeout fields, idle-watchdog callbacks, and timeout error codes from the shared runtime contract.

  Remove total-wall and idle agent timers from workflow execution while preserving explicit call and run cancellation and compatibility reads for historical timeout records.

  Remove the ACP runner activity/interaction callbacks that existed only to drive the engine idle watchdog.

  Remove agent execution limits and configurable config-probe timing from the workflow SDK surface.

  Remove agent and probe timeout inputs and timeout projections from the MCP workflow tool schema and status output.

### Patch Changes

- Updated dependencies [c562237]
- Updated dependencies [c562237]
  - @automatalabs/shared-types@1.0.0

## 0.43.1

### Patch Changes

- 52c7701: Refresh `@agentclientprotocol/claude-agent-acp` to 0.73.0 and its wrapped Claude Agent SDK runtime to 0.3.258. Engine-owned Claude sessions now receive a stable label-derived title so the updated adapter does not launch an unobserved background title-generation model call; interactive sessions retain generated titles.
- Updated dependencies [fd3bda3]
  - @automatalabs/codex-acp@2.3.1

## 0.43.0

### Minor Changes

- 06725fd: Add live workflow permission brokering and explicit first-class mode defaults. MCP inspect/await now expose pending ACP permission requests through a credential-redacted 64 KiB projection that omits private session ids while preserving the complete ordered exact option set or failing closed. Elicitation-capable clients can answer those options, and other clients can use the new `permissions-response` action; public responses forbid caller metadata and route to the daemon generation that owns execution. Permission waits suspend idle detection without stopping the total-wall clock. Config output now preserves harness mode names, descriptions, metadata, and reports the AgentPrism defaults (`auto`, `agent`, `build`, or none). Replace the inaccurate permission-persistence helpers with exact advertised-option selection while retaining deprecated source-compatible shims.

### Patch Changes

- Updated dependencies [06725fd]
  - @automatalabs/shared-types@0.34.0

## 0.42.1

### Patch Changes

- Updated dependencies [bf7a313]
  - @automatalabs/codex-acp@2.3.0

## 0.42.0

### Minor Changes

- 1452e15: Add an opt-in per-attempt idle watchdog that resets on real backend activity, cancels wedged turns through the existing wind-down path, retries with a fresh clock, and reports `AGENT_IDLE_TIMEOUT` distinctly across SDK, persistence, inspection, and MCP surfaces.

### Patch Changes

- Updated dependencies [1452e15]
  - @automatalabs/shared-types@0.33.0

## 0.41.5

### Patch Changes

- Updated dependencies [661d9d1]
  - @automatalabs/pi-acp@0.6.2

## 0.41.4

### Patch Changes

- 7f67500: Sync the Codex ACP fork with upstream `main` through `69ca755` using a non-squashed subtree merge. The upstream change adds standard ACP `session/fork`: Codex forks the source thread, returns and installs the independent session, advertises `sessionCapabilities.fork`, and supports optional AIR message-specific fork points. The conflict resolution preserves AgentPrism's loaded-turn terminal-state fields alongside upstream's new/fork/resume operation split.

  Refresh the wrapped Claude Agent SDK runtime override from 0.3.250 to 0.3.251. The new release adds model-switch hooks and resume cache-cost metadata plus Claude Code runtime/security fixes; claude-agent-acp does not configure the new hooks, and the turn-result, stop-reason, usage, and structured-output surfaces used by acp-agents remain compatible.

- Updated dependencies [7f67500]
  - @automatalabs/codex-acp@2.2.0

## 0.41.3

### Patch Changes

- 6821b31: Migrate the MCP server to the official split TypeScript SDK v2 packages and serve both the legacy 2025 protocol and modern `2026-07-28` protocol. Preserve sessionful legacy daemon behavior while adding SDK-native HTTP/stdio era negotiation, modern multi-round-trip checkpoint and backend approval handling, subscriptions, request-scoped Apps capability projection, and restart-safe request-state verification.

  Add the workflow-engine `pauseOnCheckpoint` host seam so protocol adapters can turn a live checkpoint into the existing durable checkpoint/resume flow without changing authored headless behavior. Expose the optional checkpoint `timeoutMs` through shared checkpoint context and MCP result/event projections.

  Refresh the wrapped Claude Agent SDK runtime to 0.3.250; 0.3.249 and 0.3.250 are parity-only releases with no integrated API or wire changes.

- Updated dependencies [6821b31]
  - @automatalabs/shared-types@0.32.0

## 0.41.2

### Patch Changes

- 9ddec60: Update the monolithic Model Context Protocol TypeScript SDK to 1.30.0, MCP Apps to 1.7.5, the workspace Zod floor to 4.2, and the wrapped Claude Agent SDK runtime to 0.3.248 before the separately gated SDK v2 migration.
- Updated dependencies [9ddec60]
  - @automatalabs/pi-acp@0.6.1
  - @automatalabs/codex-acp@2.1.1

## 0.41.1

### Patch Changes

- Updated dependencies [1ef9681]
  - @automatalabs/codex-acp@2.1.0

## 0.41.0

### Minor Changes

- ea0b68c: Make agent configuration fail closed and fully discoverable. Config probes now return effective ACP session modes, including config-option fallback normalization and explicit `null` for unsupported modes; workflow preflight rejects guessed or unadvertised modes before admission. Workflow `agent()` rejects unknown option keys before allocation, while REPL rejects reserved `configOptions.model` with modelSpec-native guidance and preserves independent mode failures instead of falsely blaming carried config keys. Static external MCP resources now accept subscribe/unsubscribe as no-ops.

### Patch Changes

- ea0b68c: Refresh the wrapped Claude Agent SDK runtime from 0.3.246 to 0.3.247. The upstream release adds ambient background-task metadata and spinner-tip configuration plus internal CLI fixes; the ACP-integrated structured-output, stop-reason, and usage contracts remain unchanged.

## 0.40.0

### Minor Changes

- de4e704: Make the workflow MCP surface self-contained: add protocol-native live backend/config discovery, automatically run zero-token static and mocked validation before admission, return bounded structured rejection diagnostics without creating a run, and publish compact DSL guidance directly in the tool description and bundled authoring prompt. Reuse the server's live ACP runner for probes, including approved run-scoped backend definitions, without disposing host-owned runners.

## 0.39.0

### Minor Changes

- 4be0807: Replace the REPL's state-dependent `followUp`/steering behavior with strict active-turn steering and durable queued turns. Agent handles now expose `steer`, `queue`, and `cancel`; `followUp` is removed. `steer` never starts or queues work and resolves only `injected`, `idle`, or `unsupported`. `queue` creates an independently awaitable, addressable FIFO turn on the same ACP session with exact cancellation, persistence, restore, and concurrency semantics.

  Make ACP extension metadata transport transparent. `customCapabilities` metadata gates and the derived steering/loaded-turn capability booleans are removed. Interactive steering returns the complete raw extension response, prompt turns expose their underlying `PromptResponse`, and extension owners interpret raw initialize metadata at the point of use.

  Pi ACP and Codex ACP now implement strict active-turn steering only. Idle or settlement-raced steering returns `promptRequired/noRunningTurn`; steering can no longer create a backend turn. REPL guest snapshots and call ledgers from the previous format are intentionally invalidated and auto-reset without executing old guest code.

### Patch Changes

- Updated dependencies [4be0807]
  - @automatalabs/codex-acp@2.0.0
  - @automatalabs/pi-acp@0.6.0

## 0.38.1

### Patch Changes

- Updated dependencies [cad804a]
  - @automatalabs/codex-acp@1.9.5
  - @automatalabs/pi-acp@0.5.1

## 0.38.0

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

### Patch Changes

- 205d110: Mechanical ACP dependency maintenance: lift the wrapped `@anthropic-ai/claude-agent-sdk` root
  `pnpm.overrides` pin 0.3.235 -> 0.3.238 (`@agentclientprotocol/claude-agent-acp` 0.70.0 is still npm
  latest and still exact-pins 0.3.232, so the override stays; drop it once the adapter catches up).
  0.3.236–0.3.238 are additive: `PostToolUse` `classifierContext`, `is_backgrounded`/`spawn_depth` on
  `task_started`, `suppressOriginalPrompt` on `UserPromptExpansion`, a `command_lifecycle` `refused`
  state, a fix for hook callbacks after a re-sent `initialize`, and per-branch `vcs_state_changed` events
  — none of which touch turn results, stop reasons, or usage accounting, the only runtime surfaces we
  observe through the adapter.
- Updated dependencies [205d110]
- Updated dependencies [4ff5fff]
  - @automatalabs/pi-acp@0.5.0
  - @automatalabs/shared-types@0.31.0
  - @automatalabs/codex-acp@1.9.4

## 0.37.4

### Patch Changes

- 4b27257: Mechanical ACP dependency maintenance: bump `@agentclientprotocol/claude-agent-acp` 0.69.0 -> 0.70.0
  (exact) and lift the wrapped `@anthropic-ai/claude-agent-sdk` override 0.3.234 -> 0.3.235.

  0.70.0's only change is "switch providers for loaded Claude sessions" (#1002) — the Claude-side
  analog of the codex-acp #404 we already integrated. It touches the adapter's own
  `acp-agent.ts`/`index.ts` (applying stored provider selection when a session loads); the
  `providers/list`/`set`/`disable` wire we consume is defined by `@agentclientprotocol/sdk` (unchanged
  at 1.3.0), and our client already re-issues `providers/set` on every reconstructed connection, so no
  integration code changes. 0.70.0 still exact-pins claude-agent-sdk 0.3.232 (< npm latest 0.3.235),
  so the root `pnpm.overrides` pin is bumped to keep the wrapped-runtime freshness leg green (drop it
  once the adapter catches up). SDK 0.3.235 is a "parity with Claude Code v2.1.235" release with no API
  surface change; the runtime is wrapped behind the adapter and never imported directly.

- Updated dependencies [30460a8]
  - @automatalabs/codex-acp@1.9.3

## 0.37.3

### Patch Changes

- dfe3c34: Mechanical ACP dependency maintenance: bump `@agentclientprotocol/claude-agent-acp` 0.67.0 -> 0.69.0
  (exact) and lift the wrapped `@anthropic-ai/claude-agent-sdk` to 0.3.234 via a root `pnpm.overrides`
  pin.

  The two adapter minors add only the JetBrains "AIR" extension features — align typed session
  failures (0.68.0, #992) and report changed files (0.69.0, #1001) — both gated behind an AIR client
  capability our Claude backend does not advertise (only `CodexBackend` does), so they are inert for
  the claude backend; no session-config, permission-mode, steering, or stop-reason surface changed.
  All three adapter releases (0.67–0.69) exact-pin the same `@anthropic-ai/claude-agent-sdk` 0.3.232,
  which is below npm latest 0.3.234, so the wrapped-runtime freshness leg needs the root override
  (re-added — it was dropped in 216bc1c when the adapter briefly matched latest; drop it again once the
  adapter catches up). 0.3.233/0.3.234 are additive (notification hooks, `ApiKeySource` values, an
  optional `effort` on `SDKSystemMessage`) plus a TS-only removal of the never-emitted
  `bypass_permissions_disabled` `ExitReason` we do not import; the runtime is wrapped behind the
  adapter and never imported directly, so no ACP surface the Claude backend integrates against changed.

  Verified: the protocol-coverage dist probes (steering advertisement, `AUTH_META_MATRIX`) still match
  the installed 0.69.0 dist, and the docs-drift citations moved 0.67.0 -> 0.69.0.

- 2137490: Adapt the codex-acp negotiated typed-session-failures ("AIR") client to the reshaped wire the
  `codex-acp` upstream sync (`47b57da`, PR #393 "align typed session failures with AIR protocol")
  brings in. codex-acp collapsed its `jetbrains.air.sessionFailure` record to the coarser AIR
  vocabulary: the 11 `SessionFailureCategory` values became six (`connection`, `access`, `limit`,
  `request`, `service`, `unknown`), the actions became `retry` / `login` / `new_session`, and the
  record dropped `phase` / `source` / `safeMessage` / `retryable` / `turnId` in favor of `severity`
  (`error` | `warning`, absent ⇒ `error`), `title`, and optional `details`. The extension version is
  unchanged (`1`), so our advertising CodexBackend still negotiates it and would otherwise silently
  fail to parse the new record — a walled turn would look like an empty successful one.

  `readTypedSessionFailure` now parses the new shape; `mapTypedSessionFailure` maps `access` →
  AUTH_REQUIRED, `limit` → the resumable PROVIDER_USAGE_LIMIT unless the server flags a context/budget
  ceiling with a `new_session` action (then fail-fast, preserving the previous split), `request` →
  non-recoverable, and everything else → AGENT_EXECUTION_ERROR with `recoverable = actions.includes("retry")`
  (the stand-in for the removed `retryable`). Advisory `severity: "warning"` records never enter the
  failure latch. No public seam behavior changed for the conditions the two channels share.

- Updated dependencies [9b3d8aa]
- Updated dependencies [3ebbfc3]
  - @automatalabs/codex-acp@1.9.2
  - @automatalabs/pi-acp@0.4.1

## 0.37.2

### Patch Changes

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

## 0.37.1

### Patch Changes

- 216bc1c: Mechanical ACP dependency maintenance: bump `@agentclientprotocol/claude-agent-acp` to
  0.67.0 (exact), which wraps the current `@anthropic-ai/claude-agent-sdk` 0.3.232, and
  remove the root `@anthropic-ai/claude-agent-sdk` pnpm override — the override existed only
  because prior adapter releases pinned the SDK below npm latest, and 0.67.0 pins it at
  latest, so the override is obsolete. No integrated surface changed; verified by the live
  backend e2e suite at push time.
- Updated dependencies [2f6008f]
  - @automatalabs/codex-acp@1.9.1

## 0.37.0

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

### Patch Changes

- Updated dependencies [4f18373]
  - @automatalabs/shared-types@0.30.0

## 0.36.5

### Patch Changes

- 471de39: Track `@earendil-works/pi-agent-core` in the pi backend's release freshness set, and extend
  the dependency gate's reverse-coverage enforcement to the whole `@earendil-works/` scope: any
  workspace dependency from the pi runtime family that is missing from a backend's
  `freshness.npm` now fails the gate before any network request, so a new pi-scope package can
  never silently drift out of lockstep with its siblings.

## 0.36.4

### Patch Changes

- 0c33e65: Track the wrapped Claude agent runtime forward: root pnpm override pins
  @anthropic-ai/claude-agent-sdk to 0.3.229 (npm latest) until
  @agentclientprotocol/claude-agent-acp catches up, per the ACP dependency
  freshness runbook. Upstream changes reviewed: additive (`terminal_slash_commands`
  init field, `output_tokens_details` passthrough) plus an oversized-request
  terminal_reason reclassification (`image_error` → `api_error`) — no agentprism
  code matches on those surfaces.
- Updated dependencies [9b6ae43]
  - @automatalabs/codex-acp@1.9.0

## 0.36.3

### Patch Changes

- 7e1f1db: Track the wrapped Claude agent runtime forward: root pnpm override pins
  @anthropic-ai/claude-agent-sdk to 0.3.226 (npm latest) until
  @agentclientprotocol/claude-agent-acp catches up, per the ACP dependency
  freshness runbook.

## 0.36.2

### Patch Changes

- 05af591: Runtime override: force wrapped `@anthropic-ai/claude-agent-sdk` to 0.3.225 (upstream released; `@agentclientprotocol/claude-agent-acp` still pins older — per the dependency-gate runbook, drop the override when the adapter catches up).

## 0.36.1

### Patch Changes

- db7b927: ACP maintenance: bump `@agentclientprotocol/claude-agent-acp` to the exact pin `0.66.0` (from
  `0.65.0`).

  Mechanical relative to our integration surface. 0.66.0 ships one dev-dependency bump (`globals`
  17.8.0 → 17.9.0), a feature — a provider-neutral ACP **goal** extension (#964) — and a bug fix
  (publish/replace Claude goals reliably, #967). None of these touch the surfaces the Claude backend
  integrates against: the session-scoped `_meta.claudeCode` structured-output channel
  (`outputFormat` + `emitRawSDKMessages`), the auth/provider methods, session lifecycle, and native
  `_session/steering` are all unchanged. The new goal extension is additive ACP surface that
  `@automatalabs/acp-agents` does not advertise, request, or observe (no `goal` reference exists in
  the runner), so it requires no adaptation. It is a currently-unconsumed capability the adapter now
  exposes (mirroring the codex-acp `thread/goal/*` control landed in the same-day upstream sync) —
  worth a tracking issue if we later want to drive goals through the runner, but not required to
  unblock the gate.

  Override decision — **retained, not dropped.** `@agentclientprotocol/claude-agent-acp@0.66.0`
  still exact-pins `@anthropic-ai/claude-agent-sdk@0.3.220` (verified against the registry), which is
  behind npm `latest` `0.3.224`, so the root `pnpm.overrides` entry pinning the wrapped runtime to
  `0.3.224` continues to carry it forward to latest and stays in place. Dropping it (as commit
  `4b306e1` did once the adapter had genuinely caught up) would revert the resolved runtime to
  `0.3.220` and re-fail the gate's wrapped-runtime check. Drop it only once a future adapter release
  pins `>= latest`; the gate warns automatically when the override becomes redundant.

- Updated dependencies
  - @automatalabs/codex-acp@1.8.1

## 0.36.0

### Minor Changes

- 30f3aa5: Interactive sessions gain the structured-output contract: `openSession({ schema })` (and the other `*Session` entry points) folds the schema into the backend's native channels exactly like `run()` — session/new `_meta` where the backend carries it there (Claude), the per-turn `_meta` forward where the backend computes it on the turn (Codex), and an in-band prompt contract for backends whose agent may ignore the `_meta` forward entirely (`embedSchemaInPrompt`). The schema never changes the interactive contract otherwise: the host drives the repair ladder itself and reads the result through the session's additive surface — the new `outputSchema` accessor, plus `currentTurnText()`/`finalMessageText()`/`rawStructuredOutput()`. The client-hosted StructuredOutput capture tool is never injected on the interactive path (it stays a per-call `run()` device). Also updates the engine seams for the REPL broker: `AcpAgentRunner.openSession`/`loadSession`/`forkSession`/`resumeSession` forward the schema to session creation and the per-turn channels.

  `InteractiveSession.prompt()` gains the `onHandoff` option — the host's explicit handoff acknowledgment. It fires exactly once the prompt has passed every preflight check (released session, aborted signal, prompt-in-flight, image validation) AND the underlying ACP session/prompt request has actually been invoked — the invocation runs synchronously through request construction and the wire send, so the payload is on the wire before the acknowledgment: the point of no return. Hosts that record a "delivered" marker for a prompt (the REPL broker's queued-steer delivery marker) record it in this callback: an async pre-handoff rejection never reaches it, so the marker can never precede the backend handoff and a restore can never skip a turn that was never delivered. The acknowledgment firing AFTER the invocation is the crash-boundary contract (review regression: it used to fire before, so a crash in that interval left a durable "delivered" marker on a prompt the backend never received — and a restore then skipped a never-delivered turn): a crash before the acknowledgment leaves the prompt undelivered-in-the-store and a restore re-issues it (at-least-once). A throwing callback aborts the turn — its error propagates through the normal mapping — but the backend prompt is already invoked at that point, so the turn is the host's delivery-failure path (the abandoned response can never become an unhandled host rejection), never a not-sent turn.

  `InteractiveSession.awaitCurrentTurn()` makes the REPL broker's re-attach arm REAL (phase D review round 1: the seam used to be absent from the adapter, so every built-in backend loaded, released, and re-issued). Its protocol-bounded semantics: the `session/load` contract (the agent replays the entire persisted conversation via `session/update` and only then resolves the load) makes the founding turn's completion observable exactly when the replayed transcript's trailing content event is an assistant message — a turn that ended while the host was down has its final message in the replay, and the seam resolves with it (`stopReason` synthesized `end_turn`; the protocol's replay carries none). A turn still in flight at the backend has no observable completion (the protocol has no turn-end signal for a turn this client did not start), so the seam rejects with a host-side error naming the condition and the broker degrades to re-issue, surfaced guest-visibly. The transcript probe (`SessionState.loadedTurnState`/`loadedTurnText` — the last user-message boundary and the trailing content kind, tracked from the update stream) is additive accumulator state; live sessions are unaffected. The fake-agent integration fixture's `session/load` replay additionally accepts `{ role: "user"|"assistant", text }` entries so tests can replay the founding turn's prompt alongside its outcome.

- bd28cd9: The loaded-session re-attach arm's completion evidence is now the `_session/loaded_turn` vendor extension (phase-D review round 3; the `_session/steering` precedent) — an AUTHORITATIVE turn-terminal channel for loaded sessions, replacing the quiet-grace heuristic (a settled stream with a trailing assistant chunk treated as completion, which durably settled an assistant PARTIAL as a completed-while-down turn when the next live chunk arrived later) and the blind re-issue fallback (which duplicated a still-running backend turn).

  - **New extension**: `_session/loaded_turn/query { sessionId }` → `{ status: "completed" | "running" | "interrupted" }`, asked right after `session/load` resolves (the runner still marks the load boundary synchronously after the response); `_session/loaded_turn/ended { sessionId, stopReason? | error? }` pushed when a turn that a query classified `running` ends. Advertised at initialize via strict `InitializeResponse._meta.loadedTurn.supported === true` (`NegotiatedCapabilities.supportsLoadedTurnTerminalState`). Served by the in-repo `@automatalabs/pi-acp` and `@automatalabs/codex-acp`; `ACP_EXTENSION_SUPPORT_MATRIX` pins all eight agent/method rows (claude and opencode: not-advertised).
  - **`InteractiveSession.awaitCurrentTurn()` rewritten around the extension**: `completed` settles immediately from the replay (the trailing assistant message is the turn's FINAL message — authoritative); `interrupted` rejects with the safe-re-issue class (nothing is running); `running` keeps the loaded session attached and settles ONLY from the ended notification with the turn's real accumulated text (bounded by `AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS`, default 15 min). A backend WITHOUT the extension degrades guest-visibly — the seam rejects immediately with `LoadedTurnStillRunningError` (structural `loadedTurnStillRunning` marker, non-re-armable): never settling partial output, never re-issuing a possibly-running turn. A `running` turn past the max-wait bound rejects with the RE-ARMABLE form (a later notification or cancel still settles the call); a turn that failed at the backend rejects with `LoadedTurnFailedError` (structural `loadedTurnFailed` marker — a definite outcome, settled as a rejection, never re-issued). `isLoadedTurnStillRunningError`/`isLoadedTurnFailedError` exported. The settle-grace env var (`AGENTPRISM_ACP_LOADED_TURN_SETTLE_GRACE_MS`) is gone.
  - The integration fixture's fake ACP agent advertises and serves the extension (`loadSession.loadedTurn` status, scripted `turnEnded` pushes), and the seam integration test now pins: completed-while-down settle, the round-3 regression (a replay ending in an assistant partial with the next live chunk arriving after any grace is NEVER settled before the authoritative notification), interrupted immediate re-issue, max-wait re-armable rejection, extension-absent degradation, and the no-user-message arm.

- af917eb: REPL orchestrator phase D, review round 2: the loaded-session founding-turn seam and the opencode persistence root.

  - **`InteractiveSession.awaitCurrentTurn()` is an observing wait, not a one-shot probe** (the REPL broker's re-attach arm). ACP message chunks are progress, never terminal markers, so the seam no longer treats a trailing `agent_message_chunk` as proof of completion: after `session/load` resolves it waits for the session's update stream to SETTLE — no `session/update` for the loaded-turn settle grace (default 250 ms; `AGENTPRISM_ACP_LOADED_TURN_SETTLE_GRACE_MS`) — and only then reads the transcript's trailing content. A turn that ended while the host was down (its final message in the replay) resolves with the REAL accumulated text (stop reason synthesized `end_turn` — the protocol's replay carries none). A turn still IN FLIGHT at the backend keeps streaming live chunks after the load response: the seam waits for its authoritative completion instead of rejecting — the loaded session stays attached and the re-attached call settles from the turn's real outcome (no re-issue, no duplicated work). It rejects only on genuine unobservability: a transcript with no user message, a released/dead session (the wait also races the session's release), or a stream settled without a terminal assistant message within the max-wait backstop (default 15 min; `AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS`). New additive `SessionHandle`/`SessionState` surface: `lastUpdateAtMs()` and `subscribeUpdates()`.
  - **OpenCode's spawned servers now use a STABLE per-user XDG data/state/cache root** (review: a random tmpdir per spawn made cross-process `session/load` fall back to a fresh session — re-attachment was not real for the opencode built-in despite it advertising `loadSession: true`). The root lives OUTSIDE the user's live opencode data dir (a sibling `agentprism/opencode` tree under the user's data home, seeded with credentials from the real dir as before), so the daemon's instances never overlap the user's own TUI store while agent-persisted sessions survive pool recycles and daemon restarts. `AGENTPRISM_OPENCODE_DATA_ROOT` overrides the root (tests/ops).

- 0c29a86: REPL orchestrator phase F, review round 2: authoritative re-attachment/completion for ALL four built-ins, the out-of-band eval-break relay, and addressable truncation references.

  **acp-agents — the observation path for backends without the `_session/loaded_turn` extension** (the built-in claude and opencode backends today; also the fallback when an extension backend's query wire fails). The old degradation — reject with the non-re-armable `LoadedTurnStillRunningError` so the broker releases the loaded session and re-issues the call — could duplicate a still-running backend turn. The seam now classifies the loaded session's founding turn authoritatively: the post-load continuation watch (`AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS`, default 1 s — any CONTENT update after the load boundary is live continuation, the still-running signal) plus the replay probe under the CONNECTION-DEATH CONTRACT (live-verified: claude-agent-acp and pi-acp exit on connection close and cancel their turns, `opencode acp` exits on stdin EOF, codex-acp ends/kills the codex process, and their persisted transcripts hold only completed messages — so at restore the founding turn is never still running and the replay's trailing content is authoritative: an assistant message is the turn's terminal message (completed-while-down, settled from the transcript), anything else means it died mid-way (the safe-re-issue class — nothing running, no duplication)). Live continuation flips the classification to the keep-attached wait (bounded, re-armable). The `_session/loaded_turn` extension path is unchanged. Tests pin the seam-less completed/interrupted/still-running classifications end to end through the real adapter.

  **repl-engine — a possibly-running call is never re-issued** (the broker's restore/re-attach arm): every `LoadedTurnStillRunningError` — re-armable and non-re-armable forms alike — keeps the loaded session attached and re-arms the seam on it (the doc's re-attach-to-a-still-running-task arm); re-issue is reserved for the observably-dead classes (interrupted classification, a transcript that never received its prompt, a dead/released session, a third-party adapter with no seam at all). Also new: **the out-of-band eval-break channel** (`EvalBreakChannel` / `createEvalBreakChannel`) — a worker-thread relay with a loopback HTTP break endpoint and a shared-memory (SAB + Atomics) break flag. The interrupt tool's no-id path becomes deliverable to a SYNCHRONOUSLY running eval: a never-yielding eval blocks the daemon's single thread, so the request itself cannot be processed — the relay (a separate thread) arms the flag, and every eval execution's quickjs interrupt handler consumes it mid-run with the arm-after-start rule (a stale break — armed while the workspace was idle — is dropped on first observation and never breaks a later eval). `BrokerOptions.evalBreakChannel` wires it; the broker reports consumed out-of-band breaks to the tool for the honest outcome.

  **mcp-server — the daemon wiring for both**: `run-daemon` creates the channel and advertises its URL in daemon.json (`replBreakUrl`); the stdio shim fires the relay automatically when it forwards a `repl` interrupt without an id (before forwarding, so the break lands while the daemon is wedged); the interrupt tool reports the honest out-of-band outcome (and clears the flag once its own processing owns the break). And **the structured-output cap's continuation references**: the aggregate 10 KB cap previously discarded the tail entries of elided arrays (pending ids, checkpoint questions, completion ids, status metadata) keeping only counts — the omitted values had no address and repeated reads could never recover them. Every elision now snapshots the dropped entries in the workspace's `TruncationRefStore` under a ref id that the `truncated` record carries (`{ elided, ref }`), and a later eval/wait/status call's optional `refs` parameter reads them back under `referenced` (a referenced read is itself capped, chaining fresh refs) — the cap costs reads, never data, for every omitted field. The truncation marker text now names both the `$N` refs and the structured continuation refs.

### Patch Changes

- fac9d5d: ACP maintenance: lift the wrapped Claude runtime to `@anthropic-ai/claude-agent-sdk@0.3.224` by
  moving the root `pnpm.overrides` pin from 0.3.223 (`@agentclientprotocol/claude-agent-acp@0.65.0`
  still exact-pins 0.3.220, and its latest has not yet caught up, so the override remains — drop it
  once the adapter advances; see CONTRIBUTING "When the dependency gate blocks").

  0.3.224 is a mechanical patch relative to 0.3.223: additive settings and capabilities
  (`crossSessionInbound`/`dialogExpiry` cross-session messaging, an additive `SDKMessageOrigin`
  `subkind: 'peer-send-message'`, archive-source plugin install, sandbox credential masking) plus a
  bug fix (long project paths no longer cross-referencing other projects' sessions). The runtime is
  wrapped behind the `claude-agent-acp` adapter — we never import it directly — so an additive+fix
  patch changes no ACP surface the Claude backend integrates against. The `@earendil-works` and
  `@agentclientprotocol` legs of the dependency gate pass clean, and the acp-agents live steering e2e
  (real Claude driven through the adapter over the 0.3.224 runtime) is green.

- 149b606: Phase-F review round 1: the re-attach arm's unobservable-completion degradation is replaced
  by the doc's honest re-issue fallback — the undocumented fourth reconciliation arm
  ("pending until interrupt/reset") is gone. The doc's restore path settles every outstanding
  call exactly once through exactly one of the three arms (settle from the store / re-attach /
  re-issue); the old `registerUnobservableReattach` path left a successfully re-attached call
  permanently pending when the loaded session's founding-turn completion was unobservable,
  which is the case for the built-in claude and opencode backends (they do not advertise the
  `_session/loaded_turn` extension, per the live-verified `ACP_EXTENSION_SUPPORT_MATRIX`).
  Now:

  - A loaded session WITHOUT the `awaitCurrentTurn` seam (a third-party adapter) is released
    and the call is re-issued under the same id — the same degradation the catch arm already
    used for load failures, surfaced guest-visibly with a warn line naming the reason.
  - A NON-re-armable `LoadedTurnStillRunningError` (backend without the extension, or a
    failed `_session/loaded_turn/query` wire) degrades the same way: release + re-issue under
    the same id. Never settled from a quiet gap (partial output is still never settled),
    never left pending.
  - The RE-ARMABLE class is unchanged: a `running` turn past the max-wait bound on a backend
    that DOES carry the extension keeps the loaded session attached and re-arms the seam — the
    doc's second arm (re-attach to a still-running task); a later `_session/loaded_turn/ended`
    notification or a cancel still settles the call.
  - The drain/disposal fences are unchanged: while the broker is draining or disposed, even
    safe-re-issue rejections resolve `hold` — the drain's forced stop settles every
    still-pending call DURABLY at its bound (recorded `AGENT_CANCELLED`, guest-settled), so a
    drained call is never left pending, and a disposed broker's state is being torn down.
    These are now the only `hold` producers left in the pump.

  The seam's rejection messages in acp-agents (`LoadedTurnStillRunningError` text) and the
  `awaitCurrentTurn` documentation were re-worded to match (the broker re-issues; the
  re-armable form keeps the wait on the attached session); repl-engine module docs, the
  package READMEs, and docs/api.md document the degradation and the exhaustive three-arm
  contract. Regressions: the seam-absent adapter test and the non-re-armable rejection test
  now pin the re-issue path end to end (loaded session released, reissue recorded, fresh
  turn settles the SAME guest promise exactly once, warn line names the reason), and the
  acp-agents integration test pins the re-worded non-re-armable message.

- bcede5b: REPL orchestrator phase F, review round 3 — the full-repo verification's carried defects, all closed:

  - **ACP freshness gate green**: the `packages/codex-acp` subtree is re-synced with upstream `agentclientprotocol/codex-acp@main` (ea57892 — the goal-extension `resume` action and the v1.1.11–1.1.13 releases) via a true non-squashed merge commit; the fork's `package.json` version line wins, the package lockfile stays deleted, and the imported upstream head is recorded in the attribution allowlist.
  - **The observation path's replay classification is restricted to the verified built-ins** (acp-agents): a CUSTOM backend's quiet observation window is not terminal evidence — its connection-death behavior is not live-verified — so its loaded session stays attached and the seam waits for the authoritative terminal state (the re-armable still-running rejection) instead of settling stale/partial replay or re-issuing a possibly-running call.
  - **Non-re-armable seam rejections are never re-invoked** (repl-engine): the broker kept recursing into a seam that rejects with `LoadedTurnStillRunningError` and `rearmable: false`, spinning in an unbounded microtask/warning loop that starved cancellation, drain, and every other task. The broker now keeps the loaded session attached and waits for the terminal state from the session-level `_session/loaded_turn/ended` surface, the call's cancel (settled as the recoverable `AGENT_CANCELLED`), the session's release (the safe-re-issue class), or the drain's forced stop.
  - **The interrupt is implemented in the in-process/library mode too** (mcp-server): the single-project server now owns an eval-break channel by default and exposes its relay (`replBreakUrl()`); the stdio transport's stdin reader lives on a worker thread that fires the relay for no-id `repl` interrupts, so a synchronous `while(true)` eval is breakable mid-run exactly like in daemon mode. The relay keys are realpath'd on every fire side (shim and in-process reader), so symlinked or non-normalized projectDirs interrupt correctly.
  - **Break targeting has no clock-resolution window** (repl-engine): the eval-break channel now orders arms against execution starts on a shared monotonic arm-sequence counter instead of millisecond `Date.now()` stamps — a break arriving in the same millisecond as the execution start is delivered, never consumed as stale and lost. The channel's slots also GROW on demand (no fixed workspace ceiling) and are released on broker teardown for reuse.
  - **The structured-output cap's continuation refs are cumulative, namespaced, and never evicted** (mcp-server): repeated halving of one field chains every dropped chunk into the advertised ref (earlier tails stay addressable); ref ids carry the workspace's project key so a ref from one project can never resolve in another's store; the store retains every ref until `reset` (which now clears it); and the `wait` result variant accepts `referenced` (the handler attached it, the validator forbade it).
  - Documentation and the phase-F changeset re-worded: the `repl-engine` dependency line and the shipped-tool status are stated as they are, and the changeset no longer carries the banned marker strings.

- Updated dependencies [2e4bb60]
- Updated dependencies [142a23e]
- Updated dependencies [bd28cd9]
- Updated dependencies [fac9d5d]
- Updated dependencies [142a23e]
- Updated dependencies [bd28cd9]
- Updated dependencies [bcede5b]
  - @automatalabs/codex-acp@1.8.0
  - @automatalabs/pi-acp@0.4.0

## 0.35.3

### Patch Changes

- Updated dependencies [dcd2ae4]
- Updated dependencies [f9936cc]
- Updated dependencies [0e4727e]
- Updated dependencies [f9936cc]
  - @automatalabs/codex-acp@1.7.0
  - @automatalabs/pi-acp@0.3.2

## 0.35.2

### Patch Changes

- 193714b: ACP maintenance: bump `@agentclientprotocol/claude-agent-acp` to 0.65.0 and lift the
  wrapped Claude runtime to `@anthropic-ai/claude-agent-sdk@0.3.223` via the root
  `pnpm.overrides` pin (the adapter still exact-pins 0.3.220).

  Upstream 0.65.0 fixes premature `session/prompt` resolution during steering: the turn no
  longer settles with `end_turn` while steered work is still running. The `SteeringOutcome`
  values are unchanged, so this is a strict improvement to the `prompt()` await path — we
  pass the outcome through untouched and never treated `end_turn` as "steered work done".

  Version citations in `docs/design-notes.md`, `docs/api.md`, and the `ClaudeBackend` header
  comment move with the bump.

- Updated dependencies [193714b]
  - @automatalabs/codex-acp@1.6.15

## 0.35.1

### Patch Changes

- ec21260: Update `@agentclientprotocol/claude-agent-acp` to 0.64.2 (ACP dependency freshness gate). Upstream 0.64.x keeps the `@agentclientprotocol/sdk@1.3.0` + `@anthropic-ai/claude-agent-sdk@0.3.220` pins, restores the single-tool ExitPlanMode representation, and adds an opt-in request-level steering `idleBehavior` fallback — the default `startedNewTurn` contract the runner relies on is unchanged.
- Updated dependencies [ec21260]
- Updated dependencies [ec21260]
  - @automatalabs/codex-acp@1.6.14
  - @automatalabs/pi-acp@0.3.1

## 0.35.0

### Minor Changes

- ffd83d1: Add first-class, capability-negotiated steering for held-open ACP sessions. Claude, Codex, and Pi
  support native `_session/steering`; OpenCode rejects it with a typed validation error. Expose the
  privacy-safe steering event through the workflows facade. Pi steering is codex-shaped: a live turn
  gets the content injected natively; an idle session (or a steer that races the end of a turn) runs
  it as a fire-and-forget `startedNewTurn` turn instead of erroring or leaking it into the next
  prompt; a steer racing a cancel resolves `failed` and never restarts cancelled generation.

### Patch Changes

- Updated dependencies [ffd83d1]
  - @automatalabs/pi-acp@0.3.0

## 0.34.18

### Patch Changes

- cf8ad1b: `@automatalabs/codex-acp` now lives in this monorepo at `packages/codex-acp` (#282) — imported from `VikashLoomba/codex-acp` with its full history as a non-squashed subtree, released through the ordinary Changesets train, with upstream containment (`agentclientprotocol/codex-acp`) enforced by the dependency gate as git ancestry against HEAD. `acp-agents` consumes it as a workspace dependency (published as an exact version); runtime behavior is unchanged.
- Updated dependencies [cf8ad1b]
  - @automatalabs/codex-acp@1.6.13

## 0.34.17

### Patch Changes

- f150805: Update `@agentclientprotocol/claude-agent-acp` to 0.63.0 (ACP dependency freshness gate).
- f150805: Repository metadata now points at `agentprism/agentprism-workflows` — the monorepo transferred from `VikashLoomba` to the `agentprism` GitHub organization. No runtime changes.
- Updated dependencies [f150805]
  - @automatalabs/pi-acp@0.2.8
  - @automatalabs/shared-types@0.29.1

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
