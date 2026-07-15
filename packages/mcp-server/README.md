# @automatalabs/mcp-server

A **stdio [MCP](https://modelcontextprotocol.io) server** for foreground/background execution, bounded await, safe inspection, and in-place stopping of dynamic multi-agent workflows. Its whole tool surface is the single **`workflow`** tool, with run/resume/inspect/await/stop branches. Scripts may be supplied inline or by absolute server-side path, and every admitted script is also exposed as an immutable MCP resource. Agent backends authenticate from their own CLI credential stores (`claude /login`, `codex login`, `opencode auth login`), so there is nothing auth-shaped for a host to manage here. A run that genuinely hits an expired/missing login pauses with `authContext` and resumes (`resumeFromRunId`) after you log the backend's CLI in. Auth and provider *management* APIs live in the [`@automatalabs/workflows`](../workflows) SDK for embedding hosts.

This package is a **thin MCP adapter**. All of the real work — parsing the workflow script, running the deterministic engine, fanning `agent()` calls out to real coding agents over [ACP](https://agentclientprotocol.com), journaling, resume, token budgets — lives in **[`@automatalabs/workflows`](../workflows)**. The MCP server is the *composition root*: it builds the ACP-backed agent runner, injects it into the workflow engine, registers the `workflow` tool, and serves it over stdin/stdout.

> **Embedding in your own program?** Don't reach for this package — use **[`@automatalabs/workflows`](../workflows)** directly (`runDynamicWorkflow(script, …)`). This server exists to put that same engine behind the MCP protocol. See [Programmatic use](#programmatic-use) below.

> **Published on npm** as `@automatalabs/mcp-server` (bin: `agentprism-workflow`) — see [Install](#install).

---

## What it is

```
   MCP host (Claude Code / Zed / Cursor / …)
        │   tools/call  →  "workflow"   (JSON-RPC over stdio)
        ▼
┌────────────────────────────────────────────────────┐
│  agentprism-workflow  (this package)               │
│   • registers the single "workflow" tool            │
│   • createAcpRunner()  →  injected into the engine  │
│   • WorkflowManager.runSync/startInBackground      │
└────────────────────────────────────────────────────┘
        │   session/new, session/prompt … (ACP over stdio)
        ▼
   claude-agent-acp / codex-acp / opencode acp
        │  → real Claude / Codex / OpenCode agents
```

Foreground is the default; `background:true` durably admits work and returns its run ID without
awaiting agent completion. `action:"await"` collects it in bounded calls (see [Run model](#run-model)).
`stdout` is reserved for JSON-RPC framing — every diagnostic the server emits goes to `stderr`.

---

## Install

```bash
# global (exposes the `agentprism-workflow` bin on your PATH)
npm i -g @automatalabs/mcp-server

# or per-project
npm i @automatalabs/mcp-server
```

Installing the package provides the executable **`agentprism-workflow`** (declared as the package's `bin`, pointing at the built `dist/cli.js`). You usually don't run it by hand — your MCP host launches it (see [Register it in an MCP host](#register-it-in-an-mcp-host)).

You also need a backend used by your scripts: Claude and Codex adapters are installed transitively; OpenCode is resolved from an `opencode-ai` installation or an `opencode` executable on `PATH`. Authenticate only the backends you route to. See [Backends & auth](#backends--auth).

---

## The `agentprism-workflow` bin

The package ships one executable:

| bin | entry |
| --- | --- |
| `agentprism-workflow` | `dist/cli.js` |

Running it starts the MCP server on stdio: it builds an ACP-backed `AgentRunner`, injects it into a `WorkflowManager`, registers the `workflow` tool, and connects a `StdioServerTransport`. It speaks the MCP protocol — it is not an interactive CLI. Launch it from an MCP host, or pipe JSON-RPC to it yourself for testing.

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

`env` here is inherited by the server process **and** by every agent subprocess it spawns (see [Backends & auth](#backends--auth)), so it is where you put `AGENTPRISM_*` settings and any credentials the agent CLIs need. Set `AGENTPRISM_DEFAULT_BACKEND` to `claude` (the default), `codex`, `opencode`, or a registered custom backend name to choose the backend used when an `agent()` call's `model`/`tier` does not pin a provider.

After your host reloads, the `workflow` tool appears in its tool list.

---

## The `workflow` tool

### Input parameters

The tool uses a run/inspect/await/stop union. Execution resource maxima remain runtime clamps;
inspection/await limits are contract bounds and invalid values are MCP Invalid Params (`-32602`).

| Param | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `action` | `"run" \| "inspect" \| "await" \| "stop"` | no | run | Omit for execution. `"inspect"` reads immediately; `"await"` waits only for terminal lifecycle state; `"stop"` durably aborts a live run. |
| `script` | string (non-empty) | run XOR | — | Raw JavaScript workflow script (no Markdown fences). Exactly one of `script`/`scriptPath` is required for run. The first statement **must** be `export const meta = { name, description, phases? }`. Forbidden for inspect/await/stop. |
| `scriptPath` | absolute path string | run XOR | — | Absolute path on the **server's filesystem**. Read once as UTF-8 before admission; the content is snapshotted, and later file edits do not change that run. Relative paths and unreadable files are Invalid Params. Forbidden for inspect/await/stop. |
| `background` | boolean | run only | `false` | Acknowledge after admission and execute in this server process. |
| `args` | any JSON value | no | — | Optional value exposed to the script as the global `args`. |
| `maxAgents` | integer > 0 | no | `1000` | Max agents allowed in this run (engine cap `MAX_AGENTS_PER_RUN`). Values below 1 are clamped up to 1. |
| `concurrency` | integer > 0 | no | engine default | Max concurrent agents. **Clamped to 16** (the runtime max) by the engine — never rejected. |
| `agentRetries` | integer ≥ 0 | no | engine default | Retry attempts for recoverable agent failures. **Clamped to 3** (the runtime max). |
| `agentTimeoutMs` | integer > 0 \| null | no | none | Per-agent timeout in ms. Omit or pass `null` for no hard timeout (the engine owns timeouts). |
| `tokenBudget` | integer > 0 \| null | no | none | Hard total-token budget for the whole run. Omit or pass `null` for no limit. |
| `resumeFromRunId` | string | no | — | Start a new run from this existing persisted source. Re-send content via `script` or `scriptPath`; there is no implicit persisted-script fallback. The manager admits exact runtime/cwd/terminal environment and replays only uniquely matching safety-marked calls; uncertainty runs live. |
| `resumePolicy` | `"auto" \| "positional"` | no | `"auto"` | Positional requests index/prefix matching but cannot bypass new-format input/safety/environment gates. Requires `resumeFromRunId`. |
| `checkpointReplies` | object | no | — | With `resumeFromRunId`, map the **source** `checkpointContext.callIndex` to the durable decision. Wire keys must be canonical non-negative safe integers. |
| `runId` | engine run ID | inspect/await/stop only | — | Required for inspect/await/stop; `^[a-z0-9]+-[a-z0-9]+$`, at most 128 characters. |
| `waitMs` | integer 0–25,000 | await only | `20,000` | Zero is a non-blocking status read. Values are rejected, never clamped. |
| `lastN` | integer 1–50 | inspect/await/stop only | `20` | Latest matching journal calls. Filtering happens before this selection. |
| `labelGlob` | string | inspect/await/stop only | all calls | Non-empty, at most 128 Unicode code points. Case-sensitive whole-label `*`/`?` glob with backslash escaping; trailing backslash is literal. Only known agent labels match. |
| `logLines` | integer 0–50 | inspect/await/stop only | `20` | Latest run-log lines. |

Example call arguments:

```json
{
  "script": "export const meta = { name: 'review', description: 'review a diff' };\nconst r = await agent('Review this diff and summarize risks:\\n' + args.diff);\nreturn r;",
  "args": { "diff": "diff --git a/x b/x\n+console.log(1)" },
  "concurrency": 4,
  "tokenBudget": 200000
}
```

Compact replay-safe read-only/worktree fan-out for `script`:

```js
export const meta = { name: "fan-out", description: "Audit and experiment independently" };
return await parallel([
  () => agent("Audit src/api without changing files.", {
    label: "audit:api", resume: { filesystem: "read-only" },
  }),
  () => agent("Try the worker fix in isolation; return a unified diff.", {
    label: "try:worker", isolation: "worktree", resume: { filesystem: "read-only" },
  }),
]);
```

The worktree edits are discarded. See the
[incremental resume API](../../docs/api.md#content-addressed-incremental-resume) for the safety
contract, admission gates, reports, and legacy fallback.

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
{ "runId": "mabc1234-k9x2pq", "status": "running" }
```

```json
{ "action": "await", "runId": "mabc1234-k9x2pq", "waitMs": 20000 }
```

Stop a live run and return its final bounded snapshot:

```json
{ "action": "stop", "runId": "mabc1234-k9x2pq", "lastN": 10, "logLines": 20 }
```

### Output

The tool returns both machine-readable `structuredContent` and a human-readable text block. The structured shape pins the durable core of the engine's run result:

```ts
interface WorkflowExecutionToolResult {
  runId: string;
  status: "paused" | "completed" | "failed" | "aborted";
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
  fallbacks?: WorkflowRunFallback[];       // compatibility events; absent when empty
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
}

interface WorkflowAwaitMetadata {
  requestedMs: number;
  elapsedMs: number;
  returnedBecause: "terminal" | "timeout" | "immediate";
}

interface WorkflowRunAwaitResult<T = unknown> extends WorkflowRunStatus {
  wait: WorkflowAwaitMetadata;
  tokenUsage?: TokenUsage;
  outcome?: WorkflowExecutionToolResult<T>; // exactly when lifecycle status is terminal
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

| Execution output field | Shape | Notes |
| --- | --- | --- |
| `fallbacks` | `{ callIndex, label, phase?, requestedSpec, resolvedModel?, backendId?, kind, message }[]` | Compatibility surface for non-resolution subsystems or third-party runners; model selection emits none; absent when empty. |
| `checkpointsTaken` | `{ callIndex, kind, decision, source }[]` | `source` is `"live"`, `"headless-default"`, `"journal-replay"`, or `"injected"`; paused checkpoints are omitted; absent when empty. |
| `resumeReport` | `WorkflowResumeReport` | Exact strategy/count/per-current-call correspondence for a `resumeFromRunId` execution; absent on ordinary runs. |

These fields appear on foreground execution results and terminal await `outcome` objects. They are
persisted for cold await, but never copied onto the bounded top-level `WorkflowRunStatus` returned by
inspect/await.

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
  logTail: WorkflowLogTail;
  calls: WorkflowRunCallStatus[];
  filter: { lastN: number; logLines: number; labelGlob?: string };
  truncation: WorkflowRunStatusTruncation;
}
```

Each call has its deterministic index, known agent/checkpoint attribution, a compact JSON
`resultPreview`, and redaction/truncation flags. Inspection never returns script, args, prompts,
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
Top-level and outcome token usage are identical. Paused outcomes carry the existing non-secret
`authContext` or `checkpointContext` used for CLI-login/resume or checkpoint-reply handling. Result
observability (`fallbacks` and `checkpointsTaken`) stays inside the terminal `outcome`.

---

## Script resources

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

`resources/list` is discovery convenience, not a complete index: it returns at most the **50 newest
runs by `startedAt` descending**. Resource-template completion uses that same bounded set. Direct
URI reads are the unbounded retrieval contract, so a known older run ID remains readable even when
it is absent from the listing.

Run/background results contain a `resource_link` for the newly admitted script. Inspect/await
results contain available links for the full resume lineage, oldest to newest, and duplicate that
history in structured `lineage`. A deleted revision remains listed as `available: false` without a
fabricated link. Every URI is also present in structured output.

Clients need MCP protocol revision **2025-06-18 or newer** to consume `resource_link` content
blocks. The structured URI fields remain available independently of link rendering. MCP defines no
client `resources` capability to gate these server-offered primitives.

---

## Run model

- **Foreground by default.** Omitted/false `background` preserves the synchronous behavior,
  request cancellation, progress notifications, live checkpoint elicitation, terminal `isError`,
  and result shape.
- **Detached admission.** `background:true` returns a running acknowledgement with `runId`,
  `status`, `scriptSource`, `scriptUri`, and the script resource link
  after parsing, backend approval, one of four process-local slot reservations, lease acquisition,
  and fail-fast initial persistence. It never awaits agent or script-body completion. A fifth
  active-or-starting request returns
  `Background workflow limit reached (4 active or starting runs). Await an existing run and retry.`
  There is no queue. Foreground, inspect, and await consume no slot.
- **Bounded await.** `action:"await"` waits only for terminal status. `waitMs:0` returns
  `immediate` while pending/running; a positive deadline returns `timeout` if still live; an
  already/newly terminal run returns `terminal`. Same-process awaits wake on the background promise;
  cold awaits poll persistence every 250 ms. Cancelling await clears its timer/poller and returns
  `Workflow await for runId "<runId>" was cancelled; the workflow was not cancelled.` without
  stopping, pausing, resuming, or leasing the run.
- **Read-only inspection.** `action: "inspect"` reads the manager's freshest in-memory snapshot,
  then its project-scoped persisted store. It never parses/runs a script, invokes an agent, asks
  for backend approval, sends progress, elicits, or acquires a run lease. Run ID possession is the
  capability; UI `sessionId` listing filters do not apply.
- **Progress notifications.** When the host includes a `progressToken` with the call, the server streams `notifications/progress` as agents settle (it reports `settled / total` agents plus the current phase). With no `progressToken`, progress is a no-op.
  Background runs deliberately have no initiating progress channel; inspect/await are their progress
  surface.
- **Terminal status, not exceptions.** An ordinary pause/fail/abort does **not** throw — the run resolves to a `WorkflowRunResult` with `status` already stamped (`completed | paused | failed | aborted`) plus an optional `reason`/`resetHint`. Only a malformed script (which fails before a run exists) surfaces as an MCP tool error.
- **Immediate terminal diagnostics.** Paused, failed, and aborted execution results contain a
  redacted final-20 `logTail` even when empty. The text response renders `recent run log (last X of
  Y):` before resume guidance. The terminal text is capped at 12,288 UTF-8 bytes; completed results
  omit this extra tail and preserve the existing full `logs` field.
- **Explicit incremental resume.** A run can pause for a provider usage limit, missing authentication, or an opted-in durable checkpoint, and failed/completed/aborted terminal runs retain their completed journal too. Call `workflow` again with the current content via `script` or `scriptPath`, the desired `args`, and `resumeFromRunId` set to the prior `runId`. Safe calls match by exact path/hash or a unique hash+input fingerprint, so unchanged independent calls may replay after insertions while changed/content-dependent calls run live. Identity hits preserve logical budget control flow but cost zero current provider tokens. An empty ID is invalid and an unknown source is a pre-run `PERSISTENCE_ERROR`; neither silently starts fresh. Resume never silently falls back to stored content. The new request creates a new run ID and returns `resumeReport`; terminal text includes only its compact strategy/count line.
- **Authoritative stop.** `action:"stop"` acts on `running` and `paused` runs live in this server
  process, cancels their agent/checkpoint work, persists `aborted`, appends the durable `stopped`
  event, releases the lease, and returns the final inspection projection inline. Resume is safe
  immediately and a follow-up await adds nothing. Only backend agent-session wind-down can remain;
  use inspect's per-agent states if that cleanup appears hung. Repeating stop on a terminal run is a
  successful no-op (`stopped:false`, `alreadyTerminal:true`). Unknown runs are not found; a cold
  persisted `running`/`paused` record has nothing live to stop in this process and should be resumed.
  Stop retains the journal, record, and script resource, so the kill-patch-resume loop is: stop,
  edit the file, then call run with `scriptPath` plus `resumeFromRunId`.
- **Checkpoints.** Foreground uses MCP elicitation when advertised. Background never retains that
  request-scoped callback: omitted/`"default"` returns `default ?? true`, `"abort"` becomes failed
  with `WORKFLOW_ABORTED`, and `"pause"` becomes paused with `checkpoint_required` plus
  `outcome.checkpointContext`. Resume by starting a new run with `resumeFromRunId` and
  `checkpointReplies`.
- **Auth pauses.** Await reports `auth_required`/`AUTH_REQUIRED` and the non-secret
  `outcome.authContext`. Log the named backend CLI in out-of-band, then start a new run with
  `resumeFromRunId`; no MCP credential channel is added.
- **Retention and process lifetime.** Terminal results are reconstructed from project-scoped
  persistence and have no MCP TTL; repeated/cold await works until deletion, corruption, or store
  loss. Background means detached from one request, not from this stdio child. Disconnect does not
  itself abort work while Node stays alive, but host process exit, SIGTERM/SIGKILL, crash, shutdown,
  or machine loss can stop it. The next manager recovers orphaned durable `running` state to
  `paused`; completed journal entries remain resumable, while an in-flight unjournaled call can run
  again. Later persistence after admission is best effort.

---

## The `author-workflow` prompt

The server also exposes one [MCP prompt](https://modelcontextprotocol.io/docs/concepts/prompts): **`author-workflow`**. Prompts are a *user-controlled* primitive — prompt-capable hosts surface them for explicit invocation (Claude Code renders it as the `/mcp__<server>__author-workflow` slash command) — so this adds nothing to the model-facing tool list, which stays exactly `workflow`.

Invoking it injects the complete, self-contained workflow-authoring guide (the same content as the published `agentprism-workflow-authoring` skill: the authoring guide, the exhaustive DSL reference tables, and a complete validated example script), always version-matched to the engine this server runs. Pass the optional **`task`** argument to have the guide close with "author a workflow that accomplishes: …, then run it with the `workflow` tool".

Hosts without prompt support (Codex CLI, at the time of writing) simply never see it — install the [authoring skill](https://github.com/VikashLoomba/agentprism-workflows/tree/main/skills/agentprism-workflow-authoring) there instead.

---

## Backends & auth

Each `agent()` call is dispatched to an **ACP agent server** chosen by the call's `model`/`tier`, falling back to `AGENTPRISM_DEFAULT_BACKEND` (default `claude`). The three built-in backends are:

- **Claude** → `@agentclientprotocol/claude-agent-acp` (the Claude Agent SDK over ACP). By default the server resolves that package's bin and runs it under the current Node; if it can't be resolved, it falls back to `npx -y @agentclientprotocol/claude-agent-acp`.
- **Codex** → `@automatalabs/codex-acp` (a published fork that bakes in the structured-output patch). By default the server resolves that package and runs it under the current Node.
- **OpenCode** → `opencode acp`. `opencode-ai` is intentionally not bundled; install it in the host environment or put `opencode` on `PATH`.

Beyond the built-ins, **any ACP agent** can be registered as a named backend via `AGENTPRISM_BACKENDS` (see the table below) and routed to with `agent(p, { model: "<name>" })` — or `"<name>/<inner-model>"` to send `<inner-model>` verbatim as its model config value. Scripts can pass arbitrary session/turn `_meta` to such agents with `agent(p, { meta, promptMeta })`.

A workflow script can also **declare its own backends** in its meta block (`meta.backends: { <name>: { command, args?, env?, sessionMeta? } }`). Because these spawn commands on this machine, they require approval before the run starts: if the connected client supports MCP **elicitation**, the user is asked to approve each unique spawn config (approvals stick for the session); otherwise the call fails with an informative error naming the `AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1` env opt-in. Host-registered names (`AGENTPRISM_BACKENDS`) always win over script declarations of the same name.

**Authentication belongs to the agents, not this server.** Each backend authenticates from its own CLI credential store — log in once with `claude /login`, `codex login`, or `opencode auth login` on the machine that runs this server, and workflows just run; there is no separate auth step here, and no auth state for an MCP host to inspect or manage. If a run genuinely hits an expired/missing login, the backend returns ACP `AUTH_REQUIRED` and the managed run **pauses** with `reason: "auth_required"` plus a non-secret `authContext` naming the backend: complete that backend's CLI login out-of-band, then call `workflow` again with the original script and `resumeFromRunId` — the run continues from its journal. Programmatic auth flows (env-var/gateway credential injection, LLM provider routing) live in the [`@automatalabs/workflows`](../workflows) SDK runner APIs for hosts that embed the engine directly.

---

## Configuration (environment variables)

All settings are read from the environment of the `agentprism-workflow` process (and inherited by the spawned agent servers).

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTPRISM_DEFAULT_BACKEND` | `claude` | Backend used when an `agent()` call's `model`/`tier` does not pin a provider: `claude`, `codex`, `opencode`, or a registered custom backend name. Unknown values fall back to Claude. |
| `AGENTPRISM_BACKENDS` | — | Custom ACP backends as a JSON object: `{"<name>": {"command": "…", "args": […], "env": {…}, "sessionMeta": {…}}}`. Registered names route `model`/`tier` specs **before** built-in heuristics; `claude`/`codex`/`opencode` are reserved. |
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
| `AGENTPRISM_PERSISTENCE_ROOT` | `~/.agentprism/workflows` | Absolute root for persisted run journals and logs used by resume. |

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

This MCP-server package does export its own building blocks, for hosts that want to mount the same `workflow` tool on a transport they control rather than the default stdio one:

```ts
import { createWorkflowServer } from "@automatalabs/mcp-server";
import { createAcpRunner } from "@automatalabs/workflows";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createWorkflowServer(createAcpRunner());
await server.connect(new StdioServerTransport());
```

Other exports include `workflowToolInputShape` / `parseWorkflowToolInput` /
`clampWorkflowInput` (primitive schema, action discriminator, execution clamp),
`CreateWorkflowServerOptions`,
`WorkflowExecuteToolInput`, `WorkflowInspectToolInput`, `WorkflowAwaitToolInput`, `WorkflowStopToolInput`,
`WorkflowExecutionToolResult`, `WorkflowBackgroundAccepted`, `WorkflowAwaitMetadata`,
`WorkflowInspectionToolResult`, `WorkflowRunAwaitResult`, `WorkflowStopResult`,
`WorkflowScriptLineageEntry`, `WorkflowToolResult`, `MAX_BACKGROUND_RUNS`,
`workflowToolOutputShape` / `toWorkflowToolResult`,
`createProgressReporter`, and a `main()` that runs the default stdio server. For anything beyond
hosting this tool, prefer `@automatalabs/workflows`.

---

## License

Apache-2.0
