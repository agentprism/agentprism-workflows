<p align="center">
  <img src="docs/assets/banner.png" alt="AgentPrism — One script. Many agents." />
</p>

# AgentPrism Workflows

<p align="center">
  <a href="https://www.npmjs.com/package/@automatalabs/workflows"><img src="https://img.shields.io/npm/v/@automatalabs/workflows?logo=npm&color=cb3837" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@automatalabs/workflows"><img src="https://img.shields.io/npm/dm/@automatalabs/workflows?color=cb3837" alt="npm downloads" /></a>
  <a href="https://deepwiki.com/VikashLoomba/agentprism-workflows"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki" /></a>
</p>

Run **dynamic, multi-agent workflow scripts** — `agent()`, `parallel()`, `pipeline()` — over real coding agents (Claude Code, OpenAI Codex, and OpenCode), with deterministic journaling, resume, token budgets, and git-worktree isolation.

You author a small JavaScript *script* (`export const meta`, then call `agent()` / `parallel()` / `pipeline()`); the engine runs it in a sandboxed realm, fanning each `agent()` call out to an [Agent Client Protocol](https://agentclientprotocol.com) (ACP) backend. It's available two ways:

- **As a TypeScript SDK** — `@automatalabs/workflows` — embed the runner in your own program.
- **As a stdio MCP server** — `@automatalabs/mcp-server`, built on the SDK — expose a `workflow` tool to any MCP host (Claude Code, Zed, …).

> The `@automatalabs/*` packages are **published on npm** — see [Install](#install). Two are user-facing: the `@automatalabs/workflows` SDK and the `@automatalabs/mcp-server` stdio server.

---

## Why AgentPrism

### Real harnesses, driven over an open protocol

Each `agent()` call runs on a **shipped coding agent** — Claude Code, Codex, or OpenCode — driven over [ACP](https://agentclientprotocol.com), rather than a reimplementation of an agent loop around raw model APIs. You get each backend's own tool loop, permissions, and context management, plus the auth you already have on your machine (`~/.claude/.credentials.json`, `~/.codex/auth.json`, or `opencode auth login`). When the harness improves, your workflows improve with no code change here.

### Many agents, one workflow

The backend is chosen **per `agent()` call**: an `opus` review step, a `gpt-5.5` implementation step, an `opencode/zai/glm-5.2` planning step, and a custom `browser` QA agent can share one script, hand each other structured results, and be swapped independently. Any ACP server registers as a named backend — the built-ins are defaults, not a boundary.

### Durable runs — resume without re-spending tokens

Scripts run in a deterministic realm and every `agent()` call is journaled under an identity hash. Kill the process mid-run — crash, deploy, Ctrl-C — and `resume()` replays the completed prefix from the journal as cache-hits (**zero tokens**), then executes only the steps that never ran. Provider quota walls don't fail the run either: it **pauses** with the provider's reset hint and resumes after the budget refills.

> **Resume rule:** `args` changes don't invalidate the journal; prompt changes cache-miss from the first changed call.
>
> `args` is not itself part of an `agent()` call's replay hash. New args can raise an orchestration-only loop cap while earlier calls keep replaying for zero tokens. If the new args change a prompt or another hashed identity field, replay stops at the first affected call and that call plus every later call runs live. The hashed identity is the prompt, resolved model, mode when set, tier, phase, agent type and resolved agent definition, and schema. `label`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`, and `keepSession` do not invalidate a cached call; changed values apply only to calls that run live.

### Structured output as validated objects

`agent({ schema })` returns a schema-validated object, not text to parse. Claude and Codex constrain generation natively; OpenCode and eligible custom ACP agents get a client-hosted `StructuredOutput` MCP tool injected automatically when they advertise HTTP MCP support. The runner still validates and re-prompts on mismatch, so the same API works for native, tool-capture, and final-text JSON fallback paths.

### The full ACP spec, enforced by the build

Every client-side ACP method is served (`fs/*`, `terminal/*`, permission requests, elicitation, MCP-over-ACP) and the agent-side surface — session modes, session lifecycle, auth/providers — is driven, not stubbed. A coverage manifest keyed off the SDK's method constants breaks the build on protocol drift, and a live end-to-end suite against real Claude, Codex, and OpenCode backends gates every push.

### Controls for unattended runs

Hard token budgets (run-level caps, `budget.remaining()` in-script), per-call git **worktree isolation**, per-call timeouts and retries, and `checkpoint()` — a deterministic, journaled human gate with three modes. A live SDK `confirm` callback or MCP elicitation collects the reply immediately; without a live channel, the default mode takes `default ?? true` (or `headless: "abort"` aborts), so detached runs never hang by default. Authors can opt into a durable pause with `headless: "pause"`: the run returns `status: "paused"` plus `checkpointContext`, the host resumes with `checkpointReplies`, and the decision is journaled and replayed without re-asking. For watching those runs from the outside, `@automatalabs/agentprism-otel` attaches to any `WorkflowManager` and exports OpenTelemetry traces (run → agent → tool call) plus token, cost, and duration metrics.

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
        │  session/new, session/prompt … (ACP, JSON-RPC over stdio)
        ▼
   claude-agent-acp / codex-acp / opencode acp   (long-lived, pooled subprocesses)
        │  → real Claude / Codex / OpenCode agents, one session per agent() call
```

The deterministic engine (sandboxed `vm` realm, `parallel`/`pipeline`, journal/resume, token budget, worktree isolation) is independent of *how* a single agent runs and of *how* the tool is exposed. See [`docs/design-notes.md`](docs/design-notes.md) for the full protocol-level design.

---

## Requirements

- **Node.js ≥ 22** and **pnpm ≥ 10** (see `.nvmrc` / `packageManager`).
- A backend agent CLI, authenticated on your machine:
  - **Claude** — via the bundled `@agentclientprotocol/claude-agent-acp`; auth from `~/.claude/.credentials.json` or `ANTHROPIC_API_KEY` (the orchestrator inherits your environment).
  - **Codex** — via `@automatalabs/codex-acp` (+ the `@openai/codex` binary, installed as a dependency); auth from `~/.codex/auth.json`.
  - **OpenCode** — supported but **not bundled**. Install the `opencode` CLI on PATH or add `opencode-ai` to your own project (its platform binaries are large), then authenticate with `opencode auth login`.

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

Two packages are the primary **user-facing entry points** — start with one of these:

| Package | What it is |
|---|---|
| **`@automatalabs/workflows`** | The canonical public **SDK** — a thin facade that runs workflow scripts programmatically over the default ACP backend, and re-exports the supported engine + backend integration surface. Start here. |
| **`@automatalabs/mcp-server`** | The stdio **MCP server** (bin: `agentprism-workflow`) exposing one `workflow` tool for foreground/background run, await, resume, and inspect — built on `@automatalabs/workflows`. |

One optional integration package attaches to the SDK's manager surface:

| Package | What it is |
|---|---|
| **`@automatalabs/agentprism-otel`** | OpenTelemetry traces and metrics for a `WorkflowManager`; peer-depends only on `@opentelemetry/api` and no-ops when the host has no OTel SDK. |

The other three are **internal building blocks**, composed by the SDK. You normally don't depend on them directly: `@automatalabs/workflows` is the public entry point for the supported orchestration surface.

| Package | What it is |
|---|---|
| **`@automatalabs/acp-agents`** | The ACP client + Claude/Codex/OpenCode/custom backends (the `AgentRunner` implementation, connection pooling, auth/session lifecycle, structured output, permissions, usage). Internal — public entry is `@automatalabs/workflows`. |
| **`@automatalabs/workflow-engine`** | The deterministic engine: the script realm, `parallel`/`pipeline`, journal/resume, budgets, worktree isolation. Internal — public entry is `@automatalabs/workflows`. |
| **`@automatalabs/shared-types`** | The `AgentRunner` seam + shared types the others compose against. Internal — public entry is `@automatalabs/workflows`. |

Dependency direction: `mcp-server` → `workflows` → `{ workflow-engine, acp-agents, shared-types }`. The SDK (`workflows`) is the single facade that composes the deterministic engine and the ACP backend, which meet only at the `AgentRunner` seam in `shared-types`. The engine never names a backend; the agents never know they're inside a workflow.

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

`runDynamicWorkflow` resolves to a **terminal** `WorkflowRunResult` even on pause/fail/abort — read `run.status` instead of catching. To swap the backend (or stub it in tests), pass your own runner: `runDynamicWorkflow(script, { runner })`. For lower-level control, use `WorkflowManager` / `runWorkflow` (also re-exported from the SDK).

### Run a single agent directly

```ts
import { createAcpRunner } from "@automatalabs/workflows";

const runner = createAcpRunner();
const data = await runner.run("Summarize this repo as JSON {summary}.", {
  schema: {
    type: "object", additionalProperties: false,
    required: ["summary"], properties: { summary: { type: "string" } },
  },
  model: "opus",          // routes to Claude; e.g. "gpt-5.5" routes to Codex
  cwd: process.cwd(),
});
// data is typed/validated against the schema (a plain object, not text)
await runner.dispose();   // closes pooled backend processes
```

---

## Quickstart — MCP server

The single `workflow` tool runs in the foreground by default, can acknowledge long work with
`background: true`, waits for it with bounded `action: "await"` calls, and safely inspects any known
project-scoped run by ID. Foreground execution streams `notifications/progress` and returns the
terminal structured result.

Register the stdio server in your MCP host's config:

```json
{
  "mcpServers": {
    "agentprism-workflow": {
      "command": "agentprism-workflow",
      "env": { "AGENTPRISM_DEFAULT_BACKEND": "claude" }
    }
  }
}
```

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

**Tool: `workflow`** — input parameters:

| Param | Type | Notes |
|---|---|---|
| `action` | `"run" \| "inspect" \| "await"` | Omit for the legacy run form. `"inspect"` reads immediately; `"await"` waits only for terminal lifecycle state. |
| `script` | string (required for run) | Raw JS; first statement must be `export const meta = { name, description, phases? }`. Forbidden for inspect/await. |
| `background` | boolean | Run only; default `false`. `true` returns `{ runId, status: "running" }` after durable admission. |
| `args` | any | Exposed to the script as the global `args`. |
| `maxAgents` | number | Default 1000. |
| `concurrency` | number | **Clamped** to 16 (not rejected). |
| `agentRetries` | number | **Clamped** to 3. |
| `agentTimeoutMs` | number \| null | Per-agent timeout; omit for none. |
| `tokenBudget` | number \| null | Hard total-token cap for the run; omit for none. |
| `resumeFromRunId` | string | Resume a prior run from its persisted journal (resume is **explicit**). |
| `checkpointReplies` | object | With `resumeFromRunId`, map a paused `checkpointContext.callIndex` to its decision. JSON string keys are accepted and coerced to numbers. |
| `runId` | string | Required for inspect/await; the project-scoped run capability returned by execution. |
| `waitMs` | integer | Await only: default 20,000, range 0–25,000; zero is a non-blocking status read. |
| `lastN` | integer | Inspect/await: latest matching calls, default 20, range 1–50. |
| `labelGlob` | string | Inspect/await: case-sensitive whole-label glob (`*`, `?`, backslash escaping). |
| `logLines` | integer | Inspect/await: latest log lines, default 20, range 0–50. |

Foreground remains the default. For long work, start it and retain the new run ID:

```json
{ "script": "export const meta = { name: 'review', description: 'review' }; return await agent('Review the repo');", "background": true }
```

Then long-poll in ordinary bounded tool calls until `outcome` appears:

```json
{ "action": "await", "runId": "mabc1234-k9x2pq", "waitMs": 20000 }
```

A timeout returns the freshest bounded status and partial cumulative token usage; terminal await
adds the same raw result/log projection a foreground call returns. At most four background runs may
be active or starting per server process. Background means detached from the initiating MCP request,
not from the stdio server process: process exit can stop in-flight work, while the durable journal
prefix remains resumable. Background runs send no request progress and use authored headless
checkpoint behavior. Resume after a pause/crash by starting a new run with `resumeFromRunId`; each
new background run durably inherits the replay prefix under its new run ID before acknowledgement.

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

Call `workflow` once with that script and `args: { "maxRounds": 6 }`. Copy the returned `runId`, then call `workflow` again with the same script, `args: { "maxRounds": 8 }`, and that ID as `resumeFromRunId`. Rounds 1–6 rebuild the same prompts and replay from the journal at zero token cost; only rounds 7 and 8 run live. Keep the cap out of the round prompt: interpolating `maxRounds` there would change round 1's prompt and make all eight rounds run live.

Retain every returned `runId`. Before guessing why a run paused or failed, inspect its safe log and
call tail:

```json
{ "action": "inspect", "runId": "mabc1234-k9x2pq", "lastN": 10, "labelGlob": "review-*", "logLines": 20 }
```

Inspection returns lifecycle status, ordered phases, a redacted log tail, and attributed compact
call previews. Its structured payload is capped at 24,576 UTF-8 bytes and its text at 8,192 bytes.
Paused, failed, and aborted execution responses also include a redacted final-20 `logTail` immediately.

The `workflow` tool is the server's whole *tool* surface; prompt-capable hosts additionally get the user-controlled **`author-workflow`** MCP prompt (optional `task` argument), which injects the complete bundled authoring guide — in Claude Code it surfaces as a slash command. Backend auth belongs to the agents' own CLI credential stores (`claude /login`, `codex login`, `opencode auth login`) — logged-in CLIs need no extra step. An `AUTH_REQUIRED` fault pauses the workflow with `reason: "auth_required"` and a non-secret `authContext` naming the backend; log that CLI in out-of-band, then call `workflow` again with the paused `resumeFromRunId`. Programmatic auth/provider management lives in the `@automatalabs/workflows` SDK runner APIs.

---

## Writing workflow scripts

A script is plain JavaScript whose **first statement** is the `meta` literal. Inside it, these globals are available (injected into the run's realm — they are not importable functions; `@automatalabs/workflows` ships an ambient `.d.ts` so your editor knows them):

- `agent(prompt, opts?)` — run one subagent. With `opts.schema` (a JSON Schema) you get a validated object back; without it, the assistant's text. Other opts: `label`, `phase`, `model`/`tier`, `mode`, `agentType`, `isolation`, `cwd`, `timeoutMs`, `retries`, `mcpServers`, `images`, `meta`, `promptMeta`, `keepSession`. (`keepSession` preserves the agent-side session for host re-attachment and records it in `WorkflowRunResult.agentSessions`; `meta`/`promptMeta` are generic ACP `_meta` passthroughs merged into `session/new` / `session/prompt`. Tool policy and instructions come from the `agentType` definition; `toolNames`/`instructions` remain lower-level `createAcpRunner().run()` API options.)
- `parallel([fn, …])` — run thunks concurrently; **barrier** (awaits all).
- `pipeline(items, stage1, stage2, …)` — stream each item through stages independently (no inter-stage barrier).
- `phase(title)`, `log(msg)` — progress grouping + narration.
- `budget` — the run's token budget (`budget.total`, `budget.remaining()`, `budget.spent()`).
- `gate(produce, validate, opts?)` — returns `{ ok, value, verdict, attempts }`: `value` is the final producer result and `verdict` is the exact last validator return.
- `checkpoint()`, `verify()`, `judgePanel()`, `loopUntilDry()`, `completenessCheck()`, `retry()`, `workflow()`, `args`.

Determinism is enforced (`Date.now`/`Math.random`/`new Date()` are neutered in the realm) so a killed run **resumes** from its journal with a cache-hit on the unchanged prefix.

> **Writing scripts with an AI agent?** This repo publishes a backend-agnostic authoring skill —
> [`skills/agentprism-workflow-authoring`](skills/agentprism-workflow-authoring/SKILL.md) — in the standard
> `SKILL.md` format. Install it into your coding agent (Claude Code, Codex, Cursor, OpenCode, …) with the
> [skills.sh](https://skills.sh) CLI:
>
> ```bash
> npx skills add VikashLoomba/agentprism-workflows
> ```
>
> It teaches the full DSL: per-call backend routing, structured outputs, checkpoints, budgets, isolation,
> and the determinism rules.

Validate a script **without spending tokens** (static parse + a dry run over a mock agent backend — no
ACP process, no auth needed): `npx @automatalabs/workflows validate <file> --args '<json>'`. Script a
false branch by resolved label with `--mock-answers '{"refute:*":{"real":false}}'`; reusable answers
deep-merge over fabricated schema defaults, and `$sequence` fixtures exercise multi-round convergence.
Exit codes: `0` valid, `1` parse failure, `2` dry-run failure. See the
[workflows validator guide](packages/workflows/README.md#validating-scripts--agentprism-workflows-validate)
for file fixtures, precedence, validation, limits, and reports.

---

## Structured output

Pass a JSON Schema as `agent({ schema })` and the result is a **validated object**, not text. Claude and Codex constrain generation natively (Claude via its output-format channel; Codex via a turn-level `outputSchema`), while OpenCode uses the injected client-hosted `StructuredOutput` MCP tool when it advertises HTTP MCP support. Generic ACP agents get that same tool when opted in. The runner validates and re-prompts on mismatch; the public `agent({ schema })` API is unchanged. See [`docs/design-notes.md` §6](docs/design-notes.md) for the per-backend mechanics.

---

## Backends & selection

The backend is chosen per `agent()` call from the `model`/`tier` you pass, by provider prefix:

- A **registered custom backend name** (exact, or `name/<inner-model>`) → that backend — matched first, see below.
- `opencode`, `opencode/<provider/model>` → **OpenCode** (`opencode acp`). The inner model is an OpenCode catalog id such as `zai/glm-5.2`; bracket modifiers such as `opencode/zai/glm-5.2[high]` drive OpenCode's effort option.
- `opus`, `sonnet`, `haiku`, `claude…`, `anthropic/…` → **Claude** (`claude-agent-acp`).
- `gpt…`, `codex…`, `o3`/`o4`, `openai/…` → **Codex** (`codex-acp`).
- Otherwise the default backend (`AGENTPRISM_DEFAULT_BACKEND`, default `claude` — may also name a registered custom backend).

One long-lived ACP process per backend is **pooled** and reused across `agent()` calls (one spawn + one `initialize`), with a fresh session per call — so worktree isolation is preserved via each session's `cwd`.

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

Inside a script: `agent("Verify the checkout flow…", { model: "browser", schema: VERDICT, meta: { credsRef: "vault://qa" } })`. `model: "browser/vision-large"` additionally selects `vision-large` via the agent's config-option catalog. The same registry can be declared without code via the `AGENTPRISM_BACKENDS` env var (JSON of the same shape) — which is how the MCP server picks it up. Names are case-insensitive; `claude`, `codex`, and `opencode` are reserved.

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
| `AGENTPRISM_DEFAULT_BACKEND` | `claude` | Backend when the model/tier doesn't imply one (`claude` \| `codex` \| `opencode` \| a registered custom name). |
| `AGENTPRISM_BACKENDS` | (none) | Custom ACP backends as JSON: `{"<name>": {"command": "…", "args": […], "env": {…}, "sessionMeta": {…}}}`. Programmatic `createAcpRunner({ backends })` wins per name. |
| `AGENTPRISM_ALLOW_SCRIPT_BACKENDS` | (unset) | MCP server only: `1`/`true` approves **script-declared** `meta.backends` headlessly (for clients without elicitation support). |
| `AGENTPRISM_PERSISTENCE_ROOT` | `~/.agentprism/workflows` | Absolute root for persisted run state, logs, journals, and resume data. |
| `AGENTPRISM_ACP_POOL_SIZE` | `1` | Long-lived processes held per backend. |
| `AGENTPRISM_ACP_INIT_TIMEOUT_MS` | `60000` | Deadline for a backend's one-time ACP `initialize` handshake (a non-ACP command fails fast instead of hanging). |
| `AGENTPRISM_CLAUDE_ACP_CMD` / `…_ARGS` | (bundled) | Override the Claude ACP server command/args. |
| `AGENTPRISM_CODEX_ACP_CMD` / `…_ARGS` / `…_BIN` | (bundled) | Override the Codex ACP server command/args/binary. |
| `AGENTPRISM_OPENCODE_ACP_CMD` / `…_ARGS` | `opencode acp` | Override the OpenCode ACP server command/args. With `…_CMD` set, args come only from `…_ARGS`. |
| `AGENTPRISM_OPENCODE_E2E_MODEL` | `opencode/zai/glm-5.2` | Live e2e OpenCode model spec. |

---

## Documentation

- [`packages/workflows/examples/`](packages/workflows/examples/) — **runnable examples**, from a single gated script to a complete standalone project (`repo-triage`) that mixes all three backends in one autonomous multi-stage run.
- [`docs/api.md`](docs/api.md) — **the API reference**: `WorkflowManager` options/lifecycle/events (incl. auth pauses and the `agentEvent` token-level stream), `ExecOptions`, the runner surface (`run()`, auth controller, session hand-off, model routing, event bus, interactive sessions, capabilities), backend resolution + environment variables, MCP auth tools, and the full `WorkflowError` code table.
- [`docs/design-notes.md`](docs/design-notes.md) — the deep protocol-level design: ACP lifecycle, the structured-output crux, model/permission/usage/cancellation mechanics, and the engine lineage.
- [`skills/agentprism-workflow-authoring/`](skills/agentprism-workflow-authoring/SKILL.md) — the **agent skill for authoring workflow scripts** (install with `npx skills add VikashLoomba/agentprism-workflows`): the DSL, per-call backend routing, structured output, and a full option reference, written for AI agents that write workflows.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — local development, testing (including the gated live-backend e2e), and releasing.
- [Agent Client Protocol](https://agentclientprotocol.com) · [Model Context Protocol](https://modelcontextprotocol.io)

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
