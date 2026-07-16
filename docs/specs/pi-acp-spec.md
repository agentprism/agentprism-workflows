# `@automatalabs/pi-acp` — In-process ACP Server for the pi Coding Agent

**Date:** 2026-07-15

**Status:** Frozen implementation contract for issue #198. Round 1.

**References (summary — full file:line + version pins in §14):**
our repo — `packages/acp-agents/src/capabilities.ts`,
`packages/acp-agents/src/acp-client.ts`,
`packages/acp-agents/src/protocol-coverage.ts`,
`packages/acp-agents/src/structured-output.ts`,
`packages/acp-agents/src/usage.ts`,
`packages/acp-agents/src/permissions.ts`,
`packages/acp-agents/src/errors-map.ts`,
`packages/acp-agents/src/backends/codex.ts`,
`packages/acp-agents/src/runner.ts`,
`packages/shared-types/src/meta.ts`,
`scripts/check-acp-deps.mjs`,
`packages/acp-agents/package.json`,
`packages/mcp-server/package.json`;
external — `@agentclientprotocol/sdk@1.2.1`,
`@agentclientprotocol/claude-agent-acp@0.59.0` (packaging blueprint),
`@earendil-works/pi-coding-agent@0.80.7` (repo `earendil-works/pi` tag `v0.80.7`,
commit `818d67457cdd6b60bce6b121d16b23141c252dd8`), `@modelcontextprotocol/sdk@^1.29`.

---

## 1. Problem and scope

`@agentclientprotocol/claude-agent-acp` makes the Claude Agent SDK drivable over ACP; our
`@automatalabs/codex-acp` fork does the same for Codex; `opencode-ai` ships an ACP server for
OpenCode. Each is a first-class backend our workflow runner (`@automatalabs/acp-agents`) drives
symmetrically. The **pi coding agent** (`@earendil-works/*`, MIT) has no first-class ACP server we
control: the one community bridge (`svkozak/pi-acp`) shells out to `pi --mode rpc`, a JSONL RPC that
is neither JSON-RPC nor ACP, and structurally cannot serve per-tool permission prompts, a separate
thinking stream, ACP `mcpServers`, or native structured output.

This contract specifies **one new monorepo package, `packages/pi-acp`, publishing
`@automatalabs/pi-acp`**: an ACP server (stdio, JSON-RPC 2.0, protocolVersion `1`) that embeds pi
**in-process** through its published SDK (`@earendil-works/pi-coding-agent` →
`createAgentSession()`), plus library exports for reuse. Because the seam is in-process, the server
closes every gap the bridge leaves open, and it advertises **only** the surfaces it actually
implements, so our client's feature-detection rewards it truthfully.

**In scope:** the `packages/pi-acp` package — server binary, library exports, capability
advertisement, session lifecycle, event translation, prompt/stopReason/usage, error taxonomy,
permissions, MCP bridge, structured output, auth, cancellation, model/config surface, and the
monorepo integration for that package (workspace/changesets/CI/tsconfig). The one client-repo change
is adding the pi runtime to the ACP freshness gate (§10).

**Out of scope (see §11 Non-goals):** promoting pi to a built-in `PiBackend` in `acp-agents` (a
follow-up issue mirroring #197 — until it lands, the server is drivable through the existing
custom-backend registry with zero client code); fs/terminal client-delegation; subprocess/RPC mode.

### 1.1 Verified baseline and invariants

The implementation preserves these named invariants (each grounded in §14):

1. **stdout is ACP-only.** The bin redirects `console.log/info/warn/debug` to stderr before any pi
   or SDK call; nothing but ACP ndjson is ever written to fd 1 (mirrors claude-agent-acp
   `dist/index.js:53-56`). A pi log line on stdout would corrupt the JSON-RPC stream.
2. **Advertise only what is implemented.** Every capability flag in the `initialize` response
   corresponds to a served method with real behavior. The server never advertises a lifecycle method
   it will throw on (the anti-pattern our client's `assertLifecycleSupported` exists to catch,
   `acp-client.ts:1220-1235`).
3. **Errors reject; they never masquerade as `end_turn`.** A provider/model/auth failure rejects the
   `session/prompt` request with a `RequestError` carrying a categorical `data.errorKind`; auth walls
   use JSON-RPC code `-32000` exclusively (§7, §8). An empty successful turn is a real `end_turn`,
   never a swallowed error.
4. **One in-flight turn per session.** pi's `Agent.prompt()` throws if a turn is already running
   (`agent.ts:335-341`); ACP `session/prompt` is serialized per session by construction. The adapter
   does not expose mid-turn steering/queueing over ACP in v1 (§6.4, resolves Open item 2).
5. **Truthful usage.** Per-turn token counts map near-1:1 from pi's `Usage` onto the exact ACP
   `PromptResponse.usage` field names our client's `UsageAccumulator` reads (`usage.ts:50-72`); USD
   `cost.total` rides `usage_update.cost` (§6.3).
6. **Native structured output, no prompt-embedding.** The server advertises
   `agentCapabilities._meta["@automatalabs/pi-acp"] = { outputSchema: true }` and consumes per-turn
   `_meta.outputSchema` through pi's terminating-tool pattern, emitting the result as the final
   `agent_message_chunk` so our client's `parseFinalJson(finalMessageText())` reads it natively
   (`structured-output.ts:47-64`).
7. **License compliance.** pi is MIT; §15 pins the attribution obligation for depending on and
   embedding it.

---

## 2. Package identity, layout, and packaging

### 2.1 Identity

- **npm name:** `@automatalabs/pi-acp` (scoped; unscoped `pi-acp` is the community bridge). Initial
  version `0.0.0`, first release driven by changesets in lockstep with the monorepo (§10).
- **bin name:** `pi-acp` → `dist/index.js`. Spawn resolution for the follow-up built-in backend goes
  through the resolved package bin under `process.execPath` (the claude/codex ladder,
  `backends/codex.ts:53-66`), never PATH, so ours cannot collide with the community `pi-acp` bin.
- **License:** `Apache-2.0` (the monorepo license), with the MIT third-party notice of §15.
- **engines:** `"node": ">=22.19.0"` — pinned to pi's own floor (`packages/coding-agent/package.json`
  `engines.node >=22.19.0`), which is tighter than the monorepo's `>=22`. This resolves Open item 4.
  CI already runs Node 24 (`ci.yml:36`), satisfying it. pi's `legacy-node20` dist-tag (0.74.2) is
  **not** tracked; we track `latest`, which requires Node ≥22.19.

### 2.2 Layout

```
packages/pi-acp/
  package.json
  tsconfig.json                # extends root config; composite project reference
  src/
    index.ts                   # bin entry: console redirect + runAcp() + shutdown
    server.ts                  # runAcp(): acpAgent(...).onRequest(...).connect(ndJsonStream(...))
    agent.ts                   # PiAcpAgent: per-connection session registry + method handlers
    session.ts                 # PiSession: wraps one AgentSession + its translation/permission wiring
    translate.ts               # pi AgentSessionEvent -> ACP SessionUpdate (the §6.1 table)
    stop-reason.ts             # pi terminal AssistantMessage -> ACP StopReason / RequestError (§7,§8)
    usage.ts                   # pi Usage -> ACP Usage + usage_update (§6.3)
    permissions.ts             # beforeToolCall wrapper -> session/request_permission (§9)
    mcp-bridge.ts              # ACP mcpServers (stdio) -> pi customTools (§9.3)
    structured-output.ts       # per-turn terminating tool for _meta.outputSchema (§9.4)
    auth.ts                    # authMethods from pi-ai env-key catalog (§9.5)
    model.ts                   # model/thinkingLevel config-option resolution (§5)
  test/
    *.test.ts                  # §13 test plan (tsx --test)
```

### 2.3 `package.json`

Mirrors `packages/acp-agents/package.json` and the `bin` shape of `packages/mcp-server/package.json`:

```jsonc
{
  "name": "@automatalabs/pi-acp",
  "version": "0.0.0",
  "license": "Apache-2.0",
  "engines": { "node": ">=22.19.0" },
  "repository": { "type": "git", "url": "git+https://github.com/VikashLoomba/agentprism-workflows.git", "directory": "packages/pi-acp" },
  "type": "module",
  "bin": { "pi-acp": "./dist/index.js" },
  "main": "./dist/index.js",
  "types": "./src/index.ts",
  "exports": { ".": { "types": "./src/index.ts", "import": "./dist/index.js", "default": "./dist/index.js" } },
  "files": ["dist"],
  "publishConfig": {
    "access": "public",
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "bin": { "pi-acp": "./dist/index.js" },
    "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "default": "./dist/index.js" } }
  },
  "scripts": { "build": "tsc -b", "typecheck": "tsc --noEmit", "test": "tsx --test \"test/**/*.test.ts\"", "prepublishOnly": "tsc -b" },
  "dependencies": {
    "@agentclientprotocol/sdk": "^1.2.1",
    "@earendil-works/pi-coding-agent": "0.80.7",
    "@modelcontextprotocol/sdk": "^1.29",
    "typebox": "1.3.2"
  }
}
```

