# @automatalabs/mcp-server

An **[MCP](https://modelcontextprotocol.io) server** for foreground/background execution, bounded await, safe inspection, and in-place stopping of dynamic multi-agent workflows. Execution lives in a shared per-user **local daemon** (spec-compliant Streamable HTTP on loopback) so runs survive MCP clients killing their server processes; hosts connect through the bundled **stdio shim** (the default bin, zero config change) or directly over HTTP — see [The workflow daemon](#the-workflow-daemon). Its model-facing tool surface is **three tools**: **`docs`** for selective version-matched workflow/REPL documentation, **`workflow`** for config/run/resume/inspect/await/stop, and **`repl`** for persistent interactive orchestration — plus an app-only `workflow-events` poller that feeds the [MCP Apps run monitor](#run-monitor-mcp-apps) and never enters the model's tool loop. The `workflow` tool discovers its live backend catalog with `action:"config"` and automatically validates every script before admission. Scripts may be supplied inline or by absolute server-side path, and every admitted script is also exposed as an immutable MCP resource. Agent backends authenticate from their own credential sources (`claude /login`, `codex login`, `opencode auth login`, provider API keys, or pi's `~/.pi/agent/auth.json`), so there is nothing auth-shaped for a host to manage here. A run that genuinely hits expired/missing credentials pauses with `authContext` and resumes (`resumeFromRunId`) after the backend credentials are configured. Auth and provider *management* APIs live in the [`@automatalabs/workflows`](../workflows) SDK for embedding hosts.

This package is a **thin MCP adapter**. The `workflow` tool's real work — parsing the workflow script, running the deterministic engine, fanning `agent()` calls out to real coding agents over [ACP](https://agentclientprotocol.com), journaling, and resume — lives in **[`@automatalabs/workflows`](../workflows)**; the `repl` tool's real work — the persistent QuickJS-in-WASM VM, the subagent broker, the CDP-style previewer, and the enveloped-snapshot store — lives in **[`@automatalabs/repl-engine`](../repl-engine)**. The MCP server is the *composition root*: it builds the ACP-backed agent runner, injects it into the workflow engine, registers the `workflow` tool over a per-project `WorkflowManager` and the `repl` tool over a per-project QuickJS VM, and serves them over stdin/stdout.

> **Embedding in your own program?** Don't reach for this package — use **[`@automatalabs/workflows`](../workflows)** directly (`runDynamicWorkflow(script, …)`). This server exists to put that same engine behind the MCP protocol. See [Programmatic use](#programmatic-use) below.

> **Published on npm** as `@automatalabs/mcp-server` (bin: `agentprism-workflow`) — see [Install](#install).

---

## What it is

```
   MCP host (Claude Code / Zed / Cursor / …)
        │   tools/call  →  "workflow" | "repl"   (JSON-RPC over stdio)
        ▼
┌──────────────────────────────────────────────────────┐
│  agentprism-workflow  (this package)                 │
│   • registers the "workflow" and "repl" tools        │
│   • createAcpRunner()  →  the workflow engine        │
│   • workflow → per-project WorkflowManager           │
│   • repl → per-project QuickJS VM + broker;          │
│            each workspace owns its own AcpAgentRunner │
└──────────────────────────────────────────────────────┘
        │   session/new, session/prompt … (ACP over stdio)
        ▼
   claude-agent-acp / codex-acp / opencode acp / pi-acp
        │  → real Claude / Codex / OpenCode / pi agents
```

For `workflow`, foreground is the default; `background:true` durably admits work and returns its run
ID without awaiting agent completion, and `action:"await"` collects it in bounded calls (see
[Run model](#run-model)). The `repl` tool holds a persistent QuickJS VM **per `projectDir`** — the
same per-project context model — whose state persists across tool calls and daemon restarts through
the per-project `repl/` store, and whose subagent `agent()` calls use the same ACP path shown above
(see [The `repl` tool](#the-repl-tool)). `stdout` is reserved for JSON-RPC framing — every diagnostic
the server emits goes to `stderr`.

---

## Run monitor (MCP Apps)

The `workflow` tool declares a UI resource per the
[MCP Apps extension](https://modelcontextprotocol.io/extensions/apps/overview). The server
advertises `io.modelcontextprotocol/ui`. Legacy clients opt in through initialize-scoped
`capabilities.extensions["io.modelcontextprotocol/ui"]`; modern `2026-07-28` clients carry the
same extension declaration in each request's client-capabilities envelope. In both eras its
`mimeTypes` must contain `"text/html;profile=mcp-app"`. Only that exact, well-formed declaration
adds the UI metadata and app-only surface for that client/request. Supporting hosts show a live
run-monitor panel for `workflow`
calls — a phase/agent graph with per-node log drill-in
(including expandable per-tool results), live token/cost totals, and a Stop control. The panel
keeps itself current by polling the app-only `workflow-events` tool, so no model tokens are
spent while it is visible; hosts without MCP Apps support receive no UI metadata and get the
same text/structured output as always.

<p align="center">
  <img src="https://raw.githubusercontent.com/agentprism/agentprism-workflows/main/docs/assets/run-monitor-graph.png" alt="Run monitor: live phase/agent graph of a workflow run" />
  <img src="https://raw.githubusercontent.com/agentprism/agentprism-workflows/main/docs/assets/run-monitor-log.png" alt="Run monitor: per-agent log drill-in with an expanded tool result" />
</p>

To try it locally against the [ext-apps](https://github.com/modelcontextprotocol/ext-apps)
reference host, run `node scripts/dev-app-host.mjs` from this package (see the script header
for the basic-host setup and its explicit Apps capability declaration;
`AGENTPRISM_DEV_CWD=<project dir>` serves an existing run store).

---

## Install

```bash
# global (exposes the `agentprism-workflow` bin on your PATH)
npm i -g @automatalabs/mcp-server

# or per-project
npm i @automatalabs/mcp-server
```

Installing the package provides the executable **`agentprism-workflow`** (declared as the package's `bin`, pointing at the built `dist/cli.js`). You usually don't run it by hand — your MCP host launches it (see [Register it in an MCP host](#register-it-in-an-mcp-host)).

You also need a backend used by your scripts: Claude, Codex, and pi adapters are installed transitively; OpenCode is resolved from an `opencode-ai` installation or an `opencode` executable on `PATH`. Authenticate only the backends you route to. See [Backends & auth](#backends--auth).

---

## The `agentprism-workflow` bin

The package ships one executable:

| bin | entry |
| --- | --- |
| `agentprism-workflow` | `dist/cli.js` |

Running it starts the MCP stdio entry. **By default this is a thin shim** that proxies stdio to the shared local **workflow daemon** — a per-user process serving spec-compliant Streamable HTTP on loopback — auto-starting the daemon when none is running. Workflow execution lives in the daemon, so runs survive the MCP client killing the stdio process (session end, restarts, tool timeouts). It speaks the MCP protocol — it is not an interactive CLI. Launch it from an MCP host, or pipe JSON-RPC to it yourself for testing.

```
agentprism-workflow                     # stdio shim → daemon (default)
agentprism-workflow --in-process        # the pre-daemon single-process stdio server
agentprism-workflow daemon <start|stop|status|url|run|logs>
```

With `--in-process`, the old lifecycle applies: on stdin EOF, transport close, `SIGINT`, or `SIGTERM`, the server stops accepting new tool calls and disposes the ACP runner before exiting (five-second hard deadline, then force-kill of tracked backend process trees). The shim itself is disposable — killing it never touches the daemon or its runs.

### The workflow daemon

- **Discovery**: the daemon records `{pid, instanceId, port, url, version, envFingerprint, controlUrl, controlProtocol}` (mode 0600) under `~/.agentprism/workflows/daemons/` — a **family pointer** `<envFingerprint>.json` naming the current daemon for that env, plus one `instances/<pid>.json` per live daemon. A mode-0600 `<envFingerprint>.request-state-key.json` keeps modern integrity-protected multi-round-trip state verifiable across successors; the separate user-scoped mode-0600 `run-control-key.json` authenticates cross-family predecessor control. Malformed key storage fails closed. Shims verify liveness via pid + `/healthz` and never dial a port blind. Concurrent shims race a per-family spawn lock, so a cold start produces exactly one daemon. Logs land in `~/.agentprism/workflows/logs/daemon.log`.
- **Succession**: a shim that finds an older control-v1 daemon spawns a successor (ephemeral port), which atomically repoints the family pointer. The predecessor becomes a *lame duck*: it admits no new MCP work, migrates drainable sessions immediately, continues its owned executions/REPL drains, accepts signed internal stop/cancel forwarding, and exits when those responsibilities settle. A daemon **equal to or newer** than the shim is adopted (version is a total order, so clients cannot flip discovery backward). Bootstrap exception: when the stale predecessor predates control v1 and reports active runs or requests, the new shim temporarily adopts it until that work drains; sessions alone never defer the upgrade. `daemon status` shows instance/control identity for every current, draining, other-family, and legacy daemon.
- **Port**: default `29888` (`AGENTPRISM_DAEMON_PORT` / `--port`). If the port is held — by a foreign process, or by a draining predecessor still finishing its work — the daemon falls back to an ephemeral port — discovery still works, only hardcoded client URLs need the actual port from `daemon status`.
- **Sessions and projects**: sessions are project-agnostic — every `run` call names its project via the **required `projectDir` argument** (absolute path), so one registration serves any number of projects concurrently. `inspect`/`await`/`stop` take only a runId and locate its project store automatically (live contexts first, then the on-disk store manifests). Each project gets its own `WorkflowManager` — same per-project run stores as before — while all projects share one ACP backend pool. Background runs are visible from every session, and `MAX_BACKGROUND_RUNS` caps runs **per project** rather than per client process. The `repl` tool's workspace is the same shape of per-project context: **one persistent QuickJS VM per `projectDir`**, restored lazily from the per-project `repl/` store on first touch, persisted at every state-changing boundary, and drained when the project's last MCP client disconnects (both tools share one client-presence ledger, so a `workflow`-only client keeps the workspace's children warm too). See [The `repl` tool](#the-repl-tool).
- **Lifetime**: only signals, `daemon stop`, sustained idleness (default: 15 min with zero sessions, running workflow executions, requests, or REPL drains; `AGENTPRISM_DAEMON_IDLE_TTL_MS`, `0` disables), or completed supersession drain end the daemon. Client disconnects never cancel runs. Dead-client sessions are evicted without touching execution; the shim transparently re-initializes on the spec's 404. A predecessor may remain as an execution owner after its MCP sessions migrate, while the successor routes control by run lease. The REPL client-presence drain has its own bound, `AGENTPRISM_REPL_DRAIN_BOUND_MS` (default 2 h). A request in flight when its daemon crashes is answered by the shim with a JSON-RPC error instead of hanging.
- **Security**: the daemon binds `127.0.0.1` only, validates the `Host` header, and enforces the spec's `Origin` validation (403 for non-loopback origins; extend with `AGENTPRISM_DAEMON_ALLOWED_ORIGINS`). The MCP endpoint has no authentication: any local process/user on the machine can reach it — the standard localhost-dev-server trade-off. The non-MCP run-control endpoint additionally requires a timestamped HMAC from the user-scoped mode-0600 key; it never accepts unsigned localhost requests.
- **Env is captured at daemon start**: the ACP backend registry (`AGENTPRISM_BACKENDS`, `AGENTPRISM_DEFAULT_BACKEND`, …) is resolved once by the daemon. Clients are keyed by their env fingerprint: a shim whose relevant env differs gets its **own daemon family** (one daemon per distinct env, never contending), so changing the env and restarting the host always takes effect; `--in-process` remains the escape hatch for a fully private server.

### Connecting over HTTP directly

HTTP-capable hosts can skip the shim and register the daemon's MCP endpoint straight from `agentprism-workflow daemon url`, which prints ready-to-paste snippets:

```bash
# Claude Code
claude mcp add --transport http agentprism-workflows http://127.0.0.1:29888/mcp
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.agentprism-workflows]
url = "http://127.0.0.1:29888/mcp"
```

One registration — global or per-project — serves every project: each run names its project via the required `projectDir` tool argument, and runId actions need no project at all.

The daemon must be running before an HTTP-only host connects (`daemon start`); any stdio shim usage also keeps it alive. One endpoint serves both protocol eras. Legacy clients retain the full 2025-11-25 Streamable HTTP contract: per-session `Mcp-Session-Id`, SSE with priming events and `Last-Event-ID` resumability, `DELETE` termination, and 404-driven re-initialize. Modern clients negotiate through `server/discover` and use the SDK's stateless per-request `2026-07-28` handler, `input_required` rounds, response-stream cancellation, and `subscriptions/listen`; modern requests never allocate a legacy daemon session.

---

## Register it in an MCP host

Add the server to your host's `mcpServers` config. The host spawns the bin and talks MCP to it over stdio:

```json
{
  "mcpServers": {
    "agentprism-workflow": {
      "command": "agentprism-workflow",
      "args": []
    }
  }
}
```

If the bin isn't on the host's `PATH`, launch it through `npx` instead:

```json
{
  "mcpServers": {
    "agentprism-workflow": {
      "command": "npx",
      "args": ["-y", "@automatalabs/mcp-server"]
    }
  }
}
```

`env` here is inherited by the server process **and** by every agent subprocess it spawns (see [Backends & auth](#backends--auth)), so it is where you put `AGENTPRISM_*` settings and any credentials the agent CLIs need. Leave `AGENTPRISM_DEFAULT_BACKEND` unset for automatic MCP selection: when a workflow reaches a model-less `agent()` call, the server probes configured backends without prompting, pins one project default before validation/execution, and preserves it across resume. Set it explicitly to `claude`, `codex`, `opencode`, `pi`, or a registered custom backend name only when the operator wants to force that backend.

After your host reloads, the `workflow` and `repl` tools appear in its tool list.

---

## The `docs` tool

`docs` is the agent-controlled, progressive-disclosure reference surface. Omit `topic` or use `"index"` to receive only the bounded catalog, then request exactly one `workflow/*` or `repl/*` topic. Every result contains structured metadata plus one embedded `text/markdown` MCP resource; the same byte-identical document is directly readable at `agentprism://docs/<topic>` and appears in `resources/list`.

The topic vocabulary is closed and advertised in the input schema. Calls require no `projectDir`, open no backend session, execute no workflow or REPL code, persist nothing, and spend no model tokens. The index is capped at 8 KiB and each content topic at 16 KiB. Workflow and REPL references stay separate because their `agent()` signatures and lifecycle semantics differ.

Canonical MCP topic sources live under `docs/authoring/` in the repository and are bundled into the published server. The optional authoring skill is no longer read or embedded by the server.

## The `workflow` tool

### Input parameters

The tool uses a config/run/inspect/await/stop union. `config` performs zero-token, no-prompt discovery, and every run performs static validation, a mocked dry run, and routed model/config checks before admission. Invalid scripts return bounded `status:"rejected"` diagnostics without creating a run ID or reserving background capacity. Execution resource maxima remain runtime clamps;
inspection/await limits are contract bounds and invalid values are MCP Invalid Params (`-32602`).

| Param | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `action` | `"config" \| "run" \| "inspect" \| "await" \| "stop"` | no | run | `"config"` discovers live backend/model/mode/config options without starting a workflow. Omit or use `"run"` for automatic validation followed by execution. The remaining actions operate on an admitted `runId`. |
| `script` | string (non-empty) | run XOR | — | Raw JavaScript workflow script (no Markdown fences). Exactly one of `script`/`scriptPath` is required for run. The first statement **must** be `export const meta = { name, description, phases? }`. Forbidden for inspect/await/stop. |
| `scriptPath` | absolute path string | run XOR | — | Absolute path on the **server's filesystem**. Read once as UTF-8 before admission; the content is snapshotted, and later file edits do not change that run. Relative paths and unreadable files are Invalid Params. Forbidden for inspect/await/stop. |
| `projectDir` | absolute path string | config/run (daemon) | in-process: the server's own project | Project cwd for discovery and the run store/default execution cwd for execution. Required for config and run on the shared daemon. Forbidden for inspect/await/stop. |
| `harnesses` | backend-name array (1–16) | config only | every registered backend | Limit no-prompt discovery to these backends. |
| `modelSpecs` | model-spec array (1–16) | config only | — | Select these exact routed models before reading their model-specific mode and config-option catalogs. |
| `modelFilter` | string (1–128) | config only | provider/group summaries | Case-insensitive substring or `/regular expression/` used to return bounded matching model ids. |
| `probeTimeoutMs` | integer 1–120,000 | config only | `60,000` | Per-backend no-prompt discovery timeout. |
| `background` | boolean | run only | `false` | Acknowledge after admission and execute in this server process. |
| `args` | any JSON value | no | — | Optional value exposed to the script as the global `args`. |
| `maxAgents` | integer > 0 | no | `1000` | Max agents allowed in this run (engine cap `MAX_AGENTS_PER_RUN`). Values below 1 are clamped up to 1. |
| `concurrency` | integer > 0 | no | engine default | Max concurrent agents. **Clamped to 16** (the runtime max) by the engine — never rejected. |
| `agentRetries` | integer ≥ 0 | no | engine default | Retry attempts for recoverable agent failures. **Clamped to 3** (the runtime max). |
| `agentTimeoutMs` | integer > 0 \| null | no | none | Total wall-clock ceiling in ms for each attempt. A per-call `timeoutMs` may tighten but cannot escape a finite ceiling. Omit/pass `null` for no host ceiling. Every retry re-arms the clock. |
| `resumeFromRunId` | string | no | — | Start a new run from this existing persisted source. Re-send content via `script` or `scriptPath`; there is no implicit persisted-script fallback. The manager admits compatible format/metadata/manifest/cwd state and replays only eligible calls; current-environment and Node/V8 drift are reported provenance. Pre-input-format-2 sources use the named positional bridge. If the source paused mid-agent on usage/auth, an unchanged, reopenable root occurrence continues from its recorded ACP session; every failed continuation gate runs fresh. |
| `resumePolicy` | `"auto" \| "positional"` | no | `"auto"` | Positional requests index/prefix matching but cannot bypass new-format format/metadata/manifest/input checks. Requires `resumeFromRunId`. |
| `checkpointReplies` | object | no | — | With `resumeFromRunId`, map the **source** `checkpointContext.callIndex` to the durable decision. This works under the default policy and does not require `resumePolicy: "positional"`. The JSON decision is returned verbatim (`kind: "confirm"` normally uses a boolean). Wire keys must be canonical non-negative safe integers. |
| `runId` | engine run ID | inspect/await/stop only | — | Required for inspect/await/stop; `^[a-z0-9]+-[a-z0-9]+$`, at most 128 characters. |
| `waitMs` | integer 0–25,000 | await only | `20,000` | Zero is a non-blocking status read. Values are rejected, never clamped. |
| `lastN` | integer 1–50 | inspect/await/stop only | `20` | Latest matching journal calls. Filtering happens before this selection. |
| `labelGlob` | string | inspect/await/stop only | all calls | Non-empty, at most 128 Unicode code points. Case-sensitive whole-label `*`/`?` glob with backslash escaping; trailing backslash is literal. Only known agent labels match. |
| `logLines` | integer 0–50 | inspect/await/stop only | `20` | Latest run-log lines. |

The timeout is not an idle timer: it covers the complete attempt, including backend startup,
configuration, tool work, and streamed output. Each retry receives a fresh clock, so the maximum
envelope is `(resolved retries + 1) × resolved timeout` and retries are clamped to 3. Exhaustion
settles the call to `null` with recoverable `AGENT_TIMEOUT`, frees its concurrency slot, and cancels
the ACP session; a turn that ignores cancel is closed where supported and its pooled child is
recycled after sibling sessions drain. With no finite run-level ceiling, per-call `timeoutMs: null`
or omission is uncapped. Resume requests resolve their own limits, so pass the intended
timeout/retry/concurrency values again.

Discover a backend's live catalog before pinning model, mode, or `configOptions`:

```json
{ "action": "config", "projectDir": "/absolute/project", "harnesses": ["claude"], "modelFilter": "opus" }
```

After choosing a model, inspect its exact option domain with `{ "action": "config", "projectDir": "/absolute/project", "modelSpecs": ["claude/opus[1m]"] }`. Every successful harness entry reports `modes` explicitly: copy a mode only from `modes.availableModes`; `modes:null` means the backend/model supports none, so omit `mode`. Never infer a generic `"default"`. No workflow is started and no prompt is sent. If `model` is omitted, or only a backend name is used, discovery is optional.

Example run arguments (validation is automatic):

```json
{
  "script": "export const meta = { name: 'review', description: 'review a diff' };\nconst r = await agent('Review this diff and summarize risks:\\n' + args.diff);\nreturn r;",
  "args": { "diff": "diff --git a/x b/x\n+console.log(1)" },
  "concurrency": 4
}
```

Compact reader/worktree fan-out for `script`:

```js
export const meta = { name: "fan-out", description: "Audit and experiment independently" };
return await parallel([
  () => agent("Audit src/api without changing files.", {
    label: "audit:api",
  }),
  () => agent("Try the worker fix in isolation; return a unified diff.", {
    label: "try:worker", isolation: "worktree",
  }),
]);
```

The worktree edits are discarded. Both completed calls use the same journal correspondence rule.
See the [incremental resume API](../../docs/api.md#content-addressed-incremental-resume) for
admission, reports, and legacy fallback.

The same run delivered from disk:

```json
{
  "scriptPath": "/absolute/path/to/review.workflow.js",
  "args": { "target": "src/auth.ts" }
}
```
Inspection example:

```json
{
  "action": "inspect",
  "runId": "mabc1234-k9x2pq",
  "lastN": 10,
  "labelGlob": "plan-review-*",
  "logLines": 20
}
```

Background start and bounded collection:

```json
{
  "script": "export const meta = { name: 'review', description: 'review a change' };\nconst report = await agent('Review ' + args.target, { label: 'review' });\nreturn report;",
  "args": { "target": "src/auth.ts" },
  "background": true,
  "concurrency": 4
}
```

```json
{
  "runId": "mabc1234-k9x2pq",
  "status": "running",
  "limits": {
    "maxAgents": 1000,
    "tokenBudget": null,
    "concurrency": 4,
    "agentRetries": 0,
    "agentTimeoutMs": null
  }
}
```

```json
{ "action": "await", "runId": "mabc1234-k9x2pq", "waitMs": 20000 }
```

Stop a live run and return its final bounded snapshot:

```json
{ "action": "stop", "runId": "mabc1234-k9x2pq", "lastN": 10, "logLines": 20 }
```

Cancel one in-flight agent and return a live bounded snapshot without aborting the run:

```json
{ "action": "stop", "runId": "mabc1234-k9x2pq", "callIndex": 7, "lastN": 10, "logLines": 20 }
```

The selected form settles that call to `null` with `AGENT_CANCELLED`, skips retries, and leaves
sibling calls running. `labelGlob` filters only the returned snapshot. A missing, settled,
checkpoint, terminal, or ambiguous scoped index is an input error listing the in-flight
call-index/label pairs.

### Output

The tool returns both machine-readable `structuredContent` and a human-readable text block. Discovery and pre-admission rejection have no run ID:

```ts
interface WorkflowConfigToolResult {
  action: "config";
  ok: boolean;
  harnessOptions: Array<{
    backendId: string;
    model?: string;
    probed: boolean;
    modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string }> } | null;
    options: unknown[];
    error?: string;
  }>;
  models: Array<{ backendId: string; hasModelOption: boolean; matches: string[] }>;
}

interface WorkflowValidationRejected {
  action: "run";
  status: "rejected";
  validation: { ok: false; exitCode: 1 | 2; parse: object; dryRun?: object; warnings: string[] };
}
```

A rejected run has `isError:true`, bounded diagnostics, and no `runId`, `scriptUri`, or persistence record. Admitted executions retain the durable engine result shape:

```ts
interface WorkflowExecutionToolResult {
  runId: string;
  status: "paused" | "completed" | "failed" | "aborted";
  limits: WorkflowRunLimits;
  replayEligibility?: WorkflowReplayEligibility;
  result?: unknown; // present only on a completed run — the script's resolved value
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  logs?: string[];
  logTail?: WorkflowLogTail;               // paused/failed/aborted only
  authContext?: AuthErrorContext;           // auth_required pauses only
  checkpointContext?: CheckpointContext;   // checkpoint_required pauses only
  fallbacks?: WorkflowRunFallback[];       // model/modifier/continuation audit; absent when empty
  checkpointsTaken?: WorkflowCheckpointTaken[]; // resolved checkpoints; absent when empty
  resumeReport?: WorkflowResumeReport;     // resumeFromRunId correspondence; otherwise absent
  scriptSource: "inline" | "path";
  scriptUri: string;
}

interface WorkflowBackgroundAccepted {
  runId: string;
  status: "running";
  scriptSource: "inline" | "path";
  scriptUri: string;
  limits: WorkflowRunLimits;
  replayEligibility?: WorkflowReplayEligibility;
}

interface WorkflowAwaitMetadata {
  requestedMs: number;
  elapsedMs: number;
  returnedBecause: "terminal" | "timeout" | "immediate";
}

interface WorkflowRunAwaitResult<T = unknown> extends WorkflowRunStatus {
  wait: WorkflowAwaitMetadata;
  tokenUsage?: TokenUsage;
  outcome?: Omit<WorkflowExecutionToolResult<T>, "scriptSource">; // exactly when terminal
  scriptUri: string;
  lineage: WorkflowScriptLineageEntry[];
}

interface WorkflowScriptLineageEntry {
  runId: string;
  uri: string;
  available: boolean;
}

interface WorkflowStopResult extends WorkflowRunStatus {
  stopped: boolean;
  alreadyTerminal: boolean;
  scriptUri: string;
  lineage: WorkflowScriptLineageEntry[];
}

interface WorkflowInspectionToolResult extends WorkflowRunStatus {
  scriptUri: string;
  lineage: WorkflowScriptLineageEntry[];
}

type WorkflowToolResult =
  | WorkflowExecutionToolResult
  | WorkflowBackgroundAccepted
  | WorkflowInspectionToolResult
  | WorkflowRunAwaitResult
  | WorkflowStopResult;
```

`WorkflowRunFallback.kind` is `"model" | "modifier" | "continuation"`. Continuation entries carry
an optional flat detail of `{ outcome: "reattached", method: "resume" | "load" }` or
`{ outcome: "skipped", reason }`; the MCP output schema accepts either shape because the detail is
additive. Continuation is default-on manager behavior and adds no MCP input.

| Execution output field | Shape | Notes |
| --- | --- | --- |
| `fallbacks` | `{ callIndex, label, phase?, requestedSpec, resolvedModel?, backendId?, kind, message }[]` | Compatibility surface for non-resolution subsystems or third-party runners; model selection emits none; absent when empty. |
| `checkpointsTaken` | `{ callIndex, kind, decision, source }[]` | `source` is `"live"`, `"headless-default"`, `"journal-replay"`, or `"injected"`; paused checkpoints are omitted; absent when empty. |
| `resumeReport` | `WorkflowResumeReport` | Exact strategy/count/per-current-call correspondence for a `resumeFromRunId` execution; absent on ordinary runs. |
| `replayEligibility` | `WorkflowReplayEligibility` | Bounded resume plan/progress: strategy, predicted and observed prefixes/counts, first non-replay, source/current engine and input formats, and non-gating operational changes. |

`fallbacks`, `checkpointsTaken`, and the full `resumeReport` appear on foreground execution results
and terminal await `outcome` objects. They are persisted for cold await but are not copied onto the
bounded top-level status. `replayEligibility` is intentionally common: a resumed background
acknowledgement, foreground result, inspect, and both nonterminal and terminal await statuses expose
it, and terminal await `outcome` repeats the identical final value.

Resolved `limits` is a common field rather than an execution-detail field: it appears on foreground
results, background acknowledgements, inspect/await status, stop status, and terminal await
`outcome`. Records created by versions that did not persist limits may omit it.

`scriptSource` is an admission-time fact on the direct foreground result or background
acknowledgement. It is not persisted, so terminal await outcomes expose `scriptUri` but do not infer
an inline/path source in a later request or fresh server process.

`status` lets a host distinguish a `completed` run from a `paused` one (resumable via `resumeFromRunId`) without parsing logs. The tool result is flagged `isError` when `status` is `failed` or `aborted`. A `result` field is only present when `status === "completed"`.

An inspect response extends the shared `WorkflowRunStatus` with `scriptUri` and `lineage`:

```ts
interface WorkflowRunStatus {
  runId: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
  workflowName: string;
  phases: string[];
  currentPhase?: string;
  reason?: string;
  errorCode?: WorkflowErrorCode;
  limits?: WorkflowRunLimits;
  replayEligibility?: WorkflowReplayEligibility;
  logTail: WorkflowLogTail;
  calls: WorkflowRunCallStatus[];
  filter: { lastN: number; logLines: number; labelGlob?: string };
  truncation: WorkflowRunStatusTruncation;
}
```

Each call has its deterministic index, known agent/checkpoint attribution, a compact JSON
`resultPreview`, and redaction/truncation flags. Agent rows also expose resolved `timeoutMs` and a
terminal `errorCode`; timed-out and host-cancelled calls therefore remain visible as
`AGENT_TIMEOUT` and `AGENT_CANCELLED`. `limits`
contains `maxAgents`, `tokenBudget` (a persisted-shape compatibility field that is always `null`
for new runs), `concurrency`, `agentRetries`, and `agentTimeoutMs` as resolved for
this run (legacy persisted rows may omit it). Inspection never returns script, args, prompts,
histories, hashes, session IDs, cwd, checkpoint/auth details, or raw journal results. Sensitive
keys and credential-shaped strings are redacted before results are structurally compacted; every
text scalar and preview is at most 512 UTF-8 bytes. The inherited structured status is at most
24,576 bytes, retaining newest diagnostics by dropping oldest calls, logs, then phases. The full
oldest-to-newest script lineage is mandatory: if that lineage alone makes the augmented envelope
larger, requested diagnostics are retained and `truncation.maxStructuredBytes` rises to the actual
envelope size instead of claiming the 24,576-byte status limit. The accompanying text is formatted
from the bounded status and capped at 8,192 bytes.

An unknown, corrupt, or unreadable run returns `isError: true`, no `structuredContent`, and:

```text
No workflow run found for runId "<runId>" in this server's project-scoped run store.
```

Inspecting an existing failed/aborted run is still a successful read (`isError: false`); branch on
the payload `status`.

Await inherits that exact safe status projection. Its status fields retain the 24,576-byte bound,
redaction, compaction, filtering, and truncation counters, and its text is capped at 8,192 bytes.
Before terminal state, optional `tokenUsage` is the cumulative live work observed in this execution;
replayed calls add zero. At terminal state, `outcome` is the foreground-equivalent execution result:
the authored `result` and full `logs` remain raw and unbounded, and are not duplicated into text.
It omits the admission-only `scriptSource` while retaining `scriptUri`. Top-level and outcome token
usage are identical. Paused outcomes carry the existing non-secret
`authContext` or `checkpointContext` used for CLI-login/resume or checkpoint-reply handling. Result
observability (`fallbacks` and `checkpointsTaken`) stays inside the terminal `outcome`.

---

## Run resources

Every admitted manager run has one immutable, persistence-backed resource:

```text
workflow://runs/{runId}/script
```

`resources/read` returns the exact UTF-8 content snapshotted at admission with MIME type
`text/javascript`. This applies equally to inline and `scriptPath` delivery and works for any
persisted run in the project namespace, across MCP sessions and server processes. The original path
is not persisted or re-read. A run record deletion removes the resource; stopping a run does not.

The server advertises and implements `resources: { subscribe: true, listChanged: true }`.
Subscriptions are process-local. Script content never changes after admission, so
`notifications/resources/updated` never fires. `notifications/resources/list_changed` fires when a
run is admitted and when a run record is deleted; deletion also drops that URI's subscription.
Unsubscribing after that deletion (including a deletion race) is an idempotent empty success for a
URI this process knew existed. A malformed resource URI or a run ID that never existed is rejected.

`resources/list` is discovery convenience, not a complete index: it returns at most the **50 newest
runs by `startedAt` descending**. Resource-template completion uses that same bounded set. Direct
URI reads are the unbounded retrieval contract, so a known older run ID remains readable even when
it is absent from the listing.

Every journaling run also exposes its redacted append-only event stream:

```text
workflow://runs/{runId}/events
workflow://runs/{runId}/events?after={seq}&limit={1..1000}&streamId={streamId}
```

Subscribe to the canonical URI with `resources/subscribe`. Each append produces an advisory
`notifications/resources/updated` hint; read the JSON resource and page from your last cursor until
`hasMore` is false. The canonical read is a newest-100 tail. The document carries
`{ schemaVersion:1, runId, streamId, status, finalized, after, cursor, endCursor, hasMore, events }`.
`agentProgress` gives bounded content while a call is in flight, and `agentTranscript` upserts let a
client reduce assistant/tool history before settlement using
`(scope, callIndex, executionStartSeq, entryIndex)` plus greatest `revision`.

```ts
await client.subscribeResource({ uri: `workflow://runs/${runId}/events` });
const tail = JSON.parse(resourceText(await client.readResource({ uri: `workflow://runs/${runId}/events` })));
const pageUri = `workflow://runs/${runId}/events?after=${tail.cursor}&limit=1000&streamId=${tail.streamId}`;
```

Notifications are deliberately coalesced to one in-flight promise plus one dirty bit. They are not
the event queue: a slow/reconnected client catches up without gaps from the durable cursor. Only
projected records are served; new content strings are credential-redacted and capped at 512 UTF-8
bytes. Query URIs are readable but not subscribable. Integrity failures are explicit rather than
serving a silently incomplete transcript. See the [API contract](../../docs/api.md#mcp-live-events-resource).

Run/background results contain a `resource_link` for the newly admitted script. Inspect/await
results contain available links for the full resume lineage, oldest to newest, and duplicate that
history in structured `lineage`. A deleted revision remains listed as `available: false` without a
fabricated link. Lineage is reconstructed at read time from the engine's durable resume-source
pointer (`resumeSourceRunId`) and, for deleted ancestors, the engine's content-free lineage
tombstone; the MCP layer stores no script, args, or synthetic lineage metadata. Every URI is also
present in structured output.

Clients need MCP protocol revision **2025-06-18 or newer** to consume `resource_link` content
blocks. The structured URI fields remain available independently of link rendering. MCP defines no
client `resources` capability to gate these server-offered primitives.

---

## Run model

- **Foreground by default.** Omitted/false `background` preserves the synchronous behavior,
  request cancellation, progress notifications, live checkpoint elicitation, terminal `isError`,
  and result shape.
- **Detached admission.** `background:true` returns a running acknowledgement with `runId`,
  `status`, `scriptSource`, `scriptUri`, resolved `limits`, optional resume `replayEligibility`, and the script resource link
  after parsing, backend approval, one of four process-local slot reservations, lease acquisition,
  and successful persistence readback. It never awaits agent or script-body completion. A fifth
  active-or-starting request returns
  `Background workflow limit reached (4 active or starting runs). Await an existing run and retry.`
  There is no queue. Foreground, inspect, and await consume no slot; a durably stopped background
  run frees its slot immediately even if backend session wind-down is still pending.
- **Bounded await.** `action:"await"` waits only for terminal status. `waitMs:0` returns
  `immediate` while pending/running; a positive deadline returns `timeout` if still live; an
  already/newly terminal run returns `terminal`. Same-process awaits wake on the background promise;
  cold awaits poll persistence every 250 ms. Cancelling await clears its timer/poller and returns
  `Workflow await for runId "<runId>" was cancelled; the workflow was not cancelled.` without
  stopping, pausing, resuming, or leasing the run.
- **Bounded inspection.** `action: "inspect"` reads the manager's freshest in-memory snapshot,
  then its project-scoped persisted store. It never parses/runs a script, invokes an agent, asks
  for backend approval, sends progress, or elicits. A cold persisted `pending`/`running` row may
  take a short reconciliation lease and become `paused` / `interrupted` when its owner is dead;
  live or permission-protected owners and every other status remain unchanged. Run ID possession
  is the capability; UI `sessionId` listing filters do not apply.
- **Progress notifications.** When the host includes a `progressToken` with the call, the server streams `notifications/progress` as agents settle (it reports `settled / total` agents plus the current phase). With no `progressToken`, progress is a no-op.
  Background runs deliberately have no initiating progress channel; inspect/await are their progress
  surface.
- **Terminal status, not exceptions.** An ordinary pause/fail/abort does **not** throw — the run resolves to a `WorkflowRunResult` with `status` already stamped (`completed | paused | failed | aborted`) plus an optional `reason`/`resetHint`. Only a malformed script (which fails before a run exists) surfaces as an MCP tool error.
- **Immediate terminal diagnostics.** Paused, failed, and aborted execution results contain a
  redacted final-20 `logTail` even when empty. The text response renders `recent run log (last X of
  Y):` before resume guidance. The terminal text is capped at 12,288 UTF-8 bytes; completed results
  omit this extra tail and preserve the existing full `logs` field.
- **Explicit incremental resume.** A run can pause for a provider usage limit, missing authentication, or an opted-in durable checkpoint, and failed/completed/aborted terminal runs retain their completed journal too. Call `workflow` again with the current content via `script` or `scriptPath`, the desired `args`, and `resumeFromRunId` set to the prior `runId`. Completed calls match by exact path/hash or a unique hash+input fingerprint, so unchanged independent calls may replay after insertions while changed or ambiguous calls run live. Filesystem/world state, read/write behavior, safety annotations, nested workflows, and earlier live calls do not gate a match or clear later candidates. Identity hits cost zero current provider tokens. An empty ID is invalid and an unknown source is a pre-run `PERSISTENCE_ERROR`; neither silently starts fresh. Resume never silently falls back to stored content. The new request creates a new run ID and returns `replayEligibility`; its background acknowledgement predicts the prefix, while run/await/inspect text names the observed prefix, first non-replay, runtime/environment provenance changes, and operational changes. Terminal results also return the full `resumeReport`. Operational limits are resolved from the new request rather than inherited from the source, so pass `agentTimeoutMs`, `agentRetries`, and `concurrency` again when they matter. Those host knobs and per-call `timeoutMs`/`retries` enter neither identity nor the input fingerprint and may change without rejecting replay. Sources below input format 2 use the named `inputs-format-legacy` positional bridge; current-format crash snapshots use identity even without terminal-environment capture. ≤0.23 carried ancestor rows replay only while the ancestor record remains persisted. Workflow-engine, Node, V8, filesystem, and environment differences are diagnostics, never gates. Unsupported call-path/input/checkpoint formats remain named runtime mismatches.
- **Authoritative stop.** `action:"stop"` without `callIndex` is location-independent. A local live run uses its abort controller; a lease-free persisted run is cold-stopped under the lease; a predecessor-owned run gets an idempotent durable stop intent plus signed forwarding to that owner. Final success still requires persisted `aborted` plus a readable matching `stopped` event, then releases the lease and returns the final inspection projection. If the owner does not settle inside the bounded control wait, the successful nonterminal result carries `control:{state:"pending",operationId,requestedAt,owner?}`; retry stop, inspect, or await. Repeating stop on a terminal run is a successful no-op (`stopped:false`, `alreadyTerminal:true`). `forceOwner:true` explicitly authorizes terminating a superseded owner daemon after identity revalidation; it may interrupt sibling runs in that process and is never inferred from a timeout. Stop retains the journal, record, and script resource, so the kill-patch-resume loop remains stop, edit, then run with `scriptPath` plus `resumeFromRunId`.
- **Targeted agent cancellation.** Adding `callIndex` to `action:"stop"` synchronously routes to the live execution owner, selects one uniquely matching in-flight agent, settles it to `null` with `AGENT_CANCELLED`, and returns a live status. Siblings and the run continue, retries are bypassed, and `labelGlob` remains only an output filter. The cancelled call has a durable failed record but no journal result, so a later resume executes that occurrence live. Call cancellation is not stored as a cross-owner pending intent and is never fabricated after owner loss. `forceOwner` is forbidden with `callIndex`.
- **Checkpoints.** Foreground uses MCP elicitation when advertised. Legacy clients use the established
  server-to-client request; modern clients receive the equivalent SDK `input_required` round, with the
  paused run/checkpoint identity carried in integrity-protected request state and resumed through the
  same durable journal. Background never retains a live callback: omitted/`"default"` returns
  `default ?? true`, `"abort"` becomes failed
  with `WORKFLOW_ABORTED`, and `"pause"` becomes paused with `checkpoint_required` plus
  `outcome.checkpointContext`. Resume by starting a new run with `resumeFromRunId` and
  `checkpointReplies`; no particular `resumePolicy` is required, and the decision value becomes the
  checkpoint result verbatim. The engine guarantees journal/script replay integrity and reply
  targeting only—never that the filesystem, external state, agent semantics, or any other part of
  the world stayed fresh. After a prior correspondence miss runs live, injection requires the exact recorded
  checkpoint call site, identity, and inputs; a content-only match is not enough. An unapplied reply
  is explicit in `resumeReport` and the terminal text. To bind approval to changing content,
  interpolate that content into the checkpoint prompt so it participates in the hashed checkpoint
  identity and changed content re-asks.
- **Auth pauses.** Await reports `auth_required`/`AUTH_REQUIRED` and the non-secret
  `outcome.authContext`. Log the named backend CLI in out-of-band, then start a new run with
  `resumeFromRunId`; no MCP credential channel is added.
- **Retention and process lifetime.** Terminal results are reconstructed from project-scoped
  persistence and have no MCP TTL; repeated/cold await works until deletion, corruption, or store
  loss. Runs execute in the shared daemon, so a client disconnect, shim kill, host exit, or session
  eviction does **not** touch in-flight or background work — the daemon and its runs continue, and
  any later session of the same project can await/inspect/stop them. Work is lost only when the
  daemon itself dies (signals, `daemon stop`, crash, machine loss) — or, under `--in-process`,
  whenever that single client-owned process exits: there a client disconnect stops new admissions,
  disposes the ACP runner, force-kills a stalled backend tree at the deadline, and exits.
  Construction and
  cold inspect/list/await/stop/resume preflights reconcile a dead owner's durable
  `pending`/`running` state under its lease to `paused` with `pauseReason: "interrupted"`; completed
  journal entries remain resumable, while an in-flight unjournaled call can run again. Later
  persistence after admission is best effort.

---

## The `repl` tool

The interactive model-facing tool is **`repl`**: one persistent **QuickJS-in-WASM JavaScript VM per project**, exposed as a live REPL with **one verb — `eval`** (plus the out-of-band `interrupt`). Where `workflow` runs a *deterministic script to completion*, `repl` is the *interactive* orchestration plane: the client's own agent writes JavaScript that spawns subagents, and workspace state (bindings, pending subagent calls, raised checkpoints, logged values) **persists in the VM between tool calls** — a later `eval` sees the same bindings and awaits the same promises; nothing lives in the transcript. Subagents are ACP sessions run through [`acp-agents`](../acp-agents) — the same backends `workflow` drives — **6 concurrent per workspace**, with dispatches above the cap **queued** for the next free slot (never rejected).

The VM is capability-free: no filesystem, no network, no timers beyond the `sleep(ms)` guest helper. Its entire effect surface is the host bridge — `agent(modelSpec, task, opts?)`, `checkpoint()` / `checkpoint.answer()`, `console`, and the agent-handle methods `steer` / `queue` / `cancel`. Everything else this repo's workflow authors already know — `parallel`, `pipeline`, `verify`, `judgePanel`, `gate`, `retry`, `loopUntilDry` — is pure JavaScript layered on `agent()`, injected as the in-VM guest library. The full guest surface (and the engine internals) live in the engine package, [`@automatalabs/repl-engine`](../repl-engine#the-guest-library-and-the-bridge-phase-b).

`agent()` returns a persistent promise-handle. Assign the handle before awaiting it: `const a = agent("codex", "inspect the failure"); const first = await a`. `a.steer(text)` targets only the currently running turn. It never starts or queues another turn and resolves `"injected"`, `"idle"`, or `"unsupported"`; transport and protocol failures reject. `const q = a.queue(text)` creates a distinct FIFO turn on the same session. `q.id` is available immediately, `await q` returns that turn's answer, and `q.cancel()` or an out-of-band interrupt of `q.id` cancels that exact turn. Queueing works on every backend that can continue the session; steering requires the ACP server's raw steering advertisement. Do not write `const a = await agent(...)` when you intend to reuse the handle, because that stores only the answer. Steering while idle returns `"idle"` and loses the instruction by design; callers that require later work must use `queue()`.

```js
// First REPL eval:
const a = agent("codex", "Investigate the parser failure");

// A later REPL eval, only while agents() reports a's turn as running:
const steering = await a.steer("Focus on the parser state machine");

// After the founding answer settles, create explicit future work:
const first = await a;
const q1 = a.queue("Implement the fix");
const q2 = a.queue("Run the focused tests");
console.log(q1.id, q2.id, steering);
const fixed = await q1;
const tested = await q2;
```

Every result carries a machine-readable `structuredContent` — the exact same shape as the published `outputSchema` — alongside a human-readable text block. Guest output is **one newline-joined string** with no byte ceiling, so an agent can flood its own context by printing something enormous. This is accepted and documented — the Python REPL posture.

### Input parameters

The tool is an **action union** of exactly two actions. The input schema is **strict**: the MCP SDK validates the primitive fields, then the discriminator enforces each action's exact field set, and every key outside that set is rejected as MCP Invalid Params (`-32602`).

| Param | Type | Actions | Default | Notes |
| --- | --- | --- | --- | --- |
| `action` | `"eval" \| "interrupt"` | all | — | Required. Selects the operation. |
| `projectDir` | absolute path string | all | daemon: **required**; in-process: the server's own project | The workspace key — one VM per `projectDir`, resolved through the same validated, realpathed per-project context as the `workflow` tool. Workspace state survives MCP-session churn and daemon restarts. |
| `code` | string | `eval` | — | The JavaScript to evaluate. Top-level `await` is accepted; top-level `return` is a syntax error; `console` output is captured. An empty string is valid — the documented idempotent poll (see below). |
| `timeoutMs` | integer 0–120,000 | `eval` | `60000` | The soft bound the eval holds the call open for; values above 120 000 ms are rejected. |
| `id` | string | `interrupt` | — | The call id to cancel. Omitted: break the running eval. |

`projectDir` is required on the shared daemon for **both** actions. On a single-project (`--in-process`) server it defaults to that server's own project.

### The two actions

The examples below run against one workspace, `/work/acme`, in sequence — the state each call leaves is what the next one sees.

**`eval`** runs `code` in the workspace VM, then **holds the call open pumping settlements server-side** up to the soft bound. Exactly one of three shapes returns:

- **The finished shape** — everything the code waits on settled within the bound:

  ```json
  { "output": "researched the auth flow", "result": "three findings…" }
  ```

  `output` is ONE newline-joined string: console lines (one joined line per `console.*` call, args' reprs joined with a space), raised checkpoint lines (`checkpoint c9: <question>`), uncaught-error renderings (§4.6 attribution), and the one-line durability notices (§6). `result` is the completion value's repr, present whenever the code finished — including the literal string `"undefined"` when the value is the guest `undefined` (a `const`/`let`/`class` declaration or a bare `console.log(...)` statement).

- **The still-running shape** — the bound elapsed first; the eval *continues server-side*:

  ```json
  { "output": "…", "running": ["c1"] }
  ```

  `running` lists the in-flight call ids (the stable `c1, c2, …` vocabulary — what `interrupt` targets and `agents()` reports). **Any later eval drains what settled in the meantime**, and `eval` with `""` is the documented idempotent poll: a no-op script that only reports. A poll whose drained timed-out eval **settled** in the meantime reports that eval's completion repr as its own `result` (a poll with nothing new reports its own `"undefined"`). Re-sending the poll never re-executes work.

- **The thrown-eval shape** — the code threw (or was broken mid-run by `interrupt`): `output` carries the §4.6 error rendering (name + message, the guest stack's top frames with **line numbers in the submitted code**, and — for a subagent-call error — the call id and resolved backend), with **no `result`**:

  ```json
  { "output": "TypeError: x is not a function\n    at <repl>:1:10" }
  ```

```json
{ "action": "eval", "projectDir": "/work/acme",
  "code": "const research = agent('claude/sonnet', 'Summarize the auth flow in src/auth'); 'started'" }
```
```json
{ "output": "", "result": "started" }
```

The `agent(...)` call took id `c1` and keeps running server-side — start-and-don't-await is idiomatic: `await research` in a later eval picks the answer up.

**`interrupt`** is the one out-of-band verb (the only operation that cannot be expressed as code: a wedged VM cannot run the code that would unwedge it).

**With `id`** it cancels one subagent call — ACP `session/cancel` downward (a drained handle's session is re-attached lazily first). `interrupt.outcome` is `cancelled` (cancel sent to a running turn), `idle` (the session exists but has no turn to cancel), `failed` (the lazy re-attach could not reach the backend), or `none` (no live session for that id):

```json
{ "action": "interrupt", "projectDir": "/work/acme", "id": "c2" }
```
```json
{ "interrupt": { "outcome": "cancelled", "callId": "c2" } }
```

**Without `id`** it breaks the **running eval**. `outcome` is `targeted` when a break was armed against an in-flight eval (a suspended continuation, or a fully synchronous runaway the out-of-band relay broke mid-run), or `refused-idle` — the honest refusal — when nothing breakable is running:

```json
{ "action": "interrupt", "projectDir": "/work/acme" }
```
```json
{ "interrupt": { "outcome": "refused-idle" } }
```

A missing project context (single-project mode with no adopted default) returns the **error variant** — `{ "error": "…" }` flagged `isError: true`.

### Output

Every result carries the machine-readable `structuredContent` below — a `oneOf` over the five variants, published as the tool's `outputSchema` — alongside the human text (the same output string, then a `result:` line or a `running:` line, then the interrupt outcome). The shapes are what the tool **emits at runtime**, and `result`/`running` are **mutually exclusive**: an eval result is exactly one of the finished, still-running, or thrown-eval variants.

```ts
type ReplToolOutput =
  | ReplEvalResult | ReplEvalStillRunning | ReplEvalThrown
  | ReplInterruptResult | ReplErrorResult;

interface ReplEvalResult {          // the code finished within the soft bound
  output: string;                   // ONE newline-joined string: console lines (one per call),
                                    //   checkpoint lines, error renderings, §6 notices
  result: string;                   // the completion value's §4.4 repr (a guest undefined renders "undefined")
}

interface ReplEvalStillRunning {    // the bound elapsed first; the eval continues server-side
  output: string;
  running: string[];                // the in-flight call ids (c1, c2, … — what interrupt targets)
}

interface ReplEvalThrown {          // the code threw (or was broken mid-run)
  output: string;                   // the §4.6 error rendering — no completion value exists
}

interface ReplInterruptResult {
  interrupt: {
    outcome: "targeted" | "refused-idle" | "cancelled" | "idle" | "failed" | "none";
    callId?: string;                // present on the id path
  };
}

interface ReplErrorResult {         // isError: true — a missing project context
  error: string;
}
```

### The guest API, printing, and checkpoints

`agent(modelSpec, task, opts?)` spawns an ACP subagent on a registry built-in (currently **Claude, Codex, OpenCode, and pi**) or a registered custom agent. The spec is `"backend/model"` — a bare `"backend"` runs its default model — and an unknown backend segment rejects the call **synchronously**, naming the segment and enumerating the known backends (a spec with no known-backend prefix is an error, never a silent route to the default backend). The option keys are `schema` (a structured-output JSON schema, validated per call), `cwd`, `configOptions` (backend-specific knobs, validated at admission — a typo'd key fails in milliseconds naming the valid alternatives), and `mode`. Use `mode` only when the selected `workflow` `action:"config"` entry's `modes.availableModes` explicitly lists its exact id; `modes:null` means omit it, and never invent `"default"`. For example: `agent("pi/<advertised-provider>/<advertised-model-id>", "research X and report the top 3 findings", { cwd: "/repo" })`. An unknown option key rejects synchronously too. Retain the promise-handle before awaiting it. `steer` is transient active-turn control only; `queue` creates a durable, independently awaitable FIFO turn on the same session; `cancel` targets the current public turn, while a queued handle's `cancel` targets that exact queued turn.

`checkpoint(question)` parks a promise for a human answer **inside the VM**. The raised checkpoint surfaces as an **output line** — `checkpoint c9: <question>` — and a later eval's `checkpoint.answer("c9", value)` resolves it. No side protocol: the question rides the ordinary output string and the answer rides the ordinary `eval` input.

Printing follows Python-ish conventions, **with no byte ceilings anywhere** (§4.4): strings passed **directly** to `console.log` — and a string **completion value** — print **whole** (they are the output the orchestrator asked for); objects/arrays render to **depth 2**, deeper levels as `{…}` / `[…]`; collections render their first **20 entries** per level, then `… +N more`; **nested** strings render head-limited at **200 chars**. Everything deeper/longer is reached by evaluating a narrower expression — the values are alive in the VM; slicing is the API. `_` holds the previous eval's completion value, IPython-style — bindings are the memory.

Introspection is in-band guest data: `workspace()` returns `{ bindings: [{ name, type, sizeBytes, provenance, task, callId?, status? }], inFlight, checkpoints, diagnostics }` (with `diagnostics` carrying the §6 demotions — the last reconcile summary, a retained drain error, `childrenClosed`); `agents()` lists `{ callId, modelSpec, task, state, supportsSteering, queuedTurns }`, including each unsettled queued turn under its own call ID; `reset()` tears the workspace down after the current eval completes. Subagent output passes through **unfiltered** — backend harness noise (e.g. codex's "Warning: Skill descriptions were shortened…") is forwarded verbatim, never curated away; expect it when the backend prints it.

### The workspace project model and durability

Workspaces follow the daemon's project model exactly: **one VM per `projectDir`**, addressed by the same required-in-daemon-mode argument the `workflow` tool uses. MCP-session churn — client restarts, transport eviction — never touches the workspace; the daemon's lifetime plus disk snapshots carry it across everything else.

- **Snapshots are implicit and boundary-durable.** There is no snapshot action. The workspace is written to the daemon's per-project `repl/` store (beside the workflow state, under the same project key) at **every state-changing boundary** — after each eval, and after each settlement drain that changed VM state — as a self-identifying envelope (the `quickjs.wasm` binary's SHA-256 + a format version + gzip compression). Because durability is boundary-based, a daemon kill loses at most the *in-flight* operation that had not yet reached a boundary; every committed boundary — and, through the append-only call store, every recorded subagent result — is durable and reconciled on the next touch.
- **Restore is lazy, on first touch.** There is no daemon-startup restore sweep. The VM is restored the first time a `repl` call addresses the project: host callbacks are re-registered by name, and every outstanding subagent call is reconciled three ways — **settled from the store** if it completed while the daemon was down, **re-attached** to its still-running ACP session (all four built-in backends advertise `loadSession`), or **re-issued** if it was lost. The reconcile summary demotes to `workspace().diagnostics.reconcile`; the next eval's output carries a one-line notice only when calls were **lost** (`failedLost` non-empty) — losses are never silent.
- **A refused snapshot AUTO-RESETS.** A snapshot that cannot be restored with the running engine — corrupt, a format upgrade, or a `quickjs.wasm` hash mismatch after a package bump — no longer poisons every call until a manual reset. The workspace **auto-resets and starts fresh**, and the refused snapshot file is **renamed aside** (`.refused-<timestamp>`, never deleted — auto-reset must not be silent data destruction). The next eval's `output` **leads with a loud one-line notice** naming the file and the reason. The daemon never crash-loops and never silently discards the data.
- **Subagent processes are client-presence keyed.** Child ACP processes stay warm while any MCP client is connected to the project. On last-client disconnect the workspace **drains**: in-flight subagent turns run to completion (each settlement boundary snapshots, so "close the laptop while two researchers run" ends with the findings durable), bounded by the daemon's session-eviction TTL (`AGENTPRISM_SESSION_TTL_MS`, default 2 h) — a turn that overruns the bound is force-settled as the recoverable `AGENT_CANCELLED` — then idle children close (`childrenClosed: true`). Pending queue items remain durable. A client that reconnects **mid-drain aborts it**, keeping the children warm. On the next connect the workspace is live (or restores), and the next eligible queue head re-attaches its recorded subagent session lazily. A drain that fails (a snapshot-flush error) is never silent: the failure is retained under `workspace().diagnostics.drainError`, the next eval's output carries the one-line loss notice (the failed drain **lost state** — the workspace was not persisted), and the next disconnect retries the drain.

**Interrupting a running eval is not universal.** An eval that **yields** (suspends on a subagent call or checkpoint) is broken by the QuickJS interrupt handler the next time its continuation runs. A **fully synchronous** runaway wedges the daemon's single thread, so the `interrupt` request cannot even be processed mid-run; it is broken **out of band** by a worker-thread relay that the stdio shim (or the `--in-process` relay transport) fires *before* forwarding the call — **a host connected directly over HTTP has no such relay**, and falls back to the per-eval wall-clock deadline. That deadline (`AGENTPRISM_REPL_EVAL_TIMEOUT_MS`, default 30 000 ms) is the last-resort bound in every mode. The no-id `interrupt` therefore honestly reports `refused-idle` for the cases it cannot break (a never-settling local promise, an older restored guest without the continuation-lease seam).

---

## The `author-workflow` prompt

The server also exposes one [MCP prompt](https://modelcontextprotocol.io/docs/concepts/prompts): **`author-workflow`**. Prompts are a *user-controlled* primitive, so this adds no additional tool.

The prompt is intentionally compact: it frames the optional **`task`**, directs the assistant to `docs` topic `workflow/quickstart` and only the related topics needed, then points it at protocol-native config discovery and automatic run validation. It no longer injects the complete optional skill or every API topic into one context window. Hosts without prompt support lose no authoring information because the model-facing `docs` tool carries the complete selective reference.

---

## Backends & auth

Each `agent()` call is dispatched to an **ACP agent server** chosen by the call's effective `model`/`tier`. An explicitly present `AGENTPRISM_DEFAULT_BACKEND` is the fallback. When it is truly unset, the MCP server runs zero-token session/config probes only for workflows that reach a model-less call, excludes definite probe failures and explicitly empty built-in model catalogs, prefers positive session-open readiness evidence (Codex authorization or Pi's credential-filtered catalog), then falls back to the first session-ready backend whose prompt authentication remains unknown. The selected backend is pinned into validation, call identity, execution, and resume; a later `AUTH_REQUIRED` pauses rather than switching providers. The four built-in backends are:

- **Claude** → `@agentclientprotocol/claude-agent-acp` (the Claude Agent SDK over ACP). By default the server resolves that package's bin and runs it under the current Node; if it can't be resolved, it falls back to `npx -y @agentclientprotocol/claude-agent-acp`.
- **Codex** → `@automatalabs/codex-acp` (a published fork that bakes in the structured-output patch). By default the server resolves that package and runs it under the current Node.
- **OpenCode** → `opencode acp`. `opencode-ai` is intentionally not bundled; install it in the host environment or put `opencode` on `PATH`.
- **pi** → bundled `@automatalabs/pi-acp`. Use `pi/<provider>/<model-id>` for explicit models, or backend-only `pi` for pi's configured default.

Beyond the built-ins, **any ACP agent** can be registered as a named backend via `AGENTPRISM_BACKENDS` (see the table below) and routed to with `agent(p, { model: "<name>" })` — or `"<name>/<inner-model>"` to send `<inner-model>` verbatim as its model config value. Scripts can pass arbitrary session/turn `_meta` to such agents with `agent(p, { meta, promptMeta })`.

A workflow script can also **declare its own backends** in its meta block (`meta.backends: { <name>: { command, args?, env?, sessionMeta? } }`). Because these spawn commands on this machine, they require approval before the run starts: if the connected client supports MCP **elicitation**, the user is asked to approve each unique spawn config; otherwise the call fails with an informative error naming the `AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1` env opt-in. Approvals remain session-sticky on legacy connections and are integrity-bound to the active multi-round-trip call on stateless modern connections. Host-registered names (`AGENTPRISM_BACKENDS`) always win over script declarations of the same name.

**Authentication belongs to the agents, not this server.** Claude, Codex, and OpenCode use their normal CLI credentials; pi uses the selected provider's environment key or `~/.pi/agent/auth.json`. There is no separate auth state for an MCP host to inspect or manage. In particular, a successful no-prompt config probe means session/config discovery succeeded, not that ACP universally proved first-prompt authentication; ambient CLI credentials are not observable through generic runner bookkeeping, so automatic default selection reports unknown readiness honestly where necessary. If a run genuinely hits expired/missing credentials, the backend returns ACP `AUTH_REQUIRED` and the managed run **pauses** with `reason: "auth_required"` plus a non-secret `authContext` naming the backend and advertised methods: configure that credential out-of-band, then call `workflow` again with the original script and `resumeFromRunId` — the run continues from its journal on the same pinned backend. Programmatic auth flows (env-var/gateway credential injection, LLM provider routing) live in the [`@automatalabs/workflows`](../workflows) SDK runner APIs for hosts that embed the engine directly.

---

## Configuration (environment variables)

All settings are read from the environment of the `agentprism-workflow` process (and inherited by the spawned agent servers).

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTPRISM_DEFAULT_BACKEND` | unset | Explicit backend used when an `agent()` call's model/tier does not pin a provider: `claude`, `codex`, `opencode`, `pi`, or a registered custom backend name. When absent, MCP auto-selects a project default as described above. If explicitly present but empty/unknown, historical runner behavior falls back to Claude. |
| `AGENTPRISM_BACKENDS` | — | Custom ACP backends as a JSON object: `{"<name>": {"command": "…", "args": […], "env": {…}, "sessionMeta": {…}}}`. Registered names route `model`/`tier` specs **before** built-in heuristics; `claude`/`codex`/`opencode`/`pi` are reserved. |
| `AGENTPRISM_ALLOW_SCRIPT_BACKENDS` | — | `1`/`true` approves **script-declared** `meta.backends` headlessly. Only needed for clients without elicitation support — eliciting clients are prompted per spawn config instead. Understand the risk: this lets any workflow script spawn arbitrary commands. |
| `AGENTPRISM_ACP_INIT_TIMEOUT_MS` | `60000` | Deadline for a backend's one-time ACP `initialize` handshake; a command that is not an ACP server fails fast with a clear error instead of hanging. |
| `AGENTPRISM_ACP_POOL_SIZE` | `1` | Long-lived ACP server processes to keep **per backend**. Each pooled process multiplexes many concurrent sessions; raise it to spread concurrent load across processes. Clamped to ≥ 1. |
| `AGENTPRISM_CLAUDE_ACP_CMD` | — | Override the command used to launch the Claude ACP server. When set, the default resolution/`npx` fallback is bypassed. |
| `AGENTPRISM_CLAUDE_ACP_ARGS` | — | Whitespace-separated argv passed to `AGENTPRISM_CLAUDE_ACP_CMD`. |
| `AGENTPRISM_CODEX_ACP_CMD` | — | Override the command used to launch the Codex ACP server. When set, the default bin resolution is bypassed. |
| `AGENTPRISM_CODEX_ACP_ARGS` | — | Whitespace-separated argv passed to `AGENTPRISM_CODEX_ACP_CMD`. |
| `AGENTPRISM_CODEX_ACP_BIN` | resolved `@automatalabs/codex-acp` main | Override the resolved Codex ACP bin path (used only when `AGENTPRISM_CODEX_ACP_CMD` is **not** set). |
| `AGENTPRISM_OPENCODE_ACP_CMD` | resolved `opencode-ai` bin or `opencode` | Override the command used to launch OpenCode ACP. |
| `AGENTPRISM_OPENCODE_ACP_ARGS` | — | Whitespace-separated argv passed to `AGENTPRISM_OPENCODE_ACP_CMD`. The automatic launcher uses `opencode acp`; a command override receives only the args supplied here. |
| `AGENTPRISM_PI_ACP_CMD` | bundled `@automatalabs/pi-acp` | Override the command used to launch pi ACP. |
| `AGENTPRISM_PI_ACP_ARGS` | — | Whitespace-separated argv passed only when `AGENTPRISM_PI_ACP_CMD` is set. |
| `AGENTPRISM_PERSISTENCE_ROOT` | `~/.agentprism/workflows` | Absolute root for persisted run journals and logs used by resume. |
| `AGENTPRISM_REPL_EVAL_TIMEOUT_MS` | `30000` | Per-eval wall-clock deadline (ms) for a `repl` workspace — the last-resort bound on a runaway eval the interrupt handler and out-of-band relay can't otherwise reach. Used only when it parses to an integer ≥ 1; any invalid, zero, or negative value falls back to the 30 000 ms default. There is no upper bound. |

---

## Programmatic use

For embedding the orchestrator in your own program, use **[`@automatalabs/workflows`](../workflows)** — it is the canonical programmatic SDK:

```ts
import { runDynamicWorkflow } from "@automatalabs/workflows";

const run = await runDynamicWorkflow(
  `export const meta = { name: "demo", description: "one agent" };
   const r = await agent("Say hello in one word.");
   return r;`,
  { exec: { concurrency: 4 } },
);

console.log(run.status, run.result);
```

This MCP-server package does export its own building blocks, for hosts that want to mount the same tools on a transport they control rather than the default stdio one. `createWorkflowServer(runner)` registers the `docs`, `workflow`, and `repl` tools (plus the app-only `workflow-events` poller and the `author-workflow` prompt); the `repl` workspaces default to a private client-presence ledger and a server-owned eval-break channel. `CreateWorkflowServerOptions` exposes `protocolEra` for SDK serving factories, `requestStateCodec` for deployments that need a durable/shared modern multi-round-trip key, plus `replRunner`, `replPresence`, `replClientId`, `replEvalBreakChannel`, and `replDrainBoundMs` for host lifecycle integration (the daemon passes shared instances):

```ts
import { createWorkflowServer } from "@automatalabs/mcp-server";
import { createAcpRunner } from "@automatalabs/workflows";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const runner = createAcpRunner();
await serveStdio(({ era }) => createWorkflowServer(runner, { protocolEra: era }));
```

> **Use an SDK serving entry for dual-era hosting.** A hand-constructed server connected directly to `StdioServerTransport` intentionally serves only the legacy era. `serveStdio(factory)` performs the official modern/legacy arbitration while registering each tool once through the factory. The bundled `main()` additionally supplies its internal relay transport, whose worker-thread stdin reader can fire the out-of-band eval-break for a fully synchronous runaway; a vanilla stdio transport remains bounded by the per-eval deadline for that case.

The REPL-specific exports are `replToolInputShape` / `replToolOutputShape` (the tool's Zod input/output schemas), the `ReplToolOptions` type, `createReplProjectState` / `ensureReplWorkspace` / `disposeReplProjectState` / `resetReplProjectState` and the `ReplProjectState` type (per-project workspace state), and `ReplPresenceLedger` (the client-presence drain). Other workflow-side exports include `workflowToolInputShape` / `parseWorkflowToolInput` /
`clampWorkflowInput` (primitive schema, action discriminator, execution clamp),
`CreateWorkflowServerOptions`,
`WorkflowExecuteToolInput`, `WorkflowInspectToolInput`, `WorkflowAwaitToolInput`, `WorkflowStopToolInput`,
`WorkflowExecutionToolResult`, `WorkflowBackgroundAccepted`, `WorkflowAwaitMetadata`,
`WorkflowInspectionToolResult`, `WorkflowRunAwaitResult`, `WorkflowStopResult`,
`WorkflowScriptLineageEntry`, `WorkflowToolResult`, `MAX_BACKGROUND_RUNS`,
`workflowToolOutputShape` / `toWorkflowToolResult`,
`createProgressReporter`, `installMcpServerLifecycle` / `SHUTDOWN_DEADLINE_MS`, and lifecycle
types `McpServerLifecycle`, `McpServerLifecycleOptions`, `McpServerShutdownReason`, and
`WorkflowServerControl`, plus a `main()` that runs the default stdio server. For anything beyond
hosting these tools, prefer `@automatalabs/workflows`.

---

## License

Apache-2.0
