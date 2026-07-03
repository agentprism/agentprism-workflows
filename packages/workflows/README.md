# @automatalabs/workflows

The programmatic **SDK** for AgentPrism — run dynamic, multi-agent **workflow scripts**
(`agent()` / `parallel()` / `pipeline()` / …) over real coding-agent backends through the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP).

You author a small JavaScript **script** (a string), the engine runs it in a deterministic,
journaled, resumable realm, and every `agent()` call inside it is fanned out to a pooled ACP
backend — **Claude** (`claude-agent-acp`) or **Codex** (`codex-acp`) — driving the actual agent
subprocess to completion.

This package is the **canonical SDK** that the stdio MCP server
[`@automatalabs/mcp-server`](https://www.npmjs.com/package/@automatalabs/mcp-server) is built on.
If you want to expose a `workflow` tool to an MCP host (Claude Code, Zed, …), use that package; if
you want to embed the runner in your own program, use this one.

It is a **pure library**: it pulls in neither `@modelcontextprotocol/sdk` nor `zod`. It is a thin
facade that re-exports the clean public surface of the engine + ACP packages and adds one
convenience helper, `runDynamicWorkflow`, which defaults the agent backend to ACP.

---

## Install

```bash
pnpm add @automatalabs/workflows
```

> The backend ACP servers ship as transitive dependencies and are spawned for you on demand; you
> do not install or start them separately.

---

## Requirements

- **Node.js ≥ 22.**
- **Backend auth** — the SDK spawns the ACP backend as a child process that inherits your
  `process.env`, so it uses whatever credentials those agents already use:
  - **Claude** — a logged-in Claude Code install (`~/.claude`) **or** `ANTHROPIC_API_KEY` in the
    environment.
  - **Codex** — a logged-in Codex install (`~/.codex`).

You only need auth for the backend(s) your scripts actually route to. The default backend is
Claude (override with `AGENTPRISM_DEFAULT_BACKEND`; see [Backend selection](#backend-selection)).

---

## Core API

### a) `runDynamicWorkflow(script, opts?)` — run a script to a terminal result

The one-call entry point. It builds a one-off `WorkflowManager` whose agent backend defaults to
`createAcpRunner()` and runs the script to a **terminal** `WorkflowRunResult`. It never throws for
an ordinary pause/fail/abort — read `result.status` directly.

```ts
import { runDynamicWorkflow } from "@automatalabs/workflows";

const script = `
  export const meta = {
    name: "repo-scan",
    description: "describe a repo as JSON, two ways in parallel",
    phases: [{ title: "Fan" }],
  };

  const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["repo", "fileCount"],
    properties: { repo: { type: "string" }, fileCount: { type: "number" } },
  };

  phase("Fan");
  log("scanning " + args.repo);
  return await parallel([
    () => agent("Report this repo as JSON {repo, fileCount}.", { label: "a1", schema: SCHEMA }),
    () => agent("Report this repo as JSON {repo, fileCount}.", { label: "a2", schema: SCHEMA }),
  ]);
`;

const run = await runDynamicWorkflow(script, { args: { repo: "agentprism" } });

run.status;      // "completed" | "paused" | "failed" | "aborted"
run.result;      // [{ repo, fileCount }, …] — the script's return value (schema-validated)
run.tokenUsage;  // { input, output, total, cost, … } | undefined
run.runId;       // stable id; pass back to resume a paused run from its journal
```

Options (`RunDynamicWorkflowOptions`):

| field    | type           | meaning |
|----------|----------------|---------|
| `args`   | `unknown`      | The value handed to the script's `args` global. |
| `cwd`    | `string`       | Base working directory for the run (e.g. the project root): every subagent session runs here (a per-agent `agent({ cwd })` or worktree isolation overrides it), worktrees branch from it, and `agentType` definitions are scanned from it. Omitted ⇒ `process.cwd()`. |
| `runner` | `AgentRunner`  | Swap the backend (or stub it in tests). Omitted ⇒ `createAcpRunner()`. |
| `exec`   | `ExecOptions`  | Per-run controls forwarded to the manager: `tokenBudget`, `agentTimeoutMs`, `concurrency`, `agentRetries`, `signal`, `onProgress`, `confirm`, … |

```ts
const run = await runDynamicWorkflow(script, {
  args: { repo: "agentprism" },
  exec: {
    tokenBudget: 200_000,
    concurrency: 4,
    onProgress: (snapshot) => console.error(snapshot.doneCount, "/", snapshot.agentCount),
  },
});
```

Every script **must** begin with `export const meta = { name, description, phases? }` as its first
statement, and must be **deterministic** — `Date.now()`, `Math.random()`, and `new Date()` are
unavailable inside the realm (they would break journal replay on resume).

### b) `createAcpRunner().run(...)` — drive a single agent

Skip the script realm entirely and call one agent directly. The runner is the default ACP
`AgentRunner`. With a `schema`, `run()` returns the **validated object**; without one, it returns
the assistant's final **text**.

```ts
import { createAcpRunner } from "@automatalabs/workflows";

const runner = createAcpRunner();           // optional: { size } pool option, default 1
try {
  const data = await runner.run("Summarize this repo as JSON {summary}.", {
    schema: {
      type: "object", additionalProperties: false,
      required: ["summary"], properties: { summary: { type: "string" } },
    },
    model: "opus",          // routes to Claude; e.g. "gpt-5-codex" routes to Codex
    cwd: process.cwd(),     // absolute working dir for the agent's session
  });
  // data is the schema-validated object (not text)

  const text = await runner.run("Name this repo in one word.");  // no schema ⇒ string
} finally {
  await runner.dispose();   // close the pooled backend processes when you're done
}
```

`run(prompt, options?)` accepts the seam's `RunOptions`: `schema`, `model`, `tier`, `cwd`,
`instructions`, `label`, `toolNames` / `disallowedToolNames`, `signal`, `mcpServers`,
`meta` / `promptMeta` (generic ACP `_meta` passthroughs merged into `session/new` /
`session/prompt`), `baseInstructions` / `developerInstructions` (Codex-only), and the out-of-band
telemetry callbacks `onUsage` / `onModelResolved` / `onModelFallback` / `onHistory`. Token/cost
usage is delivered via `onUsage` (it may never fire — ACP usage is experimental), never via the
return value.

> **Codex session instructions.** When the run routes to the Codex backend, `baseInstructions`
> **replaces** Codex's built-in base system prompt and `developerInstructions` adds developer-role
> instructions for the session. They ride ACP `session/new` `_meta` into Codex `thread/start` and
> are **ignored by the Claude backend** (which has no analog) — unlike `instructions`, which is
> folded into the prompt text for either backend.
>
> ```ts
> await runner.run("Cut the release.", {
>   model: "gpt-5-codex",
>   baseInstructions: "You are a release bot. Only touch CHANGELOG.md.",
>   developerInstructions: "Prefer conventional-commit summaries.",
> });
> ```

> The ACP server **process** is pooled and reused across `run()` calls; each `run()` opens and
> closes one **session** on it. Call `dispose()` once at shutdown to tear the pool down. Pool size
> is `AcpPoolOptions.size` (default 1) or `AGENTPRISM_ACP_POOL_SIZE`.

> **Custom backends.** Any ACP agent can serve `run()` / `agent()` calls — register it by name and
> route to it with `model`:
>
> ```ts
> const runner = createAcpRunner({
>   backends: { browser: { command: "node", args: ["/abs/browser-acp.js"] } },
> });
> await runner.run("Verify the checkout flow.", { model: "browser" });
> ```
>
> `model: "browser/vision-large"` additionally selects `vision-large` from the agent's config-option
> catalog. The same registry can be declared via `AGENTPRISM_BACKENDS` (JSON env var; the
> programmatic option wins per name). A `schema` is forwarded to custom backends as turn-level
> `_meta.outputSchema` and the result is JSON-parsed off the final message — agents that ignore the
> schema channel still work via the validate/re-prompt ladder.
>
> A workflow **script** can also declare backends itself via `meta.backends` (same config shape,
> keyed by name). Because script-declared backends spawn commands on your machine, they are inert
> unless you approve them: pass `allowScriptBackends: true` to `runDynamicWorkflow`, or a callback
> `(backend) => boolean | Promise<boolean>` to decide per backend — an unapproved declaration
> throws with guidance, and a declined backend aborts the run (it would otherwise silently reroute
> its `agent()` calls to the default backend). Host-registered names always win over script
> declarations. Lower-level callers can thread a pre-approved registry via `exec.scriptBackends`.

### c) `WorkflowManager` — stateful / resumable runs

`runDynamicWorkflow` is a thin wrapper over a fresh `WorkflowManager`. Construct one yourself to
keep run state across calls, persist journals, and **resume** a paused run.

```ts
import { WorkflowManager, createAcpRunner } from "@automatalabs/workflows";

const manager = new WorkflowManager({ agent: createAcpRunner() });

const run = await manager.runSync(script, { repo: "agentprism" }, { tokenBudget: 200_000 });

if (run.status === "paused") {
  // A pause carries a journal of every completed agent() call. Re-hydrate it and re-run the
  // SAME script: the unchanged prefix is replayed from the journal, the rest runs live.
  const persisted = manager.getPersistence().load(run.runId);
  const resumeJournal = new Map(persisted?.journal?.map((e) => [e.index, e]) ?? []);
  const finished = await manager.runSync(script, { repo: "agentprism" }, { resumeJournal });
  console.log(finished.status); // "completed", typically
}
```

`runSync(script, args?, exec?)` always resolves to a terminal `WorkflowRunResult`. A run **pauses**
(rather than fails) on a provider usage limit or a headless `checkpoint()`; both are resumable as
above. `WorkflowManagerOptions` lets you set a default `agent`, `concurrency`, `cwd`, a
`loadSavedWorkflow` resolver (enables nested `workflow('name')`), and per-agent timeout/retry
defaults.

Manager events are Node `EventEmitter` notifications: `agentStart`, `agentEnd`, `agentHistory`,
`tokenUsage`, `log`, `phase`, `complete`, `paused`, `resumed`, `stopped`, `error`, and
`agentEvent`. `agentEvent` forwards the live ACP stream from an ACP-capable runner with `name`,
`event`, and the runner context fields (`runId`, `label`, `sessionId`, `backendId`) when the event
carries them; `backend_error` is connection-scoped and carries `backendId` only. ACP
`session/update` traffic is emitted once under its inner discriminant name, while
permission/session/raw/backend events keep their runner names.

```ts
manager.on("agentEvent", ({ runId, label, name }) => console.error(runId, label, name));
```

### d) Bring your own backend — implement the `AgentRunner` seam

`AgentRunner` is the single, frozen coupling point between the engine and any backend. Implement
its one method and inject it anywhere a runner is accepted (`runDynamicWorkflow({ runner })`,
`new WorkflowManager({ agent })`, or `runSync(script, args, { agent })`).

```ts
import {
  runDynamicWorkflow,
  type AgentRunner,
  type RunOptions,
  type AgentResult,
} from "@automatalabs/workflows";
import type { TSchema } from "typebox";

const echoRunner: AgentRunner = {
  async run<S extends TSchema | undefined>(prompt: string, options?: RunOptions<S>) {
    // schema present ⇒ return the validated object; absent ⇒ return text.
    options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
    return `echo: ${prompt}` as AgentResult<S>;
  },
};

const run = await runDynamicWorkflow(script, { runner: echoRunner });
```

Seam contract (summarized): `run()` returns the **raw** value (schema ⇒ validated object, no schema
⇒ string) — never an envelope; usage flows out-of-band via `options.onUsage`; on failure **throw**
(ideally a `WorkflowError` so `instanceof` holds across packages); honor `options.signal` but do
**not** implement your own timeout (the engine owns timeout/abort). This makes the SDK fully
testable without a live agent — pass a stub runner.

---

## Listening in on the live ACP stream (events)

`createAcpRunner()` returns an `AcpAgentRunner` with a **typed event bus**. Subscribe with
`runner.on(name, listener)` to observe the live ACP stream of every run on that runner — streaming
assistant text, tool calls, usage, permissions — without touching the `run()` return value or the
`AgentRunner` seam.

```ts
import { createAcpRunner } from "@automatalabs/workflows";

const runner = createAcpRunner();

// ACP `sessionUpdate` discriminants are the event names; the listener payload is typed to each.
runner.on("agent_message_chunk", (e) => {
  if (e.content.type === "text") process.stdout.write(e.content.text); // stream tokens as they land
});
runner.on("tool_call", (e) => console.error(`[${e.label}] tool: ${e.title}`));
runner.on("usage_update", (e) => console.error(`ctx ${e.used}/${e.size} tokens`));

// One catch-all for "everything": fires for EVERY session/update, carrying the raw update.
const off = runner.on("session_update", (e) => console.error(e.update.sessionUpdate));

await runner.run("Refactor this module and run the tests.", { label: "refactor", cwd });
off(); // on()/once() return an unsubscribe thunk; off(name, listener) and removeAllListeners() also exist
await runner.dispose();
```

**Event names.** The ACP `sessionUpdate` discriminants verbatim — `user_message_chunk`,
`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`,
`plan_update`, `plan_removed`, `available_commands_update`, `current_mode_update`,
`config_option_update`, `session_info_update`, `usage_update` — plus a few cross-cutting events:

| event | payload |
|-------|---------|
| `session_update` | `{ update }` — catch-all for **every** update, regardless of kind |
| `permission_pending` | `{ request }` — resolver-only; emitted after the request is parked and before the resolver is invoked |
| `permission_request` | `{ request, outcome }` — the final permission outcome returned to the agent |
| `raw_message` | `{ method, message }` — a vendor extension notification (e.g. Claude `_claude/sdkMessage`) |
| `session_open` / `session_close` | an ACP session opened / was released |
| `backend_error` | `{ backendId, error }` — a pooled backend process crashed |

**Context envelope.** A pooled runner multiplexes many concurrent runs over one process, so every
event (except `backend_error`) carries `{ sessionId, backendId, label?, runId? }` — filter by
`label`/`runId` (from the run's `RunOptions`) to attribute an event to a specific run.

**Best-effort.** Listeners are observers: a throwing listener is isolated and never breaks the run,
the update drain, or sibling listeners.

**With `runDynamicWorkflow` / `WorkflowManager`.** Subscribe at the manager layer:
`manager.on("agentEvent", ({ runId, label, name, event }) => …)`. Every `agent()` call in the
script then streams live ACP events through the manager; ACP `session/update` traffic is forwarded
once under `name = event.sessionUpdate`, so hosts do not receive both the catch-all and the
per-discriminant runner event.

---

## The in-script DSL

The orchestration primitives are **not importable symbols**. They are **globals injected into the
script's `vm` realm**, available only **inside** the script string you pass to
`runDynamicWorkflow` / `runSync`. There is nothing to import to obtain them. Their shapes are
documented for editor IntelliSense by the **ambient `dsl.d.ts`** shipped with this package (it
ships no runtime code).

| global | what it does |
|--------|--------------|
| `agent(prompt, options?)` | Run ONE subagent to completion; returns its result (text, or the validated object with `options.schema`). |
| `parallel(thunks)` | Run an array of **thunks** (`() => Promise`) concurrently; resolves in input order. |
| `pipeline(items, ...stages)` | Map `items` through sequential async stages, concurrently across items. |
| `workflow(nameOrScript, args?)` | Run a saved (or inline) workflow nested in this run, sharing its limiter/budget. |
| `verify(item, options?)` | Adversarial verification panel — N reviewers vote whether `item` is real/correct. |
| `judgePanel(attempts, options?)` | LLM-judge panel — score candidates against a rubric, return the best. |
| `loopUntilDry(options)` | Repeat a round, collecting deduped new items until it dries up. |
| `completenessCheck(args, results)` | Ask a critic what is still missing. |
| `retry(thunk, options?)` | Bounded retry until `until(result)` holds. |
| `gate(thunk, validator, options?)` | Validate-and-feed-back loop until it passes. |
| `checkpoint(text, options?)` | Deterministic, journaled human gate (headless takes a default). |
| `phase(title, options?)` | Open a named phase (optional soft token sub-budget). |
| `log(message)` | Append a line to the run log. |
| `args` | The input bag passed in via `{ args }`. |
| `budget` | Live token-budget view: `budget.total`, `budget.spent()`, `budget.remaining()`. |

(`console.log/info/warn/error` route to `log` too.) Pass these primitives **thunks**, not
promises — `parallel([() => agent("a"), () => agent("b")])`, not `parallel([agent("a"), …])`.

---

## Structured output

Pass a JSON Schema to `agent({ schema })` (in a script) or `runner.run(prompt, { schema })` (direct)
and the result is a **validated object** instead of text. The backend constrains output natively
(Claude `outputFormat`; Codex strict `outputSchema`), then the value is coerced and validated
client-side (typebox `Convert` → `Check`); on a miss the runner re-prompts a bounded number of
times before failing with a non-recoverable `SCHEMA_NONCOMPLIANCE`.

A **plain JSON Schema object literal** works everywhere (this is the only option inside a script —
no schema-builder is injected into the realm):

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["title", "score"],
  "properties": {
    "title": { "type": "string" },
    "score": { "type": "number" }
  }
}
```

In TypeScript you may instead build the schema with [typebox](https://github.com/sinclairzx81/typebox)
(`Type.Object({ … })`) for static result typing. Two helpers convert a typebox schema to the exact
wire JSON Schema each backend expects:

```ts
import { toJsonSchema, toStrictJsonSchema } from "@automatalabs/workflows";
import { Type } from "typebox";

const schema = Type.Object({ title: Type.String(), score: Type.Number() });
toJsonSchema(schema);        // plain JSON Schema (Claude outputFormat)
toStrictJsonSchema(schema);  // OpenAI-strict-normalized (Codex outputSchema)
```

---

## Backend selection

The backend for each agent is chosen from its `model` (preferred) or `tier` string:

- **Provider prefix** — `anthropic/…` or `claude/…` ⇒ Claude; `openai/…` or `codex/…` ⇒ Codex.
- **Bare id** — matched by pattern: `codex` / `gpt` / `openai` / `o<digit>` ⇒ Codex;
  `claude` / `opus` / `sonnet` / `haiku` / `anthropic` ⇒ Claude.
- **No match / no spec** — the default backend: `AGENTPRISM_DEFAULT_BACKEND` (`claude` | `codex`,
  default `claude`).

```ts
import { selectBackend } from "@automatalabs/workflows";

selectBackend({ model: "opus" }).id;          // "claude"
selectBackend({ model: "gpt-5-codex" }).id;    // "codex"
selectBackend({ model: "anthropic/claude-sonnet" }).id; // "claude"
```

Within a provider, the model spec selects the concrete model on the session (Claude `_meta` model /
Codex config). Per-backend pool size is `AGENTPRISM_ACP_POOL_SIZE` (or `AcpPoolOptions.size`).

---

## Exports

```ts
// ── Run entry & helper ──
runDynamicWorkflow,           // (script, { args?, runner?, exec? }) => Promise<WorkflowRunResult>
runWorkflow,                  // the bare engine run (no status trio)
parseWorkflowScript,          // parse a script's meta + body
WorkflowManager,              // stateful / resumable run manager

// ── ACP backend ──
createAcpRunner,              // () => AcpAgentRunner (the default AgentRunner; has .on(...) events)
AcpAgentRunner,               // class — implements AgentRunner over ACP
InteractiveSession,           // held-open multi-turn ACP session returned by openSession()
selectBackend,                // pick Claude vs Codex from a model/tier spec
ClaudeBackend, CodexBackend,  // the concrete backends
clientCapabilitiesFor, adaptPromptContent,
toJsonSchema, toStrictJsonSchema,
TypedEventEmitter,            // the tiny typed emitter backing runner.on(...)

// ── Errors ──
WorkflowError, WorkflowErrorCode, isWorkflowError, isProviderUsageLimit,

// ── Persistence paths ──
AGENTPRISM_PERSISTENCE_ROOT_ENV,

// ── Types ──
RunDynamicWorkflowOptions, WorkflowRunOptions, AgentOptions, ExecOptions,
WorkflowManagerOptions, CheckpointOptions, WorkflowRunResult, WorkflowSnapshot,
WorkflowPathOptions, RunPersistenceOptions,
AcpPoolOptions, AgentRunner, RunOptions, AgentResult, AgentUsage, JournalEntry,
InteractiveSessionOptions, InteractiveTurn, PermissionResolver,
ClientHandlers, FsHandlers, TerminalHandlers, AcpSessionContext, NegotiatedCapabilities,
// ACP events: the runner.on(...) surface
AcpRunnerEventMap, AcpEventName, AcpEventListener, AcpEventContext,
AcpSessionUpdate, AcpUpdateKind, AcpPermissionPendingEvent, AcpPermissionEvent,
AcpRawMessageEvent, AcpBackendErrorEvent,
```

(The DSL globals — `agent`, `parallel`, `pipeline`, … — are **not** exported; they are realm
globals documented by the ambient `dsl.d.ts`.)

---

## See also

- **[`@automatalabs/mcp-server`](https://www.npmjs.com/package/@automatalabs/mcp-server)** — the
  stdio MCP server built on this SDK. It wraps the same engine + ACP backend behind a single
  `workflow` tool (bin: `agentprism-workflow`) for any MCP host. Use it when you want the
  **MCP-tool route** instead of embedding the runner in code.

## License

Apache-2.0
