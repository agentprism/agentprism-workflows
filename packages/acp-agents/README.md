# @automatalabs/acp-agents

Low-level building block: the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) client plus Claude, Codex, OpenCode, pi, and custom backends that implement the `AgentRunner` seam from `@automatalabs/shared-types`. It spawns an ACP server as a child process, drives one subagent turn to completion, and returns structured output or text.

This is the layer `@automatalabs/workflows` and `@automatalabs/mcp-server` are built on.

## Most users want `@automatalabs/workflows`

If you are orchestrating a workflow, use [`@automatalabs/workflows`](../workflows) instead — it re-exports `createAcpRunner` and wires it into the engine for you. Reach for this package directly only when you want to drive a **single** ACP agent yourself or need the low-level auth/session lifecycle APIs.

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

`run()` accepts the full `RunOptions` seam: `schema`, `model`, `mode`, `configOptions`, `tier`, `cwd`, `instructions`, `label`, `signal` (cancellation), `toolNames` / `disallowedToolNames`, `maxSchemaRetries`, `mcpServers`, `images` (see below), `runId`, `backends`, `meta` / `promptMeta`, `baseInstructions` / `developerInstructions` (Codex-only, see below), `keepSession`, the resume-only `continueFromSession` directive, `onSessionOpen`, `onUsage`, `onResultProvenance`, `onModelResolved`, `onModelFallback`, and `onHistory`. See `@automatalabs/shared-types` for the field-by-field contract.

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
const { backendId, options } = await runner.probeConfigOptions("codex", {
  cwd: "/abs/path/to/worktree",
});

