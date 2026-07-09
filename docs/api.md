# API reference

The integrator-facing surface of the `@automatalabs/*` packages, in one place. Everything here is published API; if a symbol is not documented here or in the [README](../README.md), treat it as internal. Version references are as of `workflow-engine` 0.7 / `acp-agents` 0.11.

Packages (all published to npm, Apache-2.0, ESM-only, Node >= 22):

| Package | What it is | Depend on it when |
|---|---|---|
| `@automatalabs/workflows` | Facade re-exporting the full public surface (`runDynamicWorkflow`, `createAcpRunner`, `WorkflowManager`, types) | You want the SDK. **Start here.** |
| `@automatalabs/workflow-engine` | The deterministic script engine + `WorkflowManager` (no agent construction — the runner is injected) | You bring your own `AgentRunner` and don't want ACP deps |
| `@automatalabs/acp-agents` | The ACP runner: pooled Claude/Codex/OpenCode ACP processes, model routing, structured output, events, interactive sessions | You want agent execution without the workflow engine |
| `@automatalabs/shared-types` | The seam contracts: `AgentRunner`, `RunOptions`, `WorkflowError` (+ codes), workflow result/meta types | You implement a custom runner or need `instanceof WorkflowError` across packages |
| `@automatalabs/mcp-server` | Stdio MCP server (bin `agentprism-workflow`) exposing one `workflow` tool | You drive workflows from Claude Code / an MCP client |
| `@automatalabs/codex-acp` | Fork of `@agentclientprotocol/codex-acp` adding turn-level `outputSchema` forwarding | Installed automatically by `acp-agents`; only pin it directly to override the version |

---

## Two front doors

**One-shot (facade):** construct nothing, get a terminal result.

```ts
import { runDynamicWorkflow } from "@automatalabs/workflows";

const run = await runDynamicWorkflow(script, {
  cwd: "/abs/path/to/project",   // every agent session runs here
  args: { target: "src/" },      // exposed as the script's `args` global
  exec: { tokenBudget: 500_000 },
});
// Never throws for ordinary outcomes — read run.status: "completed" | "paused" | "failed" | "aborted"
```

