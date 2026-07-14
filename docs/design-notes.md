# AgentPrism Workflows — Design Notes & Protocol Reference

The deep design reference behind [`../README.md`](../README.md). It records *what* the system is,
*which libraries* it uses, and *what each library actually supports* — with concrete,
package-specific API references (field/method names, file:line, versions). For installation and
usage, start with the README; read this when you need the protocol-level mechanics (ACP lifecycle,
the structured-output crux, model/permission/usage wiring, the engine lineage).

> Reference/design doc, not a roadmap or a tutorial. The implementation now lives in six
> `@automatalabs/*` packages — see [§2](#2-codebase--module-structure). The Pi `src/…` citations
> throughout are provenance for the lifted engine, not paths in this repo.

---

## 1. Goal

Rebuild the dynamic-workflow orchestrator so it has **no dependency on Pi**:

- The **`workflow` tool** is exposed by a **stdio MCP server** (instead of a Pi extension's
  `registerTool`). Any MCP-capable host (Claude Code, Zed, etc.) can call it.
- Each **`agent()` call inside a workflow script** is backed by an **ACP agent server**
  (`claude-agent-acp` for Claude, `codex-acp` for Codex, `opencode acp` for OpenCode) over the **Agent Client Protocol**
  (instead of Pi's in-process `createAgentSession`).

The deterministic orchestration engine (the JS `vm` realm, `parallel`/`pipeline`, the
journal/resume machinery, token budget, git-worktree isolation) is **reused essentially
unchanged** from `pi-dynamic-workflows` — only the *leaf* (how one subagent runs) and the
*shell* (how the tool is exposed) change.

This is built as a **new, standalone codebase** that *lifts* the reused pieces (copy + adapt the
source) rather than modifying the Pi extension; nothing imports Pi at runtime. Three core layers
(`shared-types`, `workflow-engine`, `acp-agents`) stay independently usable, while the SDK facade,
MCP shell, and optional OTel leaf compose them for hosts — see §2 for the package layout.

### The core inversion

The orchestrator process plays **two protocol roles at once**:

```
   MCP host (Claude Code / Zed / …)
        │  calls tool "workflow"  (MCP, stdio)
        ▼
┌──────────────────────────────────────────────┐
│  workflow-orchestrator process                │
│   • MCP SERVER  → exposes the `workflow` tool │
│   • ACP CLIENT  → drives agent servers        │
│   • the deterministic engine runs the script  │
└──────────────────────────────────────────────┘
        │  session/new, session/prompt … (ACP, JSON-RPC over stdio)
        ▼
   claude-agent-acp / codex-acp / opencode acp  (one or more long-lived subprocesses)
        │  → real Claude / Codex / OpenCode agents, each in its own session
```

ACP and MCP are sibling JSON-RPC protocols from the same design space (ACP = host↔agent,
MCP = agent↔tools), so this is a clean composition, not a hack.

---

## 2. Codebase & module structure

This is a **new, greenfield codebase** — not a fork, a patch, or a runtime dependency of the Pi
extension. We **lift** the specific pieces of `pi-dynamic-workflows` we need (copy + adapt the
source) and write the rest fresh. Nothing imports Pi at runtime.

The code is published as **six packages** with a one-way dependency direction. The three lower
layers remain independently usable — in particular, the ACP agent logic and workflow engine both
work **with no MCP server at all** — while the facade and integration leaves stay thin.

```
 ┌──────────────────────────┐       ┌──────────────────────────┐
 │ mcp-server               │       │ agentprism-otel          │
 │ stdio tools + auth       │       │ observes manager events  │
 └────────────┬─────────────┘       └────────────┬─────────────┘
              │ depends on                          │ structural attach
              ▼                                     ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ workflows — public SDK facade + ACP event bridge            │
 └────────────────┬───────────────────────┬────────────────────┘
                  ▼                       ▼
 ┌──────────────────────────┐  ┌───────────────────────────────┐
 │ workflow-engine          │  │ acp-agents                    │
 │ vm, journal, budgets,    │  │ pooled Claude/Codex/OpenCode │
 │ resume, worktrees        │  │ + custom ACP, auth, sessions │
 └────────────┬─────────────┘  └──────────────┬────────────────┘
              └──────────────┬────────────────┘
                             ▼
                shared-types — AgentRunner seam
```

`workflow-engine` and `acp-agents` are **siblings**: neither imports the other. They meet only at
the `AgentRunner` interface (`run(prompt, opts) → result`), injected at composition time. The
engine never names a concrete backend; the agents module never knows it's inside a workflow.

### `acp-agents` — *the internal ACP backend (an `AgentRunner`), not the public SDK*

All the logic for actually using the ACP agents: opening and holding ACP client connections to
`claude-agent-acp` / `codex-acp` / `opencode acp`, the `ClaudeBackend` / `CodexBackend` /
`OpenCodeBackend` / `CustomAcpBackend`, model selection (§5.4), permission allow/deny (§5.5),
usage extraction (§5.6), cancellation (§5.7), auth, session lifecycle, and structured-output
vendor wiring (§6). It implements the one-method `AgentRunner` seam (`run(prompt, opts)`) and adds
host-facing event, auth, and interactive/reattach APIs. Its runtime deps are
`@agentclientprotocol/sdk`, `@agentclientprotocol/claude-agent-acp`, `@automatalabs/codex-acp`,
`@modelcontextprotocol/sdk`, `typebox`, and `@automatalabs/shared-types`; OpenCode is resolved from
the host and deliberately is not bundled.

The Codex backend drives the **installed npm dependency** `@automatalabs/codex-acp@1.6.2` — a
published fork of `@agentclientprotocol/codex-acp` that bakes the turn-level `outputSchema` forward
(§6.3) into its shipped dist. It's an exact-pinned dependency, so Codex ships on a clean
`git clone && pnpm install && pnpm build` — no pnpm patch, no `patches/` file, no vendored tree.

It is its own module (it imports neither the engine nor the MCP server), but it is an **internal**
building block — **not** the importable public SDK. The canonical, importable SDK is
`@automatalabs/workflows`, which re-exports `createAcpRunner` (and the rest of this backend's public
surface), so callers never depend on `@automatalabs/acp-agents` directly. Run a single agent with no
workflow and no MCP server through that facade:

```ts
import { createAcpRunner } from "@automatalabs/workflows";   // the canonical SDK entry point
const runner = createAcpRunner();                            // AgentRunner backed by the ACP pool
const result = await runner.run("Summarize repo X", { schema: MY_SCHEMA, cwd, model: "opus" });
await runner.dispose();
```

### `workflow-engine` — the lifted Pi engine

`runWorkflow` (the `vm` realm + determinism prelude; the
`agent`/`parallel`/`pipeline`/`phase`/`log`/`budget` globals), the journal/resume, per-phase
budgets, the limiter, the run manager + persistence, and the worktree helper. It depends on an
**injected `AgentRunner`** — *not* on `acp-agents` — so it runs against a real ACP runner, a mock,
or any other backend (exactly how the Pi tests drive it today via `options.agent`). The seam:
`runWorkflow` requires `options.agent: AgentRunner` and only ever calls
`agentRunner.run(prompt, opts)` (today `Pick<WorkflowAgent,"run">`, [`src/workflow.ts:59`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts#L59), bound at [`:283`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts#L283), called at [`:465`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts#L465)).

### `mcp-server` — the shell / composition root

Owns the **`workflow` tool definition** (input schema + handler), the two conditional auth tools,
and the stdio MCP transport; streams progress via MCP `notifications/progress`; exposes the
`resumeFromRunId` param. It depends on `@automatalabs/workflows`, constructs the ACP runner, and
injects it into the facade manager. It is just **one** consumer — the engine + agents can equally
be driven by a CLI, a test harness, or another server, with no MCP involved.

### `workflows` — the public SDK facade

The canonical programmatic entry point. It composes `workflow-engine` and `acp-agents`, re-exports
the supported host surface, adds `runDynamicWorkflow`, validation/folder helpers, and bridges the
runner's live ACP events onto `WorkflowManager.agentEvent`.

### `agentprism-otel` — optional observability leaf

Attaches structurally to a `WorkflowManager` and maps workflow/agent/tool events to OpenTelemetry
spans plus token, cost, count, and duration metrics. It peer-depends on `@opentelemetry/api` and is
outside the engine/runner dependency chain.

> Packaging (as implemented): a pnpm monorepo of **six** published packages —
> `@automatalabs/shared-types` (the seam), `@automatalabs/workflow-engine`, `@automatalabs/acp-agents`,
> `@automatalabs/mcp-server` (the bin), `@automatalabs/workflows` (the importable SDK facade), and
> `@automatalabs/agentprism-otel` (the optional telemetry bridge).
> The dependency direction and the `AgentRunner` seam are the contract.

### Lifted from `pi-dynamic-workflows` → `workflow-engine` (copied/adapted, mostly unchanged)

| Concern | Source (`pi-dynamic-workflows`) | Notes |
|---|---|---|
| Script execution | [`src/workflow.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts) — `runWorkflow`, `vm.createContext`/`vm.Script` (`:835`,`:866`) | Node `vm` realm; globals `agent`/`parallel`/`pipeline`/`phase`/`log`/`budget` injected |
| Determinism | [`src/workflow.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts) `DETERMINISM_PRELUDE` (`:227`), parse blocklist (`:212`,`:890`) | neuters `Date.now`/`Math.random`/`new Date()` for resume reproducibility |
| Fan-out | `parallel` (`:555`, barrier), `pipeline` (`:579`, no *inter-stage* barrier — but still `Promise.all`-joins all items at `:588`, so don't drop that on a port), `createLimiter` (`:1013`) | concurrency gate |
| Journal / resume | [`src/run-persistence.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/run-persistence.ts), journal in [`workflow.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts) (`hashAgentCall` `:1045`, `firstMiss` longest-unchanged-prefix `:407`) | crash recovery + resume |
| Budget | `budget` object (`:315`), per-phase sub-budgets (`:303`) | soft token gate |
| Worktree isolation | [`src/worktree.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/worktree.ts) — `git worktree add` per agent | engine creates it (deterministic name) and passes `cwd` to `agent.run({cwd})` |
| Model tiering logic | [`src/model-routing.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/model-routing.ts), [`src/model-tier-config.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/model-tier-config.ts) | pure logic; resolution *target* becomes an ACP session config option (§5.4) |
| Schema validate/extract | [`src/agent.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/agent.ts) `resolveStructuredOutput` (`:113`), `extractValidated` (`:47`) | lifted into **`acp-agents`** (not the engine) as the schema guard (§6) |

### Written fresh in the new codebase

| Module | Piece | Replaces (Pi) | New |
|---|---|---|---|
| `acp-agents` | **Leaf** — run one subagent | `WorkflowAgent` in [`src/agent.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/agent.ts) (`createAgentSession`, `ModelRegistry`, `createCodingTools`) | `AcpAgentRunner.run()` (via `createAcpRunner()`) — drives Claude, Codex, OpenCode, or custom ACP agents |
| `workflows` | **Facade** — compose + validate | no Pi equivalent | public SDK, one-shot helper, workflow folders/validator, manager ACP-event bridge |
| `mcp-server` | **Shell** — expose tools | [`extensions/workflow.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/extensions/workflow.ts) + `createWorkflowTool` `defineTool` + TUI ([`display.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/display.ts), [`task-panel.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/task-panel.ts), [`workflow-ui.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow-ui.ts)) | stdio MCP server registering `workflow` plus conditional auth tools; progress via MCP notifications |
| `agentprism-otel` | **Observability** | no Pi equivalent | OTel trace/metric mapping over manager events |
| `acp-agents` | **Structured output** | injected `structured_output` tool ([`src/structured-output.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/structured-output.ts)) | native backend schema constraint for Claude/Codex plus client-hosted StructuredOutput MCP capture for eligible custom ACP backends (§6) |

---

## 3. Libraries & packages

All versions below were re-verified from the installed workspace dependency graph on 2026-07-09.

### Tool exposure (MCP server)

- **`@modelcontextprotocol/sdk`** — official TypeScript MCP SDK. Use its stdio server
  transport to expose the `workflow` tool. (Pulled transitively by claude-agent-sdk as
  `@modelcontextprotocol/sdk@1.29.0`; pin your own direct dependency.)
  Ref: https://github.com/modelcontextprotocol/typescript-sdk · https://modelcontextprotocol.io

### Agent backends (ACP)

- **`@agentclientprotocol/sdk@1.2.1`** — the ACP protocol SDK (JSON-RPC-over-stdio types +
  client/connection helpers). This is what your orchestrator uses to *speak ACP as a client*.
  Ref: https://agentclientprotocol.com · https://github.com/agentclientprotocol

- **`@agentclientprotocol/claude-agent-acp@0.59.0`** — ACP server wrapping Claude.
  Bin: `claude-agent-acp` (`npx @agentclientprotocol/claude-agent-acp`). Author: Zed Industries.
  Wraps **`@anthropic-ai/claude-agent-sdk@0.3.207`**.
  Ref: https://github.com/agentclientprotocol/claude-agent-acp
  > Naming note: the canonical package is **`claude-agent-acp`**, not "claude-acp".

- **`@automatalabs/codex-acp@1.6.2`** — ACP server wrapping OpenAI Codex (TypeScript rewrite over
  the **Codex App Server**). Bin: `codex-acp`. This is a **published fork** of
  `@agentclientprotocol/codex-acp` that bakes the `outputSchema` forward (§6.3) into its shipped
  dist; it is the package `acp-agents` exact-pins and consumes.
  Ref: https://github.com/VikashLoomba/codex-acp (fork) · https://github.com/agentclientprotocol/codex-acp (upstream)
  > The Rust `zed-industries/codex-acp` is the deprecated predecessor; development moved to the
  > `agentclientprotocol/codex-acp` TypeScript package (which this fork tracks).

### Engine support (lifted from pi-dynamic-workflows; no Pi runtime needed)

- **`acorn`** — parse the workflow script + extract/validate the `meta` literal.
- **`node:vm`**, **`node:crypto`** — script realm + journal hashing.
- A JSON-Schema lib (**`typebox`** today, or **`zod`** — note `claude-agent-acp` itself uses
  `zod ^3.25 || ^4`) for the `agent({schema})` contract and client-side validation.
- **`git`** — worktree isolation (`git worktree add/remove`).

---

## 4. The MCP side — exposing the `workflow` tool

The `workflow` tool keeps essentially the same input contract as today
([`src/workflow-tool.ts:61`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow-tool.ts#L61)), exposed via the MCP server instead of `defineTool`:

- `script` (**required** string) — raw JS; must start with
  `export const meta = { name, description, phases? }`. Agent-less deterministic scripts are valid;
  the validator warns when a script has neither `agent()` nor `checkpoint()`.
- `args` (optional) — exposed to the script as global `args`.
- `maxAgents` (optional, default 1000), `concurrency` (optional, clamped to 16),
  `agentRetries` (optional, ≤3), `agentTimeoutMs` (optional, default none),
  `tokenBudget` (optional, default none).
- **Bounds clamp, don't reject:** accept `concurrency`/`agentRetries` as plain numbers in the tool
  schema — *not* Zod `.max()`, which rejects out-of-range input with `InvalidParams`. The engine
  already clamps them (`normalizeConcurrency` → `MAX_CONCURRENCY` 16, `normalizeAgentRetries` →
  `MAX_AGENT_RETRIES` 3), so defer to it and keep the "clamped" semantics above (matches Pi).

**One semantic change vs. Pi.** MCP tool calls are request/response within the caller's turn;
there is no "return immediately, deliver the result into a *later* turn" mechanism (that was a
Pi-extension affordance, `installResultDelivery`). So the MCP `workflow` tool runs
**synchronously**: execute to completion, stream progress via MCP **`notifications/progress`**,
return the final result. This is exactly the existing `background:false` / `runSync` path
([`src/workflow-tool.ts:223`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow-tool.ts#L223)) — make it the default and drop `startInBackground`.

The shipped server registers `workflow` alone — its whole tool surface. Backend auth belongs to
the agents' own CLI credential stores, and the server deliberately exposes no auth state for a
host to inspect: agents that self-authenticate from disk are invisible to any host-side auth
bookkeeping, so an auth-status surface could only report "unauthenticated" on fully logged-in
machines — an LLM host reads that as a blocker. `AUTH_REQUIRED` pauses a run with the
non-secret `authContext`; the recovery sequence is an out-of-band CLI login, then re-call
`workflow` with `resumeFromRunId`. Programmatic credential injection stays in the SDK's
auth-capable runner APIs for embedding hosts.

Resume is **not lost**, it becomes **explicit**: expose a `resumeFromRunId` tool parameter; the
host calls `workflow` again to continue from the persisted journal (the engine already supports
this via `resumeJournal` in `runWorkflow`).

Human-in-the-loop: `checkpoint()` relied on Pi's `ui.confirm`. Over MCP, elicitation-capable
clients provide the live channel. Without elicitation, the authored headless mode applies:
`"default"` takes `default ?? true`, `"abort"` aborts, and opt-in `"pause"` persists a
`checkpoint_required` pause. The host resumes that pause with `resumeFromRunId` plus a decision in
`checkpointReplies`; its `checkpointContext` supplies the call index and hash used to journal it.

---

## 5. The ACP side — driving agent servers

ACP is **JSON-RPC 2.0 over stdio**, newline-delimited (messages MUST NOT contain embedded
newlines; stdout = protocol, stderr = free for logs). Protocol version is `1`.
Spec: https://agentclientprotocol.com/protocol/v1/transports

### 5.1 Lifecycle / a single turn

```
initialize                         → capability handshake (protocolVersion, clientCapabilities, authMethods)
session/new   { cwd, mcpServers }  → returns sessionId (+ configOptions)
session/prompt { sessionId, prompt }  (request)
  ↳ session/update  notifications  → agent_message_chunk, tool_call, tool_call_update,
                                      plan, usage_update, …  (streaming, agent→client)
session/prompt response            → { stopReason, usage? }
session/cancel { sessionId }       (notification, client→agent)
```

- **Stop reasons** (on the `session/prompt` result): `end_turn`, `max_tokens`,
  `max_turn_requests`, `refusal`, `cancelled`.
  Ref: https://agentclientprotocol.com/protocol/v1/prompt-turn

### 5.2 Sessions & concurrency — supported

A single agent-server **process hosts many concurrent sessions** (each keyed by `sessionId`).
Both servers implement a real `sessionId → session` map:

- `claude-agent-acp`: `sessions` map; prompts on **different** sessions run concurrently;
  prompts **within** one session are queued (`promptQueueing`). ([`src/acp-agent.ts`](https://github.com/agentclientprotocol/claude-agent-acp/blob/b8df8e0e5460fd782214f4dde488f7476c80c454/src/acp-agent.ts))
- `codex-acp`: `private readonly sessions: Map<string, SessionState>` with per-session prompt
  state + generation fencing. ([`src/CodexAcpServer.ts`](https://github.com/agentclientprotocol/codex-acp/blob/5506fbae85878013c6eb40ae540ea21a607d9334/src/CodexAcpServer.ts))

**Efficient fan-out:** run one (or a few) long-lived server processes and open **N sessions**;
the engine's `createLimiter` caps real concurrency. You're bound by API rate limits and
per-session memory, not by the protocol.
Ref: https://agentclientprotocol.com/protocol/v1/session-setup

### 5.3 Working directory / worktree isolation — supported, clean

`cwd` is a **required, per-session, absolute** field on `session/new` (independent per session
in one process); optional `additionalDirectories` expands the root set. So worktree isolation
maps directly: `createWorktree()` → `session/new({ cwd: worktree.cwd })`. Both servers store
`cwd` per session.
Ref: https://agentclientprotocol.com/protocol/v1/session-setup#working-directory

### 5.4 Model selection — supported, via Session Config Options (not `session/new`, not `initialize`)

The client picks the model **per session** (switchable per turn) from the catalog the agent
advertises:

- Mechanism: agent returns `configOptions` (in the `session/new` result, updatable later)
  including `{ id:"model", category:"model", type:"select", currentValue, options[] }`;
  client switches with **`session/set_config_option`** `{ configId:"model", value }`.
  Categories also include `model_config` (context/speed/quality) and `thought_level`.
  Refs: https://agentclientprotocol.com/protocol/v1/session-config-options ·
  https://agentclientprotocol.com/rfds/model-config-category
- `claude-agent-acp`: `model` option → `query.setModel(...)`; accepts aliases (`opus`/`sonnet`);
  initial precedence `ANTHROPIC_MODEL` env → `settings.model` → SDK default. The client selects
  per-session models through `session/set_config_option`.
- `codex-acp`: model encoded as `"model[effort]"` (e.g. `gpt-5.2[high]`) + separate
  `reasoning_effort` select; switch via `session/set_config_option` (the wire method;
  `setConfigOption` is just the ACP SDK's JS accessor for it).
- `opencode acp`: model values are OpenCode catalog ids like `provider/model` (for example
  `zai/glm-5.2`) under a `model` select. The public routing prefix is stripped at the first slash:
  `opencode/zai/glm-5.2[high]` routes to the OpenCode backend, selects `zai/glm-5.2`, and applies
  `[high]` to its `thought_level`/effort option when advertised.

> The **catalog** belongs to the server (Claude models on `claude-agent-acp`, Codex models on
> `codex-acp`, OpenCode models on `opencode acp`), so cross-**provider** routing = choosing which server; within a provider,
> per-call tiering works. This is what the engine's `tier: small/medium/big` maps onto.

### 5.5 Permissions → tool allow/deny — supported

The agent requests approval per gated tool call via **`session/request_permission`**
(agent→client), with options whose `kind ∈ {allow_once, allow_always, reject_once,
reject_always}`. The spec explicitly allows clients to **auto-respond**, so an allow/deny-list
is implemented by deciding at that boundary (by tool name / command / kind) without user
interaction. Both servers also expose coarse permission modes (`acceptEdits`, `plan`, `dontAsk`,
`bypassPermissions`/`agent-full-access`, …).
Ref: https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission

### 5.6 Usage / token accounting — supported

- **`usage_update`** `session/update` notification: `used` + `size` (token counts), optional
  `cost { amount, currency }`.
- Per-turn `usage` object on the `session/prompt` response (still a **Draft RFD**, but both
  servers already emit it).
- `claude-agent-acp` reports **tokens + dollar cost** (`cost = total_cost_usd`, USD); response
  `usage { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens }`.
- `codex-acp` reports **tokens/quota only** (no dollar cost).
- OpenCode reports per-turn `PromptResponse.usage` plus cumulative `usage_update` cost/context;
  the existing accumulator combines the latest cumulative cost with the per-turn token split.

This maps onto the engine's `onUsage` / token accounting; no need for the chars/4 estimator
fallback in the normal case.
Refs: https://agentclientprotocol.com/protocol/v1/prompt-turn · https://agentclientprotocol.com/rfds/session-usage

### 5.7 Cancellation — supported

`session/cancel { sessionId }` is a fire-and-forget notification; the agent aborts model+tool
work and then resolves the original `session/prompt` with `stopReason: "cancelled"`. A
`session/close` (when advertised) also frees the session. Maps onto the engine's
`AbortController`/`signal`.
Ref: https://agentclientprotocol.com/protocol/v1/cancellation

### 5.8 Giving agents extra tools — `mcpServers` on `session/new`

The client passes MCP server configs (stdio mandatory; http/sse optional per capability) in
`session/new`; the agent connects to them. This is the **only** client-side tool-injection path
in ACP (the client does not hand the agent a tool object directly).
- `claude-agent-acp`: ACP `mcpServers` → SDK `McpServerConfig`, merged with user options
  ([`src/acp-agent.ts:3127-3149`](https://github.com/agentclientprotocol/claude-agent-acp/blob/b8df8e0e5460fd782214f4dde488f7476c80c454/src/acp-agent.ts#L3127-L3149), [`:3242`](https://github.com/agentclientprotocol/claude-agent-acp/blob/b8df8e0e5460fd782214f4dde488f7476c80c454/src/acp-agent.ts#L3242)).
- `codex-acp`: supports stdio + http (rejects `acp`/`sse`).
- `opencode acp`: advertises http + sse; this is what enables the runner-hosted
  StructuredOutput MCP tool for schema runs.
Ref: https://agentclientprotocol.com/protocol/v1/session-setup#mcp-servers

### 5.9 Custom backends & the generic `_meta` passthrough

ACP is a *unified* protocol — nothing about the runner is backend-specific except the built-in
`Backend` strategies for Claude, Codex, and OpenCode. Two additive surfaces open the seam to **any** ACP agent:

- **The backend registry** (`acp-agents/src/registry.ts`): named spawn configs
  (`{ command, args?, env?, sessionMeta?, structuredOutputTool? }`), registered programmatically
  (`createAcpRunner({ backends })`) or via `AGENTPRISM_BACKENDS` (JSON env). Routing matches
  registered names FIRST (`model: "browser"` or `"browser/<inner-model>"` — the name is
  routing; the part after the slash is selected via Session Config Options), then the
  built-in heuristics. `AGENTPRISM_DEFAULT_BACKEND` may name a registry entry.
  `"claude"`/`"codex"`/`"opencode"` are reserved. A custom backend speaks the repo's published generic
  dialect: schema IN as turn-level `_meta.outputSchema` (plain JSON Schema, not
  OpenAI-strict), optionally a client-hosted StructuredOutput MCP tool when HTTP MCP is
  negotiated, and result OUT as captured tool args or final-text JSON — with the client-side
  validate/re-prompt ladder (§6) as the repair path for agents that ignore the schema channel.
- **Script-declared backends** (`meta.backends` → `ExecOptions.scriptBackends` →
  `RunOptions.backends`): a script can declare the backends it needs, making workflows
  self-contained (and letting agent-authored workflows bring their own ACP servers). This
  crosses a TRUST BOUNDARY — a spawn config is arbitrary code execution — so the layering is
  secure-by-default at every seam: the ENGINE parses/validates `meta.backends` but never acts
  on it; only a COMPOSITION ROOT that obtained approval threads it (SDK:
  `allowScriptBackends` true/callback, throwing on unapproved declarations; MCP server: an
  elicitation per unique spawn config for capable clients — approvals session-sticky, an
  elicitation failure is a DENY, and non-eliciting clients get a tool error naming the
  `AGENTPRISM_ALLOW_SCRIPT_BACKENDS` env opt-in). The runner re-validates run-scoped entries
  (reserved names rejected) and layers them UNDER the host registry — host names win. The
  pool keys connections by `Backend.poolKey` (id + spawn-config hash for custom backends) so
  two runs declaring the same NAME with different COMMANDS never share a process, and the
  one-time `initialize` handshake has a deadline (`AGENTPRISM_ACP_INIT_TIMEOUT_MS`, default
  60s) so a command that is not an ACP server fails legibly instead of hanging — fail-fast
  hygiene, NOT a security gate (the process has already been spawned by then).
- **Generic `_meta` passthrough** (`RunOptions.meta` / `RunOptions.promptMeta`, script-level
  `agent(p, { meta, promptMeta })`): the protocol reserves `_meta` for custom extension
  properties, so workflows can drive any agent's extension surface without a code change here.
  Session/new `_meta` layers lowest→highest: registry `sessionMeta` defaults → per-call `meta`
  → backend protocol-critical keys (Claude `claudeCode` schema channel, Codex
  base/developer-instruction forwards) → the engine `runId` stamp. Turn `_meta` layers
  per-call `promptMeta` under backend-computed keys (`outputSchema`). Both are ADDITIVE run
  inputs — like `mcpServers`, they never enter `hashAgentCall`, so resume keys are stable
  across meta changes.

---

## 6. Structured output (the crux)

**Both backends natively constrain a result to a JSON Schema.** What differs is *scope* and the
*vendor channel* used to reach it. ACP **core** models none of it — only an open `_meta`
extension point — so each backend tunnels its native support through a vendor-specific path.

### 6.1 ACP core (`@agentclientprotocol/sdk@1.2.1`) — no native structured output

Verified by exhaustive grep (zero matches for `outputSchema|structuredContent|json_schema|…`).

```ts
// dist/schema/types.gen.d.ts:5017
export type PromptRequest = {
  sessionId: SessionId;
  prompt: Array<ContentBlock>;
  _meta?: { [key: string]: unknown } | null;   // the ONLY extension point
};
// :2943  PromptResponse = { stopReason, usage?, _meta }   — no result payload
// :213   ToolCallContent = Content | Diff | Terminal      — no structuredContent
```

### 6.2 Claude — `@agentclientprotocol/claude-agent-acp@0.59.0` → `@anthropic-ai/claude-agent-sdk@0.3.207`

**Supported, session-scoped, via the `_meta.claudeCode` vendor extension.**

**(a) Set the schema — IN.** The SDK's `Options.outputFormat` is the native lever:

```ts
// claude-agent-sdk  sdk.d.ts:1651
/** Output format configuration for structured responses.
 *  When specified, the agent will return structured data matching the schema. */
outputFormat?: OutputFormat;
// :1981  OutputFormat = JsonSchemaOutputFormat
// :870   JsonSchemaOutputFormat = { type: 'json_schema'; schema: Record<string, unknown> }
// :1983  OutputFormatType = 'json_schema'
```

The adapter **spreads the client-supplied options straight into the SDK query**, so a client
sets it via `_meta.claudeCode.options.outputFormat` at `session/new`:

```ts
// claude-agent-acp  src/acp-agent.ts:3180
const userProvidedOptions = sessionMeta?.claudeCode?.options;   // = params._meta.claudeCode.options
// :3216
const options: Options = {
  systemPrompt,
  settingSources: ["user", "project", "local"],
  ...(thinking !== undefined && { thinking }),
  ...userProvidedOptions,   // ← :3220  carries outputFormat straight into the SDK query
  // ACP-managed overrides AFTER the spread (cwd, mcpServers, permissionMode, tools,
  // canUseTool, hooks, env, …) do NOT touch outputFormat
};
```

> Source (claude-agent-acp): [`acp-agent.ts:3180`](https://github.com/agentclientprotocol/claude-agent-acp/blob/b8df8e0e5460fd782214f4dde488f7476c80c454/src/acp-agent.ts#L3180), [`:3216`](https://github.com/agentclientprotocol/claude-agent-acp/blob/b8df8e0e5460fd782214f4dde488f7476c80c454/src/acp-agent.ts#L3216), [`:3220`](https://github.com/agentclientprotocol/claude-agent-acp/blob/b8df8e0e5460fd782214f4dde488f7476c80c454/src/acp-agent.ts#L3220), [`:3242`](https://github.com/agentclientprotocol/claude-agent-acp/blob/b8df8e0e5460fd782214f4dde488f7476c80c454/src/acp-agent.ts#L3242).

Client `session/new` payload:

```jsonc
{
  "cwd": "/abs/path/to/worktree",
  "_meta": {
    "claudeCode": {
      "options": {
        "outputFormat": { "type": "json_schema", "schema": { /* your JSON Schema */ } }
      },
      "emitRawSDKMessages": true          // required to READ the result (see (c))
    }
  }
}
```

**(b) Constraint + retry — built in.** The SDK validates the final message against the schema
and retries; on exhaustion it ends with a terminal subtype:

```ts
// claude-agent-sdk  sdk.d.ts:3943  (SDKResultError.subtype)
'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd'
  | 'error_max_structured_output_retries'
```

The adapter already handles that subtype ([`src/acp-agent.ts:1763`](https://github.com/agentclientprotocol/claude-agent-acp/blob/b8df8e0e5460fd782214f4dde488f7476c80c454/src/acp-agent.ts#L1763), mapped to an internal
error / `max_turn_requests` stop reason).

**(c) Read the result — OUT (the one rough edge).** The parsed object lands in:

```ts
// claude-agent-sdk  sdk.d.ts:3983  (SDKResultSuccess)
structured_output?: unknown;
```

…but ACP `PromptResponse` only carries `{ stopReason, usage }`, and the adapter does **not** give
`structured_output` a first-class ACP field. You read it by opting into raw SDK messages:

```ts
// claude-agent-acp  src/acp-agent.ts:357 (flag), :3488 (wired), :1337 (forwarded)
if (session.emitRawSDKMessages && shouldEmitRawMessage(session.emitRawSDKMessages, message)) {
  await this.client.extNotification("_claude/sdkMessage", {
    sessionId: params.sessionId,
    message: message as Record<string, unknown>,
  });
}
```

> Source (claude-agent-acp): [`acp-agent.ts:357`](https://github.com/agentclientprotocol/claude-agent-acp/blob/b8df8e0e5460fd782214f4dde488f7476c80c454/src/acp-agent.ts#L357) (flag), [`:3488`](https://github.com/agentclientprotocol/claude-agent-acp/blob/b8df8e0e5460fd782214f4dde488f7476c80c454/src/acp-agent.ts#L3488) (wired), [`:1337`](https://github.com/agentclientprotocol/claude-agent-acp/blob/b8df8e0e5460fd782214f4dde488f7476c80c454/src/acp-agent.ts#L1337) (forwarded).

So: set `_meta.claudeCode.emitRawSDKMessages = true`, then read `structured_output` off the
`_claude/sdkMessage` notification carrying the `type:"result", subtype:"success"` message.

**Scope:** **session-scoped** — `outputFormat` is read at `session/new`; `prompt()`
([`src/acp-agent.ts:1034`](https://github.com/agentclientprotocol/claude-agent-acp/blob/b8df8e0e5460fd782214f4dde488f7476c80c454/src/acp-agent.ts#L1034)) reads no per-turn schema. With the engine's one-session-per-`agent()`
model this is a non-issue (one schema per agent call = one session).

### 6.3 Codex — `@automatalabs/codex-acp` (Codex App Server)

**The Codex App Server natively enforces `outputSchema` AND the shipped binary honors it —
but the *stock* codex-acp adapter never forwards a client schema, so Codex structured output needs a
~1-line adapter forward. We ship that forward in the published `@automatalabs/codex-acp` fork.**
(Verified end-to-end below.)

One field-verified nuance: although the parameter is documented as constraining the *final*
assistant message, Codex applies the Responses-API constraint to **every sampled assistant message
in the turn** — intermediate progress messages between tool calls come back schema-shaped too.
`CodexBackend` therefore extracts the structured result from the turn's **final assistant message
only** (`StructuredSource.finalMessageText()`, segmented at tool/thought/plan boundaries), never by
scanning the whole turn's concatenated text — a first-JSON scan over the turn would return a
progress object instead of the result.

**Protocol declares it (turn-level `outputSchema`):**

```ts
// codex-acp  src/app-server/v2/TurnStartParams.ts:43-46  — the LIVE path is v2 `turn/start`
/** Optional JSON Schema used to constrain the final assistant message for this turn. */
outputSchema?: JsonValue | null;
// src/app-server/SendUserTurnParams.ts (v1) is DEAD CODE — the server speaks v2 turn/start only
```

> Source (codex-acp): [`TurnStartParams.ts:43-46`](https://github.com/agentclientprotocol/codex-acp/blob/5506fbae85878013c6eb40ae540ea21a607d9334/src/app-server/v2/TurnStartParams.ts#L43-L46). These TS types are **generated from the codex binary** (`codex app-server generate-ts`).

**The shipped binary honors it.** codex-acp currently ships `@openai/codex@^0.142.5`. The forward
was source-verified at tag `rust-v0.142.4` (SHA `d0fd966`) and remains covered end-to-end: the App
Server threads `turn/start.outputSchema` all the way into
the OpenAI Responses API as a **strict** structured-output constraint:

```
turn/start.output_schema            app-server-protocol/.../v2/turn.rs:143
  → final_output_json_schema        app-server/.../turn_processor.rs:523   (the handler wires it in)
  → turn_context.final_output_json_schema   core/.../session/turn_context.rs:780
  → prompt.output_schema            core/.../session/turn.rs:1109
  → Responses API (strict)          core/.../client.rs:818-819  (&prompt.output_schema, _strict)
```

> Source (openai/codex @ `rust-v0.142.4`): [`turn.rs:143`](https://github.com/openai/codex/blob/d0fd96663e19a6cd5d6f315e3420c4d154562013/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L143), [`turn_processor.rs:523`](https://github.com/openai/codex/blob/d0fd96663e19a6cd5d6f315e3420c4d154562013/codex-rs/app-server/src/request_processors/turn_processor.rs#L523), [`turn_context.rs:780`](https://github.com/openai/codex/blob/d0fd96663e19a6cd5d6f315e3420c4d154562013/codex-rs/core/src/session/turn_context.rs#L780), [`turn.rs:1109`](https://github.com/openai/codex/blob/d0fd96663e19a6cd5d6f315e3420c4d154562013/codex-rs/core/src/session/turn.rs#L1109), [`client.rs:818-819`](https://github.com/openai/codex/blob/d0fd96663e19a6cd5d6f315e3420c4d154562013/codex-rs/core/src/client.rs#L818-L819).

**The gap + the forward.** The stock adapter's `sendPrompt()` builds the `runTurn({…})` call but
never sets `outputSchema`. The fork forwards it from the prompt's `_meta` (the adapter already reads
`request._meta` nearby) — a ~1-line change in [`src/CodexAcpClient.ts`](https://github.com/VikashLoomba/codex-acp/blob/main/src/CodexAcpClient.ts):

    // inside sendPrompt() → the runTurn({ ... }) call
    outputSchema: (request._meta as any)?.["outputSchema"] ?? null,

`runTurn → turnStart → sendRequest({ method: "turn/start", params })` passes it through verbatim;
`TurnStartParams.outputSchema` already exists, so it's type-clean.

**Delivery.** The forward is baked into the published fork `@automatalabs/codex-acp@1.6.2` — its
build compiles the change into the shipped `dist/index.js`, so npm consumers get it directly (unlike
a pnpm `patchedDependencies` transform, which is a workspace-root install step that never travels in
a published tarball). `acp-agents` **exact-pins** `@automatalabs/codex-acp@1.6.2`, so the forward is
present on a clean checkout with no vendoring and no postinstall hook. `CodexBackend` spawns the
resolved package main (`require.resolve("@automatalabs/codex-acp")`) under the current node.

**Output needs no patch.** `outputSchema` constrains the FINAL assistant message, which already
flows back over the normal `session/update` agent-message stream — `CodexBackend` reads the final
text and `JSON.parse`s it. (Cleaner than Claude, which needs `emitRawSDKMessages`.)

**Strict-mode caveat.** `output_schema_strict` is `true` for normal turns, so the schema is sent in
strict mode — `CodexBackend` must normalize the engine's JSON Schema to OpenAI strict rules (every
property `required`, `additionalProperties:false`, supported types/keywords only) before sending.
Keep the validate→re-prompt guard regardless.

**Tool-level structured output also exists, but it's the wrong lever for a client (see §6.4):**

```ts
// src/app-server/Tool.ts:9            outputSchema?: JsonValue   (on the tool definition)
// src/app-server/ToolOutputSchema.ts:6-10   { properties?, required?: string[], type: string }
// src/app-server/CallToolResult.ts:9          structuredContent?: JsonValue
// src/app-server/v2/McpToolCallResult.ts:6    structuredContent: JsonValue | null
// src/app-server/v2/McpServerToolCallResponse.ts:6  structuredContent?: JsonValue
```

> Source (codex-acp): [`Tool.ts:9`](https://github.com/agentclientprotocol/codex-acp/blob/5506fbae85878013c6eb40ae540ea21a607d9334/src/app-server/Tool.ts#L9), [`ToolOutputSchema.ts:6-10`](https://github.com/agentclientprotocol/codex-acp/blob/5506fbae85878013c6eb40ae540ea21a607d9334/src/app-server/ToolOutputSchema.ts#L6-L10), [`CallToolResult.ts:9`](https://github.com/agentclientprotocol/codex-acp/blob/5506fbae85878013c6eb40ae540ea21a607d9334/src/app-server/CallToolResult.ts#L9), [`McpToolCallResult.ts:6`](https://github.com/agentclientprotocol/codex-acp/blob/5506fbae85878013c6eb40ae540ea21a607d9334/src/app-server/v2/McpToolCallResult.ts#L6), [`McpServerToolCallResponse.ts:6`](https://github.com/agentclientprotocol/codex-acp/blob/5506fbae85878013c6eb40ae540ea21a607d9334/src/app-server/v2/McpServerToolCallResponse.ts#L6).

### 6.4 Why tool-level structured output is the wrong lever for a *client*

For both backends, a tool's `structuredContent` flows back to **the model**, not to your
orchestrator. The SDK's in-process `tool()` helper exposes **no `outputSchema`**
(`claude-agent-sdk sdk.d.ts:6506`, `:3683`). The only client-capturable tool signal is the
tool's **inputSchema** (the *args* the model passes when it calls a client-hosted tool). So
schema-conformance for a subagent **result** should use the turn/session output format, not a
tool.

### 6.5 Client-hosted StructuredOutput MCP tool for custom ACP backends

Native output-format channels remain authoritative for Claude and Codex. OpenCode and custom ACP
backends without a native result channel can inject a runner-hosted MCP server through
`session/new.mcpServers` when all gates hold: `RunOptions.schema` is present, the custom backend's
registry config did not set `structuredOutputTool:false` (default true; OpenCode always opts in),
and the negotiated initialize response strictly advertises `mcpCapabilities.http === true`.
Missing or false HTTP MCP support falls back to the existing prompt-embedded schema and final-text
JSON path.

The injected server uses Streamable HTTP on `127.0.0.1` with an unguessable token path and is
runner-scoped, lazy, and closed on runner disposal. Each run registers its own token slot and appends
one MCP server after user-provided entries, named `structured_output` or the next free suffix. The
server exposes exactly one tool, `StructuredOutput`; agents may display it namespaced by server
name. Its `inputSchema` is the user's plain JSON Schema, and a valid call captures the arguments.
Invalid calls return a tool error with TypeBox validation details and do not clobber a prior valid
capture. The resolution ladder is captured tool args → native/final-text parse → prose JSON
extraction → repair prompt.

### 6.6 What this means for us

- **Keep native channels primary where they exist.** Claude constrains out-of-the-box via `_meta`;
  Codex constrains after the ~1-line adapter patch (§6.3). OpenCode has no native result channel,
  so it uses the client-hosted MCP tool plus generic `_meta.outputSchema`/prompt fallback.
- **Keep `resolveStructuredOutput`'s validate-then-re-prompt ([`src/agent.ts:113`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/agent.ts#L113)) as a guard**,
  because `structured_output` is typed `unknown` and the constraint can still fail
  (`error_max_structured_output_retries`) and tool arguments are still untrusted. Ladder:
  captured tool args → native constraint/final-text parse → client-side validate → re-prompt on
  failure.
- **Abstract behind a per-backend adapter** — the two paths genuinely differ (Claude:
  session-scoped vendor `_meta.claudeCode` + `emitRawSDKMessages`, read off the raw message stream;
  Codex: per-turn `outputSchema` forwarded by the **forked** adapter, read off the normal message
  stream, with strict-schema normalization). Same `run(prompt, { schema })` interface above them.

---

## 7. The leaf interface: `AcpAgentRunner.run(prompt, opts)`

This lives in the **`acp-agents`** module (§2) and is usable on its own — no `workflow-engine`,
no `mcp-server`. It drives `claude-agent-acp`, the `@automatalabs/codex-acp` fork (patch baked
into its dist, §2, §6.3), and `opencode acp` as ACP server subprocesses. It implements the `AgentRunner` seam the engine injects against (today
`Pick<WorkflowAgent, "run">`, [`src/workflow.ts:59`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts#L59)). One method, backend strategies behind it:

```
run(prompt, { schema?, model?, tier?, cwd?, signal?, toolNames?, … }) →
  1. pick backend (Claude vs Codex vs OpenCode/custom) by agentType/model
  2. session/new({ cwd: worktree?.cwd })           // §5.3 worktree isolation
  3. select model via session config option         // §5.4
  4. apply schema:
       Claude → already set in session/new _meta.claudeCode.options.outputFormat (+ emitRawSDKMessages)
       Codex  → outputSchema on the turn params
       OpenCode/custom → generic outputSchema + optional StructuredOutput MCP tool
  5. session/prompt(prompt); drain session/update:
       • agent_message_chunk → assistant text
       • tool_call / request_permission → enforce allow/deny (§5.5)
       • usage_update → token accounting (§5.6)
  6. on stopReason:
       schema set → extract structured result
                     (Claude: structured_output off _claude/sdkMessage; Codex/OpenCode: final text/tool capture),
                     then VALIDATE; re-prompt on failure (guard)
       no schema   → final assistant text (empty ⇒ recoverable retry)
  7. signal.aborted → session/cancel (§5.7)
```

Everything above this method — `parallel`/`pipeline`, the journal, budget, phases, resume — is
the unchanged engine.

---

## 8. Caveats / version pins / things to design around

- **Version-specific (Claude):** the structured-output path is verified for
  `claude-agent-acp@0.57.0` / `@anthropic-ai/claude-agent-sdk@0.3.202`. The `_meta.claudeCode`
  channel and `emitRawSDKMessages` are vendor extensions, not standard ACP — pin versions and
  isolate behind the backend adapter.
- **`emitRawSDKMessages` is mandatory** to read `structured_output` on the Claude path; filter
  the raw stream to just the `type:"result"` message.
- **Schema scope (Claude) is per-session** → spin up a fresh ACP session per `agent()` call (or
  per distinct schema). The engine already does one session per call.
- **Codex structured output needs a codex-acp forward:** the shipped binary (`@openai/codex@0.142.5`;
  the field was source-verified at `rust-v0.142.4`) honors `turn/start.outputSchema`, but the stock adapter never forwards
  it — the ~1-line `_meta` → `runTurn` forward (§6.3) is **baked into the published fork
  `@automatalabs/codex-acp@1.6.2`'s dist**, which `acp-agents` **exact-pins** (so it travels to npm
  consumers, unlike a pnpm `patchedDependencies` transform). `CodexBackend` also normalizes schemas
  to OpenAI **strict** rules. Output rides the normal message stream (no `emitRawSDKMessages` needed).
- **MCP turn semantics:** no "deliver result into a later turn" — run the `workflow` tool
  synchronously with progress notifications; expose `resumeFromRunId` for continuation.
- **Cross-provider routing = choose the server.** Per-call model tiering works *within* a
  provider via config options; switching providers means routing to a different ACP server.
- **OpenCode is not bundled.** `OpenCodeBackend` resolves `AGENTPRISM_OPENCODE_ACP_CMD`, then a
  host-installed `opencode-ai` launcher, then `opencode` from PATH. The package is deliberately not
  a dependency because its platform binaries are large.
- **Concurrency** is bound by provider API rate limits + per-session memory, not the protocol;
  intra-session prompts serialize.
- **Per-turn token-usage breakdown** on `PromptResponse` is still a Draft ACP RFD (servers emit
  it ahead of stabilization). `codex-acp` reports tokens/quota but **no dollar cost**.
- **`codex-acp` config options are our codex model/tier/effort routing channel** (the model,
  `reasoning_effort`, and Fast-mode `SessionConfigOption`s, switched via `session/set_config_option`).
  codex-acp disables them **only** when the connecting client is IntelliJ/JetBrains **and** its
  `version` starts with `2026.1` (`isJetBrains2026_1Client` → `isSessionConfigEnabled` in
  `CodexAcpServer.ts`). Since `acp-agents` controls the `clientInfo` it sends at `initialize`, just
  don't identify as JetBrains/IntelliJ `2026.1` and config options stay enabled — so the gate never
  affects us. It's independent of structured output, which rides the turn, not config options.

---

## 9. References

**Packages (verified versions, 2026-07-09):**
- `@modelcontextprotocol/sdk` (stdio MCP server) — https://github.com/modelcontextprotocol/typescript-sdk
- `@agentclientprotocol/sdk@1.2.1` — https://github.com/agentclientprotocol
- `@agentclientprotocol/claude-agent-acp@0.59.0` (wraps `@anthropic-ai/claude-agent-sdk@0.3.207`) — https://github.com/agentclientprotocol/claude-agent-acp
- `@automatalabs/codex-acp@1.6.2` (published fork of `@agentclientprotocol/codex-acp`, patch baked into dist) — https://github.com/VikashLoomba/codex-acp
- OpenCode (`opencode acp`) — https://opencode.ai

**ACP spec:**
- Overview / transports — https://agentclientprotocol.com/protocol/v1/transports
- Initialization — https://agentclientprotocol.com/protocol/v1/initialization
- Session setup (cwd, mcpServers) — https://agentclientprotocol.com/protocol/v1/session-setup
- Prompt turn / stop reasons / usage — https://agentclientprotocol.com/protocol/v1/prompt-turn
- Tool calls / permissions — https://agentclientprotocol.com/protocol/v1/tool-calls
- Session config options (model) — https://agentclientprotocol.com/protocol/v1/session-config-options
- Cancellation — https://agentclientprotocol.com/protocol/v1/cancellation
- Extensibility (`_meta`, `_`-methods) — https://agentclientprotocol.com/protocol/v1/extensibility

**Reused engine (lifted from [`pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows)):**
- [`src/workflow.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow.ts) — engine, vm, determinism, journal, `agent`/`parallel`/`pipeline`, budget
- [`src/workflow-manager.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/workflow-manager.ts) — run lifecycle, persistence, resume
- [`src/run-persistence.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/run-persistence.ts) — disk journal + leases
- [`src/worktree.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/worktree.ts) — git-worktree isolation
- [`src/agent.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1b0291ab58c91037ea7b067875960530d52bedce/src/agent.ts) — the leaf being replaced; `resolveStructuredOutput`/`extractValidated` reused as the schema guard
