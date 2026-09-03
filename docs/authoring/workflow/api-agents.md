# Workflow agent API reference

**Context:** JavaScript passed to the MCP `workflow` tool. Workflow scripts use `agent(prompt, options?)`; REPL evals use a different API.

## `agent(prompt, options?)` — full option table

Returns the agent's final assistant text, or the schema-validated object when `schema` is set. Resolves to `null` when a *recoverable* failure survives all retries.

| option | type | meaning |
|---|---|---|
| `label` | `string` | Display/telemetry name; also stamped on every live ACP event for this call. Always set it. Not part of the resume hash. |
| `phase` | `string` | Assign this call to a phase explicitly (needed inside concurrent stages where the global `phase()` state would race). |
| `schema` | JSON Schema object | Structured output. Plain object literal only — no schema builders exist in the realm. Part of the resume hash. |
| `model` | `string` | Model spec: optional registered harness prefix plus a verbatim id, or a backend-only name. See [Model specs & routing](#model-specs--routing). Part of the resume hash. |
| `tier` | `"small" \| "medium" \| "big"` | Coarse tier resolved from host config; beats phase/meta model, loses to explicit `model`. Part of the resume hash. |
| `mode` | `string` | Exact ACP session mode id advertised by the selected backend/model. For trusted implementation/review work use Claude `bypassPermissions` or Codex `agent` when advertised. Claude `auto` is classifier-driven and may request permission; it is not full-access autonomy. Config preserves raw names/descriptions/metadata, and every selected id is validated before prompting. Part of call identity only when authored. |
| `configOptions` | `Record<string, string \| boolean>` | Exact ACP session option ids and authored values. Applied in ascending id order after model and before the prompt, with no aliases or coercion. `"model"` is reserved for the dedicated `model` field. Part of the resume hash only when non-empty, with sorted keys. With MCP, read the advertised-options table from `workflow` action `config` before choosing values. |
| `agentType` | `string` | Bind a named subagent definition (tools allow/deny, model, isolation, role prompt). See [agentType definitions](#agenttype-definitions). Part of the resume hash. |
| `isolation` | `"worktree"` | Run in a throwaway git worktree branched from the run cwd. **Always removed (worktree + branch) when the call ends** — edits are discarded; return work as data. Degrades to the shared tree outside a git repo (logged). |
| `cwd` | `string` | Per-session working directory; relative resolves against the run's base cwd. Overridden by worktree isolation. Not hashed. |
| `retries` | `number` | Retries after *recoverable* failures (default 0, host-overridable). Exhausted retries ⇒ the call resolves `null`. |
| `mcpServers` | `McpServerConfig[]` | MCP servers attached to this session. Stdio shape: `{ name, command, args: [], env: [{ name, value }] }` (`args`/`env` required, `env` is name/value pairs, not a map); `{ type: "http" \| "sse", name, url, headers: [] }` also accepted. Not hashed. |
| `images` | `PromptImage[]` | Base64 image blocks appended to the prompt; backends without image support get a bracketed text note. Not hashed. |
| `meta` | `object` | ACP `_meta` merged into `session/new` — session-scoped extension passthrough (pairs with custom backends). Not hashed. |
| `promptMeta` | `object` | ACP `_meta` merged into `session/prompt` — turn-scoped passthrough. Backend-computed keys win on conflict. Not hashed. |
| `keepSession` | `boolean` | Skip release-time best-effort `session/close`; the non-secret re-attach record lands in `WorkflowRunResult.agentSessions` for host-side `loadSession()` / `resumeSession()`. Usage/auth pause failures are kept open automatically for managed continuation. Not identity-hashed; included in the input fingerprint. |

Agent attempts have no model-facing wall-clock or idle timeout. They remain live until they complete,
fail, or the host explicitly cancels the call or run. Same-ID MCP continuation may apply new runtime
limits, but it cannot change the persisted script, args, or effective agent configuration.

## Model specs & routing

A `model` string is resolved solely from its first segment, then delegated to the harness:

| spec shape | routes to | notes |
|---|---|---|
| *(omitted)* | host-pinned/default backend | MCP: explicit `AGENTPRISM_DEFAULT_BACKEND` wins; when truly unset, zero-token readiness discovery pins one project default before validation/execution and preserves it across resume. SDK runner: configured default, historical fallback `claude`. The selected harness keeps its session default model. Most portable. |
| `claude`, `codex`, `opencode`, `pi`, or `<custom-name>` | that registered harness | Backend-only: no model config call; the harness default remains active. |
| `claude/<id>`, `codex/<id>`, `opencode/<id>`, `pi/<id>`, or `<custom-name>/<id>` | that registered harness | Match the first segment ASCII-case-insensitively and strip exactly one segment. Custom names take priority on collision. The remaining `<id>` is sent verbatim, including further `/` characters. For Pi, that remainder is its `<provider>/<model-id>` and Pi preserves any further slashes in the model id. |
| any other string, including `anthropic/…`, `openai/…`, bare `opus`, or bare `gpt-…` | host default backend | The **entire** authored string is sent verbatim; these are not routing aliases. |

Selection is a single `session/set_config_option` with `configId: "model"` and the exact remaining string. There is no catalog matching, case folding, normalization, bracket parsing, nearest-neighbor selection, sibling effort/Fast option driving, retry, or echo verification. Brackets, dots, and provider-style prefixes are ordinary model-id characters.

Whatever the harness returns is the outcome. A rejection follows the existing agent-error path with no resolution-specific code or model fallback event. `onModelFallback` and `WorkflowRunResult.fallbacks` remain public compatibility surfaces; model resolution does not emit entries, while pause recovery emits `kind: "continuation"` reattach/skip notices.

## Structured output channels

One author API (`schema`), four fulfillment paths — chosen automatically per backend:

| backend | channel |
|---|---|
| Claude | native `outputFormat`, schema normalized to Anthropic's structured-outputs subset (e.g. `oneOf` → `anyOf`; unsupported keywords/formats stripped on the wire) |
| Codex | native strict `outputSchema` (OpenAI strict subset normalization) |
| Pi | a client-hosted `StructuredOutput` MCP tool injected when the agent advertises HTTP MCP support; common prompt-embedded schema and validated final-text JSON fallback |
| OpenCode / custom ACP | a client-hosted **`StructuredOutput` MCP tool** injected into the session when the agent advertises HTTP MCP support (an agent may show it as `structured_output_StructuredOutput`); otherwise prompt-embedded schema + JSON parse of the final message. Custom backends can opt out of tool injection with `structuredOutputTool: false`. |

Pi accepts stdio, Streamable HTTP, and SSE MCP servers; ACP-transport MCP hosting remains client-side.

In every channel the runner coerces + validates client-side and re-prompts a bounded number of times; the final miss fails the call with non-recoverable `SCHEMA_NONCOMPLIANCE`. Constraints stripped from the wire are still enforced client-side — an exotic schema keyword shows up as re-prompt churn, so keep schemas simple.