const selected = await runner.probeConfigOptions("pi/openrouter/vendor/model-id", {
  cwd: "/abs/path/to/worktree",
  selectModel: true,
});
```

`probeConfigOptions()` uses the normal first-segment routing and pool, opens exactly one session,
returns the advertised `SessionConfigOption[]` shapes verbatim, then closes that session. By
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

### Codex session instructions (`baseInstructions` / `developerInstructions`)

When the run routes to the Codex backend, two optional fields let you override Codex's thread-level instructions for the session:

- **`baseInstructions`** — replaces Codex's built-in base system prompt.
- **`developerInstructions`** — injects developer-role instructions (added on top of the base prompt).

They ride ACP `session/new` `_meta` as bare keys and are threaded into the Codex `thread/start.{baseInstructions,developerInstructions}` params by the [`@automatalabs/codex-acp`](https://www.npmjs.com/package/@automatalabs/codex-acp) adapter. Both are additive (never part of the resume identity) and are **ignored by the Claude backend** — Claude has no analog. Note this is distinct from `instructions`, which is folded into the prompt text for either backend.

```ts
await runner.run("Cut the release.", {
  model: "codex/gpt-5.6-sol",
  cwd: "/abs/path/to/worktree",
  baseInstructions: "You are a release bot. Only touch CHANGELOG.md.",
  developerInstructions: "Prefer conventional-commit summaries.",
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

Prompt turns are explicit and serialized: call `prompt(content, { images?, promptMeta? })`, await the returned `{ stopReason, text }`, then send the next turn. A second `prompt()` while one is in flight rejects with a host-side error; queue turns in your host if you want queued UX. `text` is only the assistant text from that turn. Per-turn `images` use the same ACP image block path as `run()` and still degrade through capability negotiation when the agent does not advertise image prompts.

While a `prompt()` is in flight, `steer(content, { images?, promptMeta? })` injects a follow-up through the vendor `_session/steering` extension and resolves to the agent-owned outcome: `"injected"`, `"startedNewTurn"`, or `"failed"`. It is not a second turn: it owns no output, usage, retry, or prompt settlement, and its output arrives on the original prompt's `session/update` stream. Idle callers must use `prompt()`; concurrent steering calls are left to the backend. Support is negotiated strictly from top-level `InitializeResponse._meta.steering.supported === true` (Claude, Codex, and pi advertise it; OpenCode rejects before any wire request). Optional outgoing request `_meta` remains independently handled by `gateCustomMeta()`.

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
continuation fires exactly once — the REPL broker's re-attach arm. Completion evidence is the
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

Backends WITHOUT the extension degrade through the same honest fallback the doc's restore path
prescribes for a capability-omitting backend (never by settling partial output): the seam rejects
immediately with `LoadedTurnStillRunningError` (`loadedTurnStillRunning` marker — non-re-armable),
and the broker releases the loaded session and re-issues the call under the same id, surfaced
guest-visibly — never a permanent hold (phase-F review: the old keep-attached-and-pending arm
left re-attached calls on seam-less backends pending until interrupt/reset). A `running` turn
whose notification does not arrive within the max-wait bound rejects with the RE-ARMABLE form of
the same error (the broker re-arms the seam on the still-attached session — a later notification
or a cancel still settles the call); a turn that ended by FAILING at the backend rejects with
`LoadedTurnFailedError` (`loadedTurnFailed` marker — a definite outcome, settled as a rejection,
never re-issued); everything else (no user message in the transcript, `interrupted`, a dead
process) is the safe-re-issue class. The seam's rejection classes are structural, so third-party
adapter seams can throw the same markers. `isLoadedTurnStillRunningError` /
`isLoadedTurnFailedError` are exported for hosts that classify seam rejections.

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

## Authentication lifecycle

The built-in runner is auth-capable without widening the minimal `AgentRunner` interface.
`describeAuthMethods()` returns normalized `agent` / `terminal` / `env_var` descriptors;
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

## Listening in: live ACP events

`AcpAgentRunner` is also a typed event bus — `runner.on(name, listener)` bubbles up the live ACP stream of every run (streaming text, tool calls, usage, permissions, elicitations). Event names are the ACP `sessionUpdate` discriminants (`agent_message_chunk`, `tool_call`, `usage_update`, …) plus the cross-cutting `session_update` (catch-all), `permission_pending`, `permission_request`, `elicitation_pending`, `elicitation_request`, `elicitation_complete`, `raw_message`, `steering`, `session_open` / `session_close`, and `backend_error`. Each payload carries a `{ sessionId, backendId, label?, runId?, callIndex? }` context envelope (a pooled runner multiplexes many runs at once). `steering` carries only `{ outcome }` after a resolved steering response, never prompt content or request metadata. `permission_pending` / `elicitation_pending` are resolver-only and carry `{ request }` before the host resolver is invoked; `permission_request` / `elicitation_request` fire exactly once with the final `{ request, outcome }` returned to the agent; `elicitation_complete` carries `{ notification }` for URL completions. `on()` / `once()` return an unsubscribe thunk; `off()` and `removeAllListeners()` round it out. Listeners are best-effort observers — a throwing listener never affects the run.

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
- **`AcpAgentRunner`** — the `AgentRunner` implementation; `run(prompt, options)`, `probeConfigOptions(spec?, options?)`, `openSession(options)`, `dispose()`, and `[Symbol.asyncDispose]()` for `await using`. `forceKill()` is a synchronous, best-effort emergency teardown for hosts only after a bounded graceful `dispose()` deadline; normal owners must await `dispose()`. The caller that constructs a runner owns its lifecycle.
- **Auth/provider lifecycle methods** — `describeAuthMethods()`, `completeAuth()`, `runner.auth`, `authMethods()`, `authenticate()`, `listProviders()`, `setProvider()`, `disableProvider()`, and `logout()`; see [docs/api.md](../../docs/api.md) for capability gating and installed adapter support. A successful `setProvider()` records a durable routing intent (`ProviderStore`) replayed on every fresh connection's `initialize` — provider config is in-process agent state for e.g. codex-acp, so record → recycle → replay is what makes it stick across the pool.
- **Session lifecycle methods** — `listSessions()`, `deleteSession()`, `loadSession()`, `resumeSession()`, and `forkSession()` for backends that advertise session persistence; see [docs/api.md](../../docs/api.md).
- **`InteractiveSession` / `InteractiveSessionOptions` / `InteractiveTurn` / `SteeringOutcome`** — the held-open multi-turn session surface returned by `openSession()`; `InteractiveSession.steer()` is available only while its original `prompt()` is in flight.
- **`ProbeConfigOptionsOptions` / `ProbedConfigOptions` / `SessionConfigOption`** — the no-prompt probe controls, routed result, and verbatim ACP advertised-option wire shape.
- **`BUILTIN_BACKENDS` / `ThoughtLevelDomainSemantics`** — the built-in registry declares whether each backend's thought-level values are an `"ordered"` ladder (Claude, Codex, Pi) or an `"exact-set"` (OpenCode). `builtinThoughtLevelDomainSemantics(id)` performs an exact lookup; an absent row means a custom/unknown backend and must be handled as `"exact-set"`.
- **`AcpRunnerOptions.onElicitation`** — runner-wide ACP elicitation responder; sessions can override with `InteractiveSessionOptions.onElicitation`.
- **`selectBackend({ model, tier }, registry?)`** — deterministic first-segment routing; registered custom names take priority, then the four built-ins, otherwise the configured default.
- **`ClaudeBackend` / `CodexBackend` / `OpenCodeBackend` / `PiBackend`** — the four built-in backend strategies (spawn config + per-backend schema/auth wiring). OpenCode is host-resolved rather than bundled; pi uses bundled `@automatalabs/pi-acp`.
- **`CustomAcpBackend` / `resolveBackendRegistry` / `BACKENDS_ENV`** — the custom-backend registry: run **any** ACP agent as a named backend via `createAcpRunner({ backends: { name: { command, args?, env?, sessionMeta?, customCapabilities? } } })` or the `AGENTPRISM_BACKENDS` env var (JSON, same shape; the option wins per name; names may shadow built-ins). Custom backends carry a `schema` as turn-level `_meta.outputSchema` and read the result off the final message as JSON. `customCapabilities: { namespace, gatedKeys }` declares the agent's `agentCapabilities._meta` negotiation contract: once the agent advertises that namespace, each declared bare `_meta` key is sent only when its same-named flag is `true` (no declaration = never gated).
- **Auth contracts and lifecycle** — `AuthStore`, `BackendAuthMachine`, `buildAuthDescriptors`, the built-in auth profiles, and the `AuthContext` / `AuthResolution` / `AuthMethodDescriptor` / `AuthCapableRunner` types.
- **`PermissionResolver`** — async human-in-the-loop permission resolution for runner-wide or interactive sessions.
- **`clientCapabilitiesFor` + the `ClientHandlers` / `FsHandlers` / `TerminalHandlers` / `AcpSessionContext` types** — the client-side fs/terminal interposition surface (see above).
- **`negotiateCapabilities` / `adaptPromptContent` / `gateCustomMeta` / `unsupportedMcpServer` + `NegotiatedCapabilities`** — the `initialize` capability-negotiation primitives; the negotiated record for a live connection is exposed on `PooledConnection.capabilities`.
- **`AGENT_METHOD_COVERAGE` / `CLIENT_METHOD_COVERAGE` / `ACP_EXTENSION_SUPPORT_MATRIX`** — manifests classifying the installed ACP SDK method surface and built-in vendor extensions; steering remains separate from SDK `AGENT_METHODS` and is enforced by installed-dist and live probes.
- **`toJsonSchema(schema)` / `toStrictJsonSchema(schema)`** — turn a typebox schema into on-the-wire shapes: plain JSON Schema for Claude and the Pi/OpenCode injected HTTP MCP tool, and an OpenAI-strict-normalized schema for Codex `outputSchema`. Pi retains the common prompt/validated-last-text fallback.

Also exported: `AcpAgentPool` / `resolvePoolSize` (including the same deadline-only `forceKill()` emergency path), `PooledConnection` / `SessionHandle`, `decidePermission`, `UsageAccumulator`, `resolveStructuredOutput` / `extractValidated` / `findJsonBlock` / `validateValue`, `errorText` / `mapThrownError`, and the event surface `TypedEventEmitter` / `AcpRunnerEventMap` / `AcpEventName` / `AcpEventListener` / `AcpEventContext` / `AcpSessionUpdate` (+ the per-event payload types, including `AcpPermissionPendingEvent`), plus their associated types.

## Environment overrides

| Variable | Effect |
| --- | --- |
| `AGENTPRISM_DEFAULT_BACKEND` | Backend for specs whose first segment is not registered (`claude`, `codex`, `opencode`, `pi`, or a registered custom name; unknown values fall back to Claude). |
| `AGENTPRISM_BACKENDS` | Custom ACP backends as JSON: `{"<name>": {"command": "…", "args": […], "env": {…}, "sessionMeta": {…}, "customCapabilities": {"namespace": "…", "gatedKeys": […]}}}`. |
| `AGENTPRISM_ACP_INIT_TIMEOUT_MS` | Deadline (default `60000`) for a backend's one-time ACP `initialize` handshake — a non-ACP command fails fast instead of hanging. |
| `AGENTPRISM_ACP_POOL_SIZE` | Long-lived processes to keep per backend (default `1`). |
| `AGENTPRISM_CLAUDE_ACP_CMD` / `AGENTPRISM_CLAUDE_ACP_ARGS` | Override the command (and args) used to spawn the Claude ACP server. |
| `AGENTPRISM_CODEX_ACP_CMD` / `AGENTPRISM_CODEX_ACP_ARGS` | Override the command (and args) used to spawn the Codex ACP server. |
| `AGENTPRISM_CODEX_ACP_BIN` | Override only the resolved Codex ACP bin path (keeps the default node launcher). |
| `AGENTPRISM_OPENCODE_ACP_CMD` / `AGENTPRISM_OPENCODE_ACP_ARGS` | Override the command (and args) used to spawn the OpenCode ACP server. |
| `AGENTPRISM_OPENCODE_DATA_ROOT` | Override the opencode built-in's stable per-user XDG data/state/cache root (default: `<data home>/agentprism/opencode`) — the tree where agent-persisted sessions live so cross-process `session/load` re-attachment is real. |
| `AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS` | The loaded-session founding-turn terminal-wait backstop (`awaitCurrentTurn`'s `running` arm — how long a turn classified `running` by the `_session/loaded_turn` extension is waited for its authoritative `_session/loaded_turn/ended` notification before the seam rejects with the re-armable still-running class; default `900000` = 15 min). |
| `AGENTPRISM_PI_ACP_CMD` / `AGENTPRISM_PI_ACP_ARGS` | Override the command (and args) used to spawn the bundled pi ACP server. |

## License

Apache-2.0