Normative packaging rules:

- `@agentclientprotocol/sdk` is pinned at the **npm `latest` re-verified at implementation time**
  (1.2.1 at this writing) — matches `acp-agents` `^1.2.1`, not the bridge's 0.26. Re-check `npm view
  @agentclientprotocol/sdk version` when implementing and use that exact latest.
- `@earendil-works/pi-coding-agent` is an **exact** pin (`0.80.7` at this writing; re-verify latest
  at implementation time). It transitively pulls `@earendil-works/pi-agent-core` and
  `@earendil-works/pi-ai` in lockstep (`packages/coding-agent/package.json` deps), so pi-acp declares
  only the one direct dep. The freshness gate (§10) keeps it current.
- `@modelcontextprotocol/sdk` matches `acp-agents` (`^1.29`) — the MCP client used by the stdio MCP
  bridge (§9.3).
- `typebox` matches the monorepo (`1.3.2`); used only to build the structured-output tool schema
  wrapper. pi consumes tool `parameters` as raw JSON Schema and strips symbol keys per provider
  (`packages/ai/src/api/openai-completions.ts:1110`, `bedrock-converse-stream.ts:918`,
  `mistral-conversations.ts:491`), so the typebox major mismatch with pi's bundled `1.1.38` is inert.
- `tsconfig.json` is a composite project added to the root `tsconfig.json` `references` array
  (§10.3). No source is published — `files: ["dist"]`, `types` resolves to `dist/index.d.ts` under
  `publishConfig` (the acp-agents convention).

---

## 3. Bin bootstrap and process lifecycle (`src/index.ts`)

Copy the claude-agent-acp bin shape verbatim in spirit (`dist/index.js:42-84`):

1. **`--version` / `-v`** prints the package version to stdout and exits 0 (the only sanctioned
   stdout write outside ACP, and only before the stream opens).
2. Otherwise, **redirect console before any pi/SDK import side effect executes:**
   `console.log = console.error; console.info = console.error; console.warn = console.error;
   console.debug = console.error;`. This is invariant 1.1.1.
3. Install `process.on("unhandledRejection", …)` → stderr.
4. `const { connection, agent } = runAcp();` (§4).
5. `connection.closed.then(shutdown)`, `process.on("SIGTERM", shutdown)`,
   `process.on("SIGINT", shutdown)`; `shutdown()` disposes every open `PiSession` (abort in-flight
   turns, unsubscribe, disconnect MCP clients) and `process.exit(0)`.
6. `process.stdin.resume()` to keep the loop alive while the connection is open.

`runAcp()` and the `PiAcpAgent` class are exported from `src/index.ts` (library reuse — the
`ClaudeAcpAgent`/`runAcp` export convention, claude-agent-acp `dist/lib.js:2`).

---

## 4. Server construction (`src/server.ts`)

`runAcp()` builds the agent with the SDK fluent builder and connects it over stdio ndjson:

```ts
import { agent as acpAgent, methods, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";

export function runAcp() {
  const impl = new PiAcpAgent();
  const app = acpAgent({ name: "@automatalabs/pi-acp", version: PKG_VERSION })
    .onRequest(methods.agent.initialize,        (c) => impl.initialize(c))
    .onRequest(methods.agent.authenticate,      (c) => impl.authenticate(c))
    .onRequest(methods.agent.session.new,       (c) => impl.newSession(c))
    .onRequest(methods.agent.session.load,      (c) => impl.loadSession(c))
    .onRequest(methods.agent.session.resume,    (c) => impl.resumeSession(c))
    .onRequest(methods.agent.session.fork,      (c) => impl.forkSession(c))
    .onRequest(methods.agent.session.list,      (c) => impl.listSessions(c))
    .onRequest(methods.agent.session.close,     (c) => impl.closeSession(c))
    .onRequest(methods.agent.session.setConfigOption, (c) => impl.setConfigOption(c))
    .onRequest(methods.agent.session.prompt,    (c) => impl.prompt(c))
    .onNotification(methods.agent.session.cancel, (c) => impl.cancel(c));
  const stream = ndJsonStream(
    /* output */ Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    /* input  */ Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  return { connection, agent: impl };
}
```

Method names come verbatim from the SDK `methods` registry (`acp.d.ts:17-79`). The server registers
**only** the handlers above; unregistered methods (`session/set_mode`, `providers/*`, `logout`,
`nes/*`, `document/*`) are answered by the SDK as JSON-RPC method-not-found (`-32601`), which is the
truthful response for a method whose capability is not advertised (§5). `$/cancel_request` and
`session/cancel` are handled by the same abort path (§8): the SDK aborts the in-flight request's
`context.signal`, and the adapter has wired that signal to `agent.abort()` (§9.6).

Each handler receives an `AgentRequestContext` exposing `context.params` (schema-parsed request),
`context.signal` (aborted on cancel), and `context.client` (an `AgentContext` with `notify(...)` for
`session/update` and `request(...)` for `session/request_permission`) (`acp.d.ts:142-206,367-396`).
To stream a `session/update`, a handler calls
`context.client.notify(methods.client.session.update, { sessionId, update })`
(`SessionNotification`, `types.gen.d.ts:3409`).

---

## 5. Capability advertisement (`initialize`)

`initialize` returns `protocolVersion: 1` and this exact `agentCapabilities` block. Every flag maps
to a served method; nothing is advertised that throws.

```jsonc
{
  "protocolVersion": 1,
  "agentInfo": { "name": "@automatalabs/pi-acp", "version": "<pkg version>" },
  "agentCapabilities": {
    "loadSession": true,                     // top-level flag: session/load (SDK keeps load here, not sessionCapabilities.load)
    "promptCapabilities": { "image": true }, // pi accepts image content blocks; audio/embeddedContext NOT advertised (v1)
    "mcpCapabilities": {},                    // stdio only (baseline, implicit); http/sse/acp NOT advertised (§9.3)
    "sessionCapabilities": {
      "resume": {},                           // session/resume  (§6 / Sessions)
      "fork":   {},                           // session/fork    (UNSTABLE in SDK; native via SessionManager.forkFrom)
      "list":   {},                           // session/list
      "close":  {}                            // session/close
    },
    "_meta": { "@automatalabs/pi-acp": { "outputSchema": true } }  // structured-output negotiation (§9.4)
  },
  "authMethods": [ /* §9.5, gated on advertised client auth capabilities */ ]
}
```

Advertisement rules (each grounded in our client's reader):

- **`loadSession: true`** (top level) — not `sessionCapabilities.load`. The SDK `SessionCapabilities`
  type has **no** `load` field; `session/load` is still gated by the top-level `loadSession`
  (`types.gen.d.ts:1608-1660` doc). Our client reads `agent.loadSession === true ||
  advertised(sessionCapabilities?.load)` (`capabilities.ts:104-105`), so the top-level flag drives
  `supportsLoadSession`.
- **`sessionCapabilities.resume/fork/list/close`** — each is `advertised(...)` in our client
  (`capabilities.ts:106-109`) and hard-gates the corresponding lifecycle call
  (`acp-client.ts:1220-1235`). `resume` is the single highest-value advertisement for our client
  (`supportsResumeSession`, `capabilities.ts:109`), feeding incremental resume and #183
  pause-recovery. `fork` is `@experimental` in the SDK but fully typed; native via
  `SessionManager.forkFrom` (§ Sessions).
- **`session/delete` is NOT advertised** — pi's `SessionManager` exposes no delete/unlink API
  (verified absent at `packages/coding-agent/src/core/session-manager.ts`; only TUI keybinding
  constants exist). Advertising it would force hand-unlinking session `.jsonl` files, which risks
  corrupting the fork tree. Deferred with rationale in §11.
- **`mcpCapabilities: {}`** — advertising the (empty) object, rather than omitting it, is the truthful
  choice: our client's `unsupportedMcpServer` treats stdio as always serviceable but **rejects
  http/sse once any `mcpCapabilities` block exists** (`capabilities.ts:278-300`). We serve stdio only
  (§9.3), so `{}` correctly makes the client reject http/sse servers up front instead of spending
  tokens then failing. `acp` transport is likewise not advertised.
- **`promptCapabilities.image: true`, audio/embeddedContext omitted** — pi's tools ingest images
  (the coding agent has image handling), so image blocks pass through; audio and embedded-resource
  blocks are not first-class in pi's message model in v1, and our client already degrades unsupported
  blocks to explicit bracketed text notes (`capabilities.ts:241-271`), so omitting them loses nothing
  silently.
- **`_meta["@automatalabs/pi-acp"] = { outputSchema: true }`** — the codex-acp custom-capability
  convention (`meta.ts:26-36`, `backends/codex.ts:34-37`). The namespace is our published package
  identity; under it the single flag `outputSchema` is named exactly like the bare `_meta` wire key
  it gates (`META_KEYS.outputSchema`, `meta.ts:7-13`), so a client tests `block.outputSchema === true`
  before sending `_meta.outputSchema`. **`baseInstructions`/`developerInstructions` are NOT advertised
  or accepted in v1** (resolves Open item 3): pi's system-prompt override
  (`AgentSession._systemPromptOverride`) is an internal per-turn field with no stable embedder API;
  the structured-output instruction is injected as prompt text (§9.4), not a system-prompt override.

### 5.1 Model and thinking-level config surface

The runner delivers the model verbatim (after stripping the `pi/` routing prefix) through
`session/set_config_option` with `configId: "model"` and `value: "<provider>/<model-id>"`
(`acp-client.ts:1972-1974` → `applyConfigOption`; `runner.ts:1356-1370` strips one segment). The
`session/new` response therefore advertises two **select** config options (`SessionConfigOption`,
`types.gen.d.ts:2643`; `SessionConfigSelect`, `:2760`):

| `configId`      | options                                                              | on set → adapter action |
|-----------------|---------------------------------------------------------------------|-------------------------|
| `model`         | representative `provider/id` values from the registry; `currentValue` = active model | resolve `provider/id` (§5.2) → `AgentSession.setModel(model)` (`agent-session.ts:1537`); return updated `configOptions` |
| `thinkingLevel` | `off,minimal,low,medium,high,xhigh,max` (pi-agent-core `ThinkingLevel`, `types.ts:289`); `currentValue` = active | clamp to model (`clampThinkingLevel`) and apply |

The `model` select **tolerates a value not in the advertised list**: the client sends arbitrary
`provider/id` specs, so the set-handler resolves any value dynamically (§5.2) and rejects with
`invalidParams` (`-32602`) only when unresolvable. `thinkingLevel` maps directly onto our effort
brackets. The response echo shape is `SetSessionConfigOptionResponse = { configOptions }`
(`types.gen.d.ts:2975`), which our client adopts (`acp-client.ts` `applyConfigOption`). Our client
also forbids `model` in authored `configOptions` (`assertNoModelConfigOption`, `runner.ts:1319-1329`),
so the `model` option is set only through the reserved channel — consistent with advertising it here.

### 5.2 Model resolution (`src/model.ts`)

Resolution is registry-first, decisive, and non-deprecated:

1. Construct once per process: `const registry = ModelRegistry.create(AuthStorage.create(authPath))`
   (`model-registry.ts:391`; `AuthStorage.create` from `sdk.ts:8`).
2. For a spec `"<provider>/<model-id>"` (first `/` splits provider from the rest verbatim),
   `const model = registry.find(provider, modelId)` (`model-registry.ts:695-696`) — this is exactly
   what `createAgentSession` uses internally (`sdk.ts:197`) and covers builtin + custom-configured
   providers.
3. If `model` is found, pass it as `createAgentSession({ model })`; auth resolves at stream time via
   `registry.getApiKeyAndHeaders(model)` (`sdk.ts:302-303`) from env/`auth.json`.
4. If `find` returns `undefined`, reject the originating request with `RequestError.invalidParams`
   (`-32602`) naming the unknown `provider/id` (never a silent fallback to a different model).
5. When **no** model spec is supplied (no `set_config_option "model"` before the first prompt), omit
   `model` from `createAgentSession` and let pi pick its configured default (`findInitialModel`,
   `sdk.ts:207-222`).

`getBuiltinModel` from `@earendil-works/pi-ai/providers/all` (`providers/all.ts:53`) is the
pure-catalog helper; it is **not** used as the primary path because it is strongly typed to the
generated catalog and cannot accept arbitrary custom-provider strings. The deprecated
`getModel`/`getModels` compat aliases (`compat.ts:61`, marked `@deprecated`) are not used.

---

## 6. Prompt turns: translation, stop reasons, and usage

### 6.1 Event translation table (pi `AgentSessionEvent` → ACP `SessionUpdate`)

The adapter subscribes to the `AgentSession` (`session.subscribe(listener)`,
`agent-session.ts:762`) and translates each event into a `session/update` notification. pi's event
model has three verified layers: the session-level `AgentSessionEvent`
(`agent-session.ts:127-155`), which contains the loop-level `AgentEvent` (`agent/types.ts:415-430`),
whose `message_update` carries the pi-ai `AssistantMessageEvent` token-delta union
(`ai/types.ts:464-476`).

| pi event (source) | ACP `sessionUpdate` | notes |
|---|---|---|
| `AssistantMessageEvent` `text_delta` (inside `message_update`) | `agent_message_chunk` | `content: { type:"text", text: delta }` |
| `AssistantMessageEvent` `thinking_delta` | `agent_thought_chunk` | separate thinking stream — the bridge folds this into message chunks; we do not |
| `tool_execution_start` `{toolCallId,toolName,args}` | `tool_call` | `{ toolCallId, title: toolName, kind: mapKind(toolName), status:"pending", rawInput: args, locations: fileLocations(args), _meta:{ toolName } }` (§6.2, §9.2) |
| `tool_execution_update` `{toolCallId,partialResult}` | `tool_call_update` | `{ toolCallId, status:"in_progress", content: toContent(partialResult) }` |
| `tool_execution_end` `{toolCallId,result,isError}` | `tool_call_update` | `{ toolCallId, status: isError?"failed":"completed", rawOutput: result, content: toContent(result) }`; `read`/`edit`/`write` emit `type:"diff"` content with old/new text when the tool result exposes it |
| per-turn terminal `Usage` (on the terminal `AssistantMessage`) | `usage_update` + accumulate into `PromptResponse.usage` | §6.3 |
| `compaction_start`/`compaction_end`, `queue_update`, `auto_retry_start`/`auto_retry_end`, `agent_settled`, `session_info_changed`, `thinking_level_changed`, `entry_appended` | **no fabricated `session/update`** | v1 emits none of these as content; `auto_retry_*` and `compaction_*` are surfaced only through the terminal stopReason/usage. No invented updates. |

`text_start`/`text_end`/`thinking_start`/`thinking_end`/`toolcall_*` deltas are used to sequence
chunks (they set message boundaries via `messageId`) but do not themselves emit standalone updates
beyond the `*_delta` rows above.

### 6.2 Tool-call metadata mapping (`mapKind`)

`ToolKind` is the SDK enum `"read"|"edit"|"delete"|"move"|"search"|"execute"|"think"|"fetch"|
"switch_mode"|"other"` (`types.gen.d.ts:196`). Map pi's built-in tool names decisively: `read`→`read`,
`edit`→`edit`, `write`→`edit`, `bash`→`execute`, `grep`→`search`, `find`→`search`, `ls`→`read`,
everything else (custom/MCP tools) → `other`. `locations` (`ToolCallLocation`, `types.gen.d.ts:568`)
are populated from tool args that name a file path (`read`/`edit`/`write` `path`, etc.), enabling the
client's follow-along UI. The tool's `_meta.toolName` is stamped with pi's exact tool name so the
client's permission matcher can identify it precisely (§9.2).

### 6.3 Usage (`src/usage.ts`)

pi's `Usage` (`ai/types.ts:357-379`) is `{ input, output, cacheRead, cacheWrite, cacheWrite1h?,
reasoning?, totalTokens, cost:{ input, output, cacheRead, cacheWrite, total } }`. Map onto the ACP
`Usage` shape our client's `UsageAccumulator` consumes (`usage.ts:7-17,50-72`;
`types.gen.d.ts:3037`):

| ACP `PromptResponse.usage` field | pi source |
|---|---|
| `inputTokens` | `usage.input` |
| `outputTokens` | `usage.output` |
| `cachedReadTokens` | `usage.cacheRead` |
| `cachedWriteTokens` | `usage.cacheWrite` |
| `totalTokens` | `usage.totalTokens` |
| `thoughtTokens` | `usage.reasoning` (omit when undefined) |

The USD dollar cost rides the streamed `usage_update` notification, not `PromptResponse.usage`:
emit `sessionUpdate:"usage_update"` with `{ used: usage.totalTokens, size: model.contextWindow ?? 0,
cost: { amount: usage.cost.total, currency: "USD" } }` (`UsageUpdate`/`Cost`,
`types.gen.d.ts:3928,3951`). Our client reads `cost.amount` into `AgentUsage.cost` and treats
`PromptResponse.usage` as authoritative for the token breakdown (`usage.ts:11-17,28-59`). The final
`PromptResponse` returns `{ stopReason, usage }` with the accumulated per-turn breakdown (sum across
the assistant messages of the turn).

### 6.4 Turn lifecycle and concurrency

One ACP `session/prompt` drives one pi turn: the handler calls
`await session.prompt(promptText, { … })` (`agent-session.ts:1076`), which awaits `agent.prompt()`
plus pi's own auto-retry/compaction loop and settles by emitting `agent_settled` in a `finally`
(`agent-session.ts:1023-1034`). The ACP request resolves when `session.prompt()` resolves, with the
stopReason computed from the terminal assistant message (§7).

Concurrency (resolves **Open item 2**): pi permits **one in-flight turn per session** —
`agent.prompt()` throws `"Agent is already processing…"` if called while streaming
(`agent.ts:335-341`; `agent-session.ts:1121-1126`). ACP clients serialize `session/prompt` per
session, so this never fires in normal use; if a second `session/prompt` arrives for a busy session,
the adapter rejects it with `RequestError.invalidParams` (`-32602`, "session busy"). pi's mid-turn
steering/follow-up queue (`agent.steer`/`agent.followUp`, `agent.ts:274-279`) is **not** exposed over
ACP in v1 — ACP has no in-band mid-turn steering surface, and inventing one would be an
unadvertised, non-portable extension. Recorded in §11.

---

## 7. Stop-reason taxonomy

The ACP `StopReason` enum is exactly `"end_turn"|"max_tokens"|"max_turn_requests"|"refusal"|
"cancelled"` (`types.gen.d.ts:3027`) — there is **no** `error` member, which is why errors must
reject (§8) rather than return a stopReason. pi's terminal signal is the last `AssistantMessage` of
the turn, carrying `stopReason: StopReason` and optional `errorMessage`, where pi's
`StopReason = "stop"|"length"|"toolUse"|"error"|"aborted"` (`ai/types.ts:380,388-401`); the streaming
union terminates with `{ type:"done", reason: "stop"|"length"|"toolUse" }` or
`{ type:"error", reason: "aborted"|"error" }` (`ai/types.ts:464-476`). This resolves **Open item 1**.

After `session.prompt()` resolves, read the terminal assistant message
(`agent.state.messages` last `role:"assistant"`, mirroring `_findLastAssistantMessage`) and map:

| pi terminal signal | ACP result |
|---|---|
| `stopReason "stop"` | resolve `{ stopReason: "end_turn", usage }` |
| `stopReason "length"` | resolve `{ stopReason: "max_tokens", usage }` |
| `stopReason "toolUse"` as the terminal message (loop settled on a tool turn) | resolve `{ stopReason: "end_turn", usage }` (the loop has drained; treat as normal completion) |
| `stopReason "aborted"` **or** the adapter observed `agent.abort()` for this turn | resolve `{ stopReason: "cancelled", usage }` |
| `stopReason "error"` (retries exhausted; `errorMessage` set) | **reject** with a `RequestError` per §8 (auth wall → `authRequired`; provider wall → `internalError` with `errorKind`) |

`refusal` and `max_turn_requests` have no pi equivalent in v1 and are never emitted. Note pi does
**not** throw on a provider error mid-turn: it captures the failure as a terminal assistant message
with `stopReason "error"` after exhausting auto-retries (`agent-session.ts:1023-1027,1044,2577`), so
the adapter must inspect that terminal message and reject — it does not merely propagate a thrown
error.

---

## 8. Error taxonomy and pinned wire codes

Every hard failure **rejects** the ACP request with a `RequestError` (SDK static constructors,
`jsonrpc.js:784-822`). JSON-RPC codes are pinned:

| condition | constructor | code | `data` |
|---|---|---|---|
| authentication required / missing-or-invalid provider credential | `RequestError.authRequired(data, msg)` | **`-32000`** (reserved exclusively for auth) | `{ errorKind: "auth_error" }` |
| provider rate/quota/billing wall | `RequestError.internalError(data, msg)` | `-32603` | `{ errorKind: "rate_limit" \| "billing_error" \| "provider_error", message: errorMessage }` |
| other provider/model/runtime failure (terminal `stopReason "error"`) | `RequestError.internalError(data, msg)` | `-32603` | `{ errorKind: "provider_error", message: errorMessage }` |
| unknown model spec | `RequestError.invalidParams(data, msg)` | `-32602` | `{ errorKind: "invalid_model" }` |
| session busy (second concurrent prompt) | `RequestError.invalidParams(data, msg)` | `-32602` | `{ errorKind: "session_busy" }` |
| unknown/unsupported method | SDK default | `-32601` | — |

Pinned code facts (verified in the installed SDK, `jsonrpc.js`): `-32700` parseError, `-32600`
invalidRequest, `-32601` methodNotFound, `-32602` invalidParams, `-32603` internalError, `-32800`
requestCancelled, **`-32000` authRequired (exclusive)**, `-32002` resourceNotFound.

`data.errorKind` is the categorical convention claude-agent-acp already emits
(`errorKindData(errorKind) => { errorKind }`, `dist/acp-agent.js:4113`) and the shape a capable
client dispatches on. Our generic mapper (`errors-map.ts`) routes **`-32000` → `AUTH_REQUIRED`
(pause-for-auth)** by code alone regardless of message (`errors-map.ts:135-146`;
`ACP_AUTH_REQUIRED_CODE_EXCLUSIVE`, `protocol-coverage.ts:152-154`), and folds `data.message`/`data.details`
into the classifiable error text (`errors-map.ts:33-71`). Every other reserved code is explicitly
**not** treated as auth (`OTHER_RESERVED`, `errors-map.ts:23`), so a `-32603` provider wall never
mis-routes to auth.

**errorKind classification source.** The adapter classifies the terminal `AssistantMessage`:
auth-shaped failures (pi surfaces these as "no configured auth / OAuth expired / no API key" — see
`agent-session.ts:1144-1154`, thrown **synchronously** from `prompt()` before streaming) reject with
`authRequired`. Provider quota/rate walls that survive pi's auto-retry (pi's retryable-error
classification, `_isRetryableError`/`isRetryableAssistantError`, `agent-session.ts:2577`) reject with
`internalError` + a rate/billing `errorKind` derived from `message.errorMessage`/`message.diagnostics`.
The follow-up `PiBackend` (§11) will add a `classifyProviderError` implementation
(`backends/codex.ts:39-51` pattern) so these become `PROVIDER_USAGE_LIMIT` pauses; until then the
generic client classifies the rejected request as a recoverable execution error, which is correct
default behavior.

---

## 9. Feature surfaces

### 9.1 Sessions

The adapter holds a per-connection `Map<sessionId, PiSession>` for live sessions. Each `PiSession`
owns one `AgentSession`, its event subscription, its permission wrapper, and (when armed) its
structured-output tool. The `sessionId` is pi's `SessionManager.getSessionId()`.

- **`session/new`** — `validateCwd(request.cwd)` (absolute, exists); build
  `SessionManager.create(cwd, sessionDir)` (`session-manager.ts:651`); `createAgentSession({ cwd,
  model?, thinkingLevel?, customTools, sessionManager })` (§5.2). After it returns, install the
  permission wrapper (§9.2) and the event translator (§6.1), then return `{ sessionId, configOptions,
  modes: null }` (`NewSessionResponse`, `types.gen.d.ts:2556`). `request.mcpServers` are bridged to
  `customTools` (§9.3) before the session is returned.
- **`session/load`** — reopen and **replay**. Resolve the session file for `sessionId` via
  `SessionManager.list(cwd, sessionDir)` (`session-manager.ts:759`, → `SessionInfo{ id, path }`,
  `:170-184`); `SessionManager.open(path)` (`:662`); `createAgentSession({ sessionManager })`
  restores messages via `buildSessionContext()` (`sdk.ts:188-204`). Then replay the restored linear
  branch (`getBranch()`/`buildSessionContext()`) through the §6.1 translator as `session/update`s so
  the client rehydrates the transcript.
- **`session/resume`** — identical reopen, **without** replay: restore into `agent.state` and return
  immediately, no `session/update` re-emission. This is the highest-value advertisement for our
  client (§5).
- **`session/fork`** — `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir)`
  (`session-manager.ts:700`) creates a new session file from the source; wrap it in a fresh
  `AgentSession`; return the new `sessionId`. `sourcePath` is resolved from the request's source
  `sessionId` via the same list lookup.
- **`session/list`** — `SessionManager.list(cwd, sessionDir)` → map each `SessionInfo` to the ACP
  list-session entry (`sessionId: id`, `cwd`, title from `name`/`firstMessage`).
- **`session/close`** — dispose the `PiSession`: abort any in-flight turn, unsubscribe, disconnect
  its MCP clients, drop it from the registry.

**Replay fidelity (resolves Open item 5):** v1 replays the **linear active branch** only
(`buildSessionContext()`/`getBranch()`), not the full fork-tree topology. ACP `session/update` is a
linear event stream with no representation for branch topology; `getTree()` (`session-manager.ts:449`)
informs `session/list` metadata but is not replayed. This is a decisive v1 scope, recorded in §11.

### 9.2 Permissions (headline differentiator, `src/permissions.ts`)

pi's permission seam is `Agent.beforeToolCall(context, signal) => Promise<{ block?, reason? } |
undefined>` (`agent/agent.ts:105,183-186`; `BeforeToolCallContext = { assistantMessage, toolCall,
args, context }`, `BeforeToolCallResult = { block?, reason? }`, `agent/types.ts:60-98`). **The
`AgentSession` constructor already installs `agent.beforeToolCall`** to dispatch to extension
`tool_call` handlers (`agent-session.ts:423-443`) — so the adapter must **wrap**, not overwrite, it
(this corrects the issue's "createAgentSession does not set beforeToolCall"):

```ts
const inner = session.agent.beforeToolCall;                // extension dispatch installed by AgentSession
session.agent.beforeToolCall = async (ctx, signal) => {
  const decision = await requestAcpPermission(ctx, signal); // ACP round-trip, wired to `signal`
  if (decision.block) return { block: true, reason: decision.reason };
  return inner ? inner(ctx, signal) : undefined;            // preserve extension chain
};
```

`requestAcpPermission` performs:

1. **Eager `tool_call` emission** with a dedup key on `ctx.toolCall.id` so the later streamed
   `tool_execution_start` refines the same tool call rather than duplicating it (§6.1).
2. `context.client.request(methods.client.session.requestPermission, req)` with the **standard
   three-option shape** (`PermissionOption`, `types.gen.d.ts:591`; `PermissionOptionKind`, `:624`):
   `[{ optionId:"allow_always", name:"Always allow <toolName>", kind:"allow_always" },
   { optionId:"allow_once", name:"Allow once", kind:"allow_once" },
   { optionId:"reject_once", name:"Reject", kind:"reject_once" }]`.
   The `toolCall` is a `ToolCallUpdate` (`RequestPermissionRequest.toolCall`, `types.gen.d.ts:108`)
   carrying `title`, `kind`, and `_meta.toolName = ctx.toolCall.name`. The stamped `_meta.toolName`
   lets our client's auto-responder identify the tool **exactly** (`candidateNames` reads
   `_meta.*.toolName`, `permissions.ts:164-186`; exact-then-substring matching, `:88-135`) — stable,
   descriptive `optionId`s complete the contract.
3. **Cancellation wiring:** `signal` (the turn's `AbortSignal`) aborts the permission `request` so an
   aborted turn dismisses the dialog; on abort the adapter resolves the decision as block/deny.
4. Map the response: `outcome.outcome === "selected"` with an allow option → allow (`{}` result);
   a reject option, `outcome:"cancelled"`, or abort → `{ block: true, reason }`.

### 9.3 MCP bridge (`src/mcp-bridge.ts`)

pi ships **no native MCP** (verified: zero `modelcontextprotocol` deps in pi source; README stance is
"build extensions"). The adapter bridges ACP-supplied MCP servers into pi `customTools`:

- On `session/new`, for each `request.mcpServers` entry of **stdio** transport (`McpServerStdio`,
  `types.gen.d.ts:4779`), the adapter itself connects an MCP client (`@modelcontextprotocol/sdk`
  stdio client), lists the server's tools, and registers each as a pi `defineTool` customTool
  (`extensions/types.ts:437-495`): the MCP tool's JSON-Schema `inputSchema` becomes the pi tool
  `parameters` (raw JSON Schema is accepted — §2.3), and `execute` forwards to the MCP `tools/call`,
  returning the MCP result as the pi tool result.
- **v1 serves stdio only.** `mcpCapabilities: {}` is advertised (§5), so our client rejects http/sse
  servers before sending them (`unsupportedMcpServer`, `capabilities.ts:278-300`). http transport is
  a deferred item (§11); when it lands, advertise `mcpCapabilities: { http: true }`, which also
  unlocks our client's client-hosted StructuredOutput MCP fallback
  (`supportsStructuredOutputToolTransport`, `runner.ts:1294-1296`) — but see §9.4: pi does not need
  that fallback because it serves outputSchema natively.
- MCP clients are disconnected on `session/close` and on connection teardown (invariant 3 shutdown).

### 9.4 Structured output (`src/structured-output.ts`)

pi has no native constrained decoding; the canonical pi pattern is a **terminating tool** carrying a
TypeBox/JSON-Schema parameter that ends the turn (`examples/extensions/structured-output.ts`,
`{ … , terminate: true }`). The adapter implements the ACP native `_meta.outputSchema` channel with
it:

1. At `session/new`, register a customTool `__acp_structured_output` whose `parameters` reference a
   mutable schema holder and whose `execute` captures `params` into a per-turn slot and returns
   `{ content: [{ type:"text", text:"(structured output captured)" }], details: params,
   terminate: true }`. It starts **inactive** (removed from the active tool set via
   `setActiveToolsByName`, `agent-session.ts:888`).
2. On a `session/prompt` whose request `_meta.outputSchema` (bare key `META_KEYS.outputSchema`,
   `meta.ts:7-13`) is present: set the holder's schema to the client's JSON Schema (assigned directly
   as `parameters`; providers consume it as raw JSON Schema — `openai-completions.ts:1110` et al.),
   clear the capture slot, arm the tool via `setActiveToolsByName([...base, "__acp_structured_output"])`,
   and prepend a one-line instruction to the prompt text telling the model to finish by calling
   `__acp_structured_output` with a value conforming to the schema. (Safe because exactly one turn
   runs per session — §6.4.)
3. After the turn settles, if a value was captured, emit it as the **final** `agent_message_chunk`
   (`content: { type:"text", text: JSON.stringify(captured) }`) so the client's
   `parseFinalJson(finalMessageText())` reads it and its typebox `Convert`+`Check` ladder validates
   it (`structured-output.ts:47-64,125-161`). If nothing was captured, the plain final assistant text
   is emitted and the client's validate-then-reprompt ladder (ported from pi) recovers or fails with
   `SCHEMA_NONCOMPLIANCE` — no fabrication.
4. Disarm the tool after the turn (`setActiveToolsByName(base)`).

Because the schema rides per-prompt `_meta` (not `session/new`), a single session can mix structured
and unstructured turns. In the follow-up `PiBackend` (§11), pi's structured-output posture is
declared **native**, so the runner skips prompt-embedding entirely
(`shouldInjectStructuredOutputTool` gates on `mcpCapabilities.http`, `runner.ts:1286-1296`, which
pi-acp does not advertise; the native `_meta` path is used instead — `backends/codex.ts:80-90`
pattern).

### 9.5 Auth (`src/auth.ts`)

`authMethods` are derived from pi-ai's env-key catalog (`env-api-keys.ts:64-110`,
`getApiKeyEnvVars`), kept **small and justified** — the major providers plus one stored-credentials
method:

| `AuthMethod` | type | `vars` / behavior |
|---|---|---|
| `id:"anthropic-api-key"` | `env_var` | `[{ name:"ANTHROPIC_API_KEY", secret:true }]` (pi also honors `ANTHROPIC_OAUTH_TOKEN` precedence) |
| `id:"openai-api-key"` | `env_var` | `[{ name:"OPENAI_API_KEY", secret:true }]` |
| `id:"gemini-api-key"` | `env_var` | `[{ name:"GEMINI_API_KEY", secret:true }]` |
| `id:"xai-api-key"` | `env_var` | `[{ name:"XAI_API_KEY", secret:true }]` |
| `id:"openrouter-api-key"` | `env_var` | `[{ name:"OPENROUTER_API_KEY", secret:true }]` |
| `id:"pi-stored-credentials"` | `agent` | pi reads its own `~/.pi/agent/auth.json` (`AuthStorage`); "agent handles auth itself" (the default `AuthMethodAgent`) |

`env_var` methods use the SDK `AuthMethodEnvVar` shape (`{ id, name, vars:[{ name, label?, secret?,
optional? }], link? }`, `types.gen.d.ts:2221`). The set is deliberately the five providers our
client advertises credentials for in practice plus the disk-credentials method; the full ~30-provider
catalog is not enumerated (noise). Advertised only when the client advertised the corresponding auth
capability at `initialize` (SDK `ClientCapabilities.auth`, gated the way `describeClientAuthAdvertisement`
reads it, `capabilities.ts:161-172`); a client that advertises no auth capability receives an empty
`authMethods` (the claude "hide all methods" precaution). This fits our pure-data auth-profile flow —
type-driven `env_var`/`agent` methods need zero client changes (ACP auth spec §1.3/§3.5).

`authenticate` is served as a no-op success for `env_var`/`agent` methods (credentials are ambient —
env or disk — so there is nothing to exchange); a missing credential surfaces at prompt time as the
`-32000` auth rejection (§8), which is the reliable, spec-faithful signal our client pauses on. No
terminal-login method is advertised in v1 (pi's OAuth/login is a TUI flow with no ACP `terminal`
auth surface we serve).

---

### 9.6 Cancellation and the wedged-agent backstop (`src/session.ts`)

The SDK aborts the in-flight `session/prompt` request's `context.signal` when the client sends
`session/cancel` **or** `$/cancel_request` (both wired to the same abort, §4). The adapter registers,
for the duration of each prompt turn, `signal.addEventListener("abort", () => session.agent.abort())`
(`agent.abort()` aborts the active run's controller, `agent.ts:310-311`). pi then settles the turn
with a terminal `aborted` assistant message, and the adapter resolves the ACP request with
`{ stopReason: "cancelled", usage }` (§7). Any parked `session/request_permission` for that turn is
dismissed via the same signal (§9.2 step 3).

#### Wedged-agent backstop

`agent.abort()` is cooperative; a provider stream stuck below the abort point could leave
`session.prompt()` unresolved. The adapter therefore races settlement against a bounded timer after
abort: if the turn has not settled within a fixed grace window (default 5s) after `agent.abort()`, the
adapter force-resolves the ACP request with `{ stopReason: "cancelled", usage }`, marks the
`PiSession` poisoned, and disposes it (unsubscribe, disconnect MCP, abort again) so no later event
from the wedged run reaches the connection. The poisoned session is dropped from the registry; a
subsequent `session/prompt` for that id is rejected with `invalidParams` ("session terminated"). This
guarantees an aborted turn always returns promptly even if pi's underlying stream hangs.

---

## 10. Monorepo integration

### 10.1 Freshness gate (the one client-repo change)

Add `@earendil-works/pi-coding-agent` to `ACP_DEP_MATCHERS` in `scripts/check-acp-deps.mjs:34-37`:

```js
const ACP_DEP_MATCHERS = [
  (name) => name.startsWith("@agentclientprotocol/"),
  (name) => name === "@automatalabs/codex-acp",
  (name) => name === "@earendil-works/pi-coding-agent",   // NEW
];
```

Rationale: pi releases every 2–3 days (~30 releases in 10 weeks; latest 0.80.7, 2026-07-14), so the
pre-push freshness check (§ pre-push hook) must fail when pi-acp's pinned pi runtime falls behind npm
`latest`. `@earendil-works/pi-coding-agent` is a **direct** dependency of a workspace package (pi-acp
embeds it), so it belongs in `ACP_DEP_MATCHERS` (check 1, direct freshness), **not** `WRAPPED_RUNTIMES`
(which is for third-party adapters whose runtime is only transitive, `check-acp-deps.mjs:53-55`).
`@agentclientprotocol/sdk` is already matched by the `@agentclientprotocol/` prefix. This is the only
normative change outside `packages/pi-acp`.

### 10.2 Changesets, CI

- `packages/pi-acp` is auto-included by `pnpm-workspace.yaml` (`packages/*`).
- CI (`.github/workflows/ci.yml`) runs `pnpm -r exec tsc -b`, `tsc --noEmit`, and `pnpm -r test` on
  Node 24 — pi-acp participates through its `build`/`typecheck`/`test` scripts with no CI-file change.
- A changeset accompanies the introducing PR so the package publishes on the next release wave
  (`.changeset/config.json`, access `public`, baseBranch `main`); its first publish is a new-package
  release at `0.0.0` → the changeset's bump.

### 10.3 tsconfig project reference

Add `{ "path": "packages/pi-acp" }` to the root `tsconfig.json` `references` array (alongside the six
existing package references) so `tsc -b` builds it in dependency order. `packages/pi-acp/tsconfig.json`
is a composite project extending the shared base (the acp-agents convention).

---

## 11. Non-goals (v1) — with rationale

- **`PiBackend` built-in backend in `acp-agents`** — a follow-up issue mirroring #197 (spawn ladder
  `AGENTPRISM_PI_ACP_CMD` → resolved bin under `process.execPath` → npx; auth profile; native
  structured-output posture; `classifyProviderError` for pi's retry/errorKind signals; docs/skill/live
  e2e). Kept separate because it is client-repo work with its own review surface. Until it lands, the
  server is drivable through the existing custom-backend registry (`resolveModelRoute`,
  `runner.ts:1356-1370`) with zero client code, using a custom backend whose `customCapabilities.namespace`
  is `"@automatalabs/pi-acp"`.
- **`session/delete`** — pi's `SessionManager` exposes no delete/unlink API; hand-unlinking `.jsonl`
  files risks corrupting the fork tree. Advertising it would violate the "never advertise-and-throw"
  invariant. Revisit if pi adds a first-class delete.
- **Branch-topology replay on `session/load`** — v1 replays the linear active branch only; ACP
  `session/update` has no representation for fork topology. `getTree()` metadata surfaces through
  `session/list` instead.
- **Mid-turn steering / follow-up queue over ACP** — pi's `steer`/`followUp` have no in-band ACP
  surface; inventing one would be an unadvertised non-portable extension. One serialized turn per
  session (§6.4).
- **fs/terminal client-delegation suite** — terminal output is surfaced via the shared `_meta`
  tool_call convention (like claude-agent-acp/codex-acp), not ACP `terminal/*` or `fs/*`; revisit fs
  reads later.
- **http/sse/acp MCP transports** — v1 serves stdio MCP only (§9.3). http is the natural next step
  (advertise `mcpCapabilities: { http: true }` when the client lands).
- **`baseInstructions`/`developerInstructions` `_meta`** — pi's system-prompt override is internal
  and unstable (§5); not advertised or accepted.
- **Terminal-login auth method** — pi's login is a TUI OAuth flow with no ACP `terminal` auth surface
  we serve; env/disk credentials + the `-32000` pause signal cover v1.
- **Subprocess / `pi --mode rpc` mode; upstreaming; changes to the community bridges; pi extension
  marketplace surfaces** — explicitly excluded; in-process SDK only.

---

## 12. Rejected alternatives (with rationale)

1. **Subprocess bridge over `pi --mode rpc`** (the `svkozak/pi-acp` architecture). Rejected: pi's RPC
   executes tools autonomously with no per-tool permission callback, folds thinking into message
   chunks, accepts `mcpServers` without wiring them, and offers no native structured output — exactly
   the surfaces our client feature-detects and rewards. The in-process SDK (`createAgentSession`) is
   the only seam that closes all of them.
2. **Overwriting `agent.beforeToolCall`** instead of wrapping it. Rejected: `AgentSession` installs
   its own `beforeToolCall` to dispatch extension `tool_call` handlers (`agent-session.ts:423-443`);
   overwriting would silently disable every pi extension's tool interception. The wrapper (§9.2)
   preserves the chain.
3. **`getModel(provider, id)` from `@earendil-works/pi-ai/compat` as the primary model resolver** (the
   issue's suggestion). Rejected: that alias is `@deprecated` (`compat.ts:61`) and the catalog helper
   `getBuiltinModel` is strongly typed to generated catalog keys, so neither accepts arbitrary
   custom-provider strings. `ModelRegistry.find(provider, id)` (`model-registry.ts:695`) — what
   `createAgentSession` itself uses — is the runtime path that covers builtin + custom-configured
   providers.
4. **Returning `stopReason: "end_turn"` on provider error** (or minting a synthetic `error`
   stopReason). Rejected: the ACP `StopReason` enum has no error member (`types.gen.d.ts:3027`), and
   an error that looks like a normal turn defeats the client's pause/retry logic. Errors reject with
   `data.errorKind`; `-32000` is auth-exclusive (§8).
5. **Enumerating pi-ai's full ~30-provider env-key catalog as `authMethods`.** Rejected: noise. Five
   major providers + one disk-credentials method is the small, justified set; missing credentials
   still surface at prompt time via the `-32000` signal regardless of what is advertised.
6. **Advertising `session/delete` and unlinking session files by hand.** Rejected: no first-class pi
   API; risks fork-tree corruption; violates advertise-only-what-is-implemented.
7. **Advertising `mcpCapabilities: { http: true }` in v1** to unlock the client-hosted StructuredOutput
   MCP fallback. Rejected: we do not serve http MCP in v1, so it would be an advertise-and-fail; and pi
   serves outputSchema natively (§9.4), so the fallback is unnecessary. Advertising `{}` correctly gates
   http/sse out.

---

## 13. Test plan

All tests run under `tsx --test` (`packages/acp-agents` convention). No test requires external
credentials except the gated live leg.

### 13.1 Unit

1. **Event translation table (§6.1)** — feed each pi `AgentSessionEvent` (`text_delta`,
   `thinking_delta`, `tool_execution_start/update/end`) through the translator and assert the exact
   `sessionUpdate` shape, including `agent_thought_chunk` for thinking (the bridge's gap) and
   `tool_call` `_meta.toolName`/`kind`/`locations`.
2. **stopReason taxonomy (§7)** — table test over pi terminal `stopReason`
   `stop|length|toolUse|aborted|error` → `end_turn|max_tokens|end_turn|cancelled|REJECT`; assert the
   `error` case rejects with `RequestError` and the right `errorKind`/code, never a stopReason.
3. **Error codes (§8)** — assert `authRequired` → `-32000` + `errorKind:"auth_error"`; provider wall →
   `-32603` + `errorKind`; unknown model → `-32602`. Pin the numeric codes.
4. **Usage mapping (§6.3)** — pi `Usage` → ACP `Usage` field-by-field, `cost.total` → `usage_update.cost.amount`,
   `reasoning` → `thoughtTokens` (and omitted when undefined); accumulation across multiple assistant
   messages in one turn.
5. **Permission mapping (§9.2)** — allow_once / allow_always / reject / cancel / abort → the correct
   `{ block }` result; the three-option shape and `_meta.toolName` stamping; wrapper delegates to the
   inner extension `beforeToolCall`; abort dismisses a parked permission.
6. **outputSchema tool (§9.4)** — armed only when `_meta.outputSchema` present; capture emitted as
   final `agent_message_chunk`; disarmed after the turn; a mixed structured/unstructured sequence.
7. **Capability advertisement (§5)** — `initialize` returns exactly the pinned `agentCapabilities`
   (loadSession top-level; resume/fork/list/close; `mcpCapabilities:{}`; `_meta` namespace); no delete.
8. **Auth advertisement (§9.5)** — the five env_var methods + stored-credentials `agent` method;
   empty when the client advertised no auth capability.
9. **Model resolution (§5.2)** — `registry.find` hit → model passed; miss → `invalidParams`; absent
   spec → default.

### 13.2 Integration (scripted ACP client — the repo's fake-client patterns)

10. **Full prompt turn** — drive the adapter with a mock `streamFn` `Agent` (see 13.3): assert the
    ordered `session/update` stream and the final `PromptResponse { stopReason, usage }`.
11. **Session lifecycle** — new → prompt → close; load/resume/fork round-trips over a temp `agentDir`,
    asserting resume emits no replay and load re-emits the linear branch; list returns the created
    sessions.
12. **MCP bridge (§9.3)** — stdio stub MCP server; assert its tools appear as pi customTools and a
    `tools/call` round-trips; an http server is rejected by capability gating.
13. **Cancellation + backstop (§9.6)** — `session/cancel` mid-turn resolves `cancelled`; a
    wedged mock stream force-resolves within the grace window and poisons the session.

### 13.3 Hermetic e2e

14. **Mock-model ACP server** — construct an `Agent` with an injected `streamFn` (the pi-agent-core
    seam, `agent.ts:214`) wrapped in an `AgentSession` (its constructor takes an `agent`,
    `agent-session.ts:343`), driven end-to-end by our scripted ACP client with **zero credentials**.
    This is the substrate for future engine e2e without live keys.

### 13.4 Live e2e (gated on provider keys)

15. One cheap-model leg through the full runner (a custom backend registered with namespace
    `@automatalabs/pi-acp`), asserting a real structured-output turn validates. Gated on an env key;
    skipped in CI (which is credential-free, `ci.yml:54-57`).

---

## 14. References (verified file:line + version pins)

**Base commit (this repo), all `packages/…`/`scripts/…`/config citations verified against:**
`c06d1e3a5a4363d42b892df1d4d12a5e9c5b94b2` (branch `spec/pi-acp`, based on `origin/main`).

**pi source, all `packages/{ai,agent,coding-agent}/…` citations verified against:** repo
`github.com/earendil-works/pi`, tag **`v0.80.7`**, commit
**`818d67457cdd6b60bce6b121d16b23141c252dd8`**; npm `@earendil-works/pi-coding-agent@0.80.7` (lockstep
with `@earendil-works/pi-agent-core@0.80.7`, `@earendil-works/pi-ai@0.80.7`).

**ACP SDK, `@agentclientprotocol/sdk@1.2.1`**, verified against the installed dist at
`node_modules/.pnpm/@agentclientprotocol+sdk@1.2.1_zod@4.4.3/node_modules/@agentclientprotocol/sdk/dist/`.
**Blueprint:** `@agentclientprotocol/claude-agent-acp@0.59.0` (installed). **MCP client:**
`@modelcontextprotocol/sdk@^1.29`.

### This repo (base `c06d1e3`)

- `packages/acp-agents/src/capabilities.ts` — `supportsResumeSession` :109, `supportsLoadSession`
  :104-105, `supportsForkSession` :108, `GATED_CUSTOM_META_KEYS` :45-49, `gateCustomMeta` :198-213,
  `unsupportedMcpServer` (stdio always serviceable; http/sse gated once `mcpCapabilities` exists)
  :278-300, `describeClientAuthAdvertisement` :161-172, unsupported-block degrade :241-271.
- `packages/acp-agents/src/acp-client.ts` — `assertLifecycleSupported` :1220-1235, `selectModel` →
  `applyConfigOption("model", …)` :1972-1974, `sessionRequestMeta` gating :1204-1218.
- `packages/acp-agents/src/protocol-coverage.ts` — `ACP_AUTH_REQUIRED_CODE_EXCLUSIVE = -32000`
  :152-154, auth `_meta` convention keys :143-147.
- `packages/acp-agents/src/structured-output.ts` — `parseFinalJson` :47-64, `resolveStructuredOutput`
  ladder :125-161.
- `packages/acp-agents/src/usage.ts` — field-mapping doc :7-17, `UsageAccumulator.toAgentUsage`
  :50-72.
- `packages/acp-agents/src/permissions.ts` — `decidePermission` + option-kind orders :88-135,
  `candidateNames`/`_meta.*.toolName` :164-186.
- `packages/acp-agents/src/errors-map.ts` — `ACP_AUTH_REQUIRED_ERROR_CODE` :17, `OTHER_RESERVED` :23,
  `isAcpAuthRequired` (code-only `-32000`) :135-146, error-text fold :33-71.
- `packages/acp-agents/src/backends/codex.ts` — `customCapabilities { namespace, gatedKeys }` :34-37,
  `spawnConfig` bin ladder :53-66, `promptMeta` outputSchema :80-83, `nativeStructured` :85-90,
  `classifyProviderError` :39-51.
- `packages/acp-agents/src/runner.ts` — `supportsStructuredOutputToolTransport` (http gate)
  :1294-1296, `applyModelSelection` :1309-1316, `assertNoModelConfigOption` :1319-1329,
  `resolveModelRoute` (prefix strip) :1356-1370.
- `packages/shared-types/src/meta.ts` — `META_KEYS.outputSchema` :7-13, `CODEX_META_KEYS` :19-24,
  `CODEX_CUSTOM_CAPABILITY_NAMESPACE` :36.
- `scripts/check-acp-deps.mjs` — `ACP_DEP_MATCHERS` :34-37, `WRAPPED_RUNTIMES` :53-55.
- `packages/acp-agents/package.json` (packaging/exports/publishConfig blueprint),
  `packages/mcp-server/package.json` (bin/publishConfig blueprint), `tsconfig.json` (references),
  `pnpm-workspace.yaml`, `.changeset/config.json`, `.github/workflows/ci.yml` (node 24 :36, test steps
  :48-57).

### `@agentclientprotocol/sdk@1.2.1` (`dist/…`)

- `schema/types.gen.d.ts` — `StopReason` :3027, `PromptResponse` (usage) :2996-3021, `Usage`
  (inputTokens/outputTokens/cachedReadTokens/cachedWriteTokens/totalTokens/thoughtTokens) :3037-3075,
  `Cost` :3928, `UsageUpdate` :3951, `SessionUpdate` union :3436-3462, `SessionNotification` :3409,
  `ContentChunk`/`ToolCall`/`ToolCallUpdate` :140-186,3466-3546, `ToolKind` :196, `ToolCallStatus`
  :204, `ToolCallLocation` :568, `PermissionOption` :591, `PermissionOptionKind` :624,
  `RequestPermissionRequest` :108, `AuthMethod` :2159, `AuthMethodEnvVar` :2221, `AuthMethodTerminal`
  :2264, `AuthMethodAgent` :2303, `AgentCapabilities` :1455, `PromptCapabilities` :1537,
  `McpCapabilities` :1567, `SessionCapabilities` :1608, `NewSessionResponse` :2556,
  `SessionConfigOption` :2643, `SessionConfigSelect` :2760, `SetSessionConfigOptionRequest` :5031,
  `SetSessionConfigOptionResponse` :2975, `McpServerStdio` :4779.
- `dist/acp.d.ts` — `methods` registry :17-79, `agent()` builder :588, `AgentApp.onRequest` :637,
  `AgentContext`/handler contexts :142-206,367-396, `AgentSideConnection` :735, `sessionUpdate`
  sender :765, `requestPermission` sender :778.
- `dist/stream.d.ts` — `ndJsonStream` :30.
- `dist/jsonrpc.js` — error-code constructors (at their `static` declaration): parseError -32700
  :783, invalidRequest -32600 :789, methodNotFound -32601 :795, invalidParams -32602 :803,
  internalError -32603 :809, requestCancelled -32800 :815, **authRequired -32000 :821**,
  resourceNotFound -32002 :827.

### `@agentclientprotocol/claude-agent-acp@0.59.0` (blueprint, `dist/…`)

- `dist/index.js` — console redirect :53-56, `runAcp()` :60, shutdown + `connection.closed`/SIGTERM/
  SIGINT + `stdin.resume()` :61-84.
- `dist/acp-agent.js` — imports `agent as acpAgent, methods, ndJsonStream, RequestError` :1,
  `errorKindData(errorKind) => { errorKind }` :4113, `RequestError.authRequired()` :2036,2391,
  `RequestError.internalError(errorKindData(...), …)` :2044,2080.
- `dist/lib.js` — `runAcp`/`ClaudeAcpAgent` library exports :2.

### pi `v0.80.7` (commit `818d674`)

- `packages/coding-agent/package.json` — name `@earendil-works/pi-coding-agent`, `bin: { pi:
  dist/cli.js }`, `exports { ".", "./rpc-entry" }`, `engines.node >=22.19.0`, deps pi-agent-core/pi-ai/
  pi-tui `^0.80.7` + `typebox 1.1.38`.
- `packages/coding-agent/src/core/sdk.ts` — `CreateAgentSessionOptions` :34-83 (cwd, agentDir,
  authStorage, model, thinkingLevel, tools/excludeTools/customTools, sessionManager…; **no**
  beforeToolCall/streamFn), `createAgentSession` :167-406, `registry.find` :197, internal `streamFn`
  :302-303, `new AgentSession({ agent, sessionManager, customTools, … })` :385-399.
- `packages/coding-agent/src/index.ts` — public exports of `AgentSession`/`AgentSessionEvent`
  :15-27, `createAgentSession*` :204-207, `ModelRegistry` :172, `SessionManager` :240.
- `packages/coding-agent/src/core/agent-session.ts` — `AgentSessionEvent` union :127-155,
  `readonly agent: Agent` :270, `_installAgentToolHooks` sets `agent.beforeToolCall`/`afterToolCall`
  :423-471, `getActiveToolNames`/`setActiveToolsByName` :861-888, `prompt` :1076-1224 (sync auth
  throws :1140-1154), `_runAgentPrompt` (settles + `agent_settled`) :1023-1034, `_handlePostAgentRun`
  :1037-1069, `_isRetryableError` :2577, `setModel` :1537, `getSessionStats` :3023, `subscribe` :762.
- `packages/agent/src/agent.ts` — `Agent` ctor + `streamFn`/`beforeToolCall`/`afterToolCall`
  :101-106,171-219, `subscribe` :241, `steer` :274, `followUp` :279, `hasQueuedMessages` :300,
  `abort` :310-311, `waitForIdle` :319, `prompt`/`continue` :335-348.
- `packages/agent/src/types.ts` — `BeforeToolCallResult { block?, reason? }` :60-63,
  `BeforeToolCallContext { assistantMessage, toolCall, args, context }` :89-98, `AgentEvent` union
  :415-430, `ThinkingLevel` (off,minimal,low,medium,high,xhigh,max) :289.
- `packages/ai/src/types.ts` — `Usage` interface :357-379, `StopReason`
  (stop|length|toolUse|error|aborted) :380, `AssistantMessage { usage, stopReason, errorMessage }`
  :388-401, `AssistantMessageEvent` (text/thinking/toolcall start/delta/end; `done {reason:
  stop|length|toolUse}`; `error {reason: aborted|error}`) :464-476.
- `packages/ai/src/env-api-keys.ts` — `getApiKeyEnvVars` provider→env catalog (ANTHROPIC_API_KEY(+OAuth),
  OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY, …) :64-110, `findEnvKeys` :120-122.
- `packages/ai/src/compat.ts` — `getModel`/`getModels` (`@deprecated`) :61-65.
- `packages/ai/src/providers/all.ts` — `getBuiltinModel` :53, `getBuiltinModels` :65.
- `packages/coding-agent/src/core/model-registry.ts` — `static create` :391, `find(provider,
  modelId)` :695-696, `hasConfiguredAuth` :702, `getApiKeyAndHeaders` :745, `isUsingOAuth` :860.
- `packages/coding-agent/src/core/session-manager.ts` — `static create` :651, `static open` :662,
  `static forkFrom` :700, `static list`/`listAll` :759-776, `getTree` :449, `buildSessionContext`
  :423, `getBranch` :399, `SessionInfo { path, id, cwd, name?, … }` :170-184; **no** delete/unlink
  method (verified absent).
- `packages/coding-agent/src/core/extensions/types.ts` — `ToolDefinition<TParams extends TSchema>`
  (`parameters: TParams`) :437-449, `defineTool` :495.
- `packages/coding-agent/examples/extensions/structured-output.ts` — terminating tool pattern
  (`defineTool` + `execute` returning `{ content, details, terminate: true }`).
- `packages/ai/src/api/openai-completions.ts:1110`, `bedrock-converse-stream.ts:918`,
  `google-shared.ts:283-284`, `mistral-conversations.ts:491` — providers consume `tool.parameters` as
  raw JSON Schema (symbol keys stripped), grounding the outputSchema-as-parameters injection (§9.4).

---

## 15. License and attribution (pi is MIT)

`@automatalabs/pi-acp` depends on and embeds pi (`@earendil-works/pi-coding-agent`,
`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`), which is **MIT** (Earendil Inc. / Mario
Zechner + Armin Ronacher). Obligations, satisfied in-package:

- The MIT license text and copyright notice of the pi packages are retained (they ship in the
  installed dependency's `node_modules`; no source is vendored).
- `packages/pi-acp/README.md` includes a "Built on pi" attribution and a THIRD-PARTY notice naming pi,
  its authors, its MIT license, and the pinned version.
- pi-acp itself is `Apache-2.0` (the monorepo license); Apache-2.0 and MIT are compatible for this
  depend-and-embed relationship. No pi source is copied into pi-acp; the `findJsonBlock`/`extractValidated`
  helpers already in `acp-agents/src/structured-output.ts` were ported from pi under our existing
  attribution and are not re-copied here.
