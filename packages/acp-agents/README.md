# @automatalabs/acp-agents

Low-level building block: the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) client plus Claude and Codex backends that implement the `AgentRunner` seam from `@automatalabs/shared-types`. It spawns `claude-agent-acp` / `codex-acp` as child processes, drives one subagent turn to completion over ACP, and returns structured output or text.

This is the layer `@automatalabs/workflows` and `@automatalabs/mcp-server` are built on.

## Most users want `@automatalabs/workflows`

If you are orchestrating a workflow, use [`@automatalabs/workflows`](../workflows) instead — it re-exports `createAcpRunner` and wires it into the engine for you. Reach for this package directly only when you want to drive a **single** Claude/Codex agent over ACP yourself.

```bash
npm install @automatalabs/acp-agents
```

## Standalone use: drive one agent

`createAcpRunner().run(prompt, options)` runs a single agent to completion. Pass a [typebox](https://github.com/sinclairzx81/typebox) `schema` to get a validated object back (typed as `Static<typeof schema>`); omit it to get the final assistant text as a `string`. The backend (Claude vs Codex) is selected from `model` / `tier`. Call `dispose()` when you're done to tear down the pooled child processes.

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

`run()` accepts the full `RunOptions` seam: `schema`, `model`, `tier`, `cwd`, `instructions`, `label`, `signal` (cancellation), `toolNames` / `disallowedToolNames`, `mcpServers`, `runId`, `baseInstructions` / `developerInstructions` (Codex-only, see below), `onUsage`, `onModelResolved`, `onModelFallback`, and `onHistory`. See `@automatalabs/shared-types` for the field-by-field contract.

### Codex session instructions (`baseInstructions` / `developerInstructions`)

When the run routes to the Codex backend, two optional fields let you override Codex's thread-level instructions for the session:

- **`baseInstructions`** — replaces Codex's built-in base system prompt.
- **`developerInstructions`** — injects developer-role instructions (added on top of the base prompt).

They ride ACP `session/new` `_meta` as bare keys and are threaded into the Codex `thread/start.{baseInstructions,developerInstructions}` params by the [`@automatalabs/codex-acp`](https://www.npmjs.com/package/@automatalabs/codex-acp) adapter. Both are additive (never part of the resume identity) and are **ignored by the Claude backend** — Claude has no analog. Note this is distinct from `instructions`, which is folded into the prompt text for either backend.

```ts
await runner.run("Cut the release.", {
  model: "openai/gpt-5-codex",
  cwd: "/abs/path/to/worktree",
  baseInstructions: "You are a release bot. Only touch CHANGELOG.md.",
  developerInstructions: "Prefer conventional-commit summaries.",
});
```

## Listening in: live ACP events

`AcpAgentRunner` is also a typed event bus — `runner.on(name, listener)` bubbles up the live ACP stream of every run (streaming text, tool calls, usage, permissions). Event names are the ACP `sessionUpdate` discriminants (`agent_message_chunk`, `tool_call`, `usage_update`, …) plus the cross-cutting `session_update` (catch-all), `permission_request`, `raw_message`, `session_open` / `session_close`, and `backend_error`. Each payload carries a `{ sessionId, backendId, label?, runId? }` context envelope (a pooled runner multiplexes many runs at once). `on()` / `once()` return an unsubscribe thunk; `off()` and `removeAllListeners()` round it out. Listeners are best-effort observers — a throwing listener never affects the run.

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
- **`AcpAgentRunner`** — the `AgentRunner` implementation; `run(prompt, options)` and `dispose()`.
- **`selectBackend({ model, tier }, registry?)`** — the cross-provider routing rule: which backend a spec maps to (registered custom names match first, exact or `name/<inner-model>`).
- **`ClaudeBackend` / `CodexBackend`** — the two built-in backend strategies (spawn config + per-backend schema wiring).
- **`CustomAcpBackend` / `resolveBackendRegistry` / `BACKENDS_ENV`** — the custom-backend registry: run **any** ACP agent as a named backend via `createAcpRunner({ backends: { name: { command, args?, env?, sessionMeta? } } })` or the `AGENTPRISM_BACKENDS` env var (JSON, same shape; the option wins per name; `claude`/`codex` reserved). Custom backends carry a `schema` as turn-level `_meta.outputSchema` and read the result off the final message as JSON.
- **`toJsonSchema(schema)` / `toStrictJsonSchema(schema)`** — turn a typebox schema into the on-the-wire shapes: a plain JSON Schema for Claude `outputFormat`, and an OpenAI-strict-normalized schema for Codex `outputSchema`.

Also exported: `AcpAgentPool` / `resolvePoolSize`, `PooledConnection` / `SessionHandle`, `decidePermission`, `UsageAccumulator`, `resolveStructuredOutput` / `extractValidated` / `findJsonBlock` / `validateValue`, `errorText` / `mapThrownError`, and the event surface `TypedEventEmitter` / `AcpRunnerEventMap` / `AcpEventName` / `AcpEventListener` / `AcpEventContext` / `AcpSessionUpdate` (+ the per-event payload types), plus their associated types.

## Environment overrides

| Variable | Effect |
| --- | --- |
| `AGENTPRISM_DEFAULT_BACKEND` | Backend when `model`/`tier` don't pick one (`codex` selects Codex; a registered custom name selects that backend; anything else is Claude). |
| `AGENTPRISM_BACKENDS` | Custom ACP backends as JSON: `{"<name>": {"command": "…", "args": […], "env": {…}, "sessionMeta": {…}}}`. |
| `AGENTPRISM_ACP_INIT_TIMEOUT_MS` | Deadline (default `60000`) for a backend's one-time ACP `initialize` handshake — a non-ACP command fails fast instead of hanging. |
| `AGENTPRISM_ACP_POOL_SIZE` | Long-lived processes to keep per backend (default `1`). |
| `AGENTPRISM_CLAUDE_ACP_CMD` / `AGENTPRISM_CLAUDE_ACP_ARGS` | Override the command (and args) used to spawn the Claude ACP server. |
| `AGENTPRISM_CODEX_ACP_CMD` / `AGENTPRISM_CODEX_ACP_ARGS` | Override the command (and args) used to spawn the Codex ACP server. |
| `AGENTPRISM_CODEX_ACP_BIN` | Override only the resolved Codex ACP bin path (keeps the default node launcher). |

## License

Apache-2.0
