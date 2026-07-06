<p align="center">
  <img src="docs/assets/banner.png" alt="AgentPrism — One script. Many agents." />
</p>

# AgentPrism Workflows

Run **dynamic, multi-agent workflow scripts** — `agent()`, `parallel()`, `pipeline()` — over real coding agents (Claude Code and OpenAI Codex), with deterministic journaling, resume, token budgets, and git-worktree isolation.

You author a small JavaScript *script* (`export const meta`, then call `agent()` / `parallel()` / `pipeline()`); the engine runs it in a sandboxed realm, fanning each `agent()` call out to an [Agent Client Protocol](https://agentclientprotocol.com) (ACP) backend. It's available two ways:

- **As a TypeScript SDK** — `@automatalabs/workflows` — embed the runner in your own program.
- **As a stdio MCP server** — `@automatalabs/mcp-server`, built on the SDK — expose a `workflow` tool to any MCP host (Claude Code, Zed, …).

> The `@automatalabs/*` packages are **published on npm** — see [Install](#install). Two are user-facing: the `@automatalabs/workflows` SDK and the `@automatalabs/mcp-server` stdio server.

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
   claude-agent-acp / codex-acp   (long-lived, pooled subprocesses)
        │  → real Claude / Codex agents, one session per agent() call
```

The deterministic engine (sandboxed `vm` realm, `parallel`/`pipeline`, journal/resume, token budget, worktree isolation) is independent of *how* a single agent runs and of *how* the tool is exposed. See [`docs/design-notes.md`](docs/design-notes.md) for the full protocol-level design.

---

## Requirements

- **Node.js ≥ 22** and **pnpm ≥ 10** (see `.nvmrc` / `packageManager`).
- A backend agent CLI, authenticated on your machine:
  - **Claude** — via the bundled `@agentclientprotocol/claude-agent-acp`; auth from `~/.claude/.credentials.json` or `ANTHROPIC_API_KEY` (the orchestrator inherits your environment).
  - **Codex** — via `@automatalabs/codex-acp` (+ the `@openai/codex` binary, installed as a dependency); auth from `~/.codex/auth.json`.

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

Two packages are **user-facing** — start with one of these:

| Package | What it is |
|---|---|
| **`@automatalabs/workflows`** | The canonical public **SDK** — a thin facade that runs workflow scripts programmatically over the default ACP backend, and re-exports the engine + backend surface. Start here. |
| **`@automatalabs/mcp-server`** | The stdio **MCP server** (bin: `agentprism-workflow`) exposing the `workflow` tool — built on `@automatalabs/workflows`. |

The other three are **internal building blocks**, composed by the SDK. You don't depend on them directly: `@automatalabs/workflows` is the public entry point for everything they export.

| Package | What it is |
|---|---|
| **`@automatalabs/acp-agents`** | The ACP client + `Claude`/`Codex` backends (the `AgentRunner` implementation, connection pooling, structured output, permissions, usage). Internal — public entry is `@automatalabs/workflows`. |
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
  model: "opus",          // routes to Claude; e.g. "gpt-5-codex" routes to Codex
  cwd: process.cwd(),
});
// data is typed/validated against the schema (a plain object, not text)
await runner.dispose();   // closes pooled backend processes
```

---

## Quickstart — MCP server

The `workflow` tool runs a script to completion synchronously, streaming `notifications/progress`, and returns the structured result.

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
      "args": ["/abs/path/to/agentprism-workflows/packages/mcp-server/dist/index.js"]
    }
  }
}
```

**Tool: `workflow`** — input parameters:

| Param | Type | Notes |
|---|---|---|
| `script` | string (**required**) | Raw JS; first statement must be `export const meta = { name, description, phases? }`; must call `agent()` at least once. |
| `args` | any | Exposed to the script as the global `args`. |
| `maxAgents` | number | Default 1000. |
| `concurrency` | number | **Clamped** to 16 (not rejected). |
| `agentRetries` | number | **Clamped** to 3. |
| `agentTimeoutMs` | number \| null | Per-agent timeout; omit for none. |
| `tokenBudget` | number \| null | Hard total-token cap for the run; omit for none. |
| `resumeFromRunId` | string | Resume a prior run from its persisted journal (resume is **explicit**). |

The run is synchronous (one `tools/call` = one full run). Resume after a pause/crash by calling `workflow` again with `resumeFromRunId`.

---

## Writing workflow scripts

A script is plain JavaScript whose **first statement** is the `meta` literal. Inside it, these globals are available (injected into the run's realm — they are not importable functions; `@automatalabs/workflows` ships an ambient `.d.ts` so your editor knows them):

- `agent(prompt, opts?)` — run one subagent. With `opts.schema` (a JSON Schema) you get a validated object back; without it, the assistant's text. Other opts: `label`, `phase`, `model`/`tier`, `agentType`, `isolation`, `timeoutMs`, `retries`, `mcpServers`, `meta`, `promptMeta`. (`meta`/`promptMeta` are generic ACP `_meta` passthroughs merged into `session/new` / `session/prompt` — the protocol's extension surface for custom agent properties. Working directory comes from worktree `isolation`; tool policy and instructions come from the `agentType` definition. `cwd`/`toolNames`/`instructions` are options on the lower-level `createAcpRunner().run()` API, not script-level `agent()` opts.)
- `parallel([fn, …])` — run thunks concurrently; **barrier** (awaits all).
- `pipeline(items, stage1, stage2, …)` — stream each item through stages independently (no inter-stage barrier).
- `phase(title)`, `log(msg)` — progress grouping + narration.
- `budget` — the run's token budget (`budget.total`, `budget.remaining()`, `budget.spent()`).
- `checkpoint()`, `gate()`, `verify()`, `judgePanel()`, `loopUntilDry()`, `completenessCheck()`, `retry()`, `workflow()`, `args`.

Determinism is enforced (`Date.now`/`Math.random`/`new Date()` are neutered in the realm) so a killed run **resumes** from its journal with a cache-hit on the unchanged prefix.

---

## Structured output

Pass a JSON Schema as `agent({ schema })` and the result is a **validated object**, not text. Each backend constrains generation natively (Claude via its output-format channel; Codex via a turn-level `outputSchema`), then the runner validates and re-prompts on mismatch. See [`docs/design-notes.md` §6](docs/design-notes.md) for the per-backend mechanics.

---

## Backends & selection

The backend is chosen per `agent()` call from the `model`/`tier` you pass, by provider prefix:

- A **registered custom backend name** (exact, or `name/<inner-model>`) → that backend — matched first, see below.
- `opus`, `sonnet`, `haiku`, `claude…`, `anthropic/…` → **Claude** (`claude-agent-acp`).
- `gpt…`, `codex…`, `o3`/`o4`, `openai/…` → **Codex** (`codex-acp`).
- Otherwise the default backend (`AGENTPRISM_DEFAULT_BACKEND`, default `claude` — may also name a registered custom backend).

One long-lived ACP process per backend is **pooled** and reused across `agent()` calls (one spawn + one `initialize`), with a fresh session per call — so worktree isolation is preserved via each session's `cwd`.

### Custom backends — run *any* ACP agent

The built-in pair isn't a limit: register **any ACP agent** (your own image-gen wrapper, a browser-QA agent, …) as a named backend and route to it by name.

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

Inside a script: `agent("Verify the checkout flow…", { model: "browser", schema: VERDICT, meta: { credsRef: "vault://qa" } })`. `model: "browser/vision-large"` additionally selects `vision-large` via the agent's config-option catalog. The same registry can be declared without code via the `AGENTPRISM_BACKENDS` env var (JSON of the same shape) — which is how the MCP server picks it up. Names are case-insensitive; `claude`/`codex` are reserved.

Custom backends speak a generic dialect: a `schema` is forwarded as turn-level `_meta.outputSchema` (plain JSON Schema) **and** stated in the prompt's output contract, and the result is read by JSON-parsing the final assistant message — agents that ignore the schema channel still work via the client-side validate/re-prompt ladder. Per-call `meta` merges over the registry's `sessionMeta` defaults; protocol-critical keys (schema channels, `runId`) always win.

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
| `AGENTPRISM_DEFAULT_BACKEND` | `claude` | Backend when the model/tier doesn't imply one (`claude` \| `codex` \| a registered custom name). |
| `AGENTPRISM_BACKENDS` | (none) | Custom ACP backends as JSON: `{"<name>": {"command": "…", "args": […], "env": {…}, "sessionMeta": {…}}}`. Programmatic `createAcpRunner({ backends })` wins per name. |
| `AGENTPRISM_ALLOW_SCRIPT_BACKENDS` | (unset) | MCP server only: `1`/`true` approves **script-declared** `meta.backends` headlessly (for clients without elicitation support). |
| `AGENTPRISM_ACP_POOL_SIZE` | `1` | Long-lived processes held per backend. |
| `AGENTPRISM_ACP_INIT_TIMEOUT_MS` | `60000` | Deadline for a backend's one-time ACP `initialize` handshake (a non-ACP command fails fast instead of hanging). |
| `AGENTPRISM_CLAUDE_ACP_CMD` / `…_ARGS` | (bundled) | Override the Claude ACP server command/args. |
| `AGENTPRISM_CODEX_ACP_CMD` / `…_ARGS` / `…_BIN` | (bundled) | Override the Codex ACP server command/args/binary. |

---

## Documentation

- [`docs/api.md`](docs/api.md) — **the API reference**: `WorkflowManager` options/lifecycle/events, `ExecOptions` (incl. per-run `cwd` for worktree-per-run hosts), the runner surface (`run()`, model routing, event bus, interactive sessions, capabilities), backend resolution + every environment variable, and the full `WorkflowError` code table.
- [`docs/design-notes.md`](docs/design-notes.md) — the deep protocol-level design: ACP lifecycle, the structured-output crux, model/permission/usage/cancellation mechanics, and the engine lineage.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — local development, testing (including the gated live-backend e2e), and releasing.
- [Agent Client Protocol](https://agentclientprotocol.com) · [Model Context Protocol](https://modelcontextprotocol.io)

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
