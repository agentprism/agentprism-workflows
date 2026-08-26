# `@automatalabs/pi-acp`

An in-process Agent Client Protocol server for the [pi coding agent](https://github.com/earendil-works/pi). It embeds pi through its published SDK and speaks ACP protocol version 1 over stdio. Standard output is reserved exclusively for ACP NDJSON.

## Command line

Run the server with `npx @automatalabs/pi-acp` or an installed `pi-acp` binary. `pi-acp --version` prints the package version without starting a server.

## Side-effect-free library API

The package entry exports the value APIs `runAcp(options?)`, `PiAcpAgent`, and `resolveDeps`, plus the TypeScript-only `PiAcpDeps` type. Importing it starts no server, opens no stdio connection, and does not mutate `console` or stdio. Call and await `runAcp()` explicitly to connect; pass a partial `PiAcpDeps` and/or an ACP stream for embedding and tests.

### Pi configuration and teardown

Sessions load the operator's real pi configuration — settings, extensions, and pi's own MCP servers — from `PiAcpDeps.agentDir`, which defaults to pi's `getAgentDir()` (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`). Override it to point pi at an isolated directory; embedders and tests that stub `createAgentSession` should, because the resource loader reads this path and starts the extensions it finds *before* the session factory is called.

Closing a session emits pi's `session_shutdown` event to those extensions before disposing the session, matching `AgentSessionRuntime.dispose()`. That event is pi's only extension-cleanup contract, so an extension that spawned a process releases it there. This matters more here than for out-of-process ACP backends: pi runs **in-process**, so anything it leaves behind is a live handle on the host's event loop rather than something the OS reaps with a child process tree.

## AgentPrism built-in backend

`@automatalabs/acp-agents` ships pi-acp as the built-in `pi` backend. Route a call with the backend-only id to keep pi's configured default model, or include pi's exact `provider/model-id` after the routing prefix:

```ts
await runner.run("Review this change", { model: "pi" });
await runner.run("Review this change", { model: "pi/openrouter/vendor/model-id" });
```

The runner strips exactly the first `pi/` segment and sends the remaining `provider/model-id` verbatim through ACP's reserved `model` config channel. Pi-acp advertises a configured `model` select populated from the completed credential- and provider-filter-aware Pi catalog; set requests refresh and require membership in that same catalog. An unknown model rejects with JSON-RPC `-32602` and `data.errorKind = "invalid_model"`.

### Thinking levels

Pi-acp's `thinkingLevel` select is model-aware. Its visible choices are Pi's
`getSupportedThinkingLevels()` result for the selected model, in Pi's order: a model capped at
`high` does not advertise `xhigh` or `max`, and a non-reasoning model advertises only `off`. Before
a model is selected, the option uses Pi's complete recognized domain as an unknown-model
best-effort fallback. That domain is derived once from Pi's helper with a synthetic model that
supports every level; pi-acp does not maintain a parallel hardcoded vocabulary.

The option carries the additive ACP metadata
`_meta["@automatalabs/agentprism"].recognizedValues`. The visible choices remain the supported
subset, while this metadata contains Pi's complete ordered domain so clients can distinguish an
unsupported recognized value from garbage. A supported set request is applied unchanged. A
recognized but unsupported request is clamped with Pi's `clampThinkingLevel()` and the response
echoes the effective level. An unrecognized value fails loudly with JSON-RPC `-32602` and
`data.errorKind = "invalid_config_value"`; it is never handed to Pi's lowest-level fallback.

## MCP and structured output

Pi-acp serves stdio, Streamable HTTP, and legacy SSE MCP servers and consumes stable tools, resources, prompts, completion, logging, pagination, progress, and dynamic tool registration. It also provides MCP client sampling, the workspace root, and form/URL elicitation. Client-hosted `acp` transport remains runner-owned. For `agent({ schema })`, Pi receives the runner's client-hosted HTTP `StructuredOutput` tool through this standard MCP path and retains the common prompt-embedded schema plus validated last-text fallback.

## Authentication

Credentials are ambient. The server advertises exactly one method unconditionally:

| id | name | source |
| --- | --- | --- |
| `pi-stored-credentials` | pi stored credentials | pi's `~/.pi/agent/auth.json`, or a provider API key in the server's environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`) |

The per-provider API-key methods that used to sit alongside it were `env_var`-typed; ACP schema 1.21.0 (`@agentclientprotocol/sdk` 1.4.0) removed that variant from the protocol, so they are no longer advertised — the environment variables themselves are still honored. Authentication requests are no-op acknowledgements because the environment or pi's credential store supplies the secret. A selected or otherwise resolvable model whose credential is missing rejects with `-32000` so clients can pause for authentication. Having no model at all is distinct: it rejects with `-32602` / `invalid_model`.

## Reserved tool namespaces

pi-acp owns the `mcp__` prefix for injected MCP tools. Pi extensions must not register names in that namespace.

## Version 1 limitations

Load replay is the active linear branch and excludes branch topology and compaction summaries. `additionalDirectories` is accepted but ignored because pi is not root-confined. ACP prompt audio is degraded to a text note. Terminal-login authentication is not exposed.

### Native session steering

Pi advertises the `_session/steering` extension at top-level initialize metadata as
`_meta: { steering: { supported: true } }`, with strict active-turn-only semantics. While a Pi prompt turn is
live, the server converts the supplied ACP content with the same text/image conversion as
`session/prompt` and calls native `AgentSession.steer(text, images)`, returning
`{ outcome: "injected" }`; the original `session/prompt` still owns all output, usage, and
settlement. When the session is idle — or a steer arrives just as the turn settles, before pi could
consume it — the server removes any unconsumed native queue entry and returns
`{ outcome: "promptRequired", reason: "noRunningTurn" }`. It never calls `prompt()`, `followUp()`, or
another turn-start helper from steering, so steering cannot create hidden work or prepend input to a
later prompt. Cancellation races use the same `promptRequired/noRunningTurn` response when no active
turn accepted the instruction. Unexpected internal failures reject the JSON-RPC request through the
normal structured error path.

### Loaded-session turn-terminal state (`_session/loaded_turn`)

Pi also advertises the `_session/loaded_turn` extension at top-level initialize metadata as
`_meta: { loadedTurn: { supported: true } }` — the re-attach arm's AUTHORITATIVE completion
evidence for a session re-opened with `session/load` (the REPL broker's restore path).
`_session/loaded_turn/query { sessionId }` answers whether the loaded session's founding turn is
still running right now: `running` while a turn executes in this process (the client then waits
for the `_session/loaded_turn/ended` push — sent with the turn's stop reason, or its error, when
the turn finishes, arming and clearing a one-shot watch), `completed` when the session journal's
last message entry is an assistant message (pi persists every complete LLM message atomically at
`message_end`, so a completed turn always leaves an assistant leaf and the replay's trailing
assistant message is the turn's FINAL message — authoritative, never a quiet-gap guess), and
`interrupted` otherwise (the journal shows an interrupted/abandoned turn — nothing is running, so
re-issue is safe). A query for an unknown session is the standard `unknown_session` error.

## Development

The `pnpm test` script intentionally runs `tsc -p tsconfig.type-tests.json` before the runtime test suite. This is a small deviation from the test-script example in the frozen specification and ensures the T2b public type-contract check is enforced in local and CI test runs.

## Built on pi — THIRD-PARTY notice

This package depends on and embeds `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-ai` version 0.80.10. pi is Copyright Earendil Inc., Mario Zechner, and Armin Ronacher and is distributed under the MIT License. The dependency packages retain the full MIT copyright and license text. pi-acp itself is Apache-2.0.