Options (`RunDynamicWorkflowOptions`): `runner?` (custom `AgentRunner`; defaults to `createAcpRunner()`), `cwd?`, `args?`, `exec?` (an [`ExecOptions`](#execoptions--per-run)), `allowScriptBackends?` (approval policy for script-declared `meta.backends`), `workflows?` (a [`WorkflowDir`](#workflow-directories--openworkflowdir) view or dir path(s): the first argument may then be a workflow NAME — any string without the mandatory `export const meta` head is resolved via the view's `read()`, throwing a diagnosable searched-dirs/did-you-mean error on a miss — and nested `workflow("<name>")` calls resolve from the same view).

### <a name="workflow-directories--openworkflowdir"></a>Workflow directories — `openWorkflowDir`

`openWorkflowDir(dir | dirs, { cwd? })` binds a read-only view over folders of versioned workflow scripts. Construction does **no I/O** (nothing created, scanned, or cached); every method reads the filesystem at call time so the view always reflects the current working tree, and missing dirs contribute nothing. The filename stem is the name (`review-pr.workflow.js` / `review-pr.js` ⇒ `review-pr`; across dirs first hit wins, within a dir `.workflow.js` beats `.js`; also `.mjs` variants). Surface: `dirs` (absolute, precedence order), `list()` (`[{ name, file, meta?, error? }]`, meta parsed per call, sorted), `read(name)` (script text; throws with searched dirs + closest matches), and `resolve(name)` — `(name) => string | undefined`, deliberately the exact `loadSavedWorkflow` contract, with strict name-shape validation (one flat path segment) so inline nested scripts fall through and path traversal is impossible. Exported by both `@automatalabs/workflow-engine` and the facade.

**Script validation (token-free):** `validateWorkflowScript(script, opts?)` runs a static parse (meta literal, syntax, determinism blocklist) plus a dry run over an in-process mock `AgentRunner` that fabricates schema-conforming results — no ACP process, no tokens, checkpoints take their headless defaults, script-declared backends are treated as approved (with a warning). It never throws for an invalid script; read `report.ok` / `report.exitCode` (`0` valid, `1` parse failure, `2` dry-run failure). `ValidateWorkflowOptions`: `args?`, `workflows?` (a `WorkflowDir` view or dir path(s) so nested `workflow("<name>")` calls resolve during the dry run), `dryRun?` (`false` = parse only), `cwd?` (default: a throwaway temp dir so `isolation:"worktree"` no-ops), `tokenBudget?` (the mock reports `MOCK_TOKENS_PER_AGENT` = 1000 tokens per call), `maxAgents?`, `timeoutMs?` (default 30 000). The report lists every agent call (`label`, `phase`, `model`, `tier`, `mode`, `backend` attribution via the real router, `schema` flag), every checkpoint with the default reply taken, visited phases, logs, the composed result, and warnings. Helpers `fabricateFromSchema(schema)` and `formatValidateReport(report)` are exported too. The same check ships as the package bin: `npx @automatalabs/workflows validate <file-or-name> [--args <json> | --args-file <path>] [--workflows-dir <dir>]… [--parse-only] [--cwd <dir>] [--token-budget <n>] [--max-agents <n>] [--timeout-ms <n>] [--json]` (exit `3` = usage error). With `--workflows-dir` the positional may be a workflow NAME and nested `workflow("<name>")` calls resolve; without it, nested bare names fail the dry run (the report warns and names the fix) while inline nested scripts always validate.

**Host-embedded (manager):** long-lived, evented, resumable.

```ts
import { WorkflowManager, createAcpRunner } from "@automatalabs/workflows";

const manager = new WorkflowManager({ cwd: projectRoot, agent: createAcpRunner() });
manager.on("agentEnd", (e) => ui.update(e.runId, e));
manager.on("agentEvent", (e) => ui.stream(e.runId, e));  // live token-level ACP stream (see Events)

const { runId, promise } = manager.startInBackground(script, args, { cwd: worktreePath });
// ... later:
manager.stop(runId);            // or manager.pause(runId), or await manager.resume(runId)
```

---

## WorkflowManager

### Constructor — `WorkflowManagerOptions`

| Option | Default | Meaning |
|---|---|---|
| `cwd` | `process.cwd()` | The manager's base directory. Keys run **state/log storage** and is the default run directory when a run passes no `cwd` of its own. |
| `agent` | — | The injected `AgentRunner`. Required here or per-run (`ExecOptions.agent`); the engine never constructs one. |
| `concurrency` | 8 | Max concurrent agents per run. |
| `journaling` | `true` | Default journaling policy. `false` = the host owns transcripts: no run-state/log files, `resume()` rejects, and startup stale-run recovery is skipped entirely. |
| `persistenceRoot` | `AGENTPRISM_PERSISTENCE_ROOT` env, else `~/.agentprism/workflows` | Absolute root for run state/logs. Relative paths throw. |
| `persistence` | filesystem persistence | Custom `RunPersistence` implementation. Omit it for the default `createRunPersistence(cwd, ..., { persistenceRoot })` path. |
| `defaultAgentTimeoutMs` | `null` (none) | Per-agent timeout default. |
| `defaultAgentRetries` | 0 | Retries after *recoverable* agent failures. |
| `mainModel` | — | Session main model (`provider/id`) used to auto-tier explore-style agents. |
| `sessionId` | — | Tag for new runs; `listRuns()` filters by it (`listAllRuns()` doesn't). Update via `setSessionId()`. |
| `agentsDir` | project + user agent dirs | Override the directory scanned for `agentType` definitions. |
| `loadSavedWorkflow` | — | `(name) => script` resolver enabling nested `workflow("name")` in scripts. `openWorkflowDir(dir).resolve` is a ready-made one. |

On construction, a journaling manager reconciles orphaned `"running"` runs from dead processes to `"paused"` (journal preserved for resume). A `journaling: false` manager never touches persisted state.

### <a name="execoptions--per-run"></a>`ExecOptions` — per-run

Passed as the third argument to `startInBackground` / `runSync`, second to `resume`.

| Option | Meaning |
|---|---|
| `cwd` | **This run's working directory**, overriding the manager `cwd` — the natural fit for a worktree-per-run host. Every subagent ACP session runs here (unless worktree isolation or a per-agent `agent({ cwd })` narrows it further). Persisted with the run, so `resume()` re-runs in the *same* directory. Run state stays keyed to the **manager** cwd, so `listRuns()`/`resume()` survive the run directory's deletion. |
| `agent` | Per-run `AgentRunner` override. |
| `signal` / `externalSignal` | Host `AbortSignal` that aborts this run (aliases). |
| `journaling` | Per-run journaling override. |
| `tokenBudget` | Hard cap; once spent, `agent()` throws `TOKEN_BUDGET_EXHAUSTED`. |
| `maxAgents` | Cap on total agent calls for the run. |
| `agentTimeoutMs` | Per-agent timeout (`null` = none). |
| `concurrency`, `agentRetries` | Per-run overrides of the manager defaults. |
| `confirm` | `(promptText, options) => Promise<reply>` — resolves script `checkpoint()` calls with a human reply. Headless runs without it take the checkpoint's declared default. |
| `onProgress` | Fires with the live `WorkflowSnapshot` on every progress event. |
| `scriptBackends` | APPROVED script-declared custom backends (`meta.backends`). Omitting leaves them inert — approval belongs to the composition root. |
| `resumeJournal` | Internal resume channel (set by `resume()`; don't pass manually). |

### Lifecycle

| Method | Returns | Notes |
|---|---|---|
| `startInBackground(script, args?, exec?)` | `{ runId, promise }` | Returns immediately. The promise rejects on failure (a side-channel catch prevents host unhandled rejections if you don't await it). |
| `runSync(script, args?, exec?)` | `Promise<WorkflowRunResult>` | Blocks; always resolves to a **terminal** result (`completed \| paused \| failed \| aborted`) — never throws for ordinary outcomes. |
| `pause(runId)` | `boolean` | Aborts in-flight work; journal preserved; resumable. |
| `stop(runId)` | `boolean` | Terminal abort. Not resumable. |
| `resume(runId, exec?)` | `Promise<boolean>` | Restarts a paused/failed run in the background: the journaled prefix replays without spending tokens; only un-run steps execute. Runs in the run's original per-run `cwd` unless `exec.cwd` overrides. Requires journaling. |
| `getRun(runId)` | `ManagedRun \| undefined` | Live in-memory state incl. `status`, `snapshot`, `error`. |
| `listRuns()` / `listAllRuns()` | `PersistedRunState[]` | Persisted runs (session-filtered / all). |
| `setSessionId(id)`, `setMainModel(spec)` | — | Rebind session tagging / tier fallback. |
| `dispose()` / `close()` | — | Facade manager only: detach its `agentEvent` runner subscriptions. Never disposes the runner itself. |

A run that hits a provider usage/quota wall (`PROVIDER_USAGE_LIMIT`) is **paused**, not failed — the journal checkpoints and `resume()` picks up after the budget refills (`resetHint` carries the provider's "resets in…" text when present).

### Events

`WorkflowManager` is an `EventEmitter`; **every payload carries `runId`** — route by it, no reverse index needed. Listeners are observability-only: a throwing listener is isolated and never affects the run.

| Event | Payload (beyond `runId`) |
|---|---|
| `log` | `message` |
| `phase` | `phase` title |
| `agentStart` | `label`, `phase`, `prompt`, `model?` |
| `agentEnd` | `label`, `phase`, `result` (`null` on error), `tokens`, `error?`, `errorCode?`, `recoverable?`, `model?`, `worktree?` |
| `agentHistory` | `label`, `history` (message/tool-call entries) |
| `journal` | `entry` (`JournalEntry`) — live journal append observations, including when file journaling is disabled |
| `tokenUsage` | `usage` (cumulative input/output/total/cost/cache) |
| `complete` | `result` (the composed `WorkflowRunResult`) |
| `paused` | `reason` (e.g. `"usage_limit"`), `error`, `resetHint?` |
| `stopped` / `resumed` | — |
| `error` | `error` (`WorkflowError`) — emitted only when a listener exists, so an unheard `error` never masks the thrown one |
| `agentEvent` | **The token-level streaming surface** (facade manager only — see below). |

### `agentEvent` — live token-level streaming through the manager

The `WorkflowManager` exported by **`@automatalabs/workflows`** (the facade — not the bare engine class) adds one composition-root bridge: when the injected `AgentRunner` also exposes the acp-agents `.on()` bus (`createAcpRunner()` does), the manager forwards that runner's **entire live ACP stream** as `agentEvent`. This is how a host renders message chunks, tool calls, and plans as they happen without holding a separate runner reference.

```ts
manager.on("agentEvent", (e: AgentEventPayload) => {
  if (e.name === "agent_message_chunk" && e.runId) ui.stream(e.runId, e.label, e.event);
});
```

Payload (`AgentEventPayload<K>`, exported): `{ name, event, backendId, sessionId?, label?, runId? }` —

- `name` is the ACP event name. `session/update` notifications arrive **unwrapped** as their `sessionUpdate` discriminant (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, …); the cross-cutting events (`permission_pending`, `permission_request`, `elicitation_pending`, `elicitation_request`, `elicitation_complete`, `raw_message`, `session_open`, `session_close`, `backend_error`) arrive under their own names.
- `event` is the **verbatim** runner payload for that event (typed per `name`).
- The envelope repeats the context fields hosts filter on: `runId` + `label` identify the workflow agent (stamped by the engine on every `agent()` call), `sessionId`/`backendId` identify the ACP session. `backend_error` is connection-scoped and carries no session/run context.

Bridge lifecycle: ref-counted per runner. A constructor-injected runner is bridged for the manager's lifetime; a per-run `ExecOptions.agent` runner is bridged only while its run is active. `manager.dispose()` (alias `close()`) detaches the manager's subscriptions — it does **not** dispose the runner, whose process lifetime stays with the caller. Forwarding is observability-only: a throwing `agentEvent` listener is isolated and never affects the run.

Alternative: subscribe on the runner's bus directly — see [Runner events](#runner-events); same underlying stream, same `runId`/`label` attribution, no manager involved.

### OpenTelemetry

`@automatalabs/agentprism-otel` attaches to any `WorkflowManager` and exports workflow traces and metrics through `@opentelemetry/api` only:

```ts
import { attachOtel } from "@automatalabs/agentprism-otel";

const telemetry = attachOtel(manager, { captureContent: false });
// run workflows...
telemetry.detach();
```

| Span | Source |
|---|---|
| `workflow` / `workflow <meta.name>` | run root, lazily created from the first manager event carrying `runId` |
| `invoke_agent <label>` | `agentStart` → `agentEnd` |
| `execute_tool <title>` | facade `agentEvent` `tool_call` → terminal `tool_call_update` |

Metrics: `agentprism.tokens`, `agentprism.cost`, `agentprism.agents`, and `agentprism.agent.duration`. Content attributes (`prompt`, `result`, tool input/output) are disabled by default and require `captureContent:true`; workflow `log()` messages are always added as root-span events. Without a registered OTel SDK, the API no-ops, so attaching is safe in hosts that do not configure telemetry.

---

## AcpAgentRunner (`createAcpRunner`)

```ts
import { createAcpRunner } from "@automatalabs/workflows";
const runner = createAcpRunner({
  size: 2,                                  // pooled processes per backend (AGENTPRISM_ACP_POOL_SIZE)
  clientHandlers: { fs: {...}, terminal: {...} },  // optional: route agent fs/terminal through the host
  onPermissionRequest: async (req, ctx) => ({ outcome: { outcome: "selected", optionId } }),
  onElicitation: async (req, ctx) => ({ action: "accept", content: { answer: "yes" } }),
  backends: { myAgent: { command: "/abs/bin", args: [], env: { API_KEY } } },
});
```

`AcpRunnerOptions`: `size?`, `clientHandlers?`, `onPermissionRequest?` (runner-wide async human-in-the-loop resolver; replaces the synchronous `ToolPolicy` auto-decision wherever set — pending resolvers are settled as `cancelled` on session teardown so a turn can never hang), `onElicitation?` (runner-wide ACP `elicitation/create` responder; see below), `backends?` (custom ACP backends, merged over env `AGENTPRISM_BACKENDS`; names are case-insensitive, `claude`/`codex`/`opencode` reserved).

### `run(prompt, opts)` — the AgentRunner seam

One agent call per invocation; returns the assistant text, or the **validated object** when `schema` is set (native/tool-captured structured output + validate-and-re-prompt). Key `RunOptions`:

`label`, `schema` (JSON Schema / TypeBox), `signal`, `model` / `tier`, `mode`, `cwd` (per-session working directory — worktree isolation preserved on a pooled process), `instructions`, `toolNames` / `disallowedToolNames` (the `ToolPolicy` allow/deny lists), `mcpServers`, `images`, `meta` / `promptMeta` (ACP `_meta` passthroughs), `backends` (approved script-declared), `runId` (correlation stamp), `keepSession` (skip the release-time best-effort `session/close` so the agent-persisted session stays re-openable), callbacks `onUsage`, `onHistory`, `onModelResolved`, `onModelFallback`, `onSessionOpen`.

**Session hand-off.** `run()`'s return value is always the bare result, so the ACP session identity travels out-of-band: `onSessionOpen` fires once right after `session/new` (before the first prompt) with an `AgentSessionRef` — `{ sessionId, backendId, cwd, reopen: { load, resume, list } }`. The `reopen` flags mirror the connected agent's advertised persistence (`loadSession` / `sessionCapabilities.resume` / `.list`); `backendId` doubles as the `model` routing spec for the reattach calls below. Pair it with `keepSession: true` when you intend to re-open: the runner then leaves the agent-persisted session untouched at release (the pooled process is released either way). The ref contains no secrets and is JSON-round-trippable.

**Structured output channels.** Claude and Codex keep their native schema channels authoritative and unchanged. OpenCode and custom ACP backends use the client-hosted MCP path: when `RunOptions.schema` is set, the backend opts in, and the negotiated initialize response advertises `agentCapabilities.mcpCapabilities.http === true`, the runner appends a client-hosted HTTP MCP server to `session/new.mcpServers`. The injected server is named `structured_output` (or `structured_output_2`, etc. on name collision), runs on `127.0.0.1` with an unguessable token path, and exposes one tool named `StructuredOutput`; agents may show it namespaced, for example `structured_output_StructuredOutput`. The tool input schema is the requested JSON Schema, and a valid call captures the result. Injected-tool schema runs are **serialized per pooled connection**: agents with instance-global, name-keyed MCP registries (OpenCode) expose every registered tool to every live session on the process, so overlapping injected sessions would leak one session's capture into another; the constant server name makes each registration replace the previous, and the per-connection turn guarantees the single live registration belongs to the active run. Scale schema-run parallelism with `AGENTPRISM_ACP_POOL_SIZE` (one registry per process), not concurrent sessions. If any gate fails, or a custom backend sets `structuredOutputTool:false`, behavior falls back to the existing prompt-embedded schema plus final-text JSON parse ladder. OpenCode also receives the generic `_meta.outputSchema` forward for future compatibility, but current OpenCode structured output depends on the injected tool. User-provided `mcpServers` are preserved and are not part of the resume hash.

**Model specs**: `provider/modelId`, bare id, or tier word; a trailing bracket drives sibling config options — `gpt-5.1-codex[high]` sets `reasoning_effort`, `[high fast]` also enables Fast mode (boolean-typed or legacy select shape — both supported; the client advertises `session.configOptions.boolean`). Routing: `claude|opus|sonnet|haiku` → Claude; `gpt|codex|o3|o4` → Codex; `opencode` / `opencode/<provider/model>` → OpenCode; registered custom-backend names route to their process first. OpenCode and custom backends strip their routing prefix before model selection, so `opencode/zai/glm-5.2[high]` selects `zai/glm-5.2` and applies `high` to a `thought_level`/effort option; Claude/Codex provider specs pass through whole. A bare `glm-5.2` does not route to OpenCode. An unmatched model/modifier fires `onModelFallback` (observable, never a throw) and the session default runs.

**Session modes (confinement)**: `mode` is an agent-advertised ACP session mode id. Claude-family agents commonly advertise `default`, `plan`, `acceptEdits`, `bypassPermissions`; Codex-family agents commonly advertise `read-only`, `agent`, `agent-full-access`; OpenCode exposes modes as a `configOptions` select with `category:"mode"` / `id:"mode"`. This is strict: if the backend advertises neither `modes` nor a mode config-option catalog, does not list the requested id, or rejects the wire call, the run fails before any prompt is sent. When `modes` is present, the runner validates it and calls `session/set_mode`; when `modes` is absent but a mode config option is present, it validates against that option and applies `session/set_config_option`.

Permission posture changes when `mode` is explicit: if no `onPermissionRequest` resolver is present, the headless permission fallback flips from allow to deny. Explicit `toolNames` allow-list matches still allow; `disallowedToolNames` still deny; a resolver still decides. This prevents read-only/plan modes from being defeated by automatic escalation approval. Plan/read-only modes confine writes and escalation, not reads.

### Elicitation (agent questions)

ACP `elicitation/create` lets an agent ask the human structured questions during a turn. `mode: "form"` carries an SDK `ElicitationSchema` of primitive fields; `mode: "url"` carries a URL and `elicitationId`, with a later `elicitation/complete` notification when that URL flow finishes. The SDK marks this surface **UNSTABLE/@experimental**, so the public API re-exports the SDK request/response/schema types directly.

Configure `createAcpRunner({ onElicitation })` to answer requests. A resolver receives `(request, context)` and returns `CreateElicitationResponse`, for example `{ action: "accept", content: { ... } }`, `{ action: "decline" }`, or `{ action: "cancel" }`. With no resolver for the session, the client auto-declines with `{ action: "decline" }`; parked resolvers are settled with `{ action: "cancel" }` on session cancel, release, or connection death.

Capability advertisement is fixed at `initialize`: the client advertises `elicitation: { form: {}, url: {} }` only when a runner-wide `onElicitation` exists. A session-scoped `openSession({ onElicitation })`, `loadSession({ onElicitation })`, or `resumeSession({ onElicitation })` wins over the runner resolver for that session, but by itself cannot light up initialize-time capabilities on the connection. Agents on that connection may therefore never ask. A resolver may still decline modes it cannot render.

Claude-family agents use this advertisement to enable `AskUserQuestion`, refusal-fallback dialogs, and MCP-elicitation forwarding. Advertising without a real responder would send those agent questions into a void, so this library never advertises elicitation for a stub auto-decline path.

### Auth & providers

Authentication methods are discovered without opening a session:

```ts
const methods = await runner.authMethods({ model: "codex" }); // AuthMethod[]
await runner.authenticate({ model: "codex", methodId: "api-key" });
```

`authMethods()` returns the selected backend's initialize-advertised `AuthMethod[]` (`[]` when none). `authenticate({ methodId, meta? })` drives the ACP `authenticate` method on a dedicated connection; ACP has no separate `agentCapabilities` gate for this method, so a backend that does not implement it may return method-not-found, surfaced with the backend id and method name.

If `session/new` or `session/prompt` fails with ACP `RequestError.authRequired()` (JSON-RPC code `-32000`, message prefix `Authentication required`), the runner raises `WorkflowErrorCode.AUTH_REQUIRED` with `recoverable: false`. The message names the backend and, when initialize advertised methods, tells the host to run `authenticate()` with one of those ids. The engine does not retry this; retrying cannot succeed until the host completes auth.

Provider management mirrors the SDK request shapes:

```ts
const { providers } = await runner.listProviders({ model: "codex" });
await runner.setProvider({ model: "codex", providerId: "openai", apiType: "openai", baseUrl, headers });
await runner.disableProvider({ model: "codex", providerId: "openai" });
await runner.logout({ model: "codex" });
```

`providers/list`, `providers/set`, and `providers/disable` are gated together by the unstable `agentCapabilities.providers` advertisement. `logout` is gated by `agentCapabilities.auth.logout`. Missing advertised support throws a non-recoverable `WorkflowError` naming the backend, method, and advertised auth/provider capabilities.

Installed adapter status from the bundled dists:

- `@agentclientprotocol/claude-agent-acp@0.57.0`: advertises `auth.logout`, implements `logout`, and implements `authenticate` for its gateway auth methods; terminal login methods are advertised only when the client advertises terminal auth support. It does not advertise or register `providers/*`.
- `@automatalabs/codex-acp@1.5.1`: advertises `auth.logout`, implements `authenticate` (`api-key`, `chat-gpt`, and `gateway` when gateway support is advertised), and implements `logout`. It does not advertise or register `providers/*`.

### Protocol passthrough & coverage

`PooledConnection` and `InteractiveSession` expose typed raw ACP `request()` / `notify()` escape hatches for spec methods without named wrappers:

```ts
import { AGENT_METHODS } from "@automatalabs/workflows";

await session.request(AGENT_METHODS.mcp_message, { connectionId, method: "tools/list" });
```

Prefer named wrappers (`prompt()`, `setMode()`, `openSession()`, etc.) when they exist; they preserve engine semantics like drain accumulation, local mode state, and usage recording, while raw `session/prompt` bypasses them.

Raw `request()` rejects the session-stateful methods that would create or reopen sessions outside the router: `session/new` (use `openSession()`), `session/load` (use `loadSession()`), `session/resume` (use `resumeSession()`), and `session/fork` (no driven wrapper yet). Those raw sessions are unregistered: updates do not fold into an accumulator, permission requests auto-cancel, and fs/terminal dispatch fails for unknown sessions.

`AGENT_METHOD_COVERAGE` and `CLIENT_METHOD_COVERAGE` classify every method constant exported by the installed ACP SDK. Agent methods are `"driven"`, `"passthrough"`, or `"guarded"`; guarded means raw passthrough is intentionally blocked because the method is session-stateful and not safely routable through an escape hatch. Agent coverage is 15 operational driven methods plus `initialize`, 1 guarded method (`session/fork`), and passthrough for `nes/*`, `document/*`, and `mcp/message`. Client methods are currently 14/14 served. A tripwire test compares those manifests against `AGENT_METHODS` / `CLIENT_METHODS`, so SDK bumps cannot silently add or remove protocol surface.

### <a name="runner-events"></a>Events (`runner.on(name, listener)`)

Typed bus; returns an unsubscribe thunk. Names are the ACP `sessionUpdate` discriminants verbatim (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, …) plus cross-cutting events: `session_update` (catch-all), `permission_pending`, `permission_request`, `elicitation_pending`, `elicitation_request`, `elicitation_complete`, `raw_message`, `session_open`, `session_close`, `backend_error`. Every payload carries `AcpEventContext`: `{ sessionId, backendId, label?, runId? }` — the engine stamps `runId`/`label` on every workflow agent, so multiplexed streams filter cleanly.

### Interactive sessions

```ts
const session = await runner.openSession({ model: "claude", cwd: "/abs/dir" }); // held open
const turn = await session.prompt("first turn");            // { stopReason, text }
await session.prompt([{ type: "text", text: "..." }], { images });  // image blocks degrade to a
                                                                    // text note if unadvertised
const off = session.on("agent_message_chunk", render);      // session-filtered subscription
await session.setMode("default");                           // switch after host approval
await session.cancel();                                     // cancel the active turn only
await session.release();                                    // end session; pooled process survives
```

`InteractiveSessionOptions`: `cwd` (required, absolute), `model`/`tier`, `mode` (strict ACP session mode), `toolNames`/`disallowedToolNames`, `onPermissionRequest` (session-scoped, wins over runner-wide), `onElicitation` (session-scoped, wins over runner-wide but cannot affect initialize-time capability advertisement), `mcpServers`, `meta`, `retainSessionLog` (default `false` for held-open sessions; set `true` when the host wants the runner to keep the full transcript), `keepSession` (skip the release-time `session/close` so the session stays re-openable after `release()`). `session.text` / `session.history` expose the retained assistant text and message/tool history; `session.modes` exposes the advertised catalog and current mode; `session.sessionRef` is the re-attach handle (same `AgentSessionRef` shape as `onSessionOpen`) to persist before releasing.

**Session lifecycle (reattach)**:

```ts
const listed = await runner.listSessions({ model: "claude", cwd: "/abs/dir", cursor });
await runner.deleteSession({ model: "claude", sessionId });

const loaded = await runner.loadSession({ sessionId, cwd: "/abs/dir" });
const resumed = await runner.resumeSession({ sessionId, cwd: "/abs/dir" });
```

`listSessions()` returns the SDK `ListSessionsResponse` (`sessions: SessionInfo[]`, plus `nextCursor?`); `deleteSession()` resolves to `void`. `loadSession()` and `resumeSession()` return live `InteractiveSession`s tracked and released like `openSession()` sessions. They accept the same session-scoped fields as `openSession()` plus the required `sessionId`; `mcpServers` defaults to `[]` on the wire. `loadSession()` registers the caller-supplied id before sending `session/load`, so replayed `session/update` history is accumulated and permissions during replay are routed. After it resolves, replay is visible in `session.text` / `session.history`. `resumeSession()` reattaches without replay. Both adopt response `configOptions`/`modes`, so model config selection is applied only when the reopened session advertises it, and `mode` is applied strictly from the response mode catalog.

Where does `sessionId` come from? Three sources: `listSessions()`, an `InteractiveSession.sessionRef` you persisted, or — for one-shot workflow agents — `WorkflowRunResult.agentSessions`. Every `agent()` call that opened a live session lands one `AgentSessionRecord` (`AgentSessionRef` + `callIndex`/`label`/`phase`/`keptOpen`) on the run result (even with `journaling: false` — it rides the result, not the journal), in the journal entry (so resume replays it), and on the `agentEnd` event/snapshot. The one-shot-plan round trip:

```ts
const run = await manager.runSync(planScript, args);        // plan produced one-shot
await planStore.save({ plan: run.result, session: run.agentSessions?.[0] });
// later — "discuss this plan" with the agent's full context:
const saved = await planStore.load(id);
const chat = await runner.loadSession({
  sessionId: saved.session.sessionId,
  cwd: saved.session.cwd,
  model: saved.session.backendId,
});
await chat.prompt("Revise section 3 — the user wants X.");
```

Set `agent(prompt, { keepSession: true })` in the script (or `RunOptions.keepSession` on direct `run()` calls) when you intend to re-open: it skips the release-time best-effort `session/close`, guaranteeing the agent-persisted session is untouched. Without it the record is still surfaced, and the three first-class agents keep closed sessions loadable — but `keepSession` is the explicit, agent-agnostic contract. Check `reopen.load`/`reopen.resume` before offering re-attach in UI: an agent that persists nothing advertises neither, and its sessions are reachable only while held open (`openSession`).

Lifecycle methods are capability-gated after initialize. Missing support throws a non-recoverable `WorkflowError` naming the backend, method, and advertised lifecycle capabilities. The installed `@agentclientprotocol/claude-agent-acp@0.57.0` and `@automatalabs/codex-acp@1.5.1` both advertise `loadSession: true` plus `sessionCapabilities` for list/delete/resume/close. OpenCode advertises load/list/resume/close/fork; unsupported lifecycle methods still fail through the same gate.

### Capabilities

The one-time `initialize` handshake negotiates per-connection capabilities, readable as `NegotiatedCapabilities` (exported). It includes the full `agentCapabilities`, `agentInfo`, initialize `_meta`, and advertised `authMethods`. Prompt-content flags are **booleans**: `capabilities.agent.promptCapabilities?.image === true` etc. You rarely need to gate manually — `adaptPromptContent` already degrades unsupported `image`/`audio`/`resource` blocks to a bracketed text note naming the backend. The client truthfully advertises: `fs`/`terminal` only when you registered handlers, plus `session.configOptions.boolean` always (boolean config options are handled natively). The installed ACP SDK has no `ClientCapabilities` field for MCP-over-ACP; the real declaration is a `session/new` MCP server entry `{ type: "acp", name, serverId }`, gated before the session is opened.

### MCP-over-ACP client handlers

`clientHandlers.mcp` serves client-hosted MCP servers over ACP. The consumer owns the MCP implementation and this library only routes opaque payloads with session context:

```ts
const runner = createAcpRunner({
  clientHandlers: {
    mcp: {
      connect: async (params, ctx) => ({ connectionId: `mcp:${params.serverId}` }),
      message: async (params, ctx) => ({ ok: true, echo: params }),
      disconnect: async (params, ctx) => {},
    },
  },
});

await runner.run("use my local tool", {
  cwd,
  mcpServers: [{ type: "acp", name: "local", serverId: "local-acp-mcp" }],
});
```

All three `mcp` methods are required together. Partial objects throw at runner construction. `mcp/connect` receives the SDK shape `{ serverId, _meta? }`; the client allocates and returns `{ connectionId }`. Later `mcp/message` and `mcp/disconnect` carry only `connectionId`, so the runner maps `serverId -> sessionId` from `mcpServers` and `connectionId -> sessionId` from the connect response. On session release or connection death, every live MCP connection for that session gets a best-effort `disconnect` callback.

Two gates run before any prompt tokens are spent:

- The agent must advertise `agentCapabilities.mcpCapabilities.acp === true`; otherwise the ACP server config fails with non-recoverable `SCRIPT_VALIDATION_ERROR`.
- The runner must have a complete `clientHandlers.mcp`; declaring `{ type: "acp" }` without a handler is also a non-recoverable config error.

Installed backend status verified from the packaged dists: `@agentclientprotocol/claude-agent-acp@0.57.0` advertises `http`/`sse` MCP support but no `acp`, `@automatalabs/codex-acp@1.5.1` advertises `mcpCapabilities: { acp: false, http: true, sse: false }` and rejects ACP MCP config internally, and OpenCode advertises HTTP/SSE MCP support. Current MCP-over-ACP integration tests therefore use the repository fake agent fixture.

---

## Backends & process resolution

Long-lived ACP server processes are pool-managed (spawned once, sessions multiplexed; per-session `cwd` keeps worktree isolation on a shared process).

| Backend | Default resolution | Overrides |
|---|---|---|
| `claude` | spawns the installed `@agentclientprotocol/claude-agent-acp` dep | `AGENTPRISM_CLAUDE_ACP_CMD` / `_ARGS` |
| `codex` | `require.resolve("@automatalabs/codex-acp")` — the installed dep, no config needed | `AGENTPRISM_CODEX_ACP_BIN` (path), or `AGENTPRISM_CODEX_ACP_CMD` / `_ARGS` (full command) |
| `opencode` | `AGENTPRISM_OPENCODE_ACP_CMD`, else host-installed `opencode-ai/bin/opencode` if resolvable, else `opencode` on PATH; non-override paths pass `acp` | `AGENTPRISM_OPENCODE_ACP_CMD` / `_ARGS` (full command) |
| custom | `backends` option or `AGENTPRISM_BACKENDS` (JSON) | `CustomBackendConfig`: `command`, `args?`, `env?` (a **scoped overlay** for the child only — put per-backend secrets here, never in the ambient env), `sessionMeta?`, `customCapabilities?` |

Workflow scripts may *declare* backends via `meta.backends`, but declarations are inert until the composition root approves them (`allowScriptBackends` / `ExecOptions.scriptBackends` / `AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1`).

**Environment variables**: `AGENTPRISM_ACP_POOL_SIZE` (processes per backend, default 1), `AGENTPRISM_ACP_INIT_TIMEOUT_MS` (initialize handshake deadline, default 60s), `AGENTPRISM_DEFAULT_BACKEND` (`claude` | `codex` | `opencode` | custom name), `AGENTPRISM_PERSISTENCE_ROOT`, `AGENTPRISM_ALLOW_SCRIPT_BACKENDS`, `AGENTPRISM_OPENCODE_E2E_MODEL` (live e2e only; default `opencode/zai/glm-5.2`), plus the per-backend `*_CMD`/`_ARGS`/`_BIN` above.

---

## Errors — `WorkflowError`

One runtime class (from `@automatalabs/shared-types`, so `instanceof` holds across packages) with `.code`, `.recoverable`, `.agentLabel?`, `.resetHint?`. Recoverable agent failures retry up to `agentRetries`, then resolve that agent to `null`; non-recoverable ones halt the run.

| Code | Recoverable | Meaning / engine behavior |
|---|---|---|
| `SCRIPT_VALIDATION_ERROR` | no | Script failed parse/validation (bad meta, nondeterministic API, protocol mismatch). |
| `SCRIPT_ERROR` | no | The script **crashed at runtime**: uncaught throw or unhandled promise rejection in the script body. Run fails. |
| `WORKFLOW_ABORTED` | — | Actual cancellation (pause/stop/signal). Never used for crashes. |
| `AGENT_TIMEOUT` | yes | Engine-enforced per-agent timeout. |
| `AGENT_EMPTY_OUTPUT` | yes | No assistant text on a schema-less call. |
| `SCHEMA_NONCOMPLIANCE` | no | Structured output never validated after the repair ladder. |
| `PROVIDER_USAGE_LIMIT` | no | Quota/rate wall → the run **pauses** (journaled, resumable), carries `resetHint`. |
| `TOKEN_BUDGET_EXHAUSTED` / `AGENT_LIMIT_EXCEEDED` | no | Run caps hit. |
| `AGENT_EXECUTION_ERROR` | yes | Other agent-level failure (refusal/truncation are non-recoverable variants). |
| `PERSISTENCE_ERROR`, `UNKNOWN` | no | Storage / unexpected host-level failure. |

**Script-fault containment**: a promise a script floats (un-awaited `agent()`, a stray `Promise.reject`, a `.then()` chain) is attributed to its run by realm identity and fails it with `SCRIPT_ERROR` — it does not crash the host process, and in-flight agents are cancelled. Caveat: Node invokes every `unhandledRejection` listener, so a host that installs its own listener will still *observe* contained script floats; rejections no workflow owns preserve platform semantics (your listener stays in charge; with no listener the process crashes exactly as it would without the engine).

---

## MCP server

`npx @automatalabs/mcp-server` (bin `agentprism-workflow`) speaks stdio MCP and exposes one tool named **`workflow`**: pass `script` (or a saved `name`) + `args`; it runs via a `WorkflowManager`, streams progress, and supports `resumeFromRunId`. Honors the same environment variables as the SDK.

## Workflow script DSL

Scripts run in a deterministic `vm` realm (`Date.now`/`Math.random`/argless `new Date()` throw — the journal/resume identity depends on it; the realm is a determinism boundary, **not** a security boundary). Realm globals:

`agent(prompt, { label?, schema?, model?, mode?, tier?, phase?, isolation?, cwd?, timeoutMs?, retries?, mcpServers?, images?, agentType?, meta?, promptMeta? })` · `parallel(thunks)` (barrier; failed thunks → `null`) · `pipeline(items, ...stages)` (no inter-stage barrier) · `workflow(nameOrScript, args?)` (one level of nesting) · `checkpoint(prompt, opts?)` (journaled human gate) · `gate(thunk, validator, opts?)` · `retry(thunk, opts?)` · `verify(item, opts?)` · `judgePanel(...)` · `loopUntilDry(opts)` · `completenessCheck(args, results)` · `phase(title, { budget? })` · `log(msg)` · `budget.{total,spent(),remaining()}` · `args` · `cwd`.

See the [README](../README.md#writing-workflow-scripts) for authoring guidance and examples, and [`design-notes.md`](design-notes.md) for the protocol-level design.
