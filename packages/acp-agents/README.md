# @automatalabs/acp-agents

Low-level building block: the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) client plus Claude, Codex, OpenCode, pi, and custom backends that implement the `AgentRunner` seam from `@automatalabs/shared-types`. It spawns an ACP server as a child process, drives one subagent turn to completion, and returns structured output or text.

This is the layer `@automatalabs/workflows` and `@automatalabs/mcp-server` are built on.

## Most users want `@automatalabs/workflows`

If you are orchestrating a workflow, use [`@automatalabs/workflows`](../workflows) instead — it re-exports `createAcpRunner` and wires it into the engine for you. Reach for this package directly only when you want to drive a **single** ACP agent yourself (`run()`, or the held-open [`AcpAgent` SDK](#acpagent--the-sdk-front-door)) or need the low-level auth/session lifecycle APIs.

```bash
npm install @automatalabs/acp-agents
```

Claude, Codex, and pi adapters are dependencies of this package. OpenCode is resolved from an
`opencode-ai` installation or an `opencode` executable on `PATH` only when selected.

## Standalone use: drive one agent

`createAcpRunner().run(prompt, options)` runs a single agent to completion. Pass a [typebox](https://github.com/sinclairzx81/typebox) `schema` to get a validated object back (typed as `Static<typeof schema>`); omit it to get the final assistant text as a `string`. The Claude, Codex, OpenCode, pi, or registered custom backend is selected from `model` / `tier`. Whoever constructs the runner owns it: call `dispose()` (or use `await using`) when you're done to tear down the pooled child processes.

```ts
import { createAcpRunner } from "@automatalabs/acp-agents";
import { Type } from "typebox";

const runner = createAcpRunner();

try {
  // Structured output: result is typed and validated against the schema.
  const review = await runner.run("Review the diff and summarize risk.", {
    schema: Type.Object({
      risk: Type.Union([Type.Literal("low"), Type.Literal("high")]),
      summary: Type.String(),
    }),
    model: "claude/sonnet",             // verified Claude harness id
    cwd: "/abs/path/to/worktree",       // ACP session/new { cwd } — absolute
  });
  console.log(review.risk, review.summary);

  // No schema: result is the final assistant text.
  const text = await runner.run("Explain this repo in one paragraph.", {
    model: "codex/gpt-5.6-luna", // verified Codex harness id
    cwd: "/abs/path/to/worktree",
  });
  console.log(text);
} finally {
  await runner.dispose();
}
```

`run()` accepts the full `RunOptions` seam: `schema`, `model`, `mode`, `configOptions`, `tier`, `cwd`, `instructions`, `label`, `signal` (cancellation), `toolNames` / `disallowedToolNames`, `maxSchemaRetries`, `mcpServers`, `images` (see below), `runId`, `backends`, `meta` / `promptMeta`, the backend-neutral `systemPrompt` instructions, session hand-off fields, and telemetry callbacks. See `@automatalabs/shared-types` for the field-by-field contract.

Aborting `signal` sends ACP `session/cancel` for that session. If its active turn does not settle
within five seconds, the client sends `session/close` when the agent advertised it and quarantines
the pooled child. Existing sibling sessions finish and close before the process is recycled; new
work never enters the quarantined process. The policy is identical for Claude, Codex, OpenCode, pi,
and custom ACP backends, and a `child_cleanup_error` from close remains observable.

Model routing uses only the first `/`-delimited segment. An ASCII-case-insensitive `claude`, `codex`, `opencode`, `pi`, or registered custom name selects that harness and is stripped exactly once; custom registrations win on collision. A harness name alone is backend-only and issues no model config call. Otherwise the whole string goes unchanged to `AGENTPRISM_DEFAULT_BACKEND` (default `claude`). Any remaining id is sent byte-for-byte as `configId: "model"`: catalogs are not matched, brackets and provider prefixes are ordinary characters, no sibling effort/Fast option is driven, and harness errors propagate through the normal agent-error path. Live-catalog-verified examples are `claude/opus[1m]`, `codex/gpt-5.6-sol`, and `opencode/zai/glm-5.2`; pi uses `pi/<provider>/<model-id>`. Use backend-only forms for harness-configured models.

`configOptions` exposes every other ACP session option verbatim. Its exact ids and string/boolean
values are sent in ascending id order after model selection and before the prompt, with no aliases,
coercion, fallback, retry, or echo verification. The `"model"` id is reserved for `model`; workflow
execution rejects that duplicate channel before opening a session. A harness rejection otherwise
uses the existing agent-error path.

Read a routed harness's live catalog without sending a prompt:

```ts
const { backendId, modes, options } = await runner.probeConfigOptions("codex", {
  cwd: "/abs/path/to/worktree",
});

const selected = await runner.probeConfigOptions("pi/openrouter/vendor/model-id", {
  cwd: "/abs/path/to/worktree",
  selectModel: true,
});
```

`probeConfigOptions()` uses the normal first-segment routing and pool, opens exactly one session,
returns the advertised `SessionConfigOption[]` shapes verbatim plus the effective `modes` catalog and `defaultModeId`, then closes that session. Dedicated ACP modes and the `category:"mode"` config-option fallback normalize to `SessionModeState`. When a caller omits mode, AgentPrism explicitly applies Claude `auto`, Codex `agent`, OpenCode `build`, or no Pi/custom mode; the default is applied only when the live catalog advertises it. By
default it reads the session-default catalog without making a model config request. With
`selectModel: true`, it first sends the routed model remainder verbatim and returns the echoed,
model-specific catalog; no prompt is sent in either mode. Spawn, authentication, model-selection,
and session-open failures throw normally; the API does not cache catalogs.

### Image attachments (`images`)

`images` appends base64 image `ContentBlock`s to the first prompt turn. The client adapts content to what the connected agent advertised at `initialize`: when the agent does not advertise `promptCapabilities.image`, each attachment degrades to a bracketed text note naming the mime type (never an error, never silently dropped). Repair/re-prompt turns stay text-only.

```ts
await runner.run("What's in this screenshot?", {
  cwd: "/abs/path/to/worktree",
  images: [{ data: base64Png, mimeType: "image/png" }],
});
```

### System prompt instructions (`systemPrompt`)

`systemPrompt` (a `SystemPromptOptions` from `@automatalabs/shared-types`) is the one backend-neutral way to shape the agent's system prompt for a session — on `run()`, `openSession()`, and the `AcpAgent` SDK alike. `replace` swaps the backend's built-in system prompt for your text; `append` adds your text on top of it. Each backend carries the two halves on its own session `_meta` channel (`session/new`, and `session/resume` / `session/load` / the reattach of an id-only fork):

| backend | `replace` | `append` | wire |
|---|---|---|---|
| `codex` | replaces Codex's base system prompt; its other instruction layers survive — developer instructions, `AGENTS.md` project instructions, environment context — per the app-server protocol's field semantics (documented, not source-verified here) | developer-role instructions on top of it | the bare `baseInstructions` / `developerInstructions` keys on `_meta` → the Codex `thread/start` / `thread/resume` / `thread/fork` params of the same name ([`@automatalabs/codex-acp`](https://www.npmjs.com/package/@automatalabs/codex-acp)); a live Codex fork carries them from its own `session/fork` request (observed live: `replace` takes effect on the forked thread; `append` reaches `thread/fork` but the fork answered from its source thread's developer instructions — Codex behavior) |
| `claude` | replaces the whole prompt; nothing of the `claude_code` preset survives, its dynamic sections included (tool schemas still reach the model as API tools) | appended to the adapter's `claude_code` preset | `_meta.systemPrompt`: a string for `replace`, `{ append }` for `append`; both together are sent as one replacement string (replaced prompt, blank line, appended text) because the adapter has no custom-base-plus-append form |
| `pi` | pi's custom-prompt slot (the `SYSTEM.md` / `--system-prompt` slot); the append entries, project context files (`AGENTS.md` and friends), the skills block, and the cwd line survive, while pi's default tool list, guidelines, and docs paths are dropped | one more append entry after the operator's own | `_meta.systemPrompt` `{ replace?, append? }` verbatim ([`@automatalabs/pi-acp`](https://www.npmjs.com/package/@automatalabs/pi-acp) advertises `_meta.systemPrompt: { replace: true, append: true }` at initialize) |
| `opencode` | — | — | `opencode acp` reads no session `_meta`; system prompts live in OpenCode's own config and agent definitions, so there is no system-prompt channel |
| custom | — | — | ACP has no standard key; send your agent's own `_meta` through `meta` |

Support is validated **before a session opens**: a field the routed backend cannot carry is a non-recoverable `SCRIPT_VALIDATION_ERROR` from `run()` / `openSession()` (`INVALID_ARGUMENT` from the `AcpAgent` SDK) naming the backend and the field, never a silent no-op, and so is a non-object, an unknown field, or a blank string. `systemPrompt` is additive (never part of the resume identity) and wins over the same key in the generic `meta` passthrough; a backend's own extras (Claude's `excludeDynamicSections`, say) still travel through `meta` when the option is not used. Note this is distinct from the `instructions` string, which is folded into the prompt text for every backend.

```ts
await runner.run("Cut the release.", {
  model: "codex/gpt-5.6-sol",
  cwd: "/abs/path/to/worktree",
  systemPrompt: { replace: "You are a release bot. Only touch CHANGELOG.md.", append: "Prefer conventional-commit summaries." },
});
await runner.run("Summarize the diff.", {
  model: "claude/opus",
  cwd: "/abs/path/to/worktree",
  systemPrompt: { append: "Answer in at most three sentences." },
});
```

## Client-side fs / terminal handlers (`clientHandlers`)

By default the agent uses its **own** built-in file and exec tools — the client never sees those operations. Register `clientHandlers` to interpose: the client then advertises exactly what you registered at `initialize` (`fs.readTextFile` / `fs.writeTextFile` per-method; `terminal` only when **all five** terminal methods are provided) and routes the agent's `fs/*` and `terminal/*` requests to your handlers. Every handler receives the request params plus an `AcpSessionContext` — `sessionId`, the session's **own** `cwd`, `label`, `runId` — so a pooled process serving many sessions still gets per-session isolation.

**Confinement is your job.** The library routes requests and supplies the session context; enforcing worktree roots, resolving symlinks, scoping environment variables, bounding output, and applying timeouts belongs in your handler implementation. Requests for methods you did not register are rejected with a JSON-RPC method-not-found error (agents that respect the advertisement never send them).

```ts
const runner = createAcpRunner({
  clientHandlers: {
    fs: {
      readTextFile: async ({ path }, { cwd }) => ({ content: await confinedRead(cwd, path) }),
      writeTextFile: async ({ path, content }, { cwd }) => { await confinedWrite(cwd, path, content); },
    },
    // terminal: { createTerminal, terminalOutput, waitForTerminalExit, killTerminal, releaseTerminal },
  },
});
```

## Interactive sessions

Use `runner.openSession(options)` when a host needs to hold one ACP session open across multiple prompt turns. It uses the same backend selection and session/new inputs as `run()` (`model` / `tier`, `mode`, sorted verbatim `configOptions`, absolute `cwd`, tool policy, `mcpServers`, `meta`, `runId`, Codex instruction overrides), but it spawns a **dedicated** agent process for that session instead of borrowing from the pool. A long-lived interactive session therefore never starves `run()` calls on the same backend, even with the default pool size of one.

Prompt turns are explicit and serialized: call `prompt(content, { images?, promptMeta? })`, await the returned `{ stopReason, text, response }`, then send the next turn. `response` is the complete ACP `PromptResponse`, including arbitrary response `_meta`; `text` is only the assistant text from that turn. A terminal typed-session-failure response is intentionally converted into the existing thrown `WorkflowError`, so it does not produce an `InteractiveTurn`. A second `prompt()` while one is in flight rejects with a host-side error; queue turns in your host if you want queued UX. Per-turn `images` use the same ACP image block path as `run()` and still degrade through standard prompt-content capability negotiation when the agent does not advertise image prompts.

While a `prompt()` is in flight, `steer(content, { images?, promptMeta? })` sends the vendor `_session/steering` request and returns its complete raw JSON response unchanged, including arbitrary `_meta` and unknown fields. It is not a second turn: it owns no output, usage, retry, response interpretation, or prompt settlement, and its output arrives on the original prompt's `session/update` stream. Idle callers still receive the active-prompt precondition error. For an active prompt, acp-agents does not parse an initialize capability or reject before the wire; a host that owns a steering policy must inspect raw `session.capabilities?.initializeMeta` itself. Concurrent steering calls are left to the backend.

Vendor metadata is transparent transport data. Caller `meta` / `promptMeta` keys are never deleted according to backend declarations or `agentCapabilities._meta`. The documented direct-collision winners are: on `session/new`, backend static `sessionMeta` is lowest precedence, caller `meta` wins over it, backend-computed protocol-critical session keys win over the caller, and the host `runId` stamp wins last; on `session/prompt`, backend-computed protocol-critical keys such as `outputSchema` win over caller `promptMeta`. Steering metadata has no backend-computed layer and reaches the wire unchanged. All unrelated keys, including arbitrary nested values, are preserved.

`cancel()` sends ACP `session/cancel` for the active turn and applies the same five-second
close/dispose escalation when the turn ignores it. `release()` is idempotent: it best-effort closes
the ACP session and then disposes the dedicated process. Passing `signal` to `openSession()`
releases the session on abort, and `runner.dispose()` releases any still-open interactive sessions
before closing the pooled processes. Dedicated process death is observed per session: the wrapper
auto-releases, session-scoped listeners see `session_close`, and an in-flight prompt rejects through
the normal connection-closed path. `backend_error` is connection-scoped observability on the runner
bus only; it is not delivered through `session.on()`.

### The re-attach arm: loaded-session founding-turn completion (`awaitCurrentTurn`)

`runner.loadSession({ sessionId, … })` re-opens a persisted backend session; `session/load` obliges
the agent to replay the entire persisted conversation before resolving (the runner marks the LOAD
BOUNDARY synchronously after the response). `InteractiveSession.awaitCurrentTurn()` resolves with
the founding turn (the turn that was in flight when the host died) so a re-attached call's
continuation fires exactly once — the re-attach arm of a host that survives its own restart. Completion evidence is the
vendor **`_session/loaded_turn` extension** (the `_session/steering` precedent), an AUTHORITATIVE
turn-terminal channel for loaded sessions advertised at initialize
(`InitializeResponse._meta.loadedTurn.supported === true`; pi-acp and codex-acp advertise it):

- `_session/loaded_turn/query { sessionId }` → `{ status: "completed" | "running" | "interrupted" }`
  — asked right after the load response. `running` = the founding turn is still executing at the
  backend (its replay transcript is PARTIAL); `completed` = it observably completed while the host
  was down (the replay's trailing assistant message is its FINAL message — the seam resolves with
  it immediately); `interrupted` = it ended without a terminal assistant message and no turn is
  running (re-issue is safe).
- `_session/loaded_turn/ended { sessionId, stopReason? | error? }` — pushed when a turn that a
  query classified `running` ends: the seam keeps the loaded session attached and settles with the
  turn's REAL accumulated text at this authoritative terminal marker (a quiet gap is only a
  progress-stream gap, never terminal evidence), bounded by `AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS`.

Backends WITHOUT the extension (the built-in claude and opencode backends today) are classified
by the seam's OBSERVATION path instead (phase-F review round 2): the post-load continuation watch
plus the replay probe under the CONNECTION-DEATH CONTRACT. The built-in ACP servers terminate
in-flight turns when the client connection closes (live-verified — claude-agent-acp and pi-acp
exit on connection close and cancel their turns, `opencode acp` exits on stdin EOF, codex-acp
ends/kills the codex process), and their persisted transcripts contain only COMPLETED messages —
so after a daemon crash the founding turn is NEVER still running at the backend, and the replay's
trailing content is authoritative: an assistant message is the turn's terminal message
(completed-while-down — the seam resolves with the real accumulated text), anything else means
the turn died mid-way (the safe-re-issue class — nothing is running, no duplication possible).
The one caveat — content still in flight when the load response resolved — is absorbed by a
bounded post-load continuation watch (`AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS`, default 1 s): any
CONTENT update after the load boundary is LIVE CONTINUATION, the authoritative still-running
signal, and flips the classification to the keep-attached wait. A query FAILURE on an extension
backend falls through to the same observation path (a possibly-running call is never
released-and-re-issued). A `running` turn whose terminal state does not become observable within
the max-wait bound rejects with `LoadedTurnStillRunningError` (`loadedTurnStillRunning` marker;
the broker re-arms the seam on the still-attached session for BOTH the re-armable and the
non-re-armable forms — a possibly-running call is never re-issued; a later notification or a
cancel still settles the call); a turn that ended by FAILING at the backend rejects with
`LoadedTurnFailedError` (`loadedTurnFailed` marker — a definite outcome, settled as a rejection,
never re-issued); everything else (no user message in the transcript, `interrupted`, a dead
process) is the safe-re-issue class (observably dead — re-issue cannot duplicate). The seam's
rejection classes are structural, so third-party adapter seams can throw the same markers.
`isLoadedTurnStillRunningError` / `isLoadedTurnFailedError` are exported for hosts that classify
seam rejections.

```ts
const runner = createAcpRunner();

try {
  const session = await runner.openSession({
    model: "claude/sonnet",
    cwd: "/abs/path/to/worktree",
    onPermissionRequest: async (request) => choosePermission(request),
  });

  const off = session.on("agent_message_chunk", (e) => {
    if (e.content.type === "text") process.stdout.write(e.content.text);
  });

  try {
    const first = await session.prompt("Inspect the failing test.");
    const second = await session.prompt("Patch the smallest fix.", {
      images: [{ data: base64Png, mimeType: "image/png" }],
    });
    console.log(first.stopReason, second.text);
  } finally {
    off();
    await session.release();
  }
} finally {
  await runner.dispose();
}
```

## AcpAgent — the SDK front door

`AcpAgent` is the held-open counterpart of `run()`: one **dedicated** ACP process per agent (and per fork), a lazy constructor that spawns nothing until the first call, turns that serialize in a per-agent FIFO, live `fork()`s that see everything the parent committed so far, and cold reopen of a recorded session from its `AgentSessionRef`. It composes the same primitives as the runner and `InteractiveSession` (`PooledConnection`, `SessionHandle`, the backends, the routing grammar, the structured-output tool host), adds a per-agent host for client-side function tools, and owns no pool, so a parent's `close()` never affects its forks. The full reference — options, the turn shape, the abort table, forks, cold reopen, structured output, function tools, events, discovery, errors — is [docs/api.md — AcpAgent SDK](../../docs/api.md#acpagent-sdk).

```ts
import { AcpAgent, defineTool } from "@automatalabs/acp-agents";
import { Type } from "typebox";

const catalog = await AcpAgent.probe({ modelFilter: "opus" });  // no-prompt catalog, one process per target
const primary = new AcpAgent({ cwd: "/abs/path/to/worktree", model: "claude/opus[1m]" }); // spawns nothing yet
primary.on("agent_message_chunk", (e) => {                      // this agent's events only
  if (e.content.type === "text") process.stdout.write(e.content.text);
});

const turn = await primary.prompt("Investigate the failing test.");
turn.response;                                   // the verbatim PromptResponse, `_meta` intact
turn.updates; turn.raw; turn.toolCalls;          // every update / vendor notification / folded tool call of the turn
turn.messages;                                   // the turn per message: text blocks, tool calls, thoughts (agent.messages: the transcript)
turn.usage.turn; turn.usage.session;             // this turn's tokens; the agent's running sum

for await (const event of primary.stream("Now fix it.")) {   // the same turn as prompt(), as an async iterable
  if (event.type === "agent_message_chunk" && event.content.type === "text") process.stdout.write(event.content.text);
  else if (event.type === "tool_call") console.error(`\n→ ${event.title}`);
  else if (event.type === "turn") console.error("\n", event.turn.stopReason);   // the terminal event carries the AcpAgentTurn
}                                                            // `break` cancels the turn (session/cancel) before the loop exits

const planner = await primary.fork();                        // a NEW process seeded with the transcript so far
const plan = await planner.prompt("Plan the smallest fix.", {
  mode: "plan",                    // sticky: applies to this and every later turn of `planner`
  meta: { trace: "plan-1" },       // turn `_meta`, passed through verbatim
});
await primary.prompt("Meanwhile, list the callers.");        // the parent keeps going, unaffected
await primary.setModel("claude/sonnet");                     // mid-session switch (same backend, sticky); primary.model follows

await planner.close();
await primary.close({ keep: true });                         // process disposed; the session stays re-openable
// The same session on a fresh process: the ref carries no model, so pass the agent's back. `resume` replays
// nothing (history/text start empty) — `AcpAgent.load(ref)` replays the transcript instead.
const again = await AcpAgent.resume(primary.sessionRef!, { model: primary.model });
await again.close();

// Client-side function tools: hosted by the SDK over HTTP MCP (`agent_tools`), called by the agent mid-turn.
const lookupTicket = defineTool({
  name: "lookup_ticket",                                       // ^[A-Za-z0-9_-]{1,64}$, unique per agent
  description: "Fetch one ticket from the tracker by id.",
  inputSchema: Type.Object({ id: Type.String({ minLength: 1 }) }),
  async execute({ id }, ctx) {                                  // `id` typed from the schema; ctx.signal aborts with the turn
    const res = await fetch(`https://tracker.internal/api/tickets/${id}`, { signal: ctx.signal });
    if (!res.ok) throw new Error(`ticket ${id}: HTTP ${res.status}`);   // → an isError result the agent can read
    return await res.text();
  },
});
const tooled = new AcpAgent({
  cwd: "/abs/path/to/worktree",
  model: "pi",
  tools: [lookupTicket],                                       // refused at open (INVALID_ARGUMENT) if the agent has no HTTP MCP
  permissions: { deny: ["Bash"] },                             // the headless allow/deny auto-policy
});
tooled.on("tool_call", (e) => console.error(e.title));         // pi: mcp__agent_tools__lookup_ticket
await tooled.prompt("Summarize ticket T-1042.");
await tooled.close();                                          // the tool host closes with the agent
```

Every misuse of the SDK — a bad option, an unadvertised id, a call after `close()` — is a `WorkflowError` with code `INVALID_ARGUMENT` (the runner and `InteractiveSession` keep `SCRIPT_VALIDATION_ERROR`). `agent.traits` (and the spawn-free static `AcpAgent.traits(spec?, { backends? })`) describes the backend as an `AcpAgentTraits`: `custom`, `defaultModeId`, the `fork` row, the `systemPrompt` channel with its `source` (`table` / `advertised` / `none`), `steering` / `loadedTurn`, the `structuredOutput` channel, and `promptUsage` — the tables before open, the agent's own initialize advertisements once the connection is up, and the same object on every probed harness of `AcpAgent.probe()` (`traits`).

`prompt`, `stream`, `fork`, `setModel`, `setMode`, `setConfigOptions`, and `close` run FIFO per agent, so a fork always sees a quiescent, fully persisted parent transcript. `setModel(spec)` — and the per-turn `prompt(…, { model })`, applied ahead of that turn's `configOptions` and `mode` — switches the session's model in place: the spec must route to the agent's own backend (`"<backendId>/<model id>"`; otherwise `INVALID_ARGUMENT` naming both backends, before anything is sent) and is applied exactly like open's selection, `session/set_config_option { configId: "model" }` with the routed remainder verbatim (no aliases, catalog matching, or fallback; a wire rejection maps through the normal error path and moves nothing). `agent.model` follows, so a later `fork()` and a cold `AcpAgent.resume(ref, { model: agent.model })` inherit the switch. `stream(content, options?)` is `prompt()` observed as an async iterable of **this turn's** events (each bus event tagged `type`, an update once under its kind, a concurrent `steer()`'s `steering` included, then the terminal `{ type: "turn", turn }`); its observer is attached the instant the turn is dequeued, so a queued stream never sees the previous turn, and leaving it early (`break`, `return()`, `throw()`) cancels the turn and waits for it to settle. `turn.messages` / `agent.messages` fold the same chunks `text` folds into `AcpAgentMessage`s — one assistant message per `text` boundary (tool call, thought, plan, user chunk, changed `messageId`), each with the tool calls it issued and the thoughts that led it; a run of `user_message_chunk`s is a user message. `steer()` and `cancel()` overlap the queue: `steer()` injects into the turn in flight (`_session/steering`) and rejects when nothing is in flight; `cancel()` sends one `session/cancel` for the turn whose `session/prompt` is on the wire (a turn that has started but is still opening the session or applying its per-turn options is not reached — a per-call `signal` covers that window) and, when the agent ignores it for the grace period, disposes the process **without** a wire `session/close` so `sessionRef` stays re-openable. `prompt()` resolves a turn for every `PromptResponse` the wire returned — no `stopReason` is thrown on — and rejects only on a wire rejection, validation, abort (`signal.reason` untouched), a closed agent, or a typed session failure (then with the complete turn attached as `error.turn`; narrow with `isAcpAgentTurnError`). A schema miss is a result, not an error: `prompt()` is one turn unless `schemaRetries` (constructor or per turn, default `0`) buys repair turns — the runner's own repair prompt (the StructuredOutput-tool variant when the injected tool is active, else the JSON variant) with the validation error, re-sent on the same session inside the same operation with the same turn `_meta`, every repair a real turn (`stream()` yields it, `usage` counts it, `cancel()` reaches it) — and the resolved turn is the final attempt's plus `structuredAttempts`; only an `end_turn` miss is repaired.

`fork()` follows the backend's `FORK_SESSION_TRAITS` row ([the table under Session handoff](#what-a-sessionfork-response-is-fork_session_traits)) instead of probing: on the `id-only` backend (Claude) the child releases the bare fork handle with `keepOpen` and reattaches the new id (`session/resume`, else `session/load`) before its first turn, so the wire order is always `session/fork` < `session/resume` < `session/prompt`; on the `live` backends (Codex — the workspace fork keeps the forked thread subscribed and publishes its startup state like a resumed session — pi, and OpenCode) the fork handle is the session. The cold `AcpAgent.fork(ref)` prefers `session/load` for its reattach so the child carries the recorded transcript (resume only when load is not advertised). Claude forks must keep the source cwd; a custom entry wrapping claude-agent-acp (or upstream codex-acp, which unsubscribes its forks) must declare `fork: { disposition: "id-only" }`. A per-turn `schema` is accepted only on Codex (whose schema rides each turn's `_meta.outputSchema`); every other backend binds the schema at session open, so pass it to the constructor. `AcpAgent.probe()` returns the same `HarnessConfigReport` as `probeHarnessConfig` plus a `models` view, and keeps the bare harness catalog next to a failed exact-model probe.

`tools` are client-side function tools (`AcpAgentToolDefinition`: `name`, `description`, a typebox object `inputSchema`, `execute(input, ctx)` returning a string, MCP content blocks, or `{ content, isError? }`; `defineTool()` infers the input type). Every agent with tools runs its own local tool host — an in-process Streamable HTTP MCP server on `127.0.0.1` behind a token path — injected into `mcpServers` as `agent_tools` (`agent_tools_2`, … on a name collision) on `session/new|resume|load|fork` and the id-only reattach, next to and separate from the `structured_output` host. Arguments are validated against the schema (typebox Convert + Check) before `execute` runs; a validation failure or a thrown `execute` reaches the agent as an `isError: true` result with the message, never a transport error. Names are validated in the constructor (`INVALID_ARGUMENT` before any spawn); an agent that does not advertise `mcpCapabilities.http` fails the open with `INVALID_ARGUMENT` naming the backend — tools are never silently dropped. `ctx.signal` aborts with the turn (`cancel()`, a per-call signal, the agent's signal, close); forks inherit the tools on a host of their own; the backend surfaces the calls through the normal `tool_call` / `tool_call_update` events (pi: `mcp__agent_tools__<name>`). `permissions` is the headless allow/deny `ToolPolicy`, consulted only when no `onPermissionRequest` resolver is installed.

## Authentication lifecycle

The built-in runner is auth-capable without widening the minimal `AgentRunner` interface.
`describeAuthMethods()` returns normalized `agent` / `terminal` descriptors;
`completeAuth()` applies a host resolution; and `runner.auth.status()`, `.authenticate()`, and
`.logout()` provide the controller form. Construct the runner with `authCapabilities` to advertise
what the host can complete and `onAuth` to resolve an `AuthContext` inline.

Without an inline resolver, an ACP `-32000` signal becomes a non-recoverable
`WorkflowError { code: "AUTH_REQUIRED", authContext }`. The workflow manager recognizes that code
and pauses managed runs, but a direct `runner.run()` caller receives the error and decides how to
authenticate/retry. Credential env/meta payloads remain in the in-memory `AuthStore`, are redacted
from errors and events, and are zeroized on logout.

## Session handoff

Use `onSessionOpen` to capture the backend/session/cwd re-attach handle. It fires exactly once for
the winning acquisition: a fresh `session/new`, a successful `session/resume`/`session/load`, or the
fresh fallback after a reopen failure. Set `keepSession: true` when the host intends to reopen a
successful call; pause-class `PROVIDER_USAGE_LIMIT` and `AUTH_REQUIRED` failures are kept open
automatically so managed resume can continue the interrupted turn.

When `continueFromSession` is supplied, `run()` first verifies the recorded backend and effective
`poolKey`, prefers the current connection's `session/resume` capability, and falls back to
`session/load`. A missing capability or rejected reopen reports a typed continuation skip through
`onResultProvenance`, cleans up the partial acquisition, and runs the original prompt in a fresh
session. Once reopen succeeds, the runner reports `reattached` before post-open setup and sends a
fixed continue-the-interrupted-task instruction instead of repeating the original prompt. Load
transcript usage is baselined away, so only continuation-turn usage is reported. Caller cancellation
never opens the fresh fallback. The runner also exposes `listSessions()` and `deleteSession()` where
advertised; inspect `reopen` rather than assuming every ACP agent persists state.

### What a `session/fork` response is (`FORK_SESSION_TRAITS`)

`forkSession()` returns whatever the agent answered, and the answer differs per adapter. `FORK_SESSION_TRAITS`
pins each built-in's disposition from its source: an `id-only` fork (Claude) names a persisted copy that is
not live — Claude answers `{ sessionId }` alone and prompting it fails with "Session not found" — so it must be
reopened (`session/resume`, else `session/load`) before its first turn; `live` forks (Codex — the workspace
fork keeps the forked thread subscribed, `thread/fork` subscribing the connection exactly like `thread/resume`,
and publishes the fork's available commands and MCP startup status like a resumed session; pi; OpenCode by
live verification) are the session. `fork cwd` says whether the fork may re-home (Claude's transcript store is
keyed by the source cwd).

| agent | `session/fork` disposition | reattach | fork cwd |
|---|---|---|---|
| `claude` | `id-only` | `resume-or-load` | `source-only` |
| `codex` | `live` | `none` | `free` |
| `opencode` | `live` | `none` | `free` |
| `pi` | `live` | `none` | `free` |

`forkSessionTrait(agent, declared?)` resolves a row — a built-in's own, the row a custom backend's `fork`
declaration describes (a declaration always wins over a name that shadows a built-in), else
`FORK_SESSION_TRAIT_DEFAULT` (`live` / `free`, the plain ACP contract). Custom entries that wrap
claude-agent-acp (or upstream codex-acp, which unsubscribes its forks) must declare `fork: { disposition: "id-only" }`.

`PROMPT_USAGE_SCOPES` pins that `PromptResponse.usage` is per-turn on every built-in (the SDK's `Usage` doc says "across session"; the installed adapters report the turn), so a session total is your own running sum of turn reports — `UsageAccumulator.recordPromptUsage` replaces, never sums. `promptUsageScope(agent)` answers `"turn"` for built-ins and custom agents alike. Both tables are probed in the installed Claude/Codex/pi dists by the protocol coverage suite.

## Listening in: live ACP events

`AcpAgentRunner` is also a typed event bus — `runner.on(name, listener)` bubbles up the live ACP stream of every run (streaming text, tool calls, usage, permissions, elicitations). Event names are the ACP `sessionUpdate` discriminants (`agent_message_chunk`, `tool_call`, `usage_update`, …) plus the cross-cutting `session_update` (catch-all), `permission_pending`, `permission_request`, `elicitation_pending`, `elicitation_request`, `elicitation_complete`, `raw_message`, `steering`, `session_open` / `session_close`, and `backend_error`. Each payload carries a `{ sessionId, backendId, label?, runId?, callIndex?, initializeMeta? }` context envelope (a pooled runner multiplexes many runs at once). `steering` carries `{ response }` with the complete raw server response after a resolved request, never the request prompt content or request metadata. `permission_pending` / `elicitation_pending` are resolver-only and carry `{ request }` before the host resolver is invoked; `permission_request` / `elicitation_request` fire exactly once with the final `{ request, outcome }` returned to the agent; `elicitation_complete` carries `{ notification }` for URL completions. `on()` / `once()` return an unsubscribe thunk; `off()` and `removeAllListeners()` round it out. Listeners are best-effort observers — a throwing listener never affects the run.

`AcpEventContext.callIndex` is the optional `RunOptions.callIndex` of the engine `agent()` call that
opened the session. It is copied through session state and late-event tombstones onto session
updates, permissions, elicitations, raw messages, and session open/close events; retries of one
engine call retain the same value. Direct runner callers and interactive sessions may omit it.

`callIndex` is host-only correlation metadata: it is never sent on the ACP wire, placed in `_meta`,
used as session identity, or included in workflow journal hashes. Filter by `(runId, callIndex)`
when direct call attribution is available, with `label`/`runId` remaining valid for compatibility.
Connection-scoped `backend_error` has no session, run, or call context.

```ts
const off = runner.on("agent_message_chunk", (e) => {
  if (e.content.type === "text") process.stdout.write(e.content.text);
});
runner.on("tool_call", (e) => console.error(`[${e.label}] ${e.title}`));
// … run() …
off();
```

The full event map (`AcpRunnerEventMap`) and helpers (`TypedEventEmitter`) are exported here and re-exported from `@automatalabs/workflows`.

## Key exports

From [`src/index.ts`](./src/index.ts):

- **`createAcpRunner(options?)`** — factory returning an `AcpAgentRunner` (this is what `@automatalabs/workflows` injects into the engine).
- **`AcpAgentRunner`** — the `AgentRunner` implementation; `run(prompt, options)`, `probeConfigOptions(spec?, { cwd?, selectModel?, backends?, signal? })` (zero-token/no-prompt discovery; approved run-scoped backends apply only to that probe), `listBackends()` / `listCustomBackends()`, `openSession(options)`, `dispose()`, and `[Symbol.asyncDispose]()` for `await using`. `forceKill()` is a synchronous, best-effort emergency teardown for hosts only after a bounded graceful `dispose()` deadline; normal owners must await `dispose()`. The caller that constructs a runner owns its lifecycle.
- **Auth/provider lifecycle methods** — `describeAuthMethods()`, `completeAuth()`, `runner.auth`, `authMethods()`, `authenticate()`, `listProviders()`, `setProvider()`, `disableProvider()`, and `logout()`; see [docs/api.md](../../docs/api.md) for capability gating and installed adapter support. A successful `setProvider()` records a durable routing intent (`ProviderStore`) replayed on every fresh connection's `initialize` — provider config is in-process agent state for e.g. codex-acp, so record → recycle → replay is what makes it stick across the pool.
- **Session lifecycle methods** — `listSessions()`, `deleteSession()`, `loadSession()`, `resumeSession()`, and `forkSession()` for backends that advertise session persistence; see [docs/api.md](../../docs/api.md).
- **`InteractiveSession` / `InteractiveSessionOptions` / `InteractiveTurn` / `SteeringResponse`** — the held-open multi-turn session surface returned by `openSession()`; `InteractiveSession.steer()` is available only while its original `prompt()` is in flight and returns the raw extension response.
- **`AcpAgent`** (+ `AcpAgentOptions`, `AcpAgentPromptOptions`, `AcpAgentTurn`, `AcpAgentMessage`, `AcpAgentStream` / `AcpAgentStreamEvent`, `AcpAgentForkOptions`, `AcpAgentReopenOptions`, `AcpAgentProbeOptions`, `AcpAgentCatalog`, `AcpAgentState`, `AcpAgentTraits` / `describeBackendTraits`, `AcpAgentTurnError` / `isAcpAgentTurnError`, the function-tool surface `AcpAgentToolDefinition` / `AcpAgentToolContext` / `AcpAgentToolResult` / `defineTool` / `AGENT_TOOLS_SERVER_NAME` / `AGENT_TOOL_NAME_PATTERN`) — the SDK-style front door: one dedicated ACP process per agent, a per-agent FIFO (`prompt`/`stream`/`fork`/`setModel`/`setMode`/`setConfigOptions`/`close` serialize behind the in-flight turn; `steer`/`cancel` overlap it), mid-session model switching (`setModel(spec)` / a per-turn `model`, same backend, sticky, inherited by later forks), verbatim per-turn results (`turn.response` incl. `_meta`, every `updates`/`raw` record, folded `toolCalls`, the per-message `messages` fold, per-turn `usage`), an opt-in `schemaRetries` structured repair ladder (`turn.structuredAttempts`), `stream()` (the turn as an async iterable of its own events plus the terminal turn; an early exit cancels it), live `fork()` on a new process following the backend's `FORK_SESSION_TRAITS` row (id-only backends are reattached before their first turn), client-side function `tools` served from a per-agent HTTP MCP host (`agent_tools`, HTTP-MCP-gated at open), the headless `permissions` policy, `close({ keep })`, `Symbol.asyncDispose`, the cold statics `AcpAgent.resume/load/fork(ref)` routed by `ref.backendId` (never the default backend; `fork(ref)` prefers `session/load` so the child carries the transcript), and `AcpAgent.probe()` — the same catalog `probeHarnessConfig` produces, on one disposed process per target. A typed session failure rejects `prompt()` with the runner's mapped `WorkflowError` carrying the complete turn as `error.turn`. Quick start above; full reference in [docs/api.md](../../docs/api.md#acpagent-sdk). `@automatalabs/workflows` re-exports the class, `isAcpAgentTurnError`, and the types.
- **`ProbeConfigOptionsOptions` / `ProbedConfigOptions` / `SessionConfigOption`** — the no-prompt probe controls, routed result, and verbatim ACP advertised-option wire shape.
- **`probeHarnessConfig` / `buildHarnessModelsView` / `buildHarnessConfigSummary`** — the token-free harness config catalog (moved here from `@automatalabs/workflows`, which re-exports it): one no-prompt session per requested harness resolving to a `HarnessConfigReport` (`ValidateHarnessOptions[]` plus the bounded `authoringSummary`), the `--models` view builders (`buildModelFilter`, `selectChoicePairs`, `summarizeSelectChoices`), `formatHarnessConfigSummary`, and the `ValidateProbeRunner` seam a host passes as `probeRunner` to reuse its own live runner.
- **`BUILTIN_BACKENDS` / `ThoughtLevelDomainSemantics`** — the built-in registry declares whether each backend's thought-level values are an `"ordered"` ladder (Claude, Codex, Pi) or an `"exact-set"` (OpenCode). `builtinThoughtLevelDomainSemantics(id)` performs an exact lookup; an absent row means a custom/unknown backend and must be handled as `"exact-set"`.
- **`AcpRunnerOptions.onElicitation`** — runner-wide ACP elicitation responder; sessions can override with `InteractiveSessionOptions.onElicitation`.
- **`selectBackend({ model, tier }, registry?)`** — deterministic first-segment routing; registered custom names take priority, then the four built-ins, otherwise the configured default.
- **`resolveModelRoute(spec, registry?)` / `ModelRoute`** — the same routing with the verbatim model value kept: `{ backend, modelSpec }`, where `modelSpec` is the text after the routed first segment (`undefined` for a backend-only spec) or the whole spec when nothing routed. `selectBackend` is `resolveModelRoute(model ?? tier).backend`.
- **`ClaudeBackend` / `CodexBackend` / `OpenCodeBackend` / `PiBackend`** — the four built-in backend strategies (spawn config + per-backend schema/auth wiring). OpenCode is host-resolved rather than bundled; pi uses bundled `@automatalabs/pi-acp`.
- **`CustomAcpBackend` / `resolveBackendRegistry` / `BACKENDS_ENV`** — the custom-backend registry: run **any** ACP agent as a named backend via `createAcpRunner({ backends: { name: { command, args?, env?, sessionMeta?, structuredOutputTool?, fork? } } })` or the `AGENTPRISM_BACKENDS` env var (JSON, same shape; the option wins per name; names may shadow built-ins). `fork?` (`CustomBackendForkConfig`, `{ disposition: "id-only" | "live", cwd?: "source-only" | "free" }`) declares how the agent answers `session/fork` — see `FORK_SESSION_TRAITS` above; omitted means `live`/`free`. Custom backends carry a `schema` as turn-level `_meta.outputSchema` and read the result off the final message as JSON. No host-side vendor capability declaration is required.
- **Auth contracts and lifecycle** — `AuthStore`, `BackendAuthMachine`, `buildAuthDescriptors`, the built-in auth profiles, and the `AuthContext` / `AuthResolution` / `AuthMethodDescriptor` / `AuthCapableRunner` types.
- **Permission APIs** — `PermissionResolver` parks a request for an async host decision; `selectPermissionOption(request, optionId)` validates one exact advertised option. `decidePermission` remains the SDK/headless auto-policy. Provider effects and persistence are never inferred from labels, `kind`, or response metadata.
- **`clientCapabilitiesFor` + the `ClientHandlers` / `FsHandlers` / `TerminalHandlers` / `AcpSessionContext` types** — the client-side fs/terminal interposition surface (see above).
- **`negotiateCapabilities` / `adaptPromptContent` / `unsupportedMcpServer` + `NegotiatedCapabilities`** — the standard ACP capability-negotiation primitives; the negotiated record for a live connection is exposed on `PooledConnection.capabilities`, with vendor initialize metadata retained only as raw `initializeMeta`.
- **`AGENT_METHOD_COVERAGE` / `CLIENT_METHOD_COVERAGE` / `ACP_EXTENSION_SUPPORT_MATRIX`** — manifests classifying the installed ACP SDK method surface and documenting built-in vendor-extension advertisements. The extension matrix is evidence for probes and never routes runtime behavior.
- **`FORK_SESSION_TRAITS` / `FORK_SESSION_TRAIT_DEFAULT` / `forkSessionTrait(agent, declared?)`** and **`PROMPT_USAGE_SCOPES` / `promptUsageScope(agent)`** — the per-built-in `session/fork` disposition table and the per-turn `PromptResponse.usage` scope pin (see [Session handoff](#session-handoff)); both also ride each `BUILTIN_PROTOCOL_COVERAGE` row as `fork` / `promptUsage`. Executable data probed in the installed adapter dists, never a runtime branch.
- **`toJsonSchema(schema)` / `toStrictJsonSchema(schema)`** — turn a typebox schema into on-the-wire shapes: plain JSON Schema for Claude and the Pi/OpenCode injected HTTP MCP tool, and an OpenAI-strict-normalized schema for Codex `outputSchema`. Pi retains the common prompt/validated-last-text fallback.

Also exported: `AcpAgentPool` / `resolvePoolSize` (including the same deadline-only `forceKill()` emergency path), `PooledConnection` / `SessionHandle`, `decidePermission`, `UsageAccumulator`, `resolveStructuredOutput` / `extractValidated` / `findJsonBlock` / `validateValue`, `errorText` / `mapThrownError`, and the event surface `TypedEventEmitter` / `AcpRunnerEventMap` / `AcpEventName` / `AcpEventListener` / `AcpEventContext` / `AcpSessionUpdate` (+ the per-event payload types, including `AcpPermissionPendingEvent`), plus their associated types.

## Environment overrides

| Variable | Effect |
| --- | --- |
| `AGENTPRISM_DEFAULT_BACKEND` | Backend for specs whose first segment is not registered (`claude`, `codex`, `opencode`, `pi`, or a registered custom name; unknown values fall back to Claude). |
| `AGENTPRISM_BACKENDS` | Custom ACP backends as JSON: `{"<name>": {"command": "…", "args": […], "env": {…}, "sessionMeta": {…}, "structuredOutputTool": true, "fork": { "disposition": "id-only" }}}` (`fork` optional; declare `id-only` for entries wrapping claude-agent-acp or upstream codex-acp). |
| `AGENTPRISM_ACP_INIT_TIMEOUT_MS` | Deadline (default `60000`) for a backend's one-time ACP `initialize` handshake — a non-ACP command fails fast instead of hanging. |
| `AGENTPRISM_ACP_POOL_SIZE` | Long-lived processes to keep per backend (default `1`). |
| `AGENTPRISM_CLAUDE_ACP_CMD` / `AGENTPRISM_CLAUDE_ACP_ARGS` | Override the command (and args) used to spawn the Claude ACP server. |
| `AGENTPRISM_CODEX_ACP_CMD` / `AGENTPRISM_CODEX_ACP_ARGS` | Override the command (and args) used to spawn the Codex ACP server. |
| `AGENTPRISM_CODEX_ACP_BIN` | Override only the resolved Codex ACP bin path (keeps the default node launcher). |
| `AGENTPRISM_OPENCODE_ACP_CMD` / `AGENTPRISM_OPENCODE_ACP_ARGS` | Override the command (and args) used to spawn the OpenCode ACP server. |
| `AGENTPRISM_OPENCODE_DATA_ROOT` | Override the opencode built-in's stable per-user XDG data/state/cache root (default: `<data home>/agentprism/opencode`) — the tree where agent-persisted sessions live so cross-process `session/load` re-attachment is real. |
| `AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS` | The loaded-session founding-turn terminal-wait backstop (`awaitCurrentTurn`'s keep-attached `running` wait — how long a turn classified `running` (by the extension's query or by live continuation on the observation path) is waited for its terminal state before the seam rejects with the still-running class; the broker re-arms the wait on the still-attached session; default `900000` = 15 min). |
| `AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS` | The observation path's post-load continuation window (backends without the `_session/loaded_turn` extension): how long the seam watches the loaded session's stream for LIVE CONTENT after the load boundary before classifying the founding turn from the replay (completed / interrupted); default `1000` = 1 s. |
| `AGENTPRISM_PI_ACP_CMD` / `AGENTPRISM_PI_ACP_ARGS` | Override the command (and args) used to spawn the bundled pi ACP server. |

## License

Apache-2.0
