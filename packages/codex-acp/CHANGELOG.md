# @automatalabs/codex-acp

## 2.8.1

### Patch Changes

- 67668a6: Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `d7b07c1`).

  - Update the wrapped `@openai/codex` runtime to 0.155.0 and regenerate the app-server protocol types. The protocol gains the `thread/attachment/*` requests and a `thread/attachment/updated` notification; the adapter explicitly ignores that notification because persisted attachment metadata has no ACP session-update counterpart, and it does not call the new requests. `FeedbackUploadResponse` and the server-notification unions change only in generated types.
  - Codex 0.155.0 itself changes no surface the fork owns (turn-level `outputSchema` forwarding, the goal extension, `_session/loaded_turn`): accepted prompts now persist when compaction fails before a turn starts, automatic approval reviews retry transient failures, and account switches invalidate the previous identity's cached model catalog. The merge was conflict-free and the fork's suite passes unchanged.

## 2.8.0

### Minor Changes

- 7363614: Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `6ec22f3`).

  - Implement the agent side of the experimental ACP session-compaction RFD (#515), gated on the client advertising `clientCapabilities.session.compaction`: for those clients, automatic compaction and `/compact` emit `session/update` notifications with `sessionUpdate: "compaction_update"` keyed by Codex's `contextCompaction` item id (`in_progress` → `completed`, or `failed`/`cancelled` when the turn ends first), duplicate completion signals including the legacy `thread/compacted` notification are suppressed, loaded sessions replay persisted compactions in history position, and `/compact` now reports the compaction turn's start and completion. Clients that do not opt in keep the existing synthetic tool-call and text fallback unchanged; AgentPrism does not advertise the capability, so its update stream is unaffected.
  - Native subagent bookkeeping now records the closing state of child sessions and closes every child when the root turn ends non-completed, and a timed-out subagent wait finishes outstanding subagents as failed.
  - The fork-owned client-backed file reader and `_session/loaded_turn` ended-push scheduler were re-merged behind upstream's new `supportsCompaction` constructor parameter, keeping upstream call sites positionally compatible, and re-verified against the fork's 724-test suite.

## 2.7.0

### Minor Changes

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

## 2.6.0

### Minor Changes

- 98bea95: Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `a7afd2a`, upstream release 1.12.0).

  - Set the standard ACP `name` on tool-call events (#513): every initial `tool_call` now carries the programmatic tool name next to the existing `_meta` decoration. Additive; AgentPrism's runner prefers this field for tool-policy matching and history entries.
  - Supply validated diff statistics on file-change updates through `_meta.jetbrains.air.diffStats` (#501): added/removed line counts computed from the parsed patch or the supplied content, so clients can render file cards without re-diffing. Additive `_meta`; the fork's client-fs snapshots were refreshed to carry the block.
  - Derive the AIR `agentFileChangeReport` from Codex `turn/diff/updated` snapshots instead of a hidden ephemeral fork and an extra model turn (#518); the version-1 wire contract and path limits are preserved.
  - Improve `request_user_input` elicitation forms (#299): the full question becomes the title, the short header the description, and a picked option is preserved alongside a `user_note` answer instead of being replaced by custom text.
  - Bump `@openai/codex` to ^0.154.0 (#494); the generated app-server types gain required `originator`/`toolsError`/`normalModelSlug`/`ordinaryUsageAllowed` fields, and the fork-owned loaded-turn fixture was updated accordingly.
  - Upstream's npm publish polling (#499) and hono dev-dependency bump (#488) are not adopted; the fork keeps its workflow deletions and releases through root Changesets. The fork-owned `outputSchema` forwarding, goal, `_session/loaded_turn`, and client-backed file-read extensions were re-merged with upstream's new `collectTurnDiffs` constructor parameter placed before the fork-owned trailing parameters, and re-verified against the fork's 688-test suite.

## 2.5.0

### Minor Changes

- d9ebf60: Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `51d6247`, upstream release 1.11.0).

  - Advertise the AIR recommended-config-value extension: the model and reasoning-effort session config options carry a recommended-value hint for clients that opt in (#491). Additive; clients that do not advertise the capability, including AgentPrism's runner, see no change.
  - Simplify GPT model display names in the model picker (`gpt-5.6-sol` renders as "5.6 Sol") (#493). Cosmetic: option values and routing ids are unchanged.
  - Bump `@openai/codex` to ^0.153.4.
  - Upstream preview-publishing CI (#474) is not adopted; the fork keeps its workflow deletions and releases through root Changesets. The fork-owned `outputSchema` forwarding and AgentPrism ACP extensions were re-verified against the merged `CodexAcpServer` and the fork's 632-test suite.

## 2.4.2

### Patch Changes

- b098a93: Sync upstream Codex ACP through `7c374bc` with its original ancestry. Read complete paginated thread history for session loading and forks, bound resumed history to the resume cursor, and reject repeated pagination cursors. Complete standalone MCP elicitation tool cards after the permission response. Preserve the fork's structured-output, goal, and loaded-turn extensions.

## 2.4.1

### Patch Changes

- 6a52287: Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `061f9a4`), updating the bundled `@openai/codex` runtime from 0.153.2 to 0.153.3. The upstream adapter source is unchanged, so no fork integration changes are required.

## 2.4.0

### Minor Changes

- 18561da: Sync upstream codex-acp through `432a459` with a non-squashed subtree merge and update the Codex runtime to 0.153.2. The adapter now reports connection auth identity through the upstream authStatus extension and exposes background terminal tasks to clients that negotiate AIR asyncTasks, including targeted stop and lifecycle recovery.

  Preserve the fork's structured output, instruction overrides, client-backed file reads, strict steering, loaded-turn continuation, and engine-owned session title behavior alongside the upstream additions. Regenerate app-server types using the updated runtime and keep fork-owned constructor parameters after the upstream parameters.

## 2.3.2

### Patch Changes

- 81b2209: Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `5552cef`). Refresh and merge complete Codex rate-limit snapshots for the status command, report individual spend limits, retain the latest turn usage for status-only prompts, and report context-window percentage used consistently.

## 2.3.1

### Patch Changes

- fd3bda3: Sync upstream `agentclientprotocol/codex-acp` through `87997e2`. This adds URL-elicitation OAuth recovery for MCP server connections and updates the bundled Codex runtime to 0.152.0 with its generated app-server protocol types. The fork's structured-output forwarding, typed failures, goal and loaded-turn extensions, and workflow title-generation fence remain intact.

## 2.3.0

### Minor Changes

- bf7a313: Sync upstream `agentclientprotocol/codex-acp` through `4823131`, adding AI-generated session titles and the `/rename` command. Preserve workflow cost and lifecycle semantics by suppressing the upstream fire-and-forget title-generation turn for AgentPrism engine sessions carrying the `runId` metadata stamp; interactive Codex sessions remain eligible.

## 2.2.0

### Minor Changes

- 7f67500: Sync the Codex ACP fork with upstream `main` through `69ca755` using a non-squashed subtree merge. The upstream change adds standard ACP `session/fork`: Codex forks the source thread, returns and installs the independent session, advertises `sessionCapabilities.fork`, and supports optional AIR message-specific fork points. The conflict resolution preserves AgentPrism's loaded-turn terminal-state fields alongside upstream's new/fork/resume operation split.

  Refresh the wrapped Claude Agent SDK runtime override from 0.3.250 to 0.3.251. The new release adds model-switch hooks and resume cache-cost metadata plus Claude Code runtime/security fixes; claude-agent-acp does not configure the new hooks, and the turn-result, stop-reason, usage, and structured-output surfaces used by acp-agents remain compatible.

## 2.1.1

### Patch Changes

- 9ddec60: Update the monolithic Model Context Protocol TypeScript SDK to 1.30.0, MCP Apps to 1.7.5, the workspace Zod floor to 4.2, and the wrapped Claude Agent SDK runtime to 0.3.248 before the separately gated SDK v2 migration.

## 2.1.0

### Minor Changes

- 1ef9681: Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `2b48e98`). Adds capability-negotiated native ACP subagent sessions with separate child histories and root-routed permissions, retains the legacy tool-call fallback, and reports per-turn agent file changes. The conflict resolution preserves the fork's structured output, client-backed file reads, strict steering, and loaded-turn completion extensions after the new upstream subagent router parameter.

## 2.0.0

### Major Changes

- 4be0807: Replace the REPL's state-dependent `followUp`/steering behavior with strict active-turn steering and durable queued turns. Agent handles now expose `steer`, `queue`, and `cancel`; `followUp` is removed. `steer` never starts or queues work and resolves only `injected`, `idle`, or `unsupported`. `queue` creates an independently awaitable, addressable FIFO turn on the same ACP session with exact cancellation, persistence, restore, and concurrency semantics.

  Make ACP extension metadata transport transparent. `customCapabilities` metadata gates and the derived steering/loaded-turn capability booleans are removed. Interactive steering returns the complete raw extension response, prompt turns expose their underlying `PromptResponse`, and extension owners interpret raw initialize metadata at the point of use.

  Pi ACP and Codex ACP now implement strict active-turn steering only. Idle or settlement-raced steering returns `promptRequired/noRunningTurn`; steering can no longer create a backend turn. REPL guest snapshots and call ledgers from the previous format are intentionally invalidated and auto-reset without executing old guest code.

## 1.9.5

### Patch Changes

- cad804a: Sync the Codex ACP fork with upstream `main` through `50f69e5`, preserving the full non-squashed upstream history and AgentPrism fork extensions. The upstream changes add ACP v1 permission presentation/lifecycle handling and expose permission-mode kinds while retaining the existing mode IDs.

  Update the embedded Pi runtime packages to 0.84.3. The release keeps model selection session-scoped by default, retains the existing steering APIs, and leaves provider-error classification unchanged.

## 1.9.4

### Patch Changes

- 4ff5fff: Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `ba5bcc3`,
  upstream releases v1.5.1 through v1.6.2 plus two post-release fixes). Upstream changes:
  `@openai/codex` ^0.147.0 -> ^0.148.0 with regenerated app-server v2 types (#410); release-pipeline
  hardening — e2e/apt timeouts, `vitest --no-file-parallelism --retry=2` (#413, 86e0772, 51e011f);
  suppress late `available_commands_update` publishes after `session/close` via the
  session-generation guard (#418); device-code login now emits `elicitation/complete` and resolves
  when the login finishes before the elicitation response (#421); `@agentclientprotocol/sdk` ^1.3.0 ->
  ^1.4.0 and dev-dep bumps (#422). `misalignmentPolicyViolation` maps to the existing `policy_denied`
  category and `thread/reverted` / `thread/queue/changed` join the ignored-notification list. Fork-owned
  surfaces (turn-level `outputSchema` forwarding, goal extension, `_session/loaded_turn`) auto-merged
  without conflict; conflicts resolved by the standard policy (fork `package.json` version/description
  kept with upstream's dependency changes; fork's deleted `package-lock.json` and `.github/workflows`
  stay deleted; the changesets-owned `CHANGELOG.md` kept ours).

## 1.9.3

### Patch Changes

- 30460a8: Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `3d56827`,
  upstream release `chore(main): release 1.5.0` (#409)). Mechanical: the single upstream commit is a
  release-please version/CHANGELOG bump only — it packages the AIR/provider changes already synced at
  `47b57da` and changes no source under `packages/codex-acp/src`. Conflicts resolved by the standard
  policy (fork `package.json` version/description kept; fork's deleted `package-lock.json` stays
  deleted; the changesets-owned `CHANGELOG.md` kept ours; upstream's `.release-please-manifest.json`
  version taken). No integration surface changed.

## 1.9.2

### Patch Changes

- 9b3d8aa: Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `47b57da`,
  upstream releases v1.3.0 + v1.4.0). Upstream changes:

  - **align typed session failures with AIR protocol (#393)** — reshapes the negotiated
    `jetbrains.air.sessionFailure` record: the category vocabulary collapses to
    `connection`/`access`/`limit`/`request`/`service`/`unknown`, actions to
    `retry`/`login`/`new_session`, and the record now carries `severity`/`title`/`details` instead of
    `phase`/`source`/`safeMessage`/`retryable`/`turnId`. Retry warnings and deprecation notices ride
    the same slot as advisory `severity: "warning"` records. The AIR extension version is unchanged
    (`1`). Our consuming client (`@automatalabs/acp-agents`) is adapted in the same branch.
  - **report changed files to AIR (#403)** — a new additive `agentFileChangeReport` AIR capability,
    gated behind a client advertisement our stack does not send; inert for us.
  - **restore native provider state after overrides (#400)** and **switch providers for loaded Codex
    sessions (#404)** — internal codex app-server restart/resume lifecycle; the ACP
    `providers/list`/`set`/`disable` wire shapes are unchanged. Adds a `CodexProcessState` constructor
    parameter (kept LAST behind the fork-owned params; fork test helper and call sites reconciled).

  Fork-owned surfaces (turn-level `outputSchema` forwarding, goal extension, `_session/loaded_turn`,
  `ClientFileSystem`) preserved through the merge; fork vitest suite green.

## 1.9.1

### Patch Changes

- 2f6008f: Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `c4a9311`).
  Additive upstream changes: a new provider-neutral `contextCompaction` tool-call `_meta`
  extension (`ContextCompactionMeta.ts`) carrying compaction-specific facts (trigger,
  pre/post tokens, duration, error) on synthetic context-compaction tool calls, with the
  tool-call mapper emitting it and lifecycle/load-session fixtures updated accordingly. No
  surface we integrate against changed; mechanical sync per the dependency-gate runbook.

## 1.9.0

### Minor Changes

- 9b6ae43: Sync with upstream agentclientprotocol/codex-acp v1.2.0 (non-squashed subtree merge of `b51bedf`). Upstream adds a negotiated typed-session-failures extension (AIR): terminal turn failures ride PromptResponse metadata and asynchronous failures ride session updates, with restart-safe identities and deterministic recovery revisions — active only for clients that advertise the AIR extension capability in initialize `_meta`; clients that do not advertise it (including this monorepo's own acp-agents backend) keep the exact legacy error behavior. Also carries upstream's release-please CI scaffolding (inert in the fork) and a hono dev-dependency bump. Fork-owned surfaces (turn-level outputSchema forwarding, goal extension, `_session/loaded_turn`) are unchanged; the CodexEventHandler constructor keeps fork-owned parameters last, after upstream's new canonical parameters.

## 1.8.1

### Patch Changes

- Resync the fork with upstream `agentclientprotocol/codex-acp@145ebba` (v1.1.14 tip) via a
  non-squashed subtree merge (4 commits), preserving upstream ancestry for the dependency gate.

  Upstream changes folded in:

  - **Codex runtime 0.146.1 → 0.147.0** (#375): regenerated the app-server protocol types. The
    0.147.0 surface is additive for this fork — `turn/start` (including the `outputSchema` patch
    channel) and `thread/start` are unchanged. Notable type churn: `Thread.isPinned` was replaced by
    `section: ThreadSection | null` + `sectionEnteredAt: number | null`, new `threadSection/*`
    methods and `ThreadSection*` params landed, and `McpStartupCompleteEvent` is no longer re-exported
    from the `app-server` barrel (import it directly).
  - **Provider-neutral ACP goal replacement** (#376): `thread/goal/*` control can now replace an
    active goal through ACP, with per-session goal-control generations that suppress stale or
    duplicate continuations and start a turn when the app-server accepts a goal without routing one.
  - **`fix: normalize cwd filters for Windows sessions`** (#377): a new `PathUtils` normalizer for
    `list-sessions` cwd filtering on Windows.
  - Upstream release commit **v1.1.14**.

  Merge resolution keeps the fork in its own favor where the two histories diverge: the fork version
  line (`1.8.0`), description, and packaging metadata are retained (upstream's `1.1.14`/empty
  description dropped); the npm `package-lock.json` stays removed (the fork is a workspace pnpm
  package); and the fork-owned loaded-turn machinery (`pendingLoadNotifications`,
  `loadedTurnUpdateChains`, the `ServerNotification` import) is preserved alongside upstream's new
  `goalControlGenerations`. Upstream's corrected `McpStartupCompleteEvent` direct import is taken, and
  the fork-owned `loaded-turn.test.ts` `Thread` fixture is migrated from `isPinned` to
  `section`/`sectionEnteredAt` to match the 0.147.0 shape (mirroring upstream's own fixture fix). The
  turn-level `outputSchema` forward — the reason this fork exists — is untouched.

  Scored **patch**: this is an upstream-tracking maintenance resync, not a new fork-owned capability.
  The fork's own published contract — the turn-level `outputSchema` forward that is the sole reason
  `@automatalabs/codex-acp` is published — is untouched, and every folded-in delta is
  backward-compatible: codex 0.147.0 is a runtime/type regeneration (the `turn/start` and
  `thread/start` surfaces we forward against are unchanged), #376 _refines_ the provider-neutral goal
  extension that was already introduced and versioned (minor, 1.7.0) rather than adding a new
  extension, and #377 is a Windows `cwd`-filter bugfix. This matches the repo's patch precedent for
  focused upstream resyncs that carry runtime bumps and refinements without extending a fork-owned
  surface (e.g. `0e4727e`, the #374 goal-resume fix, and `193714b`, the codex 0.146.0 resync).

## 1.8.0

### Minor Changes

- 2e4bb60: The `_session/loaded_turn` extension's load-time watch is now the loaded turn's LIVE window, not just its terminal marker (phase-D review round 5):

  - **Live post-load text is forwarded**: the load-time watcher forwards the loaded active turn's `item/agentMessage/delta` output to the ACP client as `agent_message_chunk` session updates (serialized per session, wire order preserved), exactly like the prompt handler forwards a running turn's deltas — the client's transcript accumulates the turn's REAL post-load text and the seam settles with that accumulated text at the ended notification, never the replay-time partial.
  - **The load window never drops a completion**: a per-load notification buffer is installed before any `session/load` work (the subscription becomes live at `thread/resume`, but the watcher installs only after the load/auth/state work). A `turn/completed` (or a live delta) arriving in that window is buffered and replayed through the watcher AFTER the thread history streams — a completion discarded in that window previously left a `running` query permanently un-terminated.
  - **Authoritative active-turn detection for `active` threads with an ended last turn**: a thread whose runtime status is `active` but whose loaded last turn reads `completed` answers `running`, and the watcher now recognizes the ACTUAL active turn's completion by ANY `turn/completed` on the session (its id is not in the stale turns list) — the old id filter watched the already-completed last turn's id and the running answer never terminated. The in-process handler's ended push applies the same match.

- 142a23e: The `_session/loaded_turn/ended` push is ORDERED behind the session's pending delta updates (phase-D review round 6): the load-time watcher pushed the terminal marker synchronously while `forwardLoadedTurnDelta` delivered the turn's final chunks asynchronously through the per-session update chain — a `turn/completed` arriving back-to-back with the final live delta reached the ACP client first, and the re-attach seam durably settled PARTIAL text. The push now rides the same per-session chain (the load-time watcher, the recorded-ended push after a query, and the in-process event handler's push when a prompt subscription replaced the watcher), so every delta enqueued before the turn's completion reaches the client before the terminal marker.
- bd28cd9: The `_session/loaded_turn` vendor extension (the `_session/steering` precedent): turn-TERMINAL state for loaded sessions — the re-attach arm's authoritative completion evidence. Advertised at initialize as `_meta: { steering: { supported: true }, loadedTurn: { supported: true } }`. `_session/loaded_turn/query { sessionId }` answers whether the loaded session's founding turn is still running right now: `running` while a turn executes in-process (`currentTurnId` set — the query arms a one-shot watch that pushes `_session/loaded_turn/ended { sessionId, stopReason? | error? }` when that turn completes, with the ACP stop reason for completed/interrupted turns or the turn's error for failed ones), `completed` when the loaded thread's last turn status is `completed` (the replayed final message is the founding turn's FINAL message — authoritative), and `interrupted` for `inProgress`/`interrupted`/`failed` last turns (nothing is running — re-issue is safe). The thread's last turn status is captured on the session state at `session/load`; the ended push is emitted from the codex event handler's `turn/completed` path.
- bcede5b: REPL orchestrator phase F, review round 3 — the full-repo verification's carried defects, all closed:

  - **ACP freshness gate green**: the `packages/codex-acp` subtree is re-synced with upstream `agentclientprotocol/codex-acp@main` (ea57892 — the goal-extension `resume` action and the v1.1.11–1.1.13 releases) via a true non-squashed merge commit; the fork's `package.json` version line wins, the package lockfile stays deleted, and the imported upstream head is recorded in the attribution allowlist.
  - **The observation path's replay classification is restricted to the verified built-ins** (acp-agents): a CUSTOM backend's quiet observation window is not terminal evidence — its connection-death behavior is not live-verified — so its loaded session stays attached and the seam waits for the authoritative terminal state (the re-armable still-running rejection) instead of settling stale/partial replay or re-issuing a possibly-running call.
  - **Non-re-armable seam rejections are never re-invoked** (repl-engine): the broker kept recursing into a seam that rejects with `LoadedTurnStillRunningError` and `rearmable: false`, spinning in an unbounded microtask/warning loop that starved cancellation, drain, and every other task. The broker now keeps the loaded session attached and waits for the terminal state from the session-level `_session/loaded_turn/ended` surface, the call's cancel (settled as the recoverable `AGENT_CANCELLED`), the session's release (the safe-re-issue class), or the drain's forced stop.
  - **The interrupt is implemented in the in-process/library mode too** (mcp-server): the single-project server now owns an eval-break channel by default and exposes its relay (`replBreakUrl()`); the stdio transport's stdin reader lives on a worker thread that fires the relay for no-id `repl` interrupts, so a synchronous `while(true)` eval is breakable mid-run exactly like in daemon mode. The relay keys are realpath'd on every fire side (shim and in-process reader), so symlinked or non-normalized projectDirs interrupt correctly.
  - **Break targeting has no clock-resolution window** (repl-engine): the eval-break channel now orders arms against execution starts on a shared monotonic arm-sequence counter instead of millisecond `Date.now()` stamps — a break arriving in the same millisecond as the execution start is delivered, never consumed as stale and lost. The channel's slots also GROW on demand (no fixed workspace ceiling) and are released on broker teardown for reuse.
  - **The structured-output cap's continuation refs are cumulative, namespaced, and never evicted** (mcp-server): repeated halving of one field chains every dropped chunk into the advertised ref (earlier tails stay addressable); ref ids carry the workspace's project key so a ref from one project can never resolve in another's store; the store retains every ref until `reset` (which now clears it); and the `wait` result variant accepts `referenced` (the handler attached it, the validator forbade it).
  - Documentation and the phase-F changeset re-worded: the `repl-engine` dependency line and the shipped-tool status are stated as they are, and the changeset no longer carries the banned marker strings.

## 1.7.0

### Minor Changes

- dcd2ae4: Resync the `packages/codex-acp` subtree with upstream `agentclientprotocol/codex-acp@main`
  (5d40f74), which adds ChatGPT device-code authentication via URL elicitation (#347).

  This is a real upstream feature touching `CodexAcpClient` / `CodexAcpServer` / auth-method
  selection, not a mechanical lockfile bump — read the diff before merging. The new
  `chat-gpt-device-code` method is advertised only when the client supports URL elicitation, and
  the fork's no-fork-history test fixtures and package identity are preserved. Merged with a true
  merge commit (not squash) to keep the upstream-ancestry invariant the dependency gate checks.

- f9936cc: Resync the `packages/codex-acp` subtree with upstream `agentclientprotocol/codex-acp@main`
  (61de42d): a provider-neutral ACP goal extension (#371) and the Codex 0.146.1 bump (#370).

  The goal extension is a real feature touching `CodexAcpServer`, `CodexEventHandler`, and the
  goal-snapshot plumbing, plus new test fixtures. Conflicts resolved in the fork's favor:
  `package.json` keeps fork version/description (upstream's `@openai/codex` `^0.146.1` bump is
  taken), and the package-level lockfile stays deleted. Merged with a true merge commit to keep
  the upstream-ancestry invariant.

### Patch Changes

- 0e4727e: Resync the `packages/codex-acp` subtree with upstream `agentclientprotocol/codex-acp@main`
  (4bb290f): fix to resume paused goals through ACP control (#374). Small, focused fix touching
  `CodexAcpServer`, `GoalExtension`, and their tests. True merge commit preserves upstream
  ancestry.

## 1.6.15

### Patch Changes

- 193714b: Resync the `packages/codex-acp` subtree with upstream `agentclientprotocol/codex-acp@main`
  (0ff2d55), which carries a transitive npm security bump and the Codex 0.146.0 update.

  No runtime source changed on our side: the merge only lands upstream's canonical key
  ordering in four `CodexACPAgent` test fixtures. The fork had already back-ported the
  `pluginId`/`scriptPath`/`id` keys at a different position, so git's line-based merge
  duplicated them inside the same object literals; resolved by taking upstream's file
  content for those fixtures. Key counts now match upstream and the merge base exactly.
  The fork's deliberate deletion of the package-level lockfile is preserved (the monorepo
  uses the root `pnpm-lock.yaml`), as are the fork's package identity and version.

## 1.6.14

### Patch Changes

- ec21260: Update `@openai/codex` to ^0.146.0, regenerate the app-server protocol types, and resync the fork with upstream `agentclientprotocol/codex-acp@efa3789` (v1.1.9 tip) via non-squashed subtree merge.

  Upstream changes folded in: ACP plan review confirmation flow gated on the client `plan` capability (#351), throttled plan update snapshots with a pre-completion flush, structured permission-change metadata on approval requests (#342), the flaky file-approval e2e fix (#352), and removal of the synthetic "Conversation interrupted" message (#358). Merge resolution keeps the canonical `CodexEventHandler(connection, sessionState, supportsPlanUpdates)` signature and threads the fork-owned client file reader as a trailing optional parameter.

  The 0.146.0 App Server surface is additive for this fork: `turn/start` (including the `outputSchema` patch channel) and `thread/start` are unchanged; new surface includes thread pinning (`Thread.isPinned`, list/metadata params), `commandExecution` plugin-script attribution (`pluginId`/`scriptPath`), `externalAgentConfig/import/recordHistory`, expanded `ConfigRequirements`, and remote skill icon URLs. Test fixtures updated for the new required fields.

## 1.6.13

### Patch Changes

- cf8ad1b: `@automatalabs/codex-acp` now lives in this monorepo at `packages/codex-acp` (#282) — imported from `VikashLoomba/codex-acp` with its full history as a non-squashed subtree, released through the ordinary Changesets train, with upstream containment (`agentclientprotocol/codex-acp`) enforced by the dependency gate as git ancestry against HEAD. `acp-agents` consumes it as a workspace dependency (published as an exact version); runtime behavior is unchanged.
