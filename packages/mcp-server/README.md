# @automatalabs/mcp-server

An **[MCP](https://modelcontextprotocol.io) server** for foreground/background execution, bounded await, safe inspection, and in-place stopping of dynamic multi-agent workflows. Execution lives in a shared per-user **local daemon** (spec-compliant Streamable HTTP on loopback) so runs survive MCP clients killing their server processes; hosts connect through the bundled **stdio shim** (the default bin, zero config change) or directly over HTTP — see [The workflow daemon](#the-workflow-daemon). Its model-facing tool surface is **two tools**: **`workflow`**, with run/resume/inspect/await/stop branches, and **`repl`** — a persistent QuickJS-in-WASM JavaScript REPL for live, stateful subagent orchestration (see [The `repl` tool](#the-repl-tool)) — plus an app-only `workflow-events` poller that feeds the [MCP Apps run monitor](#run-monitor-mcp-apps) and never enters the model's tool loop. Scripts may be supplied inline or by absolute server-side path, and every admitted script is also exposed as an immutable MCP resource. Agent backends authenticate from their own credential sources (`claude /login`, `codex login`, `opencode auth login`, provider API keys, or pi's `~/.pi/agent/auth.json`), so there is nothing auth-shaped for a host to manage here. A run that genuinely hits expired/missing credentials pauses with `authContext` and resumes (`resumeFromRunId`) after the backend credentials are configured. Auth and provider *management* APIs live in the [`@automatalabs/workflows`](../workflows) SDK for embedding hosts.

This package is a **thin MCP adapter**. The `workflow` tool's real work — parsing the workflow script, running the deterministic engine, fanning `agent()` calls out to real coding agents over [ACP](https://agentclientprotocol.com), journaling, resume, token budgets — lives in **[`@automatalabs/workflows`](../workflows)**; the `repl` tool's real work — the persistent QuickJS-in-WASM VM, the subagent broker, the CDP-style previewer, and the enveloped-snapshot store — lives in **[`@automatalabs/repl-engine`](../repl-engine)**. The MCP server is the *composition root*: it builds the ACP-backed agent runner, injects it into the workflow engine, registers the `workflow` tool over a per-project `WorkflowManager` and the `repl` tool over a per-project QuickJS VM, and serves them over stdin/stdout.

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
[MCP Apps extension](https://modelcontextprotocol.io/extensions/apps/overview), and the server
advertises `io.modelcontextprotocol/ui` in its capabilities. Hosts that render MCP Apps show a
live run-monitor panel for `workflow` calls — a phase/agent graph with per-node log drill-in
(including expandable per-tool results), live token/cost totals, and a Stop control. The panel
keeps itself current by polling the app-only `workflow-events` tool, so no model tokens are
spent while it is visible; hosts without MCP Apps support ignore the UI metadata and get the
same text/structured output as always.

<p align="center">
  <img src="https://raw.githubusercontent.com/agentprism/agentprism-workflows/main/docs/assets/run-monitor-graph.png" alt="Run monitor: live phase/agent graph of a workflow run" />
  <img src="https://raw.githubusercontent.com/agentprism/agentprism-workflows/main/docs/assets/run-monitor-log.png" alt="Run monitor: per-agent log drill-in with an expanded tool result" />
</p>

To try it locally against the [ext-apps](https://github.com/modelcontextprotocol/ext-apps)
reference host, run `node scripts/dev-app-host.mjs` from this package (see the script header
for the basic-host setup; `AGENTPRISM_DEV_CWD=<project dir>` serves an existing run store).

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

- **Discovery**: the daemon records `{pid, port, url, version}` in `~/.agentprism/workflows/daemon.json` (mode 0600); shims verify liveness via pid + `/healthz` and never dial a port blind. Concurrent shims race a spawn lock, so a cold start produces exactly one daemon. Logs land in `~/.agentprism/workflows/logs/daemon.log`.
- **Port**: default `29888` (`AGENTPRISM_DAEMON_PORT` / `--port`). If a foreign process holds the port, the daemon falls back to an ephemeral port — discovery still works, only hardcoded client URLs need the actual port from `daemon status`.
- **Sessions and projects**: sessions are project-agnostic — every `run` call names its project via the **required `projectDir` argument** (absolute path), so one registration serves any number of projects concurrently. `inspect`/`await`/`stop` take only a runId and locate its project store automatically (live contexts first, then the on-disk store manifests). Each project gets its own `WorkflowManager` — same per-project run stores as before — while all projects share one ACP backend pool. Background runs are visible from every session, and `MAX_BACKGROUND_RUNS` caps runs **per project** rather than per client process. The `repl` tool's workspace is the same shape of per-project context: **one persistent QuickJS VM per `projectDir`**, restored lazily from the per-project `repl/` store on first touch, persisted at every state-changing boundary, and drained when the project's last MCP client disconnects (both tools share one client-presence ledger, so a `workflow`-only client keeps the workspace's children warm too). See [The `repl` tool](#the-repl-tool).
- **Lifetime**: only signals, `daemon stop`, or sustained idleness end the daemon (default: 15 min with zero sessions and zero active runs, `AGENTPRISM_DAEMON_IDLE_TTL_MS`, `0` disables). Client disconnects never cancel runs — per the Streamable HTTP spec, cancellation is only an explicit MCP cancellation. Dead-client sessions (no open connections, no traffic for `AGENTPRISM_SESSION_TTL_MS`, default 2 h) are evicted without touching their runs; the shim transparently re-initializes on the spec's 404, so eviction and daemon restarts are invisible to live clients.
- **Security**: the daemon binds `127.0.0.1` only, validates the `Host` header, and enforces the spec's `Origin` validation (403 for non-loopback origins; extend with `AGENTPRISM_DAEMON_ALLOWED_ORIGINS`). There is no authentication: any local process/user on the machine can reach it — the standard localhost-dev-server trade-off.
- **Env is captured at daemon start**: the ACP backend registry (`AGENTPRISM_BACKENDS`, `AGENTPRISM_DEFAULT_BACKEND`, …) is resolved once by the daemon. A shim whose env fingerprint differs restarts an **idle** daemon automatically and warns (but still connects) when the daemon is busy; `--in-process` is the escape hatch when you need per-client env.

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

The daemon must be running before an HTTP-only host connects (`daemon start`); any stdio shim usage also keeps it alive. The transport implements the full 2025-11-25 Streamable HTTP contract: per-session `Mcp-Session-Id`, SSE with priming events and `Last-Event-ID` resumability (dropped connections replay missed messages, including tool responses), `DELETE` session termination, and 404-driven re-initialize.

---

## Register it in an MCP host

Add the server to your host's `mcpServers` config. The host spawns the bin and talks MCP to it over stdio:

```json
{
  "mcpServers": {
    "agentprism-workflow": {
      "command": "agentprism-workflow",
      "args": [],
      "env": {
        "AGENTPRISM_DEFAULT_BACKEND": "claude"
      }
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
      "args": ["-y", "@automatalabs/mcp-server"],
      "env": {
        "AGENTPRISM_DEFAULT_BACKEND": "claude"
      }
    }
  }
}
```

`env` here is inherited by the server process **and** by every agent subprocess it spawns (see [Backends & auth](#backends--auth)), so it is where you put `AGENTPRISM_*` settings and any credentials the agent CLIs need. Set `AGENTPRISM_DEFAULT_BACKEND` to `claude` (the default), `codex`, `opencode`, `pi`, or a registered custom backend name to choose the backend used when an `agent()` call's `model`/`tier` does not pin a provider.

After your host reloads, the `workflow` and `repl` tools appear in its tool list.

---

## The `workflow` tool

### Input parameters

The tool uses a run/inspect/await/stop union. Execution resource maxima remain runtime clamps;
inspection/await limits are contract bounds and invalid values are MCP Invalid Params (`-32602`).

| Param | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `action` | `"run" \| "inspect" \| "await" \| "stop"` | no | run | Omit for execution. `"inspect"` reads immediately; `"await"` waits only for terminal lifecycle state; `"stop"` aborts the run unless `callIndex` selects one in-flight agent. |
| `script` | string (non-empty) | run XOR | — | Raw JavaScript workflow script (no Markdown fences). Exactly one of `script`/`scriptPath` is required for run. The first statement **must** be `export const meta = { name, description, phases? }`. Forbidden for inspect/await/stop. |
| `scriptPath` | absolute path string | run XOR | — | Absolute path on the **server's filesystem**. Read once as UTF-8 before admission; the content is snapshotted, and later file edits do not change that run. Relative paths and unreadable files are Invalid Params. Forbidden for inspect/await/stop. |
| `projectDir` | absolute path string | run (daemon) | in-process: the server's own project | Absolute project directory: selects the project-scoped run store (where the runId, journal, and resume state live) and the run's default execution cwd. **Required for run on the shared workflow daemon** — one registration serves every project. Forbidden for inspect/await/stop: a runId locates its project store automatically. |
| `background` | boolean | run only | `false` | Acknowledge after admission and execute in this server process. |
| `args` | any JSON value | no | — | Optional value exposed to the script as the global `args`. |
| `maxAgents` | integer > 0 | no | `1000` | Max agents allowed in this run (engine cap `MAX_AGENTS_PER_RUN`). Values below 1 are clamped up to 1. |
| `concurrency` | integer > 0 | no | engine default | Max concurrent agents. **Clamped to 16** (the runtime max) by the engine — never rejected. |
| `agentRetries` | integer ≥ 0 | no | engine default | Retry attempts for recoverable agent failures. **Clamped to 3** (the runtime max). |
| `agentTimeoutMs` | integer > 0 \| null | no | none | Total wall-clock ceiling in ms for each attempt. A per-call `timeoutMs` may tighten but cannot escape a finite ceiling. Omit/pass `null` for no host ceiling. Every retry re-arms the clock. |
| `tokenBudget` | integer > 0 \| null | no | none | Hard total-token budget for the whole run. Omit or pass `null` for no limit. |
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

Example call arguments:

```json
{
  "script": "export const meta = { name: 'review', description: 'review a diff' };\nconst r = await agent('Review this diff and summarize risks:\\n' + args.diff);\nreturn r;",
  "args": { "diff": "diff --git a/x b/x\n+console.log(1)" },
  "concurrency": 4,
  "tokenBudget": 200000
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
  "concurrency": 4,
  "tokenBudget": 200000
}
```

```json
{
  "runId": "mabc1234-k9x2pq",
  "status": "running",
  "limits": {
    "maxAgents": 1000,
    "tokenBudget": 200000,
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

The tool returns both machine-readable `structuredContent` and a human-readable text block. The structured shape pins the durable core of the engine's run result:

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
contains `maxAgents`, `tokenBudget`, `concurrency`, `agentRetries`, and `agentTimeoutMs` as resolved
for this run (legacy persisted rows may omit it). Inspection never returns script, args, prompts,
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

Await inherits that exact safe status projection. Its status fields retain the 24,576-byte budget,
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
- **Explicit incremental resume.** A run can pause for a provider usage limit, missing authentication, or an opted-in durable checkpoint, and failed/completed/aborted terminal runs retain their completed journal too. Call `workflow` again with the current content via `script` or `scriptPath`, the desired `args`, and `resumeFromRunId` set to the prior `runId`. Completed calls match by exact path/hash or a unique hash+input fingerprint, so unchanged independent calls may replay after insertions while changed or ambiguous calls run live. Filesystem/world state, read/write behavior, safety annotations, nested workflows, and earlier live calls do not gate a match or clear later candidates. Identity hits preserve logical budget control flow but cost zero current provider tokens. An empty ID is invalid and an unknown source is a pre-run `PERSISTENCE_ERROR`; neither silently starts fresh. Resume never silently falls back to stored content. The new request creates a new run ID and returns `replayEligibility`; its background acknowledgement predicts the prefix, while run/await/inspect text names the observed prefix, first non-replay, runtime/environment provenance changes, and operational changes. Terminal results also return the full `resumeReport`. Operational limits are resolved from the new request rather than inherited from the source, so pass `agentTimeoutMs`, `agentRetries`, and `concurrency` again when they matter. Those host knobs and per-call `timeoutMs`/`retries` enter neither identity nor the input fingerprint and may change without rejecting replay. Sources below input format 2 use the named `inputs-format-legacy` positional bridge; current-format crash snapshots use identity even without terminal-environment capture. ≤0.23 carried ancestor rows replay only while the ancestor record remains persisted. Workflow-engine, Node, V8, filesystem, and environment differences are diagnostics, never gates. Unsupported call-path/input/checkpoint formats remain named runtime mismatches.
- **Authoritative stop.** `action:"stop"` without `callIndex` acts on `running` and `paused` runs live in this server
  process, cancels their agent/checkpoint work, persists `aborted`, appends the durable `stopped`
  event, releases the lease, and returns the final inspection projection inline. Resume is safe
  immediately and an additional await adds nothing. Only backend agent-session wind-down can remain;
  use inspect's per-agent states if that cleanup appears hung. Repeating stop on a terminal run is a
  successful no-op (`stopped:false`, `alreadyTerminal:true`). Unknown runs are not found; a cold
  dead-owner `pending`/`running` record is first reconciled to `paused` / `interrupted`, and any cold
  paused record has nothing live to stop in this process and should be resumed.
  Stop retains the journal, record, and script resource, so the kill-patch-resume loop is: stop,
  edit the file, then call run with `scriptPath` plus `resumeFromRunId`. Missing terminal-environment
  capture does not veto replay; the `resumeReport` shows which completed calls corresponded.
- **Targeted agent cancellation.** Adding `callIndex` to `action:"stop"` selects one uniquely
  matching in-flight agent, settles it to `null` with `AGENT_CANCELLED`, and returns a live status.
  Siblings and the run continue, retries are bypassed, and `labelGlob` remains only an output filter.
  The cancelled call has a durable failed record but no journal result, so a later resume executes
  that occurrence live. The engine-owned latch settles even an abort-ignoring runner while the ACP
  layer closes/recycles a session that ignores cancellation.
- **Checkpoints.** Foreground uses MCP elicitation when advertised. Background never retains that
  request-scoped callback: omitted/`"default"` returns `default ?? true`, `"abort"` becomes failed
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

The second model-facing tool is **`repl`**: one persistent **QuickJS-in-WASM JavaScript VM per project**, exposed as a live REPL. Where `workflow` runs a *deterministic script to completion*, `repl` is the *interactive* orchestration plane — the client's own agent writes JavaScript that spawns subagents, and workspace state (variables, pending subagent calls, raised checkpoints, logged values) **persists in the VM between tool calls**. A later `eval` in the same workspace sees the same bindings and awaits the same promises; nothing lives in the transcript. Subagents are ACP sessions run through [`acp-agents`](../acp-agents) — the same backends `workflow` drives — capped at **6 concurrent per workspace**.

The VM is capability-free: no filesystem, no network, no timers beyond the job drain. Its entire effect surface is the host bridge — `agent(modelSpec, task, opts?)`, `checkpoint()` / `checkpoint.answer()`, `console`, and the agent-handle methods `followUp` / `steer` / `cancel`. Everything else this repo's workflow authors already know — `parallel`, `pipeline`, `verify`, `judgePanel`, `gate`, `retry`, `loopUntilDry` — is pure JavaScript layered on `agent()`, injected as the in-VM guest library. The full guest surface (and the engine internals) live in the engine package, [`@automatalabs/repl-engine`](../repl-engine#the-guest-library-and-the-bridge-phase-b).

Every result carries a machine-readable `structuredContent` (the published `outputSchema`) alongside a bounded human-readable text block. Guest output (console lines, the previewed completion value) is kept in fields separate from the trusted orchestration metadata (pending call ids, checkpoints, the workspace manifest) — never one flat string.

### Input parameters

The tool is an **action union**. The MCP SDK validates the primitive fields, then a discriminator enforces each action's exact field set: a missing required field, and an *irrelevant known* field (`reset` with `code`, `status` with `ids`), are both MCP Invalid Params (`-32602`).

| Param | Type | Actions | Default | Notes |
| --- | --- | --- | --- | --- |
| `action` | `"eval" \| "wait" \| "status" \| "interrupt" \| "reset"` | all | — | Required. Selects the operation. |
| `projectDir` | absolute path string | all | daemon: **required** (except `status`); in-process: the server's own project | The workspace key — one VM per `projectDir`, resolved through the same validated, realpathed per-project context as the `workflow` tool. Workspace state survives MCP-session churn and daemon restarts. |
| `code` | string | `eval` | — | The JavaScript to evaluate. Top-level `await` is accepted; top-level `return` is a syntax error; `console` output is captured. An empty string is valid and resolves with `undefined`. |
| `ids` | string[] | `wait` | every pending call | Call ids to wait for. |
| `timeoutMs` | integer 0–120,000 | `wait` | `30000` | Bounded server-side wait; `"still running"` on timeout. |
| `id` | string | `interrupt` | — | The call id to cancel. Omitted: break the running eval. |
| `refs` | string[] | `eval` / `wait` / `status` | — | Continuation-ref ids from an earlier truncated result; their elided entries return under `referenced`. |

`projectDir` is required on the shared daemon for every action **except `status`** (which may list every known workspace without naming one). On a single-project (`--in-process`) server it defaults to that server's own project.

### The five actions

The examples below run against one workspace, `/work/acme`, in sequence — the state each call leaves is what the next one sees.

**`eval`** runs `code` in the workspace VM, drains microtasks/jobs, settles what it can, and returns. `result` is the previewed completion value **when the eval resolves to a value** — including the literal string `"undefined"` when that value is the guest `undefined` (a `const`/`let`/`class` declaration or a bare `console.log(...)` statement resolves with `undefined`, so those evals carry `result: "undefined"`, not a missing field). `result` is **absent whenever the eval does not resolve to a value**: when it **suspends** — on a subagent call, a `checkpoint()`, or any other unsettled promise — it returns *immediately with no fabricated value* and `pending` lists the call ids (the continuation resumes at settlement, exactly like a `.then`); and when it **throws, rejects, hits a syntax error, or is interrupted**, the error renders in `output` as a plain `Name: message` line — the error's own `name` and `message`, e.g. `TypeError: x is not a function`, **not** an `error:`-prefixed line — and there is no completion value. (The `error:` prefix is reserved for a *late uncaught* rejection of an already-suspended continuation, which the VM's rejection bridge routes through `console.error`.) The first `eval` in an untouched workspace creates (or restores) the VM.

```json
{ "action": "eval", "projectDir": "/work/acme",
  "code": "const research = agent('claude/sonnet', 'Summarize the auth flow in src/auth')" }
```
```json
{ "action": "eval", "projectDir": "/work/acme", "output": [], "outputTruncated": false,
  "result": "undefined", "pending": ["c1"], "checkpoints": [], "completed": [] }
```

The eval **resolved** — a `const` declaration resolves with the guest value `undefined`, which previews as the string `"undefined"`, so `result` is `"undefined"`. The `agent(...)` call took id `c1` and keeps running server-side, listed in `pending`. (An eval carries no `result` field when it **suspends** — e.g. `const x = await agent(...)` or `await checkpoint(...)`, where `pending` lists the id and there is no completion value yet — or when it **throws, rejects, syntax-errors, or is interrupted**.)

**`wait`** blocks server-side until the target calls settle (or `timeoutMs` elapses), then returns the **same shape as `eval`** — including any console output drained by its pumps — plus `drained` and `timedOut` (`timedOut === !drained`). On timeout the text appends `(still running — wait timed out after N ms)`; call `wait` again to keep waiting. It absorbs client tool-call timeouts.

```json
{ "action": "wait", "projectDir": "/work/acme", "ids": ["c1"], "timeoutMs": 60000 }
```
```json
{ "action": "wait", "projectDir": "/work/acme", "output": [], "outputTruncated": false,
  "pending": [], "checkpoints": [], "completed": ["c1"], "drained": true, "timedOut": false }
```

`c1` settled during the wait, so its id is in `completed`; nothing awaited it yet, so there is no console output. A later `eval` that reads it — `console.log({ chars: (await research).length })` — resolves immediately and prints `$1`, with `completed: []` (c1 already settled).

**`status`** is `ls` for the data plane. Per workspace it reports `state` (`not-opened` / `fresh` / `restored` / `refused`), the restore `reconcile` summary (restored only), the **workspace manifest** (`bindings` — top-level names with a structure-only `token`, `type`, `sizeBytes`, `provenance`/`task`/`provenanceAtMs`, and, for agent handles, `handleCallId` + `handleStatus`), the `$N` `logs` range, the `evalSeq` counter, `inFlight` calls, `checkpoints`, `liveAgents`, `pending` ops, `childrenClosed`, and any retained `drainError`. It is metadata, never content. **A named `status` is a first touch** — it creates or restores the workspace exactly like the stateful actions, so its manifest, reconcile summary, and any restore refusal are all surfaced on that first call. Only the **project-less** `status` (omit `projectDir`) is non-materializing: it lists every already-known workspace (an empty array when none have been opened) without opening one.

```json
{ "action": "status", "projectDir": "/work/acme" }
```
```json
{ "action": "status", "projectDir": "/work/acme", "workspaces": [ {
  "projectDir": "/work/acme", "state": "fresh",
  "bindings": [ {
    "name": "research", "token": "agent handle · settled · call c1 · 151B",
    "type": "agent handle", "sizeBytes": 151,
    "handleCallId": "c1", "handleStatus": "settled",
    "provenance": "eval 1", "provenanceAtMs": 1754500000000,
    "task": "Summarize the auth flow in src/auth" } ],
  "logs": { "first": null, "last": null, "count": 0 }, "evalSeq": 1,
  "inFlight": [], "checkpoints": [],
  "liveAgents": [ {
    "callId": "c1", "modelSpec": "claude/sonnet",
    "task": "Summarize the auth flow in src/auth",
    "state": "idle", "supportsSteering": true, "queuedSteers": 0 } ],
  "pending": [], "childrenClosed": false } ] }
```

`research` was bound in the first eval, so its `provenance` is `eval 1` (the model spec lives on `liveAgents[].modelSpec`, not on the binding); `handleStatus` is `settled` because `c1` completed during the wait. The settled subagent's ACP session stays **registered and `idle`** — reusable for `followUp` until the client-presence drain closes it — so `c1` appears once in `liveAgents` with `state: "idle"` (a settled call is not removed from `liveAgents`). `evalSeq` is `1` (one eval so far), and no `console.log` has run yet, so `logs` is empty. The byte size in the token is `formatByteSize(sizeBytes)` (decimal units, no space — `151B`, `2.5kB`, `1MB`).

**`interrupt`** has two paths.

**With `id`** it cancels one subagent call — ACP `session/cancel` downward (a drained handle's session is re-attached lazily first). `interrupt.outcome` is `cancelled` (cancel sent to a running turn), `idle` (the session exists but has no turn to cancel), `failed` (the lazy re-attach could not reach the backend), or `none` (no live session for that id). Suppose a later eval started a second subagent — `const audit = agent('codex/gpt-5.6-sol', 'Cross-check the auth findings')` — still running as `c2` (the next id after `research`'s `c1`):

```json
{ "action": "interrupt", "projectDir": "/work/acme", "id": "c2" }
```
```json
{ "action": "interrupt", "projectDir": "/work/acme",
  "interrupt": { "outcome": "cancelled", "callId": "c2" } }
```

**Without `id`** it breaks the **running eval**. `outcome` is `targeted` when a break was armed against an in-flight eval (a suspended continuation, or a fully synchronous runaway the out-of-band relay broke mid-run), or `refused-idle` when nothing breakable is running — no eval is in flight, the in-flight eval awaits something no host call can key a resumption to (a never-settling local promise), or a restored older guest predates the continuation-lease seam:

```json
{ "action": "interrupt", "projectDir": "/work/acme" }
```
```json
{ "action": "interrupt", "projectDir": "/work/acme",
  "interrupt": { "outcome": "refused-idle" } }
```

**`reset`** tears the workspace down: cancels in-flight ACP sessions, drops the VM, clears the whole per-project `repl/` store, and drops the workspace's continuation refs. It is the escape hatch for a refused snapshot.

```json
{ "action": "reset", "projectDir": "/work/acme" }
```
```json
{ "action": "reset", "projectDir": "/work/acme", "dropped": true }
```

A refused snapshot (see [Durability](#the-workspace-project-model-and-durability)) or a missing project context returns the **error variant** — `{ action, projectDir?, error }` flagged `isError: true`, where `action` is whichever action touched the refused/absent workspace. A **refused snapshot** returns the error variant on `eval`/`wait`/`interrupt`; a **named `status`** instead reports the same refusal *through its normal status variant* — `state: "refused"` with a `restoreError` message, **not** the `isError` error variant — and `reset` clears the store rather than surfacing a snapshot refusal at all. A **missing project context** (single-project mode with no adopted default) returns the error variant on the four **stateful** actions — `eval`, `wait`, `interrupt`, and `reset`. `status` never takes the error path: a project-less `status` lists every known workspace (an empty array when none have been opened) and a named `status` *creates* the context, so it can never find one missing. The published schema's error branch still enumerates all five `action` values for completeness, but no runtime path emits it with `action: "status"`.

### Output

Every result carries the machine-readable `structuredContent` below — the published `outputSchema`, a `oneOf` over the six variants — alongside the bounded text. The fields present on each variant are exactly those listed; the discriminator forbids any other top-level field.

```ts
type ReplToolOutput =
  | ReplEvalResult | ReplWaitResult | ReplStatusResult
  | ReplInterruptResult | ReplResetResult | ReplErrorResult;

interface ReplEvalResult {
  action: "eval";
  projectDir: string;
  output: string[];             // rendered console lines (already broker-capped)
  outputTruncated: boolean;     // console lines dropped by the caps (still reachable via $N)
  result?: string;              // previewed completion value; present when the eval RESOLVES to a value (a guest undefined renders as the string "undefined"); absent when the eval SUSPENDS, throws, rejects, syntax-errors, or is interrupted
  pending: string[];            // pending call ids, registry order
  checkpoints: CheckpointSummary[];
  completed: string[];          // call ids settled into the guest by this op (checkpoint answers excluded)
  truncated?: TruncatedRecord;  // present only when the 10 KB structured cap elided a field
  referenced?: Record<string, unknown[]>;  // read-back for the `refs` parameter
}

interface ReplWaitResult extends Omit<ReplEvalResult, "action"> {
  action: "wait";
  drained: boolean;             // the targets settled within the bound
  timedOut: boolean;            // === !drained
}

interface CheckpointSummary {
  id: string;                   // the checkpoint's call id (shares the c1, c2, … sequence)
  question: string;             // previewed via the top-level string rule (double-quoted, head+tail past 200 chars)
}

interface ReplStatusResult {
  action: "status";
  projectDir?: string;          // present only on a named status
  workspaces: WorkspaceStatus[];
  truncated?: TruncatedRecord;
  referenced?: Record<string, unknown[]>;
}

interface WorkspaceStatus {
  projectDir: string;
  state: "not-opened" | "fresh" | "restored" | "refused";
  restoreError?: string;        // refused only — the containment message
  reconcile?: ReconcileReport;  // restored only
  bindings: ManifestBinding[];
  logs: { first: number | null; last: number | null; count: number };  // the $N range
  evalSeq: number;              // snapshot-durable eval counter
  inFlight: string[];           // in-flight host-call ids
  checkpoints: CheckpointSummary[];
  liveAgents: LiveAgent[];
  pending: string[];            // pending call ids
  childrenClosed: boolean;      // the client-presence drain closed idle children
  drainError?: string;          // a retained last-drain failure
}

interface ReconcileReport {     // which arm each outstanding call took on restore
  settledFromStore: string[];
  reattached: string[];
  reissued: string[];
  failedLost: string[];
  requeuedCheckpoints: string[];
  leftPending: string[];
  reQueuedUndelivered: string[];
}

interface ManifestBinding {     // metadata, never value content
  name: string;
  token: string;                // structure-only, e.g. "agent handle · settled · call c1 · 151B", "{3 keys} · 1.2kB", "string · 2.4kB"
  type: string;                 // machine-readable type label: "string", "number", "object", "array", "agent handle", …
  sizeBytes: number;            // trap-free byte-size estimate
  handleCallId: string | null;  // set for agent-handle bindings
  handleStatus: "pending" | "settled" | null;
  provenance: string | null;    // "eval N", "worker c2" (or "worker c2+c3"), "session restore"
  provenanceAtMs: number | null;
  task: string | null;          // the founding call's task, ≤ 200 chars head+tail
}

interface LiveAgent {
  callId: string;               // the founding call id (the steering address)
  modelSpec: string;            // ≤ 200 chars head+tail
  task: string;                 // ≤ 200 chars head+tail
  state: "opening" | "running" | "delivering" | "idle";
  supportsSteering: boolean;
  queuedSteers: number;
}

interface ReplInterruptResult {
  action: "interrupt";
  projectDir: string;
  interrupt: {
    outcome: "targeted" | "refused-idle" | "cancelled" | "idle" | "failed" | "none";
    callId?: string;            // present on the id path
  };
}

interface ReplResetResult { action: "reset"; projectDir: string; dropped: true; }

interface ReplErrorResult {     // isError: true — a refused snapshot (eval/wait/interrupt; a named status reports refusal via its status variant instead) or a missing project context (the stateful actions eval/wait/interrupt/reset; status never takes this path)
  // The enum lists "status" for schema completeness only — no runtime path emits an error variant for it.
  action: "eval" | "wait" | "status" | "interrupt" | "reset";
  projectDir?: string;
  error: string;
}
```

`TruncatedRecord` records what the structured cap elided. Each key is an elided field's path (`"pending"`, `"workspaces[0].reconcile.requeuedCheckpoints"`, …); its value is the elided entry count, or `{ elided, ref }` when the workspace captured a continuation ref for the dropped tail. The reserved key `strings` is a plain count of strings the string backstop head+tail-elided:

```ts
type TruncatedRecord = Record<string, number | { elided: number; ref: string }>;
```

### Subagents, checkpoints, and call ids

Every `agent(...)` call and every `checkpoint(...)` draws the **next id from one shared per-workspace sequence** — `c1`, `c2`, … — so in the timeline above `research` took `c1` and `audit` took `c2`; a `checkpoint()` in that workspace would take `c3`. (The `reset` above dropped `/work/acme`, so the counter below restarts at `c1` in the fresh VM.) `checkpoint("question")` parks a promise **inside the VM**; the previewed question appears in the result's `checkpoints` list as `{ id, question }`, the client's agent relays it to its human, and the answer returns in a later eval as `checkpoint.answer("c1", value)`. No side protocol — the question rides the ordinary tool result and the answer rides the ordinary `eval` input.

```json
{ "action": "eval", "projectDir": "/work/acme",
  "code": "const ok = await checkpoint('Delete the staging DB?'); ok ? 'go' : 'stop'" }
```
```json
{ "action": "eval", "projectDir": "/work/acme", "output": [], "outputTruncated": false,
  "pending": ["c1"], "checkpoints": [ { "id": "c1", "question": "\"Delete the staging DB?\"" } ],
  "completed": [] }
```

This eval **suspends** on `await checkpoint(...)`, so it carries no `result` — `pending` lists the checkpoint id `c1` and `checkpoints` previews the question. The question is rendered through the top-level string rule, so it crosses the wire double-quoted (`"\"Delete the staging DB?\""` as a JSON string). A later eval answers it; the answer resolves the parked promise during that eval's drain (the `'go'`/`'stop'` continuation runs, but its value is not re-surfaced unless logged), and `checkpoint.answer` itself completes with `true`, so `result` is `"true"`:

```json
{ "action": "eval", "projectDir": "/work/acme", "code": "checkpoint.answer('c1', true)" }
```
```json
{ "action": "eval", "projectDir": "/work/acme", "output": [], "outputTruncated": false,
  "result": "true", "pending": [], "checkpoints": [], "completed": [] }
```

An answered id leaves the `checkpoints` list — that is its visibility; checkpoint answers are deliberately **excluded** from `completed` (hence `completed: []` above even though the parked promise settled).

### Output addressing and the caps

Every `console.log` value is **captured inside the VM** as `$1`, `$2`, … via `structuredClone` (a stable snapshot — mutating the value after the log never changes `$N`), and the rendered line carries its address in the previewer's collapsed CDP syntax — property names unquoted, strings double-quoted, nested objects as brand tokens:

```text
[$14 · object · 48kB] {sections: Array(12), title: "Auth flow", …}
```

So the orchestrator slices deeper in a later eval — `console.log($14.sections.map(s => s.title))` — instead of re-running work. Cloneable data — plain objects, arrays, `Map`/`Set`/`Date`/`RegExp`/`Error`/`ArrayBuffer`/typed arrays — is preserved whole. What `structuredClone` cannot take is *not* dropped from the graph: an iterative marker-copy fallback substitutes a typed marker (`{ __unclonable__: "function" | "symbol" | "promise" | "weakmap" | "weakset" | "weakref" | "unfreezable", description? }`) for functions, symbols, promises, weak collections, and hostile or otherwise unfreezable subgraphs — so `$N` preserves the value's *shape* with those specific pieces stood in for by markers, rather than either failing or silently losing the surrounding structure. Nothing cloneable is lost by logging, and nothing floods the client's context by being logged.

The two surfaces are capped **independently**:

- **The text block** is capped at **256 physical lines or 10,000 UTF-8 bytes, whichever trips first** (line-granular — a line that would trip either limit is dropped whole and a truncation marker ships instead; embedded newlines count toward the line cap). Console values beyond the cap stay reachable through their `$N` refs.
- **`structuredContent`** is capped only by a **10,000-byte serialized-JSON** bound (no line cap). When it trips, the largest arrays are elided head-first and each drop is recorded in the `truncated` record. An elided array carries a **continuation ref** (`{ elided, ref }`) *when the workspace captured one* — pass those ref ids back through the `refs` parameter of a later `eval`/`wait`/`status` call and the dropped entries return under `referenced`. That read-back is **itself subject to the same 10,000-byte cap**: `referenced` re-enters the structured cap, so a retrieved tail that is still over the bound is re-elided and a **fresh** continuation ref is issued for its remainder. A large tail therefore drains across **chained reads** — one ref read per round — rather than in a single call; each read costs only a read and loses no data. The guarantee is **not universal**, though: an array dropped when no ref store is available (a project-less `status` before any workspace has materialized) keeps a bare count, and the `strings` backstop head+tail-*shortens* an oversized string element in place — recorded as a bare `strings` count, never stored — so those two elisions do lose data.

Continuation refs are **workspace-namespaced** (`<project-key>:t<seq>`) and held **in memory** per workspace: a ref from one project can never resolve in another, `reset` clears them, and a daemon restart loses them (the caller re-reads current state and gets fresh refs).

### The workspace project model and durability

Workspaces follow the daemon's project model exactly: **one VM per `projectDir`**, addressed by the same required-in-daemon-mode argument the `workflow` tool uses. MCP-session churn — client restarts, transport eviction — never touches the workspace; the daemon's lifetime plus disk snapshots carry it across everything else.

- **Snapshots are implicit and boundary-durable.** There is no snapshot action. The workspace is written to the daemon's per-project `repl/` store (beside the workflow state, under the same project key) at **every state-changing boundary** — after each eval, and after each settlement drain that changed VM state — as a self-identifying envelope (the `quickjs.wasm` binary's SHA-256 + a format version + gzip compression). Because durability is boundary-based, a daemon kill loses at most the *in-flight* operation that had not yet reached a boundary; every committed boundary — and, through the append-only call store, every recorded subagent result — is durable and reconciled on the next touch.
- **Restore is lazy, on first touch.** There is no daemon-startup restore sweep. The VM is restored the first time a `repl` call addresses the project (a named `status`, `eval`, `wait`, or `interrupt`): host callbacks are re-registered by name, and every outstanding subagent call is reconciled three ways — **settled from the store** if it completed while the daemon was down, **re-attached** to its still-running ACP session (all four built-in backends advertise `loadSession`), or **re-issued** if it was lost. The `reconcile` summary appears in `status`.
- **A refused snapshot is contained, not fatal.** A snapshot that cannot be restored with the running engine — corrupt, a format upgrade, or a `quickjs.wasm` hash mismatch after a package bump — is surfaced loudly and points at `reset`: `eval`/`wait`/`interrupt` return the `isError` **error variant** (an `error` naming the cause), and a named `status` reports it through its **status variant** (`state: "refused"` with a `restoreError`). The daemon never crash-loops and never silently discards the data.
- **Subagent processes are client-presence keyed.** Child ACP processes stay warm while any MCP client is connected to the project. On last-client disconnect the workspace **drains**: in-flight subagent turns run to completion (each settlement boundary snapshots, so "close the laptop while two researchers run" ends with the findings durable), bounded by the daemon's session-eviction TTL (`AGENTPRISM_SESSION_TTL_MS`, default 2 h) — a turn that overruns the bound is force-settled as the recoverable `AGENT_CANCELLED` — then idle children close (`childrenClosed: true`). A client that reconnects **mid-drain aborts it**, keeping the children warm. On the next connect the workspace is live (or restores), and `followUp` re-attaches a subagent session lazily. A drain that fails (a snapshot-flush error) is never silent: it surfaces as a `warn:`/`drainError` line on later results and retries on the next disconnect.

**Interrupting a running eval is not universal.** An eval that **yields** (suspends on a subagent call or checkpoint) is broken by the QuickJS interrupt handler the next time its continuation runs. A **fully synchronous** runaway wedges the daemon's single thread, so the `interrupt` request cannot even be processed mid-run; it is broken **out of band** by a worker-thread relay that the stdio shim (or the `--in-process` relay transport) fires *before* forwarding the call — **a host connected directly over HTTP has no such relay**, and falls back to the per-eval wall-clock deadline. That deadline (`AGENTPRISM_REPL_EVAL_TIMEOUT_MS`, default 30 000 ms) is the last-resort bound in every mode. The no-id `interrupt` therefore honestly reports `refused-idle` for the cases it cannot break (a never-settling local promise, an older restored guest without the continuation-lease seam).

---

## The `author-workflow` prompt

The server also exposes one [MCP prompt](https://modelcontextprotocol.io/docs/concepts/prompts): **`author-workflow`**. Prompts are a *user-controlled* primitive — prompt-capable hosts surface them for explicit invocation (Claude Code renders it as the `/mcp__<server>__author-workflow` slash command) — so this adds nothing to the model-facing tool list (`workflow` and `repl`) — the prompt registers no tool of its own.

Invoking it injects the complete, self-contained workflow-authoring guide (the same content as the published `agentprism-workflow-authoring` skill: the authoring guide, the exhaustive DSL reference tables, and a complete validated example script), always version-matched to the engine this server runs. Pass the optional **`task`** argument to have the guide close with "author a workflow that accomplishes: …, then run it with the `workflow` tool".

Hosts without prompt support (Codex CLI, at the time of writing) simply never see it — install the [authoring skill](https://github.com/agentprism/agentprism-workflows/tree/main/skills/agentprism-workflow-authoring) there instead.

---

## Backends & auth

Each `agent()` call is dispatched to an **ACP agent server** chosen by the call's `model`/`tier`, falling back to `AGENTPRISM_DEFAULT_BACKEND` (default `claude`). The four built-in backends are:

- **Claude** → `@agentclientprotocol/claude-agent-acp` (the Claude Agent SDK over ACP). By default the server resolves that package's bin and runs it under the current Node; if it can't be resolved, it falls back to `npx -y @agentclientprotocol/claude-agent-acp`.
- **Codex** → `@automatalabs/codex-acp` (a published fork that bakes in the structured-output patch). By default the server resolves that package and runs it under the current Node.
- **OpenCode** → `opencode acp`. `opencode-ai` is intentionally not bundled; install it in the host environment or put `opencode` on `PATH`.
- **pi** → bundled `@automatalabs/pi-acp`. Use `pi/<provider>/<model-id>` for explicit models, or backend-only `pi` for pi's configured default.

Beyond the built-ins, **any ACP agent** can be registered as a named backend via `AGENTPRISM_BACKENDS` (see the table below) and routed to with `agent(p, { model: "<name>" })` — or `"<name>/<inner-model>"` to send `<inner-model>` verbatim as its model config value. Scripts can pass arbitrary session/turn `_meta` to such agents with `agent(p, { meta, promptMeta })`.

A workflow script can also **declare its own backends** in its meta block (`meta.backends: { <name>: { command, args?, env?, sessionMeta? } }`). Because these spawn commands on this machine, they require approval before the run starts: if the connected client supports MCP **elicitation**, the user is asked to approve each unique spawn config (approvals stick for the session); otherwise the call fails with an informative error naming the `AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1` env opt-in. Host-registered names (`AGENTPRISM_BACKENDS`) always win over script declarations of the same name.

**Authentication belongs to the agents, not this server.** Claude, Codex, and OpenCode use their normal CLI credentials; pi uses the selected provider's environment key or `~/.pi/agent/auth.json`. There is no separate auth state for an MCP host to inspect or manage. If a run genuinely hits expired/missing credentials, the backend returns ACP `AUTH_REQUIRED` and the managed run **pauses** with `reason: "auth_required"` plus a non-secret `authContext` naming the backend and advertised methods: configure that credential out-of-band, then call `workflow` again with the original script and `resumeFromRunId` — the run continues from its journal. Programmatic auth flows (env-var/gateway credential injection, LLM provider routing) live in the [`@automatalabs/workflows`](../workflows) SDK runner APIs for hosts that embed the engine directly.

---

## Configuration (environment variables)

All settings are read from the environment of the `agentprism-workflow` process (and inherited by the spawned agent servers).

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTPRISM_DEFAULT_BACKEND` | `claude` | Backend used when an `agent()` call's `model`/`tier` does not pin a provider: `claude`, `codex`, `opencode`, `pi`, or a registered custom backend name. Unknown values fall back to Claude. |
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
  { exec: { concurrency: 4, tokenBudget: 100_000 } },
);

console.log(run.status, run.result);
```

This MCP-server package does export its own building blocks, for hosts that want to mount the same tools on a transport they control rather than the default stdio one. `createWorkflowServer(runner)` registers **both** the `workflow` and `repl` tools (plus the app-only `workflow-events` poller and the `author-workflow` prompt); the `repl` workspaces default to a private client-presence ledger and a server-owned eval-break channel, and `CreateWorkflowServerOptions` exposes `replRunner`, `replPresence`, `replClientId`, `replEvalBreakChannel`, and `replDrainBoundMs` to override them (the daemon passes shared instances):

```ts
import { createWorkflowServer, installMcpServerLifecycle } from "@automatalabs/mcp-server";
import { createAcpRunner } from "@automatalabs/workflows";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const runner = createAcpRunner();
const server = createWorkflowServer(runner);
const transport = new StdioServerTransport();
await server.connect(transport);
installMcpServerLifecycle({ runner, server, transport });
```

> **Synchronous-runaway interruption needs the relay transport.** A vanilla `StdioServerTransport` (above) serves every `repl` action, but its stdin reader runs on the main thread, so it cannot fire the out-of-band eval-break for a *fully synchronous* runaway — that eval only stops at the per-eval deadline. The bundled `main()` instead uses the internal relay stdio transport (a worker-thread stdin reader that fires `server.replBreakUrl()` before forwarding a no-id `interrupt`), so the documented no-id interrupt breaks a synchronous runaway mid-run. A yielding eval is interruptible on either transport.

The REPL-specific exports are `replToolInputShape` / `replToolOutputShape` (the tool's Zod input/output schemas), `capStructuredResult` (the 10 KB structured cap), the `ReplToolOptions` type, `createReplProjectState` / `ensureReplWorkspace` / `disposeReplProjectState` / `resetReplProjectState` and the `ReplProjectState` type (per-project workspace state), and `ReplPresenceLedger` (the client-presence drain). Other workflow-side exports include `workflowToolInputShape` / `parseWorkflowToolInput` /
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
