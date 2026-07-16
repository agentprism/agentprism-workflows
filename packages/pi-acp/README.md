# `@automatalabs/pi-acp`

An in-process Agent Client Protocol server for the [pi coding agent](https://github.com/earendil-works/pi). It embeds pi through its published SDK and speaks ACP protocol version 1 over stdio. Standard output is reserved exclusively for ACP NDJSON.

## Command line

Run the server with `npx @automatalabs/pi-acp` or an installed `pi-acp` binary. `pi-acp --version` prints the package version without starting a server.

## Side-effect-free library API

The package entry exports the value APIs `runAcp(options?)`, `PiAcpAgent`, and `resolveDeps`, plus the TypeScript-only `PiAcpDeps` type. Importing it starts no server, opens no stdio connection, and does not mutate `console` or stdio. Call and await `runAcp()` explicitly to connect; pass a partial `PiAcpDeps` and/or an ACP stream for embedding and tests.

## AgentPrism built-in backend

`@automatalabs/acp-agents` ships pi-acp as the built-in `pi` backend. Route a call with the backend-only id to keep pi's configured default model, or include pi's exact `provider/model-id` after the routing prefix:

```ts
await runner.run("Review this change", { model: "pi" });
await runner.run("Review this change", { model: "pi/openrouter/vendor/model-id" });
```

The runner strips exactly the first `pi/` segment and sends the remaining `provider/model-id` verbatim through ACP's reserved `model` config channel. An unknown model rejects with JSON-RPC `-32602` and `data.errorKind = "invalid_model"`. Hosts driving pi-acp directly can negotiate its native schema channel from `agentCapabilities._meta["@automatalabs/pi-acp"].outputSchema` and send the bare `_meta.outputSchema` key.

## Authentication

Credentials are ambient. The server advertises these exact methods unconditionally:

| id | name | source |
| --- | --- | --- |
| `anthropic-api-key` | Anthropic API key | `ANTHROPIC_API_KEY` |
| `openai-api-key` | OpenAI API key | `OPENAI_API_KEY` |
| `gemini-api-key` | Google Gemini API key | `GEMINI_API_KEY` |
| `xai-api-key` | xAI API key | `XAI_API_KEY` |
| `openrouter-api-key` | OpenRouter API key | `OPENROUTER_API_KEY` |
| `pi-stored-credentials` | pi stored credentials | pi's `~/.pi/agent/auth.json` |

Authentication requests are no-op acknowledgements because the environment or pi's credential store supplies the secret. A selected or otherwise resolvable model whose credential is missing rejects with `-32000` so clients can pause for authentication. Having no model at all is distinct: it rejects with `-32602` / `invalid_model`.

## Reserved tool namespaces

pi-acp owns the `mcp__` prefix for bridged MCP tools and the exact `__acp_structured_output` tool. pi extensions must not register names in the `mcp__` or `__acp_` namespaces.

## Version 1 limitations

Only stdio MCP servers are supported. Load replay is the active linear branch and excludes branch topology and compaction summaries. `additionalDirectories` is accepted but ignored because pi is not root-confined. Audio is degraded to a text note. Mid-turn steering and terminal-login authentication are not exposed.

## Development

The `pnpm test` script intentionally runs `tsc -p tsconfig.type-tests.json` before the runtime test suite. This is a small deviation from the test-script example in the frozen specification and ensures the T2b public type-contract check is enforced in local and CI test runs.

## Built on pi — THIRD-PARTY notice

This package depends on and embeds `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-ai` version 0.80.9. pi is Copyright Earendil Inc., Mario Zechner, and Armin Ronacher and is distributed under the MIT License. The dependency packages retain the full MIT copyright and license text. pi-acp itself is Apache-2.0.
