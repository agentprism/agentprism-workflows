---
name: agentprism-workflow-authoring
description: Write and run deterministic AgentPrism workflow scripts through the MCP workflow tool. Use for workflow DSL syntax, live backend/model/mode discovery with action:"config", agent routing, structured output, explicit checkpoints, composition, run status, pause, stop, result retrieval, and same-run resume.
---

# Workflow scripts: quickstart

**Context:** JavaScript passed to the MCP `workflow` tool. Scripts use `agent(prompt, options?)`, allow top-level `await` and top-level `return`, and start with a required metadata export.

A workflow script is a deterministic orchestrator. Script code owns loops, fan-out, conditionals, aggregation, and checkpoints; `agent()` workers perform repository or research tasks. Workers start fresh sessions and share no memory, so interpolate every prior result a later worker needs into its prompt.

## Before you write: discover the live catalog

Backend availability, model ids, mode ids, and config-option ids differ per machine, login, and harness version. Never write one from memory. Call the `workflow` tool first:

```json
{ "action": "config", "projectDir": "/absolute/project" }
```

The response lists every backend (`claude`, `codex`, `opencode`, `pi`, plus registered custom backends) with whether it could be probed, its advertised modes and default mode, its config options, and its model catalog. Pin only values copied from that response. A backend name alone (`model: "codex"`) is always a valid route and keeps that backend's own default model, so most scripts never need a pinned model id. Read [`references/models-and-config.md`](references/models-and-config.md) for the response fields and the pinning walkthrough.

## Minimal valid script

```js
export const meta = {
  name: "review-target",
  model: "codex",
  description: "Review a target and return concrete findings",
  phases: [{ title: "Review" }],
};

phase("Review");
const report = await agent(
  `Review ${args.target}. Read the relevant files and report concrete findings.`,
  { label: "review" },
);
return { report };
```

The metadata export must be the first statement and a pure object literal. `name` and `description` are required non-empty strings. `phases`, when present, is an array of objects shaped `{ title: string, detail?: string, model?: string }`, never strings.

Submit the source without Markdown fences through the run action, with an absolute `projectDir` on the shared daemon. `args` is the JSON value supplied by the tool call. Some hosts carry caller data as a JSON string, so harden scripts that accept external input:

```js
const raw = typeof args === "string" ? (() => {
  try { return JSON.parse(args); } catch { return {}; }
})() : args;
const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
```

## Core rules

- The DSL primitives are injected globals; do not import them.
- Top-level `await` and top-level `return` are supported.
- Scripts are JavaScript, not TypeScript.
- No `require`, imports, filesystem API, network API, timers, `Date.now()`, `Math.random()`, or no-argument `Date` construction. Pass nondeterministic values through `args`.
- Every `agent()` call should have a stable descriptive `label`.
- A recoverable worker failure resolves to `null` after retries. Null-check load-bearing results.
- `parallel()` takes thunks, not already-started promises:

```js
const results = (await parallel([
  () => agent("Review correctness", { label: "review:correctness" }),
  () => agent("Review test coverage", { label: "review:coverage" }),
])).filter(Boolean);
```

- Use a plain JSON Schema object in `schema` when script control flow depends on a worker result.
- Return a compact JSON-serializable result; do not return a transcript.

## Model selection

Every `agent()` call must resolve a model from its own `model` option, its `agentType` definition, the current phase's `model`, or `meta.model`. A backend name alone (`"codex"`) keeps that backend's configured default model. Omit a call's `model` only when it inherits one of those routes; a call with no route is rejected at preflight before anything runs.

`mode` and `configOptions` are optional. Set them only with ids copied from the config response. For trusted implementation or review work, select Claude `bypassPermissions` or Codex `agent` when advertised. Claude `auto` is classifier-driven and may request permission, which you must answer through `permissions-response`.

## Validation and execution

