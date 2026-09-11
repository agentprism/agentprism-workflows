# @automatalabs/mcp-server

An **[MCP](https://modelcontextprotocol.io) server** for asynchronous execution, bounded status observation, and in-place stopping of dynamic multi-agent workflows. Execution lives in a shared per-user **local daemon** (spec-compliant Streamable HTTP on loopback) so runs survive MCP clients killing their server processes; hosts connect through the bundled **stdio shim** (the default bin, zero config change) or directly over HTTP — see [The workflow daemon](#the-workflow-daemon). Its model-facing tools are **`workflow`** for the strict config/run/resume/setup-response/status/result/permissions-response/stop/pause lifecycle and **`repl`** for persistent interactive orchestration. Version-matched guidance for both is published through the SEP-2640 MCP Skills Extension. Apps-capable clients also get the dedicated `workflow_monitor` launcher. App-only `workflow-events`, `workflow-runs`, and `workflow-notifications` tools feed the [MCP Apps run monitor](#run-monitor-mcp-apps) and never enter the model's tool loop. The `workflow` tool discovers its live backend catalog with `action:"config"` and durably accepts each script before slow preparation and validates it before live execution. Scripts may be supplied inline or by absolute server-side path, and every admitted run exposes its script file as an MCP `file://` resource. Agent backends authenticate from their own credential sources (`claude /login`, `codex login`, `opencode auth login`, provider API keys, or pi's `~/.pi/agent/auth.json`), so there is nothing auth-shaped for a host to manage here. A run that genuinely hits expired/missing credentials pauses with `authContext` and resumes with `action:"resume"` after the backend credentials are configured. Auth and provider *management* APIs live in the [`@automatalabs/workflows`](../workflows) SDK for embedding hosts.

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

For `workflow`, run/resume return durable acknowledgements and `status` reads a bounded snapshot.
The events resource and dedicated monitor provide continuous progress. The `repl` tool holds a
persistent QuickJS VM **per `projectDir`** — the

same per-project context model — whose state persists across tool calls and daemon restarts through
the per-project `repl/` store, and whose subagent `agent()` calls use the same ACP path shown above
(see [The `repl` tool](#the-repl-tool)). `stdout` is reserved for JSON-RPC framing — every diagnostic
the server emits goes to `stderr`.

---

## Run monitor (MCP Apps)

Call **`workflow_monitor({ runId })`** after a run has been durably accepted. This dedicated
model-facing launcher is the only tool associated with
`ui://agentprism-workflow/run-monitor.html`; `workflow` management calls never open a panel.
Legacy initialize capabilities and modern per-request capabilities must explicitly advertise
`io.modelcontextprotocol/ui` with `mimeTypes:["text/html;profile=mcp-app"]` to discover it.
The app-only `workflow-events`, `workflow-runs`, and `workflow-notifications` tools have
`visibility:["app"]` and no UI resource association.

Like Excalidraw's MCP App, each invocation uses one shared HTML resource and explicit input state.
Hosts that retain App instances can show independent run panels. If a host reuses one iframe,
a new monitor invocation deliberately binds it to the requested run and discards late replies
from the previous binding. Active/recent project navigation is optional. Resource URI alone does
not control whether a host keeps multiple panels.

The panel shows pending setup, phase/agent graph, live usage, selectable agent details, and
expandable tool results. It provides setup answers, explicit checkpoint replies, live permission
choices, targeted agent stop, whole-run stop, and exact-result paging/download. Fullscreen preserves
selection and run identity; narrow layouts adapt the inspector and controls to the available size.
App-only polling consumes no model tool calls.

Selection updates a bounded `ui/update-model-context` snapshot with the selected run/node and
resource URIs. It does not send a chat message. **Ask about this agent** explicitly sends the selected
agent context when the host supports text messages. Automatic messages are limited to required
input and terminal outcomes; phase starts, progress, and usage churn remain quiet. Concurrent views
claim event notifications through a host-scoped receipt ledger. Its scope depends on the host's
session/origin isolation, and an accepted-message/lost-ack crash cannot guarantee exactly-once
message delivery. Hosts lacking a capability simply omit that interaction.

To try the shipped App in the official reference host, run
`node packages/mcp-server/scripts/dev-app-host.mjs` from the repository root; its header describes
basic-host setup. `AGENTPRISM_DEV_CWD=<project dir>` serves an existing run store.

---

## Claude Code channels

Claude Code cannot render the run monitor, so the server delivers the monitor's automatic messages
to it another way: as [Claude Code channel](https://code.claude.com/docs/en/channels-reference)
notifications. The server declares `capabilities.experimental["claude/channel"]` and emits
`notifications/claude/channel` for exactly what the panel would have injected, with the same wording
and ids:

| Update | When | `kind` |
| :-- | :-- | :-- |
| Run completed, failed, or stopped | the terminal run event | `terminal` |
| Checkpoint waiting for an answer | the run pauses on `checkpoint()` | `checkpoint` |
| Auth, usage-limit, or manual pause | the run pauses for another reason | `paused` |
| Permission request parked | a subagent asks for permission | `permission` |
| Setup request waiting | preparation needs a backend approval | `setup` |

Each notification carries the message as `content` and `meta: { run_id, kind, status, event_id }`;
Claude sees it as `<channel source="<server name>" run_id="…" kind="…" status="…">…</channel>`.
Phase starts, progress, and usage churn stay quiet, as in the panel.

**Which session receives a run's updates.** Every MCP client has its own server instance, so a
session receives updates only for the runs its own `run`, `resume`, or `status` calls named. Other
clients of the shared daemon, including other Claude Code sessions, never see them. A restarted or
resumed Claude Code session re-attaches the moment it inspects the run with `status`; nothing is
replayed, because that status response already carries what happened while it was away.

**Enabling it.** Channels are a Claude Code research preview and are opt-in per session. A server
from `.mcp.json` is not on the preview allowlist, so launch Claude Code with the development flag,
naming the key you registered the server under:

```bash
claude --dangerously-load-development-channels server:agentprism-workflows
```

Neither that flag nor `--channels` appears in `claude --help` during the preview; both work. Team,
Enterprise, and managed Console organizations must enable `channelsEnabled` first, and channels are
unavailable on Amazon Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry. Hosts that
never registered the channel drop the notification silently, so declaring it costs nothing
elsewhere. Claude Code registers a channel only over the 2025 handshake: do not set
`MCP_PROTOCOL_NEGOTIATION=auto` for this server if you want channel delivery.

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

With `--in-process`, the old lifecycle applies: on stdin EOF, transport close, `SIGINT`, or `SIGTERM`, the server stops accepting new tool calls and disposes the ACP runner before exiting (five-second hard deadline, then force-kill of tracked backend process trees). The shim itself is disposable — killing it never touches the daemon or its runs — and it lives exactly as long as its host: when the host closes the shim's stdin or dies, the shim ends its daemon session and exits, so a dead host never keeps a daemon alive.

### The workflow daemon

- **Discovery**: the daemon records `{pid, instanceId, port, url, version, envFingerprint, controlUrl, controlProtocol}` (mode 0600) under `~/.agentprism/workflows/daemons/` — a **family pointer** `<envFingerprint>.json` naming the current daemon for that env, plus one `instances/<pid>.json` per live daemon. The user-scoped mode-0600 `run-control-key.json` authenticates cross-family predecessor control. Malformed key storage fails closed. Shims verify liveness via pid + `/healthz` and never dial a port blind. Concurrent shims race a per-family spawn lock, so a cold start produces exactly one daemon. The records are hints, not truth: `daemon status` and `daemon stop --all` reconcile them against the OS process table, so a daemon that lost or never wrote its record is still listed and stoppable (POSIX; on Windows the records are all there is), and a record whose pid the OS has since reused is pruned rather than signalled. Logs land in `~/.agentprism/workflows/logs/daemon.log`.
- **Succession**: a shim that finds an older control-v1 daemon spawns a successor (ephemeral port), which atomically repoints the family pointer. The predecessor becomes a *lame duck*: it admits no new MCP work, migrates drainable sessions immediately, continues its owned executions/REPL drains, accepts signed internal stop/cancel forwarding, and exits when those responsibilities settle. A daemon **equal to or newer** than the shim is adopted (version is a total order, so clients cannot flip discovery backward). Bootstrap exception: when the stale predecessor predates control v1 and reports active runs or requests, the new shim temporarily adopts it until that work drains; sessions alone never defer the upgrade. Supersession is a one-way door: a superseded daemon stays superseded even if its successor later exits and clears the pointer, so a predecessor never returns to service. `daemon status` shows instance/control identity for every current, draining, and other-family daemon, plus any untracked daemon process.
- **Port**: default `29888` (`AGENTPRISM_DAEMON_PORT` / `--port`). If the port is held — by a foreign process, or by a draining predecessor still finishing its work — the daemon falls back to an ephemeral port — discovery still works, only hardcoded client URLs need the actual port from `daemon status`.
- **Sessions and projects**: sessions are project-agnostic — every `run` call names its project via the **required `projectDir` argument** (absolute path), so one registration serves any number of projects concurrently. `status`/`stop` take only a runId and locate its project store automatically (live contexts first, then the on-disk store manifests). Each project gets its own `WorkflowManager` — same per-project run stores as before — while all projects share one ACP backend pool. Accepted runs are visible from every session, and `MAX_ACTIVE_RUNS` caps runs **per project** rather than per client process. The `repl` tool's workspace is the same shape of per-project context: **one persistent QuickJS VM per `projectDir`**, restored lazily from the per-project `repl/` store on first touch, persisted at every state-changing boundary, and drained when the project's last MCP client disconnects (both tools share one client-presence ledger, so a `workflow`-only client keeps the workspace's children warm too). See [The `repl` tool](#the-repl-tool).
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

The daemon must be running before an HTTP-only host connects (`daemon start`); any stdio shim usage also keeps it alive. One endpoint serves both protocol eras. Legacy clients retain the full 2025-11-25 Streamable HTTP contract: per-session `Mcp-Session-Id`, SSE with priming events and `Last-Event-ID` resumability, `DELETE` termination, and 404-driven re-initialize. Modern clients negotiate through `server/discover` and use the SDK's stateless per-request `2026-07-28` handler, response-stream cancellation, and `subscriptions/listen`; modern requests never allocate a legacy daemon session.

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

`env` here is inherited by the server process **and** by every agent subprocess it spawns (see [Backends & auth](#backends--auth)), so it is where you put `AGENTPRISM_*` settings and any credentials the agent CLIs need. Every MCP client must configure an effective model directly or through a named-agent definition, resolved tier, phase, or `meta.model`. A backend-only route such as `codex` explicitly uses that backend's configured default model. Missing routing fails with live discovery guidance; neither agent-configuration setup nor automatic backend selection fills it. `AGENTPRISM_DEFAULT_BACKEND` does not configure an otherwise model-less MCP call.

After reload, `workflow` and `repl` appear; Apps-capable hosts also discover `workflow_monitor`.

---

## Agent Skills over MCP

The server declares the accepted SEP-2640 extension `io.modelcontextprotocol/skills` and publishes two version-matched skills:

- `skill://agentprism-workflow-authoring/SKILL.md`
- `skill://agentprism-repl-orchestration/SKILL.md`

Skills-aware hosts discover their complete entries through `skills/list`, refresh one through `skills/get`, and activate them through the host's own skill-loading and approval path. Every entry contains verbatim `SKILL.md` frontmatter plus a complete per-file `{ uri, digest, size }` manifest. Every file is read lazily through standard `resources/read`; SHA-256 digests cover the exact raw bytes returned. The server also advertises `directoryRead: true` and implements non-recursive `resources/directory/read` for skill directories.

Workflow and REPL are separate skills because their `agent()` signatures and lifecycle semantics differ. Canonical sources live under `docs/authoring/` and are bundled into both the published MCP server and the MCP server embedded in `@automatalabs/workflows`. There is no `docs` tool, `agentprism://docs/*` compatibility surface, archive form, or obsolete `skill://index.json` resource.

## The `workflow` tool

### Input parameters

Discovery and runtime use the same strict eight-action `oneOf`:
config/run/resume/setup-response/status/result/permissions-response/stop.
Each branch requires its literal `action` and rejects extra fields. Run requires exactly one
of `script` and `scriptPath`. There are no aliases or completion-wait controls.

| Field | Actions | Contract |
| --- | --- | --- |
| `script`, `scriptPath` | run | Raw JavaScript or an absolute server-side regular-file path, exactly one. First statement: `export const meta = { name, description, phases? }`. The accepted UTF-8 text is at most 1 MiB. An inline script is copied into the run store as `{runId}.script.js`; a `scriptPath` run records the path. The admitted text is what executes. |
| `projectDir` | config, run | Absolute project directory, required on the shared daemon; defaults to the server's project under `--in-process`. Other actions locate the project through `runId`. |
| `args` | run | Strict-JSON script input, immutable after admission. |
| `maxAgents`, `concurrency`, `agentRetries` | run, resume | Runtime limits; default agent cap 1000, concurrency clamped to 16, retries clamped to 3. Resolved limits are returned. |
| `harnesses`, `modelSpecs`, `modelFilter` | config | Optional backend names, exact routed models, and bounded model substring or `/regex/` filter for no-prompt discovery. |
| `runId` | resume, setup-response, status, result, permissions-response, pause, stop | Exact persisted identity, matching `^[a-z0-9]+-[a-z0-9]+$`, at most 128 characters. Resume continues the exact run ID, including a paused or stopped one. |
| `checkpointReplies` | resume | Map `checkpointContext.callIndex` to the explicit kind-valid JSON answer. The first durable answer wins. |
| `setupId`, `response` | setup-response | Exact pending setup UUID, with `{ action:"accept", content:{...} }`, `{ action:"decline" }`, or `{ action:"cancel" }`. Accept content must satisfy the persisted `requestedSchema`. |
| `permissionId`, `response` | permissions-response | Exact pending UUID and `{ outcome:{ outcome:"selected", optionId } }` or `{ outcome:{ outcome:"cancelled" } }`. Only an advertised option ID is accepted; response `_meta` is forbidden. |
| `lastN`, `labelGlob`, `logLines` | status, pause, stop | Bounded inspection: latest 1–50 calls (default 20), case-sensitive whole-label glob, and 0–50 log lines (default 20). |
| `offset`, `maxBytes` | result | Exact UTF-8 JSON paging: offset defaults to zero; maxBytes is 4–16,384 (default 16,384). Continue at the previous `endOffset`. |
| `callIndex` | stop | Cancel one uniquely matching live agent; its slot resolves to `null` with `AGENT_CANCELLED`, while siblings continue. |
| `forceOwner` | whole-run stop | Explicitly permit termination of a superseded owner after identity revalidation; may interrupt sibling runs. Forbidden with `callIndex`. |

Discover exact live model, mode, and config values before pinning them:

```json
{ "action":"config", "projectDir":"/absolute/project", "harnesses":["codex"], "modelFilter":"gpt" }
```

Catalogs preserve raw mode IDs, names, descriptions, and `_meta`. For trusted work, choose
Claude `bypassPermissions` or Codex `agent` when advertised. Claude `auto` uses a model classifier and may request permission.

Config returns a compact `authoringSummary`: Claude/Codex's small catalogs, Pi's native
`enabledModels` preferences intersected with authenticated models plus unmatched patterns, and
OpenCode's direct models before explicitly classified aggregator browse groups (including OpenRouter, OpenCode, Hugging Face, and Bedrock). The current
model is shown separately. Expand `openrouter/*` with `modelFilter`; browse selectors cannot dispatch.
Use `modelSpecs` for exact-model option discovery. Partial probe failures preserve healthy catalogs.

### Preparation, admission, and setup

```json
{
  "action":"run",
  "projectDir":"/absolute/project",
  "script":"export const meta = { name: 'review', description: 'review the repository', model: 'codex' }; return await agent('Review the repo');"
}
```

The request reads the source, checks its structure, runs the mocked dry run and the routed
no-prompt probes, and only then admits execution under format-3 routing admission and returns.
Nothing is persisted before admission: malformed source, a failed dry run, missing routing, and a
full project are tool execution errors (`isError:true`) with no run behind them, and cancelling the
request (closing the response stream, or `notifications/cancelled` on stdio) abandons preparation
and releases capacity. A script that declares custom backends is validated the same way and then
parked in durable setup (`status:"pending"`, `setup.request`) until `setup-response` approves it.
When the request carries `_meta.progressToken`, preparation stages are reported as progress.

An accepted response is always an acknowledgement, including when work finishes quickly:

```ts
type WorkflowOperationAccepted = {
  accepted: true;
  runId: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
  scriptSource: "inline" | "path" | "stored";
  scriptUri: string; // file:// URI of the run's script file
  scriptPath: string; // the same location as an absolute path
  eventsUri: string;
  limits: { maxAgents: number; concurrency: number; agentRetries: number };
  setup?: WorkflowSetup;
} & (
  | { action:"run" }
  | { action:"resume"; continuation: WorkflowContinuationResult }
);

type WorkflowSetup =
  | { state:"preparing" }
  | { state:"input-required"; request: {
      id: string;
      kind: "backend-approval";
      title: string;
      message: string;
      requestedSchema: {
        type:"object";
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties?: false;
      };
    } };
```

It carries no execution result or result URI. Read `status` for the current outcome and `result`
for exact output. Pending setup appears in status and the App immediately. `setup-response` works
with every client; no tool request stays open for a human answer. Repeating the same response to
the same setup ID is idempotent even after execution starts; a conflicting response is rejected.
Decline, cancel, and a false backend approval retain a cancelled (`aborted`) run in history.

Script-declared spawn commands require approval before any probe or live dispatch, unless
`AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1` is set. All clients require each actual call to resolve a
model directly or through an agent definition, resolved tier, phase, or `meta.model`. A backend-only
route such as `codex` explicitly retains that backend's default model. Mode and config options remain
optional. Missing routing returns an actionable error with bounded live discovery; there is no
agent-configuration setup or automatic backend selection. Mock validation cannot prove coverage;
additional configured calls on live branches are valid. Format-3 admission captures immutable tier
and named-agent routing inputs and approved backend definitions with an integrity hash before live
dispatch. Same-ID continuation reuses the snapshot without routing discovery or file drift.

### Output and interaction

`status` is a bounded observation. It includes lifecycle state, resolved limits, log and call tails,
`latestActivity`, live `pendingPermissions`, and `setup` where relevant. Paused or terminal runs add
`outcome`: exact authored result/full logs on completion, or redacted `logTail` and non-secret
`authContext`/`checkpointContext` where applicable. Inspecting failed or aborted runs is a successful
read. Missing, corrupt, and unreadable runs fail clearly. The inherited status projection is capped
at 24,576 UTF-8 bytes and status text at 8,192; raw terminal outcome has no new envelope cap.

Every unanswered script checkpoint pauses with `reason:"checkpoint_required"`. Use the App or:

```json
{ "action":"resume", "runId":"mabc1234-k9x2pq", "checkpointReplies":{"1":true} }
```

Use the exact index from `outcome.checkpointContext`. Confirm replies must be boolean, input replies
strings (including the empty string), and select replies one exact choice. The first answer is
persisted before continuation. Later conflicting answers cannot replace it. There is no `headless`
or `default` checkpoint option; lack of a UI, timeout, or dismissal never approves or aborts work.
SDK users may supply a live `confirm` callback that collects an actual explicit answer.

ACP permissions remain live in the owner process and are answered with `permissions-response` from
the App or a later tool call. Safe projections omit private ACP session IDs, redact diagnostics,
and preserve complete ordered option IDs within a separate 64 KiB envelope. An unrepresentable
request is cancelled rather than partially exposed. Owner loss invalidates the original ACP request;
a successor cannot reconstruct it. Setup and checkpoints, in contrast, are durable waits.

An `AUTH_REQUIRED` pause reports `reason:"auth_required"` and `outcome.authContext`. Configure the
named backend's credentials out of band, then call `action:"resume"` with the same `runId`. Continuation keeps the run's args, cwd, immutable routing inputs, journal, event stream, cumulative usage, and checkpoint answers; resume itself accepts no replacement inputs. The script is re-read from the run's file: an unchanged or missing file continues the persisted script, and a changed file is a revision. A revision is validated exactly like a new run (structure, mocked dry run, routed probes), may declare only backends the run's setup already approved, and then continues with an identity-matched replay of this run's own journal: calls whose prompt and inputs are unchanged replay without provider usage, edited or new calls and everything the revision reorders run live. The acknowledgement's `continuation.scriptRevised:true` marks such a generation, the persisted record adopts the revised text, and `scriptRevisions` lists every accepted revision. A revision that does not parse, fails validation, or widens backend approval is a tool execution error that changes nothing; fix the file and resume again.
Historical records without current admission or explicit checkpoint provenance remain readable
where supported but refuse continuation/reuse clearly; start a fresh run.

Full status, outcome, and response fields are documented in the [API reference](../../docs/api.md#status-outcome-and-response-shapes).

## Run resources

Every admitted run has an editable script file resource, and every completed run with a persisted
JSON value has an immutable exact-result resource:

```text
file:///…/runs/{runId}.script.js   (an inline script: the store's copy next to the run record)
file:///absolute/scriptPath        (a scriptPath run: the caller's own file)
workflow://runs/{runId}/result
```

The script resource is a `file://` URI naming the one file a run recorded as its script: the store
copy written for an inline script, or the exact `scriptPath` the caller supplied. `scriptUri` and
`scriptPath` in run, resume, status, and outcome responses name that location. `resources/read`
returns the file's current UTF-8 text with MIME type `text/javascript`, so an edit made after
admission is visible immediately. The admitted text keeps executing until a `resume` reads the
changed file back as a validated revision; the persisted record always holds the text that executes.
Only a file some run recorded is addressable: an arbitrary `file://` URI, or an unowned file inside
the store, is not a resource. The result resource returns `JSON.stringify` of the authoritative
persisted authored result with MIME type `application/json`, works for any persisted run in the
project namespace across MCP sessions and server processes, and fails closed while the run is
nonterminal or when a paused/failed/aborted/completed-without-value run has no exact authored
result. Deleting a run record removes its store copy and both resources; a caller's `scriptPath`
file is never touched. Stopping a run removes nothing.

The server advertises and implements `resources: { subscribe: true, listChanged: true }`.
Subscriptions are process-local. The server does not watch script files, and completed-result
content is immutable, so `notifications/resources/updated` never fires for either. `notifications/resources/list_changed`
fires when a run is admitted, when a completed result becomes available, and when a run record is
deleted; deletion also drops those URIs' subscriptions.
Unsubscribing after that deletion (including a deletion race) is an idempotent empty success for a
URI this process knew existed. A malformed resource URI or a run ID that never existed is rejected.

`resources/list` is discovery convenience, not a complete index: each workflow resource template
returns at most the **50 newest runs by `startedAt` descending** (the result template filters that
set to completed runs with values). Resource-template completion uses the same bounded set. Direct
URI reads are the durable retrieval contract, so a known older run ID remains readable even when
it is absent from the listing.

The result resource has no server-side envelope cap. Hosts that truncate large resource reads can
page the same exact UTF-8 JSON through the model-facing workflow tool:

```json
{ "action": "result", "runId": "mabc1234-k9x2pq", "offset": 0, "maxBytes": 16384 }
```

The response is `{ action:"result", runId, status:"completed", resultUri, eventsUri?, mimeType:"application/json",
encoding:"utf-8", totalBytes, offset, endOffset, hasMore, chunk }`. Concatenate `chunk` values in
order and continue at each `endOffset`; boundaries never split a UTF-8 code point. An arbitrary
caller offset inside a multi-byte code point is rejected instead of returning replacement text.

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
the event queue: a slow/reconnected client catches up without gaps from the durable cursor. The
events document is bounded/redacted observability, not an exact result-reconstruction API; use the
`/result` resource or `action:"result"` for authored output. Only projected records are served; new
content strings are credential-redacted and capped at 512 UTF-8 bytes. Query URIs are readable but not subscribable. Integrity failures are explicit rather than
serving a silently incomplete transcript. See the [API contract](../../docs/api.md#mcp-live-events-resource).

Run/resume acknowledgements contain clearly labelled `resource_link` blocks for the newly admitted
script file and its durable events stream, and structured `scriptUri`/`scriptPath`/`eventsUri` fields. Status,
permission-response, stop, terminal outcome, and result-retrieval responses repeat `eventsUri` and
the events link whenever that stream exists; legacy rows may omit them. Completed
status results also carry `resultUri` and a clearly labelled exact result link. Status,
permission-response, and stop responses link only the exact run's script file. Every URI is
also present in structured output. Lower-level SDK ancestry is not projected through MCP.

Clients need MCP protocol revision **2025-06-18 or newer** to consume `resource_link` content
blocks. The structured URI fields remain available independently of link rendering. MCP defines no
client `resources` capability to gate these server-offered primitives.

---

## Run model

- **Preparation is synchronous; execution is not.** Run and Resume prepare inside the request under
  a 120-second ceiling, honor request cancellation before admission, and report preparation
  progress when a progress token is supplied. Observation requests have a 45-second bound. Human
  setup and agent execution outlive individual requests; there is no workflow completion wait, and
  cancellation after admission never stops an admitted run.
- **Capacity.** At most four preparing or executing runs per project are active, with no queue.
  Waiting setup consumes capacity. Rejected preparation and failed/stopped/paused/completed work
  release it.
  Exact retries return the existing operation and do not consume another slot, even at capacity.
- **Same-ID continuation.** Resume durably records its caller operation and generation under the
  run lease before executing. Lost-ack retries reuse that receipt; journal hits add no provider
  usage. Checkpoint answers and setup receipts cannot be overwritten by a conflicting retry.
- **Observation and recovery.** Status never waits for work or collects an answer. A cold accepted
  preparation is recovered under its lease and preserves pending setup IDs. An interrupted admitted
  execution becomes paused/interrupted for explicit resume. A live lease is never stolen on timeout.
- **Pause.** A pause request goes to the live execution owner; there is nothing to record cold.
  Agents already executing finish and journal, nothing new starts, queued calls settle as
  interrupted rows, and the run settles as `paused` with `reason:"requested"`. The response
  carries `pauseRequested` and `paused` after a two-second wait for executing agents; a `running`
  answer settles on its own. Resume continues from the journal. A run whose owner died is
  reconciled to its interrupted pause instead.
- **Stop.** Whole-run stop is location independent: it records a durable intent and forwards to the
  lease owner. Final success requires durable aborted state and a matching stopped event. A bounded
  control wait may return `control.state:"pending"` with an operation ID. Repeated terminal stop is
  a successful no-op. A stopped (`aborted`) run is not final: resume replays its journal and re-runs
  the interrupted calls. Targeted agent cancellation needs a live owner and is not fabricated cold.
- **Process lifetime.** Disconnect, shim kill, and session eviction leave daemon-owned work alive.
  A successor routes setup replies, permission replies, and stop/cancel control to a predecessor
  still holding the lease. Owner process exit can interrupt work; `--in-process` ends with its own
  client-owned process. There is no cross-machine handoff.
- **Retention.** Script, events, exact results, and operation receipts use the project store and
  have no MCP TTL. Deletion/corruption/store loss are explicit boundaries; unreadable accepted
  identities cannot silently turn into a new execution on retry.

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

The prompt is intentionally compact: it frames the optional **`task`**, directs the assistant to activate `skill://agentprism-workflow-authoring/SKILL.md` through the host's skill-loading path and read only the references needed, then points it at protocol-native config discovery and automatic run validation. It never embeds the skill or treats an ordinary resource read as skill activation. Hosts without prompt support can discover the same skill through `skills/list`.

---

## Backends & auth

Each `agent()` call is dispatched to an **ACP agent server** chosen by the call's effective `model`/`tier`. Every actual call requires a model directly or through inherited routing. Mode and config options remain optional. Missing routes fail before dispatch with bounded catalog guidance; Config discovers options without choosing a route. Format-3 admission preserves captured tier and named-agent inputs for cold continuation. A later `AUTH_REQUIRED` pauses without switching providers. The four built-in backends are:

- **Claude** → `@agentclientprotocol/claude-agent-acp` (the Claude Agent SDK over ACP). By default the server resolves that package's bin and runs it under the current Node; if it can't be resolved, it falls back to `npx -y @agentclientprotocol/claude-agent-acp`.
- **Codex** → `@automatalabs/codex-acp` (a published fork that bakes in the structured-output patch). By default the server resolves that package and runs it under the current Node.
- **OpenCode** → `opencode acp`. `opencode-ai` is intentionally not bundled; install it in the host environment or put `opencode` on `PATH`.
- **pi** → bundled `@automatalabs/pi-acp`. Use `pi/<provider>/<model-id>` for explicit models, or backend-only `pi` for pi's configured default.

Beyond the built-ins, **any ACP agent** can be registered as a named backend via `AGENTPRISM_BACKENDS` (see the table below) and routed to with `agent(p, { model: "<name>" })` — or `"<name>/<inner-model>"` to send `<inner-model>` verbatim as its model config value. Scripts can pass arbitrary session/turn `_meta` to such agents with `agent(p, { meta, promptMeta })`.

A workflow script can **declare its own backends** in `meta.backends` as
`{ <name>: { command, args?, env?, sessionMeta? } }`. These commands require a durable
`backend-approval` setup answer before any probe or live dispatch, unless
`AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1` is configured. Every client can answer with `setup-response`;
repeat answers are scoped to the saved setup ID. Host-registered names always win over declarations.

**Authentication belongs to the agents, not this server.** Claude, Codex, and OpenCode use their normal CLI credentials; pi uses the selected provider's environment key or `~/.pi/agent/auth.json`. There is no separate auth state for an MCP host to inspect or manage. In particular, a successful no-prompt config probe means session/config discovery succeeded, not that ACP universally proved first-prompt authentication; ambient CLI credentials are not observable through generic runner bookkeeping, so discovery never claims universal first-prompt readiness. If a run genuinely hits expired/missing credentials, the backend returns ACP `AUTH_REQUIRED` and the managed run **pauses** with `reason: "auth_required"` plus a non-secret `authContext` naming the backend and advertised methods: configure that credential out-of-band, then call `workflow` with `{ action:"resume", runId }` — that exact run continues from its stored script, args, immutable routing inputs, and journal on the same pinned backend. Programmatic auth flows (env-var/gateway credential injection, LLM provider routing) live in the [`@automatalabs/workflows`](../workflows) SDK runner APIs for hosts that embed the engine directly.

---

## Configuration (environment variables)

All settings are read from the environment of the `agentprism-workflow` process (and inherited by the spawned agent servers).

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTPRISM_DEFAULT_BACKEND` | unset | Explicit fallback backend used when an `agent()` call's model/tier does not pin a provider: `claude`, `codex`, `opencode`, `pi`, or a registered custom backend name. MCP requires an effective authored/inherited model; this variable cannot fill a missing route. If explicitly present but empty/unknown, historical runner behavior falls back to Claude. |
| `AGENTPRISM_BACKENDS` | — | Custom ACP backends as a JSON object: `{"<name>": {"command": "…", "args": […], "env": {…}, "sessionMeta": {…}}}`. Registered names route `model`/`tier` specs **before** built-in heuristics; `claude`/`codex`/`opencode`/`pi` are reserved. |
| `AGENTPRISM_ALLOW_SCRIPT_BACKENDS` | — | `1`/`true` approves **script-declared** `meta.backends` headlessly. Otherwise each accepted run exposes durable backend-approval setup before probing or execution. Understand the risk: this lets any workflow script spawn arbitrary commands. |
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

This MCP-server package does export its own building blocks, for hosts that want to mount the same surface on a transport they control rather than the default stdio one. `createWorkflowServer(runner)` registers the `workflow` and `repl` tools, the two authoring skills (plus their `skills/list`, `skills/get`, resource-read, and directory-read surface), the capability-gated `workflow_monitor` launcher, app-only `workflow-events`, `workflow-runs`, and `workflow-notifications` tools, and the `author-workflow` prompt. The `repl` workspaces default to a private client-presence ledger and a server-owned eval-break channel. `CreateWorkflowServerOptions` exposes `protocolEra` for SDK serving factories, plus `replRunner`, `replPresence`, `replClientId`, `replEvalBreakChannel`, and `replDrainBoundMs` for host lifecycle integration (the daemon passes shared instances). Workflow setup and continuation use durable run state; the server has no request-state codec or token verifier:

```ts
import { createWorkflowServer, WorkflowPermissionBroker } from "@automatalabs/mcp-server";
import { createAcpRunner } from "@automatalabs/workflows";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const permissionBroker = new WorkflowPermissionBroker();
const runner = createAcpRunner({
  onPermissionRequest: permissionBroker.resolver,
  enforceToolPolicyBeforePermissionResolver: true,
});
permissionBroker.attach(runner);
await serveStdio(({ era }) => createWorkflowServer(runner, { protocolEra: era, permissionBroker }));
```

> **Use an SDK serving entry for dual-era hosting.** A hand-constructed server connected directly to `StdioServerTransport` intentionally serves only the legacy era. `serveStdio(factory)` performs the official modern/legacy arbitration while registering each tool once through the factory. The bundled `main()` additionally supplies its internal relay transport, whose worker-thread stdin reader can fire the out-of-band eval-break for a fully synchronous runaway; a vanilla stdio transport remains bounded by the per-eval deadline for that case.

The REPL-specific exports are `replToolInputShape` / `replToolOutputShape` (the tool's Zod input/output schemas), the `ReplToolOptions` type, `createReplProjectState` / `ensureReplWorkspace` / `disposeReplProjectState` / `resetReplProjectState` and the `ReplProjectState` type (per-project workspace state), and `ReplPresenceLedger` (the client-presence drain). Other workflow-side exports include the individual-validator catalog `workflowToolInputShape`, canonical `workflowToolInputBranches` / `workflowToolCanonicalInputSchema`, strict `workflowToolInputSchema` / `parseWorkflowToolInput`,
`clampWorkflowInput`,
`CreateWorkflowServerOptions`,
`WorkflowExecuteToolInput`, `WorkflowResumeToolInput`, `WorkflowSetupResponseToolInput`, `WorkflowStatusToolInput`, `WorkflowPermissionResponseToolInput`, `WorkflowStopToolInput`, `WorkflowPauseToolInput`,
`WorkflowExecutionOutcome`, `WorkflowOperationAccepted`, `WorkflowSetupResponseResult`,
`WorkflowRunLatestActivity`,
`WorkflowStatusToolResult`, `WorkflowPermissionResponseResult`, `WorkflowStopResult`, `WorkflowPauseResult`,
`WorkflowToolResult`, `WorkflowPermissionBroker`, `WorkflowPendingPermission`, `MAX_ACTIVE_RUNS`,
`workflowToolOutputShape` / `toWorkflowExecutionOutcome`,
`createProgressReporter`, `installMcpServerLifecycle` / `SHUTDOWN_DEADLINE_MS`, and lifecycle
types `McpServerLifecycle`, `McpServerLifecycleOptions`, `McpServerShutdownReason`, and
`WorkflowServerControl`, plus a `main()` that runs the default stdio server. For anything beyond
hosting these tools, prefer `@automatalabs/workflows`.

---

## License

Apache-2.0
