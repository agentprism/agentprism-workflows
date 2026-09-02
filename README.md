<p align="center">
  <img src="docs/assets/banner.png" alt="AgentPrism — One script. Many agents." />
</p>

# AgentPrism Workflows

<p align="center">
  <a href="https://www.npmjs.com/package/@automatalabs/workflows"><img src="https://img.shields.io/npm/v/@automatalabs/workflows?logo=npm&color=cb3837" alt="npm version" /></a>
  <a href="https://agentprism.github.io/agentprism-workflows/npm-downloads-details.json"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fagentprism.github.io%2Fagentprism-workflows%2Fnpm-downloads.json&amp;cacheSeconds=3600" alt="npm downloads across AgentPrism packages" /></a>
  <a href="https://deepwiki.com/agentprism/agentprism-workflows"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki" /></a>
</p>

Run **dynamic, multi-agent workflow scripts** — `agent()`, `parallel()`, `pipeline()` — over real coding agents (Claude Code, OpenAI Codex, OpenCode, and pi), with deterministic journaling, resume, and git-worktree isolation.

**Your agent authors** a small JavaScript *script* (`export const meta`, then call `agent()` / `parallel()` / `pipeline()`); the engine runs it in a sandboxed realm, fanning each `agent()` call out to an [Agent Client Protocol](https://agentclientprotocol.com) (ACP) backend. It's available two ways:

- **As a TypeScript SDK** — `@automatalabs/workflows` — embed the runner in your own program.
- **As a stdio MCP server** — `@automatalabs/mcp-server`, built on the SDK — expose `workflow` and `repl` tools to any MCP host (Claude Code, Zed, …).

> All nine `@automatalabs/*` packages are **published on npm** — see [Install](#install). Two are primary user-facing entry points: the `@automatalabs/workflows` SDK and the `@automatalabs/mcp-server` stdio server.

---

## Why AgentPrism

### Real harnesses, driven over an open protocol

Each `agent()` call runs on a **shipped coding agent** — Claude Code, Codex, OpenCode, or pi — driven over [ACP](https://agentclientprotocol.com), rather than a reimplementation of an agent loop around raw model APIs. You get each backend's own tool loop, permissions, and context management, plus the auth you already have on your machine (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `opencode auth login`, provider API keys, or pi's `~/.pi/agent/auth.json`). When the harness improves, your workflows improve with no code change here.

### Many agents, one workflow

The backend is chosen **per `agent()` call**: a `claude/opus[1m]` review step, a `codex/gpt-5.6-sol` implementation step, an `opencode/zai/glm-5.2` planning step, a backend-default `pi` research step, and a custom `browser` QA agent can share one script, hand each other structured results, and be swapped independently. Any ACP server registers as a named backend — the built-ins are defaults, not a boundary.

### Have your agent write the workflow

You describe the workflow in plain language; your agent designs it with the right APIs, validates it, and runs it. The connected MCP server is self-documenting:

- **`docs` tool** — the preferred agent-controlled path. It serves version-matched workflow and REPL documentation one bounded topic at a time. Call it with no topic for the index, then select only what the task needs.
- **MCP prompt** — prompt-capable hosts also expose **`author-workflow`** (optional `task`). It frames the task and directs the assistant to the selective `docs` topics instead of injecting the entire guide.
- **Optional agent skill** — non-MCP or skills-first hosts can still install the standalone authoring skill:

  ```bash
  npx skills add agentprism/agentprism-workflows
  ```

A representative ask:

> Implement the spec in docs/specs/my-feature.md as a robust workflow of sequential stages. For each stage, have gpt-5.6-sol implement at xhigh effort and claude opus verify it at xhigh — it should re-run the builds and tests itself instead of trusting the implementer's claims — with the two going back and forth until the stage is green. Then a single final review phase that returns its findings; the workflow shouldn't loop back at all once it reaches the final review. Validate the workflow before launching it, then run it in the background and see it through to the end.

From an ask like that, the agent picks the primitives — `gate()` fix-loops with the reviewer's feedback threaded into fresh attempts, structured-output verdicts, self-contained prompts, per-call model routing and effort via `configOptions` — and the validator (static parse → mock dry run → per-harness config probe) proves the script's structure and its model/config choices for zero tokens before any real run.

### Durable runs — resume without re-spending tokens

Scripts run in a deterministic realm and every `agent()` call is journaled under an identity hash. A new `resumeFromRunId` execution replays unchanged completed calls even after insertions or reordering; ambiguous or mismatched calls run live. Filesystem/environment drift is reported as provenance instead of vetoing replay. Provider quota and authentication walls don't fail the run either: the run **pauses**, keeps the interrupted ACP session reopenable, and on resume reattaches to continue that exact turn when its call index, identity, execution inputs, backend, cwd, and reopen capability still match. Any correspondence uncertainty fails to a fresh live call, while completed calls retain ordinary journal replay.

> **Resume rule:** replay is content-addressed and fail-to-live on correspondence: a completed call replays when its identity and input fingerprint match uniquely. Filesystem or world state never gates replay.
>
> `args` is not itself part of an `agent()` identity. New args can raise an orchestration-only loop cap while earlier calls keep replaying; when args change a prompt or another hashed/runner-visible input, only corresponding calls miss. New-format reuse requires exact cwd, compatible format/metadata/manifest admission, and unambiguous identity/input correspondence—not a purity annotation. Identity hits spend zero current provider tokens. See the [incremental resume API](docs/api.md#content-addressed-incremental-resume) for matching, reports, legacy fallback, and checkpoints.

Compact reader/experiment fan-out:

```js
const [audit, experiment] = await parallel([
  () => agent("Audit src/api without changing files.", {
    label: "audit:api",
  }),
  () => agent("Try the worker fix in isolation; return a unified diff.", {
    label: "try:worker", isolation: "worktree",
  }),
]);
```

The worktree's edits are discarded; return them as data. Both completed calls replay from their
journal identity without a filesystem-safety annotation.

### Structured output as validated objects

`agent({ schema })` returns a schema-validated object, not text to parse. Claude and Codex use their agent-specific schema channels. Pi, OpenCode, and eligible custom ACP agents get a client-hosted `StructuredOutput` MCP tool injected automatically when they advertise HTTP MCP support. The runner still validates and re-prompts on mismatch, so the same API works for schema channels, tool capture, and validated final-text fallback.

### The full ACP spec, enforced by the build

Every client-side ACP method is served (`fs/*`, `terminal/*`, permission requests, elicitation, MCP-over-ACP) and the agent-side surface — session modes, session lifecycle, auth/providers — is driven, not stubbed. A coverage manifest keyed off the SDK's method constants breaks the build on protocol drift; the separate executable extension matrix tracks vendor `_session/steering` support without misclassifying it as standard ACP. The end-to-end suite covers real Claude, Codex, OpenCode, and pi providers when gated, including a Claude/Codex native-steering smoke, plus a credential-free pi leg through pi-acp's injected runtime.

### Controls for unattended runs

Per-run agent and concurrency limits, per-call git **worktree isolation**, retries, explicit call/run cancellation, and `checkpoint()` — a deterministic, journaled human gate with three modes. A live SDK `confirm` callback or MCP elicitation collects the reply immediately; without a live channel, the default mode takes `default ?? true` (or `headless: "abort"` aborts), so detached runs never hang by default. Authors can opt into a durable pause with `headless: "pause"`: the run returns `status: "paused"` plus `checkpointContext`, the host resumes with `checkpointReplies`, and the decision is journaled and replayed without re-asking. Separately, an unresolved ACP permission keeps its live agent call running-but-waiting; MCP status surfaces the exact options and `permissions-response` routes the decision back to the execution owner. For watching those runs from the outside, `@automatalabs/agentprism-otel` attaches to any `WorkflowManager` and exports OpenTelemetry traces (run → agent → tool call) plus token, cost, and duration metrics.

---

## How it works

One process plays **two protocol roles at once**: it's an **MCP server** (or a library) that accepts a workflow script, and an **ACP client** that drives one or more agent subprocesses to execute each `agent()` call.

```
   your program  ──or──  MCP host (Claude Code / Zed / …)
        │  runDynamicWorkflow(script)      calls tool "workflow"
        ▼
┌──────────────────────────────────────────────┐
│  AgentPrism orchestrator                      │
│   • the deterministic engine runs the script  │
│   • ACP CLIENT → drives agent servers         │
└──────────────────────────────────────────────┘
        │  session/new or resume/load, then session/prompt … (ACP over stdio)
        ▼
   claude-agent-acp / codex-acp / opencode acp / pi-acp   (long-lived, pooled subprocesses)
        │  → real agents; paused occurrences may reopen their recorded session
```

The deterministic engine (sandboxed `vm` realm, `parallel`/`pipeline`, journal/resume, worktree isolation) is independent of *how* a single agent runs and of *how* the tool is exposed. See [`docs/design-notes.md`](docs/design-notes.md) for the full protocol-level design.

The MCP server also exposes a second, **interactive** route: the `repl` tool. Instead of running a deterministic script to completion, it holds a persistent **QuickJS-in-WASM VM per project** (the [`@automatalabs/repl-engine`](packages/repl-engine) tier), and the client's own agent writes live JavaScript that spawns subagents over the same ACP path — workspace state (bindings, pending calls, checkpoints, logged values) persisting between tool calls and across daemon restarts. Workflows is the batch orchestrator; `repl` is the live steering plane. See [The `repl` tool](packages/mcp-server/README.md#the-repl-tool).

---

## Requirements

- **Node.js ≥ 22** and **pnpm ≥ 10** (see `.nvmrc` / `packageManager`).
- A backend agent CLI, authenticated on your machine:
  - **Claude** — via the bundled `@agentclientprotocol/claude-agent-acp`; auth from `~/.claude/.credentials.json` or `ANTHROPIC_API_KEY` (the orchestrator inherits your environment).
  - **Codex** — via `@automatalabs/codex-acp` (+ the `@openai/codex` binary, installed as a dependency); auth from `~/.codex/auth.json`.
  - **OpenCode** — supported but **not bundled**. Install the `opencode` CLI on PATH or add `opencode-ai` to your own project (its platform binaries are large), then authenticate with `opencode auth login`.
  - **pi** — via the bundled `@automatalabs/pi-acp`; auth from the selected provider's API key or pi's `~/.pi/agent/auth.json`.

You only need auth for the backend(s) you actually call.

---

## Install

### From npm

```bash
pnpm add @automatalabs/workflows        # the SDK
# or, to run the MCP server:
pnpm add @automatalabs/mcp-server
```

### From source (for development)

```bash
git clone <this-repo> agentprism-workflows
cd agentprism-workflows
pnpm install      # installs deps + fetches backend binaries
pnpm build        # tsc -b across all packages
```

---

## Packages

These are the packages you interact with directly. The first two are the primary **user-facing entry points** — start with one of them; the third is a standalone backend server:

| Package | What it is |
|---|---|
| **`@automatalabs/workflows`** | The canonical public **SDK** — a thin facade that runs workflow scripts programmatically over the default ACP backend, and re-exports the supported engine + backend integration surface. Start here. |
| **`@automatalabs/mcp-server`** | The stdio **MCP server** (bin: `agentprism-workflow`) exposing the `workflow` tool (foreground/background run, bounded status, resume, permission response, stop) and the `repl` tool (a persistent JavaScript REPL for live subagent orchestration) — built on `@automatalabs/workflows` and `@automatalabs/repl-engine`. |
| **`@automatalabs/pi-acp`** | The standalone stdio **ACP server** (bin: `pi-acp`) embedding the pi coding agent in-process; exact-pinned and spawned by the first-class `pi` backend. |

One optional integration package attaches to the SDK's manager surface:

| Package | What it is |
|---|---|
| **`@automatalabs/agentprism-otel`** | OpenTelemetry traces and metrics for a `WorkflowManager`; peer-depends only on `@opentelemetry/api` and no-ops when the host has no OTel SDK. |

The five packages below are **internal building blocks**. Most are composed by the SDK (`@automatalabs/workflows` → `workflow-engine`, `acp-agents`, `shared-types`); the exceptions are `@automatalabs/repl-engine`, which **depends on** the SDK and is composed by the **MCP server** (which registers its `repl` tool), and `@automatalabs/codex-acp`, which is spawned by `acp-agents`. You normally don't depend on any of them directly: `@automatalabs/workflows` is the public entry point for the supported orchestration surface.

| Package | What it is |
|---|---|
| **`@automatalabs/acp-agents`** | The ACP client + Claude/Codex/OpenCode/pi/custom backends (the `AgentRunner` implementation, connection pooling, auth/session lifecycle, structured output, permissions, usage). Internal — public entry is `@automatalabs/workflows`. |
| **`@automatalabs/workflow-engine`** | The deterministic engine: the script realm, `parallel`/`pipeline`, journal/resume, and worktree isolation. Internal — public entry is `@automatalabs/workflows`. |
| **`@automatalabs/repl-engine`** | The published REPL orchestrator engine: a persistent JavaScript REPL in a capability-free QuickJS-in-WASM VM (workspace lifecycle, eval + job drain, per-VM memory limits, per-eval interrupts, trap-free completion reads, the append-only call store and enveloped snapshots). Its `repl` MCP tool is registered in `mcp-server` (the roadmap's `repl-orchestrator`, phase E — implemented); it depends on `workflows`, `acp-agents` (subagents are ACP sessions), and `shared-types`. |
| **`@automatalabs/codex-acp`** | The workspace fork of `agentclientprotocol/codex-acp` (imported with full history) — the ACP server the Codex backend spawns, baking turn-level `outputSchema` forwarding into its shipped dist. Consumed by `@automatalabs/acp-agents` as `workspace:*`; you never depend on it directly. |
| **`@automatalabs/shared-types`** | The `AgentRunner` seam + shared types the others compose against. Internal — public entry is `@automatalabs/workflows`. |

Dependency direction: `mcp-server` → `{ workflows, repl-engine, shared-types }`; `workflows` → `{ workflow-engine, acp-agents, shared-types }`; `acp-agents` → `{ codex-acp, pi-acp, shared-types }`; `repl-engine` → `{ workflows, acp-agents, shared-types }`. The SDK (`workflows`) is the single facade that composes the deterministic engine and the ACP backend, which meet only at the `AgentRunner` seam in `shared-types`. The engine never names a backend; the agents never know they're inside a workflow. `acp-agents` spawns the bundled `codex-acp` / `pi-acp` ACP servers as its Codex and pi backends. `repl-engine` composes the QuickJS-in-WASM shim with `workflows` (for the shared per-project key) and `acp-agents` (the REPL's subagents are ACP sessions against the same backends the SDK drives), and ships its `repl` tool in `mcp-server`.

### Published ACP registry

Our independently published ACP servers are available as an [ACP-format registry](https://github.com/agentclientprotocol/registry/blob/main/FORMAT.md):

```text
https://agentprism.github.io/agentprism-workflows/acp-registry/v1/latest/registry.json
```

It currently contains the `@automatalabs/codex-acp` fork and the from-scratch
`@automatalabs/pi-acp` server. Each npx distribution is pinned to the npm `latest` version that CI
has verified is actually published; the GitHub Pages data workflow refreshes the registry after
successful releases and on its regular schedule.

---

## Quickstart — SDK

Run a workflow script. The default backend is the ACP runner (`createAcpRunner()`), so this drives real agents and needs backend auth.

```ts
import { runDynamicWorkflow } from "@automatalabs/workflows";

const script = `
  export const meta = {
    name: "repo-scan",
    description: "describe a repo as JSON, three ways in parallel",
    phases: [{ title: "Fan" }],
  };

  const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["repo", "fileCount"],
    properties: { repo: { type: "string" }, fileCount: { type: "number" } },
  };

  phase("Fan");
  const results = await parallel([
    () => agent("Report this repo as JSON {repo, fileCount}.", { label: "a1", schema: SCHEMA }),
    () => agent("Report this repo as JSON {repo, fileCount}.", { label: "a2", schema: SCHEMA }),
  ]);
  return results;
`;

const run = await runDynamicWorkflow(script, { args: {} });

console.log(run.status);   // "completed" | "paused" | "failed" | "aborted"
console.log(run.result);   // [{ repo: "...", fileCount: 123 }, …] — schema-validated objects
console.log(run.tokenUsage, run.runId);
```

`runDynamicWorkflow` resolves to a **terminal** `WorkflowRunResult` even on pause/fail/abort — read `run.status` instead of catching. The optional `fallbacks` audit field records resume-continuation outcomes (`kind: "continuation"`, reattached method or skip reason); model resolution itself emits no entries because the selected harness accepts or rejects the verbatim id. `checkpointsTaken` records every checkpoint resolved in that execution with its decision source (`live`, `headless-default`, `journal-replay`, or `injected`). Both fields are absent when empty and do not affect routing or replay identity. To swap the backend (or stub it in tests), pass your own runner: `runDynamicWorkflow(script, { runner })`. For lower-level control, use `WorkflowManager` / `runWorkflow` (also re-exported from the SDK).

### Run a single agent directly

```ts
import { createAcpRunner } from "@automatalabs/workflows";

const runner = createAcpRunner();
const data = await runner.run("Summarize this repo as JSON {summary}.", {
  schema: {
    type: "object", additionalProperties: false,
    required: ["summary"], properties: { summary: { type: "string" } },
  },
  model: "claude/opus[1m]", // verified Claude id; use "codex/gpt-5.6-sol" for Codex
  cwd: process.cwd(),
});
// data is typed/validated against the schema (a plain object, not text)
await runner.dispose();   // closes pooled backend processes
```

---

## Quickstart — MCP server

The `workflow` tool runs in the foreground by default, can acknowledge long work with
`background: true`, and observes it with bounded `action: "status"` calls. Omitted or zero `waitMs`
returns immediately; a positive value waits for a milestone without cancelling work. Foreground execution streams `notifications/progress` and normally returns
the terminal structured result; if a live ACP permission needs an answer, it returns the still-running
run plus `pendingPermissions` so the same run can be continued through another tool call.

Register the MCP entry in your host's config (the same command as before — it is now a thin
stdio shim that auto-starts a shared local **workflow daemon**, so runs survive the host
killing the process; add `--in-process` to the args for the old single-process behavior):

```json
{
  "mcpServers": {
    "agentprism-workflow": {
      "command": "npx",
      "args": ["-y", "@automatalabs/workflows", "mcp"]
    }
  }
}
```

The server is bundled in the `@automatalabs/workflows` tarball, so this needs no separate
server installation. The independently published `@automatalabs/mcp-server` package and its
`agentprism-workflow` bin remain available as an alternative. With no
`AGENTPRISM_DEFAULT_BACKEND`, a workflow that reaches a model-less `agent()` call probes configured
backends without prompting, prefers positive session-open readiness evidence, and pins one backend
for that project/run. Set the environment variable only when you want an explicit operator default.

From a source checkout, point at the built entry instead:

```json
{
  "mcpServers": {
    "agentprism-workflow": {
      "command": "node",
      "args": ["/abs/path/to/agentprism-workflows/packages/mcp-server/dist/cli.js"]
    }
  }
}
```

**MCP Apps run monitor.** The `workflow` tool declares a UI resource
(`_meta.ui.resourceUri`) per the [MCP Apps extension](https://modelcontextprotocol.io/extensions/apps/overview).
The server advertises `io.modelcontextprotocol/ui`; on the current legacy MCP wire, a client opts
in through `capabilities.extensions["io.modelcontextprotocol/ui"]` with
`mimeTypes: ["text/html;profile=mcp-app"]`. Only that exact, well-formed declaration adds the UI
metadata and app-only surface. Supporting hosts (Claude, Claude Desktop, VS Code Copilot,
Goose, …) show a live run-monitor panel
for `workflow` calls: a phase/agent graph with per-node log drill-in, live token/cost totals,
and a Stop control. The panel derives the observed runId from the call's arguments
(status/result/permissions-response/stop) or the newly-created runId from a run/resume result
(immediately for `background: true` admissions), then keeps itself
current by polling the app-only `workflow-events` tool (`visibility: ["app"]`, outside the
model's tool loop) — no model tokens are spent while it is visible. The panel also mirrors
run status into the host's model context (`ui/update-model-context`, last push wins) at
**milestones only** — an agent call going terminal (done or error), a phase start, and the
run reaching a paused or terminal state — so the agent learns how a run is doing without
re-calling the tool. Live-view churn (agent *starts*, banners, progress rows, token/cost
tallies) never pushes on its own: it is panel detail the agent can read on demand, and in
hosts that treat a context update as conversational input, pushing it would wake the agent
repeatedly; `status` text summaries carry
`annotations.audience: ["assistant"]`, and blocking `run`/`status` calls report
`notifications/progress` when the client sends `_meta.progressToken`. Hosts without MCP Apps
support receive no UI metadata and get the same text/structured output as before. To try it
locally against the ext-apps reference host, run
`node packages/mcp-server/scripts/dev-app-host.mjs`; its header shows the Apps capability the
reference host's generic core client must advertise.

> **Known limitation (upstream):** MCP Apps currently renders a **new** panel instance for
> every model-initiated `workflow` call — the spec has no way to re-attach a call to an
> already-rendered view yet. Reusable views (`viewSessionId`) are tracked upstream in
> [ext-apps#430](https://github.com/modelcontextprotocol/ext-apps/issues/430); until that
> lands, the mitigations above (context pushes + tool-description guidance) keep the agent
> from re-calling the tool just to check status.

<p align="center">
  <img src="docs/assets/run-monitor-graph.png" alt="Run monitor: live phase/agent graph of a workflow run" />
  <img src="docs/assets/run-monitor-log.png" alt="Run monitor: per-agent log drill-in with an expanded tool result" />
</p>

**Tool: `workflow`** — input parameters:

Tool discovery publishes a strict seven-action `oneOf`: `action` is required, each branch lists
only its valid fields, and cross-action fields are rejected as MCP Invalid Params. During migration,
the runtime still maps an omitted action to `run`, legacy `inspect` to immediate `status`, and legacy
`await` to `status` with its historical 20-second omitted wait. New callers should use only the
published canonical forms.

| Param | Type | Notes |
|---|---|---|
| `action` | `"config" \| "run" \| "resume" \| "status" \| "result" \| "permissions-response" \| "stop"` | Required canonical discriminator. `"config"` performs zero-token live backend discovery. `"run"` validates and executes explicit content. `"resume"` creates a new run from stored script and args. `"status"` is the one run-observation action. `"result"` pages completed exact JSON. `permissions-response` resolves one live ACP request using an exact advertised option. |
| `script` | string | Run only: supply **exactly one** of `script` or `scriptPath`. Raw JS (no Markdown fences); first statement must be `export const meta = { name, description, phases? }`. Forbidden for resume/status/result/permissions-response/stop. |
| `scriptPath` | absolute path string | Run only: the other half of the `script`/`scriptPath` pair — an absolute path on the server's filesystem, read once at admission. Forbidden for resume/status/result/permissions-response/stop. |
| `projectDir` | absolute path string | Config/run: project-sensitive discovery cwd and the run's project store/default cwd. Required for both on the shared daemon; defaults to the server's project under `--in-process`. Resume locates the project from its source `runId`. |
| `harnesses` | string[] | Config only: optional backend names to probe; omission discovers every registered backend. |
| `modelSpecs` | string[] | Config only: select exact routed models before reading their model-specific options. |
| `modelFilter` | string | Config only: bounded model-id substring or `/regex/` filter. |
| `background` | boolean | Run/resume; default `false`. `true` acknowledges after durable admission and executes in the daemon (returns the new `{ runId, status: "running" }`). |
| `args` | any | Exposed to the script as the global `args`. Resume defaults to the source's stored strict-JSON args; an explicit value replaces them. |
| `maxAgents` | number | Default 1000. |
| `concurrency` | number | **Clamped** to 16 (not rejected). |
| `agentRetries` | number | **Clamped** to 3. |
| `resumeFromRunId` | string | Run only: advanced edited replay using the explicitly supplied `script`/`scriptPath` and current `args`. Simple stored-content replay uses `action:"resume"` plus `runId`. |
| `resumePolicy` | `"auto" \| "positional"` | Resume/run-with-`resumeFromRunId`; default `"auto"`. Positional requests index/prefix matching but cannot bypass new-format format, metadata, manifest, or input checks. |
| `checkpointReplies` | object | With resume or `resumeFromRunId`, map the **source** `checkpointContext.callIndex` to its decision. Keys must be canonical non-negative integer strings on the JSON wire. |
| `runId` | string | Required for resume/status/result/permissions-response/stop. For resume it names the immutable source; the response carries a new run ID. |
| `permissionId` | UUID string | Permissions-response only: opaque pending request id returned by status. |
| `response` | ACP permission response | Permissions-response only: `{ outcome:{ outcome:"selected", optionId } }` using an exact advertised option, or `{ outcome:{ outcome:"cancelled" } }`. |
| `callIndex` | integer | Stop only: cancel exactly that one in-flight agent call (its slot settles to `null` with `AGENT_CANCELLED`) without aborting the run. Forbidden for every other action. |
| `waitMs` | integer | Status only: omit or use zero for an immediate read; positive values wait up to 25,000 ms. This bounds only the MCP request and never cancels workflow work. |
| `offset` | integer | Result only: UTF-8 byte offset, default zero; continue at the prior `endOffset`. |
| `maxBytes` | integer | Result only: exact chunk size bound, 4–16,384 bytes; default 16,384. |
| `lastN` | integer | Status/stop: latest matching calls, default 20, range 1–50. |
| `labelGlob` | string | Status/stop: case-sensitive whole-label glob (`*`, `?`, backslash escaping). |
| `logLines` | integer | Status/stop: latest log lines, default 20, range 0–50. |

When pinning a model, mode, or `configOptions`, discover exact live values first:

```json
{ "action": "config", "projectDir": "/absolute/project", "harnesses": ["codex"], "modelFilter": "gpt" }
```

The config response preserves each harness's raw mode id, name, description, and `_meta`, and reports
AgentPrism's explicit omitted-mode defaults: Claude `auto`, Codex `agent`, OpenCode `build`, and no Pi
mode. These defaults are applied at session start instead of inheriting ambient harness settings.

Every run is statically checked, mock-executed, and config-probed before admission. Invalid scripts return `status:"rejected"` diagnostics without a run ID, background reservation, or token spend. Foreground remains the default. For long work, start it and retain the new run ID:

```json
{ "action": "run", "script": "export const meta = { name: 'review', description: 'review' }; return await agent('Review the repo');", "background": true }
```

Then long-poll in ordinary bounded tool calls until `outcome` appears:

```json
{ "action": "status", "runId": "mabc1234-k9x2pq", "waitMs": 20000 }
```

A timeout returns the freshest bounded status and partial cumulative token usage; terminal status
adds the same raw result/log projection a foreground call returns. Every admitted run and subsequent
status/terminal response for a durable event-log run exposes `eventsUri` plus a labelled events
resource link. Completed foreground/status responses expose `workflow://runs/{runId}/result`
separately from the script resource. Exact JSON up
to 4,096 UTF-8 bytes is copied into foreground/status text for content-first hosts; larger results
point to that resource and bounded `action:"result"` paging (`endOffset` + `hasMore`). The
bounded/redacted events stream is observability, not an exact-result API. Status returns early with
`wait.returnedBecause:"action-required"` when an ACP permission is pending. Status includes
the complete ordered exact option ids with credential-redacted, bounded diagnostics and no private ACP
session id; requests that cannot fit safely fail closed. Elicitation-capable clients present them to
the user; other clients answer
through:

```json
{
  "action": "permissions-response",
  "runId": "mabc1234-k9x2pq",
  "permissionId": "00000000-0000-4000-8000-000000000000",
  "response": { "outcome": { "outcome": "selected", "optionId": "allow_for_session" } }
}
```

The request remains live in its owning daemon while waiting. Permission responses accept only an exact
advertised option id or cancellation—caller-supplied response `_meta` is forbidden—and route across
daemon upgrades to that owner, but cannot be reconstructed after owner loss. At most four background runs may
be active or starting per project. Runs execute in the shared local daemon, so MCP clients
disconnecting or killing the stdio shim never stops in-flight work — any later session can locate
it and use status or stop. Across a version upgrade, the successor routes signed stop/cancel control
to the predecessor holding the run lease; whole-stop intent is durable and can report a nonterminal
`control.state:"pending"` before final settlement. Owner daemon exit (signals, forced owner stop,
crash, machine loss) — or, under `--in-process`, the client-owned process exiting — can interrupt
in-flight work, while the durable journal prefix remains resumable. Background runs send no request progress and use authored headless
checkpoint behavior. Resume a paused, failed, completed, or aborted source with
`{ "action":"resume", "runId":"…" }`; the server reuses its immutable persisted script and stored
strict-JSON args, creates a new linked run, and durably records any replay prefix before a background
acknowledgement. Supply `args` to replace the stored value. Operational limits come only from the new
request. Use explicit `script` or `scriptPath` plus `resumeFromRunId` when replaying edited content.

#### Follow a background run live

`status` returns bounded snapshots, including one compact `latestActivity` sample per matching call
when durable progress has been observed. The sample carries its source cursor/timestamp, turn and
event counts, observed tokens, a bounded latest assistant preview or tool name, and current/terminal
relevance; it is useful after cancellation, abort, and restart but is not a transcript. Use the
returned `eventsUri` or labelled events link to consume redacted progress and assistant/tool
transcript upserts while agents are still working. Subscribe
before the first read so an append cannot race the handoff, then page from the last reduced cursor:

```ts
const canonical = `workflow://runs/${runId}/events`;
await client.subscribeResource({ uri: canonical });

const initial = JSON.parse(resourceText(await client.readResource({ uri: canonical })));
const streamId = initial.streamId;
let cursor = 0;

async function catchUp() {
  let page;
  do {
    const uri = `${canonical}?after=${cursor}&limit=1000&streamId=${streamId}`;
    page = JSON.parse(resourceText(await client.readResource({ uri })));
    for (const event of page.events) reduceRunEvent(event);
    cursor = page.cursor;
  } while (page.hasMore);
}

await catchUp();
// Call catchUp() after each notifications/resources/updated hint.
```

Update notifications are coalesced wake-up hints, not the event queue; replaying from `cursor` is
what makes reconnects gap-free. See the
[`@automatalabs/mcp-server` run-resource contract](packages/mcp-server/README.md#run-resources) for
event shapes, redaction limits, and stream-replacement errors.

#### Raise a loop cap without paying for completed rounds twice

This script intentionally halts after six expensive reviews when called with `{ "maxRounds": 6 }`, although eight are required:

```js
export const meta = {
  name: "resume-loop-cap",
  description: "Run expensive review rounds up to an args-controlled cap",
  phases: [{ title: "Review" }],
};

const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
const numericCap = Number(input.maxRounds);
const maxRounds = Number.isInteger(numericCap) && numericCap > 0 ? numericCap : 8;

phase("Review");
const rounds = [];
for (let i = 0; i < maxRounds; i += 1) {
  rounds.push(
    await agent(
      `Review round ${i + 1}: inspect the repository and report unresolved release blockers.`,
      { label: `review:${i + 1}`, phase: "Review" },
    ),
  );
}

if (maxRounds < 8) throw new Error(`review cap ${maxRounds} reached before 8 rounds`);
return { rounds };
```

Call `workflow` once with that script and `args: { "maxRounds": 6 }`. Copy the returned `runId`, then call `{ "action":"resume", "runId":"…", "args":{ "maxRounds":8 } }`. The stored immutable script is reused, rounds 1–6 rebuild the same identities and replay with zero current provider tokens, and only rounds 7 and 8 run live. Keep the cap out of the round prompt: interpolating `maxRounds` into every prompt would change all eight identities and make all eight calls live.

Retain every returned `runId`. Before guessing why a run paused or failed, read its safe status,
log, and call tail:

```json
{ "action": "status", "runId": "mabc1234-k9x2pq", "lastN": 10, "labelGlob": "review-*", "logLines": 20 }
```

Status returns lifecycle state, ordered phases, a redacted log tail, attributed compact call
previews, and the durable latest-activity samples described above. `lastN` and `labelGlob` apply to
both call rows and activity. Its structured payload, including `latestActivity`, is capped at 24,576
UTF-8 bytes and its text at 8,192 bytes.
Paused, failed, and aborted execution responses also include a redacted final-20 `logTail` immediately.

The model-facing surface is `docs`, `workflow`, and `repl`. `docs` embeds one selected, version-matched text/markdown topic per call; `repl` is a persistent QuickJS-in-WASM JavaScript VM (one per project) for live, stateful orchestration. Prompt-capable hosts additionally get the compact user-controlled **`author-workflow`** MCP prompt (optional `task` argument), which directs the assistant to relevant `docs` topics. Backend auth belongs to the agents' credential sources (`claude /login`, `codex login`, `opencode auth login`, Pi provider environment keys, or `~/.pi/agent/auth.json`) — configured credentials need no extra step. An `AUTH_REQUIRED` fault pauses the workflow with `reason: "auth_required"` and a non-secret `authContext` naming the backend; configure that credential out-of-band, then call `{ "action":"resume", "runId":"…" }` for the paused source. Programmatic auth/provider management lives in the `@automatalabs/workflows` SDK runner APIs.

---

## Writing workflow scripts

A script is plain JavaScript whose **first statement** is the `meta` literal. Inside it, these globals are available (injected into the run's realm — they are not importable functions; `@automatalabs/workflows` ships an ambient `.d.ts` so your editor knows them):

- `agent(prompt, opts?)` — run one subagent. With `opts.schema` (a JSON Schema) you get a validated object back; without it, the assistant's text. Other opts: `label`, `phase`, `model`/`tier`, `mode`, `configOptions`, `agentType`, `isolation`, `cwd`, `retries`, `mcpServers`, `images`, `meta`, `promptMeta`, `keepSession`, plus the deprecated replay-neutral `resume` annotation. (`configOptions` is the selected harness's exact ACP option id/value bag; `keepSession` preserves the agent-side session for host re-attachment and records it in `WorkflowRunResult.agentSessions`; `meta`/`promptMeta` are generic ACP `_meta` passthroughs merged into `session/new` / `session/prompt`. Tool policy and instructions come from the `agentType` definition; `toolNames`/`instructions` remain lower-level `createAcpRunner().run()` API options.)
- `parallel([fn, …])` — run thunks concurrently; **barrier** (awaits all).
- `pipeline(items, stage1, stage2, …)` — stream each item through stages independently (no inter-stage barrier).
- `phase(title)`, `log(msg)` — progress grouping + narration.
- `gate(produce, validate, opts?)` — returns `{ ok, value, verdict, attempts }`: `value` is the final producer result and `verdict` is the exact last validator return.
- `checkpoint()`, `verify()`, `judgePanel()`, `loopUntilDry()`, `completenessCheck()`, `retry()`, `workflow()`, `args`.

Determinism is enforced (`Date.now`/`Math.random`/`new Date()` are neutered in the realm) so replay identities and input fingerprints are reproducible. Eligible new-format calls match by exact path/hash or unique content; uncertain correspondence runs live.

> **Writing scripts with an AI agent?** The MCP `workflow` tool is self-contained: its description teaches the compact DSL, `action:"config"` exposes live choices, and `run` validates automatically. This repo also publishes an optional exhaustive backend-agnostic authoring skill —
> [`skills/agentprism-workflow-authoring`](skills/agentprism-workflow-authoring/SKILL.md) — in the standard
> `SKILL.md` format. Install it into your coding agent (Claude Code, Codex, Cursor, OpenCode, …) with the
> [skills.sh](https://skills.sh) CLI:
>
> ```bash
> npx skills add agentprism/agentprism-workflows
> ```
>
> It teaches the full DSL: per-call backend routing, structured outputs, checkpoints, isolation,
> and the determinism rules.

MCP users need no separate validation or discovery step outside the tool. For terminal and CI workflows, the packages retain equivalent commands. Validate a script **without spending tokens**: `npx @automatalabs/workflows validate <file> --args '<json>'`.
After its static parse and mock-agent dry run, validation opens each distinctly routed ACP harness
once without a prompt to surface its advertised mode/config-option catalogs and check authored
`mode` and `configOptions`. An unavailable or unauthenticated harness adds one warning and skips only its
configuration checks; it does not fail validation. Script a
false branch by resolved label with `--mock-answers '{"refute:*":{"real":false}}'`; reusable answers
deep-merge over fabricated schema defaults, and `$sequence` fixtures exercise multi-round convergence.
Exit codes: `0` valid, `1` parse failure, `2` dry-run failure. See the
[workflows validator guide](packages/workflows/README.md#validating-scripts--agentprism-workflows-validate)
for file fixtures, precedence, validation, limits, and reports.

Discover what a harness will negotiate **before** authoring: `npx @automatalabs/workflows config`
probes each routable harness (built-ins + registered customs) with one no-prompt, zero-token
session and prints its advertised modes plus config-option catalog — including each raw mode name,
description, and `_meta`, model ids, and effort levels. A successful result also reports
`defaultModeId`: omitted modes use Claude `auto`, Codex `agent`, OpenCode `build`, or no Pi mode.
Authored and built-in defaults must appear in `modes.availableModes`.
Name harnesses to scope it (`config codex`), `--json` for machines; it is the same table every validate report includes.

---

## Structured output

Pass a JSON Schema as `agent({ schema })` and the result is a **validated object**, not text. Claude and Codex use their agent-specific schema channels. Pi and OpenCode receive the injected client-hosted HTTP `StructuredOutput` MCP tool; the runner also retains the common prompt-embedded schema and validated last-text fallback. Generic ACP agents get the same tool when opted in. The public `agent({ schema })` API is unchanged. See [`docs/design-notes.md` §6](docs/design-notes.md) for the per-backend mechanics.

---

## Backends & selection

The public `@automatalabs/acp-agents` registry is the executable source of built-in identity:
`BUILTIN_BACKENDS`, ordered `BUILTIN_BACKEND_IDS`, exact-case `builtinBackend(id)`, and
`BUILTIN_PROTOCOL_COVERAGE`. `BuiltinBackendId`, `BuiltinBackendDefinition`,
`BuiltinBackendReleaseMetadata`, and `BuiltinProtocolCoverageRow` are exported types. Adding a
first-class backend follows the checked-in [backend onboarding checklist](docs/backend-onboarding-checklist.md),
including manifest regeneration, protocol disposition, documentation, packaging, and live evidence.

The backend is chosen per `agent()` call from the effective `model`/`tier` spec with one deterministic rule:

- Split on the first `/`. If the first segment, ASCII-case-insensitively, is `claude`, `codex`, `opencode`, `pi`, or a registered custom backend name, route there and strip exactly that segment. Custom registrations take priority on a name collision.
- A backend name alone (`claude`, `codex`, `opencode`, `pi`, or a custom name) selects no model, leaving that harness's configured default untouched.
- Otherwise route the entire authored string, unchanged, to the effective default backend. In the SDK runner this is `AGENTPRISM_DEFAULT_BACKEND` (historical fallback `claude`). In the MCP server an explicitly present environment value wins; when truly unset, a model-less workflow performs zero-token readiness probes and pins one project default before validation/execution. `anthropic/…`, `openai/…`, bare `opus`, and bare `gpt-…` are not routing aliases.
- When a model id remains, it is sent byte-for-byte through `session/set_config_option`: no catalog matching, case folding, bracket parsing, or fallback. Brackets, dots, and provider prefixes are ordinary id characters, and a harness rejection follows the existing agent-error path.

Per-call `configOptions` extends that same verbatim rule to the rest of the harness's ACP session
options: exact ids and string/boolean values are sent in ascending option-id order, after model
selection and before the prompt, with no aliases or coercion. The `"model"` key is reserved; use
the dedicated `model` field. Run the validator and read each harness's advertised-options table
before choosing ids or select values.

Live-catalog-verified examples are `claude/opus[1m]`, `codex/gpt-5.6-sol`, and `opencode/zai/glm-5.2`. Pi model specs use `pi/<provider>/<model-id>`; prefer backend-only forms when the desired model is configured inside the harness.

One long-lived ACP process per backend is **pooled** and reused across `agent()` calls (one spawn + one `initialize`). Calls normally open a fresh session; an eligible resume of a usage/auth-paused occurrence instead reopens that occurrence's recorded session and continues it. Worktree-isolated calls always stay on the fresh path, preserving isolation through each new session's `cwd`.

When an agent returns initialize-response `_meta`, every session ref and session-scoped runner event
includes it as a stable, recursively frozen `initializeMeta` snapshot. Absent or `null` metadata is
omitted. Extension owners inspect this raw snapshot at their own decision point; `acp-agents` does not
infer extension support from backend names, versions, or `agentCapabilities._meta`. Request and
response extension metadata is transported transparently except for documented protocol-critical
direct-collision winners; metadata never changes routing, pooling, retries, or workflow hashes.

### Custom backends — run *any* ACP agent

The built-ins aren't a limit: register **any ACP agent** (your own image-gen wrapper, a browser-QA agent, …) as a named backend and route to it by name.

```ts
import { createAcpRunner, runDynamicWorkflow } from "@automatalabs/workflows";

const runner = createAcpRunner({
  backends: {
    browser: {
      command: "node",
      args: ["/abs/path/to/browser-acp.js"],
      env: { HEADLESS: "1" },                          // merged over process.env
      sessionMeta: { allowedDomains: ["example.com"] }, // static session/new _meta defaults
    },
  },
});
await runDynamicWorkflow(script, { runner });
```

Inside a script: `agent("Verify the checkout flow…", { model: "browser", schema: VERDICT, meta: { credsRef: "vault://qa" } })`. `model: "browser/vision-large"` sends `vision-large` verbatim as the model id. The same registry can be declared without code via the `AGENTPRISM_BACKENDS` env var (JSON of the same shape) — which is how the MCP server picks it up. Names are ASCII-case-insensitive, and a registered custom name takes priority even when it matches `claude`, `codex`, `opencode`, or `pi`.

Custom backends speak a generic dialect: a `schema` is forwarded as turn-level `_meta.outputSchema` (plain JSON Schema), and when the initialized agent advertises HTTP MCP support the runner injects a localhost `StructuredOutput` MCP tool whose input schema is that same schema. Without HTTP MCP, or when `structuredOutputTool:false` is set on the backend config, the schema is stated in the prompt and the result is read by JSON-parsing the final assistant message. Per-call `meta` merges over the registry's `sessionMeta` defaults; protocol-critical keys (schema channels, `runId`) always win.

#### Script-declared backends (`meta.backends`)

A workflow script can also declare the backends it needs, so the workflow is a self-contained artifact (and so *agent-authored* workflows can bring their own ACP servers):

```js
export const meta = {
  name: "visual-qa",
  description: "verify the preview deployment",
  backends: {
    browser: { command: "browser-acp", args: ["--headless"], sessionMeta: { mode: "verify" } },
  },
};
const verdict = await agent("Verify the checkout flow…", { model: "browser", schema: VERDICT });
```

Script-declared backends spawn commands on the host, so they are **inert until approved** — the engine parses them but never acts on them:

- **SDK**: pass `allowScriptBackends: true` (or a per-backend approval callback) to `runDynamicWorkflow`; unapproved declarations throw with guidance rather than silently rerouting.
- **MCP server**: clients that support **elicitation** are asked to approve each unique spawn config (session-sticky); other clients get an informative tool error naming the `AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1` env opt-in.
- Host-registered names always win on conflict — a script can never hijack a name the operator configured.

---

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `AGENTPRISM_DEFAULT_BACKEND` | unset | Explicit backend when the model/tier doesn't imply one (`claude` \| `codex` \| `opencode` \| `pi` \| a registered custom name). When absent, the MCP server auto-selects and pins a project default from zero-token readiness probes; the SDK runner retains its historical Claude fallback. |
| `AGENTPRISM_BACKENDS` | (none) | Custom ACP backends as JSON: `{"<name>": {"command": "…", "args": […], "env": {…}, "sessionMeta": {…}}}`. Programmatic `createAcpRunner({ backends })` wins per name. |
| `AGENTPRISM_ALLOW_SCRIPT_BACKENDS` | (unset) | MCP server only: `1`/`true` approves **script-declared** `meta.backends` headlessly (for clients without elicitation support). |
| `AGENTPRISM_PERSISTENCE_ROOT` | `~/.agentprism/workflows` | Absolute root for persisted run state, logs, journals, and resume data. |
| `AGENTPRISM_ACP_POOL_SIZE` | `1` | Long-lived processes held per backend. |
| `AGENTPRISM_ACP_INIT_TIMEOUT_MS` | `60000` | Deadline for a backend's one-time ACP `initialize` handshake (a non-ACP command fails fast instead of hanging). |
| `AGENTPRISM_CLAUDE_ACP_CMD` / `…_ARGS` | (bundled) | Override the Claude ACP server command/args. |
| `AGENTPRISM_CODEX_ACP_CMD` / `…_ARGS` / `…_BIN` | (bundled) | Override the Codex ACP server command/args/binary. |
| `AGENTPRISM_OPENCODE_ACP_CMD` / `…_ARGS` | `opencode acp` | Override the OpenCode ACP server command/args. With `…_CMD` set, args come only from `…_ARGS`. |
| `AGENTPRISM_PI_ACP_CMD` / `…_ARGS` | bundled `@automatalabs/pi-acp` | Override the pi ACP server command/args. With `…_CMD` set, args come only from `…_ARGS`. |
| `AGENTPRISM_OPENCODE_E2E_MODEL` | `opencode/zai/glm-5.2` | Live e2e OpenCode model spec. |

---

## Documentation

- [`packages/workflows/examples/`](packages/workflows/examples/) — **runnable examples**, from a single gated script to a complete standalone project (`repo-triage`) that mixes three selected backends in one autonomous multi-stage run.
- [`docs/api.md`](docs/api.md) — **the API reference**: `WorkflowManager` options/lifecycle/events (incl. auth pauses and the `agentEvent` token-level stream), `ExecOptions`, the runner surface (`run()`, auth controller, session hand-off, model routing, event bus, interactive sessions, capabilities), backend resolution + environment variables, the SDK auth/provider APIs, and the full `WorkflowError` code table.
- [`docs/design-notes.md`](docs/design-notes.md) — the deep protocol-level design: ACP lifecycle, the structured-output crux, model/permission/usage/cancellation mechanics, and the engine lineage.
- [`skills/agentprism-workflow-authoring/`](skills/agentprism-workflow-authoring/SKILL.md) — the **agent skill for authoring workflow scripts** (install with `npx skills add agentprism/agentprism-workflows`): the DSL, per-call backend routing, structured output, and a full option reference, written for AI agents that write workflows.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — local development, testing (including the gated live-backend e2e), and releasing.
- [Agent Client Protocol](https://agentclientprotocol.com) · [Model Context Protocol](https://modelcontextprotocol.io)

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
