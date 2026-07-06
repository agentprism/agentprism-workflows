# API reference

The integrator-facing surface of the `@automatalabs/*` packages, in one place. Everything here is published API; if a symbol is not documented here or in the [README](../README.md), treat it as internal. Version references are as of `workflow-engine` 0.7 / `acp-agents` 0.11.

Packages (all published to npm, Apache-2.0, ESM-only, Node >= 22):

| Package | What it is | Depend on it when |
|---|---|---|
| `@automatalabs/workflows` | Facade re-exporting the full public surface (`runDynamicWorkflow`, `createAcpRunner`, `WorkflowManager`, types) | You want the SDK. **Start here.** |
| `@automatalabs/workflow-engine` | The deterministic script engine + `WorkflowManager` (no agent construction — the runner is injected) | You bring your own `AgentRunner` and don't want ACP deps |
| `@automatalabs/acp-agents` | The ACP runner: pooled `claude-agent-acp` / `codex-acp` processes, model routing, structured output, events, interactive sessions | You want agent execution without the workflow engine |
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

Options (`RunDynamicWorkflowOptions`): `runner?` (custom `AgentRunner`; defaults to `createAcpRunner()`), `cwd?`, `args?`, `exec?` (an [`ExecOptions`](#execoptions--per-run)), `allowScriptBackends?` (approval policy for script-declared `meta.backends`).

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
| `defaultAgentTimeoutMs` | `null` (none) | Per-agent timeout default. |
| `defaultAgentRetries` | 0 | Retries after *recoverable* agent failures. |
| `mainModel` | — | Session main model (`provider/id`) used to auto-tier explore-style agents. |
| `sessionId` | — | Tag for new runs; `listRuns()` filters by it (`listAllRuns()` doesn't). Update via `setSessionId()`. |
| `agentsDir` | project + user agent dirs | Override the directory scanned for `agentType` definitions. |
| `loadSavedWorkflow` | — | `(name) => script` resolver enabling nested `workflow("name")` in scripts. |

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

- `name` is the ACP event name. `session/update` notifications arrive **unwrapped** as their `sessionUpdate` discriminant (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, …); the cross-cutting events (`permission_pending`, `permission_request`, `raw_message`, `session_open`, `session_close`, `backend_error`) arrive under their own names.
- `event` is the **verbatim** runner payload for that event (typed per `name`).
- The envelope repeats the context fields hosts filter on: `runId` + `label` identify the workflow agent (stamped by the engine on every `agent()` call), `sessionId`/`backendId` identify the ACP session. `backend_error` is connection-scoped and carries no session/run context.

Bridge lifecycle: ref-counted per runner. A constructor-injected runner is bridged for the manager's lifetime; a per-run `ExecOptions.agent` runner is bridged only while its run is active. `manager.dispose()` (alias `close()`) detaches the manager's subscriptions — it does **not** dispose the runner, whose process lifetime stays with the caller. Forwarding is observability-only: a throwing `agentEvent` listener is isolated and never affects the run.

Alternative: subscribe on the runner's bus directly — see [Runner events](#runner-events); same underlying stream, same `runId`/`label` attribution, no manager involved.

---

## AcpAgentRunner (`createAcpRunner`)

```ts
import { createAcpRunner } from "@automatalabs/workflows";
const runner = createAcpRunner({
  size: 2,                                  // pooled processes per backend (AGENTPRISM_ACP_POOL_SIZE)
  clientHandlers: { fs: {...}, terminal: {...} },  // optional: route agent fs/terminal through the host
  onPermissionRequest: async (req, ctx) => ({ outcome: { outcome: "selected", optionId } }),
  backends: { myAgent: { command: "/abs/bin", args: [], env: { API_KEY } } },
});
```

`AcpRunnerOptions`: `size?`, `clientHandlers?`, `onPermissionRequest?` (runner-wide async human-in-the-loop resolver; replaces the synchronous `ToolPolicy` auto-decision wherever set — pending resolvers are settled as `cancelled` on session teardown so a turn can never hang), `backends?` (custom ACP backends, merged over env `AGENTPRISM_BACKENDS`; names are case-insensitive, `claude`/`codex` reserved).

### `run(prompt, opts)` — the AgentRunner seam

One agent call per invocation; returns the assistant text, or the **validated object** when `schema` is set (backend-native structured output + validate-and-re-prompt). Key `RunOptions`:

`label`, `schema` (JSON Schema / TypeBox), `signal`, `model` / `tier`, `cwd` (per-session working directory — worktree isolation preserved on a pooled process), `instructions`, `toolNames` / `disallowedToolNames` (the `ToolPolicy` allow/deny lists), `mcpServers`, `images`, `meta` / `promptMeta` (ACP `_meta` passthroughs), `backends` (approved script-declared), `runId` (correlation stamp), callbacks `onUsage`, `onHistory`, `onModelResolved`, `onModelFallback`.

**Model specs**: `provider/modelId`, bare id, or tier word; a trailing bracket drives sibling config options — `gpt-5.1-codex[high]` sets `reasoning_effort`, `[high fast]` also enables Fast mode (boolean-typed or legacy select shape — both supported; the client advertises `session.configOptions.boolean`). Routing: `claude|opus|sonnet|haiku` → Claude; `gpt|codex|o3|o4` → Codex; registered custom-backend names route to their process. An unmatched model/modifier fires `onModelFallback` (observable, never a throw) and the session default runs.

### <a name="runner-events"></a>Events (`runner.on(name, listener)`)

Typed bus; returns an unsubscribe thunk. Names are the ACP `sessionUpdate` discriminants verbatim (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, …) plus cross-cutting events: `session_update` (catch-all), `permission_pending`, `permission_request`, `raw_message`, `session_open`, `session_close`, `backend_error`. Every payload carries `AcpEventContext`: `{ sessionId, backendId, label?, runId? }` — the engine stamps `runId`/`label` on every workflow agent, so multiplexed streams filter cleanly.

### Interactive sessions

```ts
const session = await runner.openSession({ model: "claude", cwd: "/abs/dir" }); // held open
const turn = await session.prompt("first turn");            // { stopReason, text }
await session.prompt([{ type: "text", text: "..." }], { images });  // image blocks degrade to a
                                                                    // text note if unadvertised
const off = session.on("agent_message_chunk", render);      // session-filtered subscription
await session.cancel();                                     // cancel the active turn only
await session.release();                                    // end session; pooled process survives
```

`InteractiveSessionOptions`: `cwd` (required, absolute), `model`/`tier`, `toolNames`/`disallowedToolNames`, `permissionResolver` (session-scoped, wins over runner-wide), `mcpServers`, `meta`, `retainSessionLog` (default `true`; set `false` for day-long sessions where the host keeps its own transcript).

### Capabilities

The one-time `initialize` handshake negotiates per-connection capabilities, readable as `NegotiatedCapabilities` (exported). Prompt-content flags are **booleans**: `capabilities.agent.promptCapabilities?.image === true` etc. You rarely need to gate manually — `adaptPromptContent` already degrades unsupported `image`/`audio`/`resource` blocks to a bracketed text note naming the backend. The client truthfully advertises: `fs`/`terminal` only when you registered handlers, plus `session.configOptions.boolean` always (boolean config options are handled natively).

---

## Backends & process resolution

Long-lived ACP server processes are pool-managed (spawned once, sessions multiplexed; per-session `cwd` keeps worktree isolation on a shared process).

| Backend | Default resolution | Overrides |
|---|---|---|
| `claude` | spawns the installed `@agentclientprotocol/claude-agent-acp` dep | `AGENTPRISM_CLAUDE_ACP_CMD` / `_ARGS` |
| `codex` | `require.resolve("@automatalabs/codex-acp")` — the installed dep, no config needed | `AGENTPRISM_CODEX_ACP_BIN` (path), or `AGENTPRISM_CODEX_ACP_CMD` / `_ARGS` (full command) |
| custom | `backends` option or `AGENTPRISM_BACKENDS` (JSON) | `CustomBackendConfig`: `command`, `args?`, `env?` (a **scoped overlay** for the child only — put per-backend secrets here, never in the ambient env), `sessionMeta?`, `customCapabilities?` |

Workflow scripts may *declare* backends via `meta.backends`, but declarations are inert until the composition root approves them (`allowScriptBackends` / `ExecOptions.scriptBackends` / `AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1`).

**Environment variables**: `AGENTPRISM_ACP_POOL_SIZE` (processes per backend, default 1), `AGENTPRISM_ACP_INIT_TIMEOUT_MS` (initialize handshake deadline, default 60s), `AGENTPRISM_DEFAULT_BACKEND`, `AGENTPRISM_PERSISTENCE_ROOT`, `AGENTPRISM_ALLOW_SCRIPT_BACKENDS`, plus the per-backend `*_CMD`/`_ARGS`/`_BIN` above.

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

`agent(prompt, { label?, schema?, model?, tier?, phase?, isolation?, cwd?, mcpServers?, images?, agentType? })` · `parallel(thunks)` (barrier; failed thunks → `null`) · `pipeline(items, ...stages)` (no inter-stage barrier) · `workflow(nameOrScript, args?)` (one level of nesting) · `checkpoint(prompt, opts?)` (journaled human gate) · `gate(thunk, validator, opts?)` · `retry(thunk, opts?)` · `verify(item, opts?)` · `judgePanel(...)` · `loopUntilDry(opts)` · `completenessCheck(args, results)` · `phase(title, { budget? })` · `log(msg)` · `budget.{total,spent(),remaining()}` · `args` · `cwd`.

See the [README](../README.md#writing-workflow-scripts) for authoring guidance and examples, and [`design-notes.md`](design-notes.md) for the protocol-level design.
