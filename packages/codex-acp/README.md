# ACP adapter for Codex CLI (`@automatalabs/codex-acp`)

[![npm version](https://img.shields.io/npm/v/%40automatalabs%2Fcodex-acp)](https://www.npmjs.com/package/@automatalabs/codex-acp)

Use [OpenAI Codex](https://github.com/openai/codex) from [Agent Client Protocol](https://agentclientprotocol.com/) clients.

`codex-acp` is a stdio ACP agent server. It starts the Codex App Server, translates ACP requests into Codex operations, and maps Codex events back into the client.

This package is a fork of [`agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp), regularly synced with upstream. On top of upstream it exposes Codex App Server features not (yet) piped through the ACP interface — turn-level structured output (`outputSchema`) and per-session instruction overrides — and advertises them under `agentCapabilities._meta` so clients can feature-detect before sending them (see the fork sections below).

## Features

- ChatGPT, API key, and client-provided custom gateway authentication.
- Model, reasoning effort, fast mode, approval, and sandbox mode configuration.
- Text prompts, embedded context, images, resource links, and additional workspace directories.
- Turn-level structured output: a JSON Schema on the prompt's `_meta.outputSchema` constrains the final assistant message (fork extension, see below).
- Per-session base and developer instruction overrides via request `_meta` (fork extension, see below).
- Fork extensions advertised under `agentCapabilities._meta["@automatalabs/codex-acp"]` for client-side feature detection.
- Shell command, file change, permission request, MCP tool call, terminal output, reasoning, plan, web search, image generation, image view, token usage, and review events.
- Client `fs.readTextFile` capability: when the client advertises it, file-change diff content is read through `fs/read_text_file` (so diffs reflect unsaved editor buffers), with local file system fallback otherwise. File writes happen inside codex itself — the app-server delegates no file IO to the client.
- Subagent launches as standard ACP tool calls, with Codex thread identity and activity details in namespaced `_meta.codex.subagent` metadata.
- Client-provided MCP servers over command-based stdio config and HTTP transport.
- Slash commands: `/status`, `/mcp`, `/skills`, `/review`, `/review-branch`, `/review-commit`, `/compact`, and `/logout`, as well as configured skills.

## Installation

Run the published package directly:

```bash
npx -y @automatalabs/codex-acp
```

Or install it globally:

```bash
npm install -g @automatalabs/codex-acp
codex-acp --version
```

The npm package includes a compatible `@openai/codex` dependency. Set `CODEX_PATH` only when you want the adapter to run a different Codex binary:

```bash
CODEX_PATH=/path/to/codex npx -y @automatalabs/codex-acp
```

## Authentication

The adapter advertises ACP auth methods during initialization. Clients can authenticate with:

- ChatGPT login. Set `NO_BROWSER=1` to hide this method in remote or browserless environments.
- API key via `CODEX_API_KEY` or `OPENAI_API_KEY`.
- A custom OpenAI-compatible gateway, when the client opts in to the gateway auth capability.

## Runtime options

- `CODEX_API_KEY` - API key used when the API-key auth method is selected. Takes precedence over `OPENAI_API_KEY`.
- `OPENAI_API_KEY` - fallback API key used when the API-key auth method is selected.
- `CODEX_PATH` - run a specific Codex executable instead of the bundled package dependency.
- `CODEX_CONFIG` - JSON object merged into the Codex session config.
- `MODEL_PROVIDER` - model provider to pass to Codex for new sessions.
- `DEFAULT_AUTH_REQUEST` - ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` - initial mode id: `read-only`, `agent`, or `agent-full-access`.
- `NO_BROWSER` - hide browser-based ChatGPT auth when set.
- `APP_SERVER_LOGS` - directory for adapter logs.

## Session instruction overrides

Clients can override Codex's thread instructions per session by setting bare keys on the ACP
session request's `_meta` (on `session/new`, `session/load`, or `session/resume`). They map
directly onto the Codex `thread/start` / `thread/resume` / `thread/fork` parameters of the same
name:

| `_meta` key | Codex thread param | Effect |
| --- | --- | --- |
| `baseInstructions` | `baseInstructions` | Replaces Codex's built-in base system prompt for the thread. |
| `developerInstructions` | `developerInstructions` | Injects developer-role instructions for the thread. |

Both are optional strings; omit a key to keep Codex's default, and a present non-string value is
rejected with an invalid-params error. Example `session/new` params:

```jsonc
{
  "cwd": "/abs/path/to/workspace",
  "mcpServers": [],
  "_meta": {
    "baseInstructions": "You are a release bot. Only touch CHANGELOG.md.",
    "developerInstructions": "Prefer conventional-commit summaries."
  }
}
```

## Structured output (turn-level `outputSchema`)

Clients can constrain a turn's **final assistant message** to a JSON Schema by setting the bare
`outputSchema` key on the `session/prompt` request's `_meta`. The schema is forwarded verbatim
into the Codex App Server's `turn/start.outputSchema` (OpenAI Responses API strict mode); when
the key is absent the turn is unconstrained. The key is per-turn — each `session/prompt` sets
(or omits) it independently. Example `session/prompt` params:

```jsonc
{
  "sessionId": "sess-123",
  "prompt": [{ "type": "text", "text": "List the three largest files." }],
  "_meta": {
    "outputSchema": {
      "type": "object",
      "properties": { "files": { "type": "array", "items": { "type": "string" } } },
      "required": ["files"],
      "additionalProperties": false
    }
  }
}
```

## Fork capability advertisement

So clients can feature-detect the fork's non-standard `_meta` inputs instead of sending them
blind, the initialize response advertises them under the fork's package name (per the ACP
extensibility convention):

```jsonc
"agentCapabilities": {
  "_meta": {
    "@automatalabs/codex-acp": {
      "outputSchema": true,           // session/prompt _meta.outputSchema (see above)
      "baseInstructions": true,       // session-scoped instruction overrides (see above)
      "developerInstructions": true
    }
  }
}
```

Each flag is named exactly like the bare `_meta` wire key it gates. A client that sees the
namespace object should send a gated key only when its flag is `true`; clients that predate the
advertisement can continue sending the keys blind (the adapter accepts them regardless).

## Development

```bash
npm install
npm run start
npm run typecheck
npm test
```

Build standalone binaries in `dist/bin` with:

```bash
npm run bundle:all
```

See [readme-dev.md](readme-dev.md) for local client configuration, binary packaging, and Codex type regeneration.

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