Run prepares the workflow inside the request: source checks, a mocked dry run, and no-prompt config probes for every routed backend/model pair. Only when every step succeeds does the server start execution and return the `runId`. Malformed source, a failed dry run, missing routing, an unadvertised mode or config option, or a full project (four active runs) are tool execution errors (`isError:true`) that create no run. A script declaring custom backends is validated the same way, then parked (`status:"pending"` with `setup.request`) until you approve it with `setup-response`.

Cancelling the run request before it returns abandons preparation; nothing is persisted. Once admitted, the run belongs to the server and survives client disconnects. Each run's script is a `file://` resource (`scriptUri`, `scriptPath`). Retain `runId` for status, setup, checkpoint replies, pause, stop, and results.

The input is one flat object, but each action accepts only its own fields: send only fields belonging to the selected action. The `action` field's description lists every action's fields. `projectDir` belongs to `config` and `run` only. A rejected call names the action, the offending or missing field, and the fields that action accepts.

## Minimal MCP lifecycle

Start a run and retain its `runId`:

```json
{
  "action": "run",
  "projectDir": "/absolute/project",
  "script": "export const meta = { name: 'review', description: 'Review a target', model: 'codex' }; return await agent(`Review ${args.target}`, { label: 'review' });",
  "args": { "target": "packages/core" }
}
```

Observe the current state. Status is always an immediate snapshot; issue it again for a later sample:

```json
{ "action": "status", "runId": "RUN_ID" }
```

Act on what status reports:

- `setup.state:"input-required"`: approve the declared custom backends with `{ action:"setup-response", runId, setupId: setup.request.id, response:{ action:"accept", content:{ approve:true } } }`, or send `response:{ action:"decline" }`.
- `pendingPermissions[]`: answer one with `{ action:"permissions-response", runId, permissionId, response:{ outcome:{ outcome:"selected", optionId } } }`, using an `optionId` from that entry's `request.options`.
- `outcome.checkpointContext`: the run is paused on a `checkpoint()`. Answer its exact `callIndex` and continue with `{ action:"resume", runId, checkpointReplies:{ "1": false } }`. The reply reaches the script verbatim; a negative answer follows the script's own control flow. Nothing else can answer a checkpoint.

After completion, retrieve the exact result. If `hasMore` is true, repeat with `offset` set to the previous `endOffset`:

```json
{ "action": "result", "runId": "RUN_ID", "offset": 0, "maxBytes": 16384 }
```

Continue a paused, failed, or stopped run in place; do not resend `script` or `args`:

```json
{ "action": "resume", "runId": "RUN_ID" }
```

Resume keeps the same `runId`, reuses the run's args, journal, and checkpoint decisions, and re-reads the script from `scriptPath`. An unchanged file continues where the run left off; an edited file is validated like a new run and continues with an identity-matched replay (unchanged calls replay, edited or new calls run live).

Pause with `{ action:"pause", runId }` to let executing agents finish and journal first; stop with `{ action:"stop", runId }` to interrupt now. Both leave a run that `resume` continues. If your host lists a `workflow_monitor` tool, `{ "runId": "RUN_ID" }` opens a live view; it is never required.

## What to read next

Read only the references needed for the task:

- [`references/composition-and-failure.md`](references/composition-and-failure.md) — metadata, fan-out, phases, and null semantics.
- [`references/api-agents.md`](references/api-agents.md) — every `agent()` option, model specs, and structured output.
- [`references/run-lifecycle.md`](references/run-lifecycle.md) — every tool action, its fields, and what status reports.
- [`references/models-and-config.md`](references/models-and-config.md) — reading the config response and pinning models, modes, and options.
- [`references/checkpoints-and-quality.md`](references/checkpoints-and-quality.md) — quality loops and human checkpoints.
- [`references/environment-and-tools.md`](references/environment-and-tools.md) — working directory, isolation, tools, and custom backends.
- [`references/determinism-and-resume.md`](references/determinism-and-resume.md) — what is journaled and how resume replays it.
- [`references/api-control-flow.md`](references/api-control-flow.md) — complete control-flow signatures and error codes.
- [`references/examples.md`](references/examples.md) — complete composition patterns.
