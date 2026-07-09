# @automatalabs/acp-agents

Low-level building block: the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) client plus Claude, Codex, OpenCode, and custom backends that implement the `AgentRunner` seam from `@automatalabs/shared-types`. It spawns an ACP server as a child process, drives one subagent turn to completion, and returns structured output or text.

This is the layer `@automatalabs/workflows` and `@automatalabs/mcp-server` are built on.

## Most users want `@automatalabs/workflows`

If you are orchestrating a workflow, use [`@automatalabs/workflows`](../workflows) instead — it re-exports `createAcpRunner` and wires it into the engine for you. Reach for this package directly only when you want to drive a **single** ACP agent yourself or need the low-level auth/session lifecycle APIs.

```bash
npm install @automatalabs/acp-agents
```

Claude and Codex adapters are dependencies of this package. OpenCode is resolved from an
`opencode-ai` installation or an `opencode` executable on `PATH` only when selected.

## Standalone use: drive one agent

`createAcpRunner().run(prompt, options)` runs a single agent to completion. Pass a [typebox](https://github.com/sinclairzx81/typebox) `schema` to get a validated object back (typed as `Static<typeof schema>`); omit it to get the final assistant text as a `string`. The Claude, Codex, OpenCode, or registered custom backend is selected from `model` / `tier`. Whoever constructs the runner owns it: call `dispose()` (or use `await using`) when you're done to tear down the pooled child processes.

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
    model: "anthropic/claude-sonnet-4", // routes to the Claude backend
    cwd: "/abs/path/to/worktree",       // ACP session/new { cwd } — absolute
  });
  console.log(review.risk, review.summary);

  // No schema: result is the final assistant text.
  const text = await runner.run("Explain this repo in one paragraph.", {
    model: "openai/gpt-5", // routes to the Codex backend
    cwd: "/abs/path/to/worktree",
  });
  console.log(text);
} finally {
  await runner.dispose();
}
```

`run()` accepts the full `RunOptions` seam: `schema`, `model`, `mode`, `tier`, `cwd`, `instructions`, `label`, `signal` (cancellation), `toolNames` / `disallowedToolNames`, `maxSchemaRetries`, `mcpServers`, `images` (see below), `runId`, `backends`, `meta` / `promptMeta`, `baseInstructions` / `developerInstructions` (Codex-only, see below), `keepSession`, `onSessionOpen`, `onUsage`, `onModelResolved`, `onModelFallback`, and `onHistory`. See `@automatalabs/shared-types` for the field-by-field contract.

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
  model: "openai/gpt-5.5",
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

Use `runner.openSession(options)` when a host needs to hold one ACP session open across multiple prompt turns. It uses the same backend selection and session/new inputs as `run()` (`model` / `tier`, absolute `cwd`, tool policy, `mcpServers`, `meta`, `runId`, Codex instruction overrides), but it spawns a **dedicated** agent process for that session instead of borrowing from the pool. A long-lived interactive session therefore never starves `run()` calls on the same backend, even with the default pool size of one.

Prompt turns are explicit and serialized: call `prompt(content, { images?, promptMeta? })`, await the returned `{ stopReason, text }`, then send the next turn. A second `prompt()` while one is in flight rejects with a host-side error; queue turns in your host if you want queued UX. `text` is only the assistant text from that turn. Per-turn `images` use the same ACP image block path as `run()` and still degrade through capability negotiation when the agent does not advertise image prompts.

`cancel()` sends ACP `session/cancel` for the active turn. `release()` is idempotent: it best-effort closes the ACP session and then disposes the dedicated process. Passing `signal` to `openSession()` releases the session on abort, and `runner.dispose()` releases any still-open interactive sessions before closing the pooled processes. Dedicated process death is observed per session: the wrapper auto-releases, session-scoped listeners see `session_close`, and an in-flight prompt rejects through the normal connection-closed path. `backend_error` is connection-scoped observability on the runner bus only; it is not delivered through `session.on()`.

```ts
const runner = createAcpRunner();

