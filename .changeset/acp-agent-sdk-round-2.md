---
"@automatalabs/acp-agents": major
"@automatalabs/shared-types": minor
"@automatalabs/pi-acp": patch
---

AcpAgent SDK round 2: per-agent traits, `INVALID_ARGUMENT` for SDK misuse, system-prompt discovery,
the message-level transcript (`turn.messages` / `agent.messages`), `stream()`, client-side function
tools, the `permissions` rename, and mid-session model switching (`setModel()` / a per-turn `model`).

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
  the `fork` row, `systemPrompt` (`replace` / `append` plus `source`: `table` / `declared` /
  `advertised` / `none`), `steering` / `loadedTurn` (`supported` / `not-advertised` / `unknown`),
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
  `{ name, description, inputSchema (typebox), execute(input, ctx) }`, with `defineTool()` to infer
  the input type, `AcpAgentToolContext` (`sessionId`, `backendId`, `label?`, a best-effort
  `toolCallId?`, `signal`) and `AcpAgentToolResult` (a string, MCP content blocks, or
  `{ content, isError? }`). Every agent with tools runs its own local tool host (`AgentToolHost`,
  the `StructuredOutputToolHost` pattern generalized over a shared `LocalMcpHttpHost` base): an
  in-process Streamable HTTP MCP server on `127.0.0.1` behind an unguessable token path serving
  `tools/list` and `tools/call`, injected into `mcpServers` as `agent_tools` (`agent_tools_2`, … on a
  caller-name collision; `AGENT_TOOLS_SERVER_NAME`) on `session/new|resume|load|fork` and the id-only
  fork's reattach, separate from and coexisting with the `structured_output` host. Arguments are
  validated with typebox Convert + Check before `execute`; a validation failure or a thrown
  `execute` answers the agent with an `isError: true` result carrying the message, never a
  transport error. Names (`^[A-Za-z0-9_-]{1,64}$`, unique; `AGENT_TOOL_NAME_PATTERN`) are validated
  in the constructor (`INVALID_ARGUMENT` before any spawn); an agent that does not advertise
  `mcpCapabilities.http` fails the open with `INVALID_ARGUMENT` naming the backend — tools are never
  silently dropped. `ctx.signal` aborts on `cancel()`, a per-call signal, the agent's signal, and
  close; forks inherit the tools on a host of their own; the host closes with the agent, waiting up
  to one second for in-flight calls to flush. Calls surface through the backend's normal
  `tool_call` / `tool_call_update` events (pi: `mcp__agent_tools__<name>`).
- Both local MCP hosts now close without waiting on a peer's keep-alive socket: idle connections
  are closed at once, requests still being answered get a bounded grace, then the rest are torn down.
- New mid-session model switching: `agent.setModel(spec)` (queued in the FIFO like `setMode`;
  sticky) and `AcpAgentPromptOptions.model` (applied before that turn, ahead of its
  `configOptions` and `mode` — open's order; sticky). The spec is resolved with the rule `fork()`
  applies to a `model` override — the runner's routing grammar, and it must route to this agent's
  backend and poolKey (`"<backendId>/<model id>"`) — otherwise `INVALID_ARGUMENT` naming both
  backends before anything is sent; a backend-only or blank spec is refused the same way (there is
  no wire form for "unselect"). The switch is applied exactly like open's selection
  (`SessionHandle.selectModel`: `session/set_config_option { configId: "model" }` with the routed
  remainder verbatim; no aliases, coercion, catalog matching, or fallback), a wire rejection maps
  through the normal error path with `model` unchanged, and on success `agent.model` (now a getter)
  is the routed spec, so later forks and a cold `AcpAgent.resume(ref, { model: agent.model })`
  inherit the switch. `"model"` stays reserved in `configOptions`.

`@automatalabs/pi-acp`

- README correction: a replaced system prompt drops pi's default instruction text (the tool list
  with snippets, its guidelines, the docs/examples paths); pi still appends the append entries, the
  project context files, the skills block, and the `Current working directory` line. The previous
  text wrongly claimed the tool snippets and guidelines were kept.
