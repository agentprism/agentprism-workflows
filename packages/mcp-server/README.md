# @automatalabs/mcp-server

A **stdio [MCP](https://modelcontextprotocol.io) server** for running dynamic, multi-agent workflow scripts from any MCP host (Claude Code, Zed, Cursor, …). Its whole tool surface is the single **`workflow`** tool: agent backends authenticate from their own CLI credential stores (`claude /login`, `codex login`, `opencode auth login`), so there is nothing auth-shaped for a host to manage here. A run that genuinely hits an expired/missing login pauses with `authContext` and resumes (`resumeFromRunId`) after you log the backend's CLI in. Auth and provider *management* APIs live in the [`@automatalabs/workflows`](../workflows) SDK for embedding hosts.

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
│   • WorkflowManager.runSync(script, args, exec)     │
└────────────────────────────────────────────────────┘
        │   session/new, session/prompt … (ACP over stdio)
        ▼
   claude-agent-acp / codex-acp / opencode acp
        │  → real Claude / Codex / OpenCode agents
```

One `tools/call` to `workflow` runs a complete workflow **synchronously** (see [Run model](#run-model)). `stdout` is reserved for JSON-RPC framing — every diagnostic the server emits goes to `stderr`.

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

The tool's input schema (validated by the MCP SDK before the handler runs). Numeric **bounds are not encoded in the schema** — out-of-range values are **clamped**, not rejected, so a host can pass aggressive knobs without getting a `-32602`.

| Param | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `script` | string (non-empty) | **yes** | — | Raw JavaScript workflow script (no Markdown fences). The first statement **must** be `export const meta = { name, description, phases? }`. Agentless scripts are valid; validation warns only when the script has neither `agent()` nor `checkpoint()`. Saved workflow names are not resolved by this MCP input. |
| `args` | any JSON value | no | — | Optional value exposed to the script as the global `args`. |
| `maxAgents` | integer > 0 | no | `1000` | Max agents allowed in this run (engine cap `MAX_AGENTS_PER_RUN`). Values below 1 are clamped up to 1. |
| `concurrency` | integer > 0 | no | engine default | Max concurrent agents. **Clamped to 16** (the runtime max) by the engine — never rejected. |
| `agentRetries` | integer ≥ 0 | no | engine default | Retry attempts for recoverable agent failures. **Clamped to 3** (the runtime max). |
| `agentTimeoutMs` | integer > 0 \| null | no | none | Per-agent timeout in ms. Omit or pass `null` for no hard timeout (the engine owns timeouts). |
| `tokenBudget` | integer > 0 \| null | no | none | Hard total-token budget for the whole run. Omit or pass `null` for no limit. |
| `resumeFromRunId` | string | no | — | Resume a prior run from its persisted journal (the engine replays the unchanged prefix and runs the rest live). See [Run model](#run-model). |
| `checkpointReplies` | object | no | — | With `resumeFromRunId`, map `checkpointContext.callIndex` to the durable checkpoint decision. JSON string keys are coerced to numeric indexes. |

Example call arguments:

```json
{
  "script": "export const meta = { name: 'review', description: 'review a diff' };\nconst r = await agent('Review this diff and summarize risks:\\n' + args.diff);\nreturn r;",
  "args": { "diff": "diff --git a/x b/x\n+console.log(1)" },
  "concurrency": 4,
  "tokenBudget": 200000
}
```

### Output

The tool returns both machine-readable `structuredContent` and a human-readable text block. The structured shape pins the durable core of the engine's run result:

```ts
interface WorkflowToolResult {
  runId: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
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
  authContext?: AuthErrorContext;           // auth_required pauses only
  checkpointContext?: CheckpointContext;   // checkpoint_required pauses only
}
```

`status` lets a host distinguish a `completed` run from a `paused` one (resumable via `resumeFromRunId`) without parsing logs. The tool result is flagged `isError` when `status` is `failed` or `aborted`. A `result` field is only present when `status === "completed"`.

---

## Run model

- **Synchronous.** One `tools/call` to `workflow` is one full run, awaited to completion (the tool is a plain handler — background tasks are not used). When the call resolves, the run has reached a terminal state.
- **Progress notifications.** When the host includes a `progressToken` with the call, the server streams `notifications/progress` as agents settle (it reports `settled / total` agents plus the current phase). With no `progressToken`, progress is a no-op.
- **Terminal status, not exceptions.** An ordinary pause/fail/abort does **not** throw — the run resolves to a `WorkflowRunResult` with `status` already stamped (`completed | paused | failed | aborted`) plus an optional `reason`/`resetHint`. Only a malformed script (which fails before a run exists) surfaces as an MCP tool error.
- **Explicit resume.** A run can pause for a provider usage limit, missing authentication, or an opted-in durable checkpoint. Its journal is persisted under the returned `runId`. To continue, call `workflow` again with the **same `script`** plus `resumeFromRunId: "<that runId>"`; the engine re-hydrates the journal, replays the unchanged prefix deterministically, and runs the remainder live.
- **Checkpoints.** A script's `checkpoint()` gate uses MCP **elicitation** as its live channel when the connected client advertises it. Without elicitation, the authored headless mode applies: the default remains `default ?? true`, `headless: "abort"` aborts, and only `headless: "pause"` durably pauses with `checkpointContext`. Resume that pause with `resumeFromRunId` plus `checkpointReplies: { "<callIndex>": <decision> }`; an elicitation-capable client may instead answer live on resume. The decision is journaled and replayed, so detached runs never pause for checkpoints unless the workflow author opts in.

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

Beyond the built-ins, **any ACP agent** can be registered as a named backend via `AGENTPRISM_BACKENDS` (see the table below) and routed to with `agent(p, { model: "<name>" })` — or `"<name>/<inner-model>"` to also select a model from the agent's catalog. Scripts can pass arbitrary session/turn `_meta` to such agents with `agent(p, { meta, promptMeta })`.

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

Other exports include `workflowToolInputShape` / `clampWorkflowInput` (the input schema + clamp), `workflowToolOutputShape` / `toWorkflowToolResult` (the output schema + projector), `createProgressReporter`, and a `main()` that runs the default stdio server. For anything beyond hosting this tool, prefer `@automatalabs/workflows`.

---

## License

Apache-2.0