try {
  const session = await runner.openSession({
    model: "anthropic/claude-sonnet-4",
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

Use `onSessionOpen` to capture the backend/session/cwd re-attach handle. Set `keepSession: true`
when the backend supports persistence and the host intends to call `loadSession()` or
`resumeSession()` later; this skips the release-time best-effort `session/close`. The runner also
exposes `listSessions()` and `deleteSession()` where advertised. Re-attach support is capability
gated, so inspect the handle's `reopen` flags rather than assuming every ACP agent persists state.

## Listening in: live ACP events

`AcpAgentRunner` is also a typed event bus — `runner.on(name, listener)` bubbles up the live ACP stream of every run (streaming text, tool calls, usage, permissions, elicitations). Event names are the ACP `sessionUpdate` discriminants (`agent_message_chunk`, `tool_call`, `usage_update`, …) plus the cross-cutting `session_update` (catch-all), `permission_pending`, `permission_request`, `elicitation_pending`, `elicitation_request`, `elicitation_complete`, `raw_message`, `session_open` / `session_close`, and `backend_error`. Each payload carries a `{ sessionId, backendId, label?, runId? }` context envelope (a pooled runner multiplexes many runs at once). `permission_pending` / `elicitation_pending` are resolver-only and carry `{ request }` before the host resolver is invoked; `permission_request` / `elicitation_request` fire exactly once with the final `{ request, outcome }` returned to the agent; `elicitation_complete` carries `{ notification }` for URL completions. `on()` / `once()` return an unsubscribe thunk; `off()` and `removeAllListeners()` round it out. Listeners are best-effort observers — a throwing listener never affects the run.

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
- **`AcpAgentRunner`** — the `AgentRunner` implementation; `run(prompt, options)`, `openSession(options)`, `dispose()`, and `[Symbol.asyncDispose]()` for `await using`. The caller that constructs a runner owns its lifecycle.
- **Auth/provider lifecycle methods** — `describeAuthMethods()`, `completeAuth()`, `runner.auth`, `authMethods()`, `authenticate()`, `listProviders()`, `setProvider()`, `disableProvider()`, and `logout()`; see [docs/api.md](../../docs/api.md) for capability gating and installed adapter support.
- **Session lifecycle methods** — `listSessions()`, `deleteSession()`, `loadSession()`, and `resumeSession()` for backends that advertise session persistence; see [docs/api.md](../../docs/api.md).
- **`InteractiveSession` / `InteractiveSessionOptions` / `InteractiveTurn`** — the held-open multi-turn session surface returned by `openSession()`.
- **`AcpRunnerOptions.onElicitation`** — runner-wide ACP elicitation responder; sessions can override with `InteractiveSessionOptions.onElicitation`.
- **`selectBackend({ model, tier }, registry?)`** — the cross-provider routing rule: which backend a spec maps to (registered custom names match first, exact or `name/<inner-model>`).
- **`ClaudeBackend` / `CodexBackend` / `OpenCodeBackend`** — the three built-in backend strategies (spawn config + per-backend schema/auth wiring). OpenCode is host-resolved rather than bundled.
- **`CustomAcpBackend` / `resolveBackendRegistry` / `BACKENDS_ENV`** — the custom-backend registry: run **any** ACP agent as a named backend via `createAcpRunner({ backends: { name: { command, args?, env?, sessionMeta?, customCapabilities? } } })` or the `AGENTPRISM_BACKENDS` env var (JSON, same shape; the option wins per name; `claude`/`codex`/`opencode` reserved). Custom backends carry a `schema` as turn-level `_meta.outputSchema` and read the result off the final message as JSON. `customCapabilities: { namespace, gatedKeys }` declares the agent's `agentCapabilities._meta` negotiation contract: once the agent advertises that namespace, each declared bare `_meta` key is sent only when its same-named flag is `true` (no declaration = never gated).
- **Auth contracts and lifecycle** — `AuthStore`, `BackendAuthMachine`, `buildAuthDescriptors`, the built-in auth profiles, and the `AuthContext` / `AuthResolution` / `AuthMethodDescriptor` / `AuthCapableRunner` types.
- **`PermissionResolver`** — async human-in-the-loop permission resolution for runner-wide or interactive sessions.
- **`clientCapabilitiesFor` + the `ClientHandlers` / `FsHandlers` / `TerminalHandlers` / `AcpSessionContext` types** — the client-side fs/terminal interposition surface (see above).
- **`negotiateCapabilities` / `adaptPromptContent` / `gateCustomMeta` / `unsupportedMcpServer` + `NegotiatedCapabilities`** — the `initialize` capability-negotiation primitives; the negotiated record for a live connection is exposed on `PooledConnection.capabilities`.
- **`AGENT_METHOD_COVERAGE` / `CLIENT_METHOD_COVERAGE`** — manifests classifying the installed ACP SDK method surface; enforced by tests so SDK bumps cannot silently drift.
- **`toJsonSchema(schema)` / `toStrictJsonSchema(schema)`** — turn a typebox schema into the on-the-wire shapes: a plain JSON Schema for Claude `outputFormat`, and an OpenAI-strict-normalized schema for Codex `outputSchema`.

Also exported: `AcpAgentPool` / `resolvePoolSize`, `PooledConnection` / `SessionHandle`, `decidePermission`, `UsageAccumulator`, `resolveStructuredOutput` / `extractValidated` / `findJsonBlock` / `validateValue`, `errorText` / `mapThrownError`, and the event surface `TypedEventEmitter` / `AcpRunnerEventMap` / `AcpEventName` / `AcpEventListener` / `AcpEventContext` / `AcpSessionUpdate` (+ the per-event payload types, including `AcpPermissionPendingEvent`), plus their associated types.

## Environment overrides

| Variable | Effect |
| --- | --- |
| `AGENTPRISM_DEFAULT_BACKEND` | Backend when `model`/`tier` don't pick one (`codex` selects Codex; a registered custom name selects that backend; anything else is Claude). |
| `AGENTPRISM_BACKENDS` | Custom ACP backends as JSON: `{"<name>": {"command": "…", "args": […], "env": {…}, "sessionMeta": {…}, "customCapabilities": {"namespace": "…", "gatedKeys": […]}}}`. |
| `AGENTPRISM_ACP_INIT_TIMEOUT_MS` | Deadline (default `60000`) for a backend's one-time ACP `initialize` handshake — a non-ACP command fails fast instead of hanging. |
| `AGENTPRISM_ACP_POOL_SIZE` | Long-lived processes to keep per backend (default `1`). |
| `AGENTPRISM_CLAUDE_ACP_CMD` / `AGENTPRISM_CLAUDE_ACP_ARGS` | Override the command (and args) used to spawn the Claude ACP server. |
| `AGENTPRISM_CODEX_ACP_CMD` / `AGENTPRISM_CODEX_ACP_ARGS` | Override the command (and args) used to spawn the Codex ACP server. |
| `AGENTPRISM_CODEX_ACP_BIN` | Override only the resolved Codex ACP bin path (keeps the default node launcher). |
| `AGENTPRISM_OPENCODE_ACP_CMD` / `AGENTPRISM_OPENCODE_ACP_ARGS` | Override the command (and args) used to spawn the OpenCode ACP server. |

## License

Apache-2.0
