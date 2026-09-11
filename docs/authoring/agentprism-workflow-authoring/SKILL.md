---
name: agentprism-workflow-authoring
description: Write and run deterministic AgentPrism workflow scripts through the MCP workflow tool. Use for workflow DSL syntax, agent routing, structured output, explicit checkpoints, composition, validation, durable setup, monitoring, status, stop, result retrieval, and same-run resume.
---

# Workflow scripts: quickstart

**Context:** JavaScript passed to the MCP `workflow` tool. This is not REPL code: workflow scripts use `agent(prompt, options?)`, allow top-level `return`, and start from a required metadata export.

A workflow script is a deterministic orchestrator. Script code owns loops, fan-out, conditionals, aggregation, and checkpoints; `agent()` workers perform repository or research tasks. Workers start fresh sessions and do not share memory, so interpolate every prior result a later worker needs into its prompt.

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

Submit the source without Markdown fences using the `workflow` tool's run form, with an absolute `projectDir` on the shared daemon. `args` is the JSON value supplied by the tool call. Some hosts may carry caller data as a JSON string, so harden scripts that accept external input:

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

Every actual call must resolve a model from its own options, a named-agent definition, a resolved
tier, the current phase, or `meta.model`. A backend-only value such as `"codex"` explicitly retains
that backend's configured default model. Omit a call's `model` only when it inherits a route.
Missing routing fails with bounded discovery guidance for every client; there is no configuration
form or automatically selected backend. Mode and config options remain optional. Before pinning a model id, `mode`, or `configOptions`, call `workflow` with `action:"config"` and use `modelSpecs` for that model's exact domain. For trusted implementation/review work, select Claude `bypassPermissions` or Codex `agent` when advertised. Claude `auto` is classifier-driven and may request permission; do not treat it as full-access autonomy. Pin only exact advertised ids and never guess model or option ids. The effective choices are persisted canonically for the run and reused unchanged by continuation.

## Validation and execution

Run prepares the workflow inside the request: bounded input/source checks, a mocked dry run, routed no-prompt config probes, and immutable routing admission. Only when every step succeeds does the server start execution and return the `runId`. Malformed source, a failed dry run, missing routing, or a full project are tool execution errors (`isError:true`) that create no run. A script declaring custom backends is validated the same way, then parked in durable setup (`status:"pending"` with `setup.request`) until approved; declined setup remains an inspectable aborted run. No live worker starts before validation, required backend approval, and admission finish.

Cancel a Run by cancelling the request: close the Streamable HTTP response stream, or send `notifications/cancelled` on stdio. Preparation stops, nothing is persisted, and the capacity slot is released. Cancellation that arrives after admission is ignored; a run whose acknowledgement was lost is listed under the `workflow://runs/` resources. Supply `_meta.progressToken` to receive preparation stage notifications. Retain `runId` for status, setup, checkpoint replies, stop, and results. No workflow execution-mode field is accepted.

The input is a strict action union: send only fields belonging to the selected action. In particular, `projectDir` belongs to `config` and `run`, not `status`, `result`, `resume`, or `stop`. Some MCP clients report every rejected union branch; when that happens, first check the branch matching your `action` and remove cross-action fields.

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

If `setup.state` is `"input-required"`, answer the backend-approval request at the exact `setup.request.id` with `action:"setup-response"` and fields matching its `requestedSchema`. Setup acceptance is `{ action:"accept", content:{ ... } }`; decline/cancel has no content. A checkpoint is different: it appears in `outcome.checkpointContext` and requires a new Resume with `checkpointReplies`.

Every unanswered `checkpoint()` pauses. For example, answer the exact observed checkpoint index with `{ action:"resume", runId:"RUN_ID", checkpointReplies:{ "1":false } }`. The explicit value follows the script's authored control flow. Timeouts, absent panels, and dismissed interactions cannot supply an answer.

To open an App, call the separate `workflow_monitor` tool with `{ "runId":"RUN_ID" }`. Lifecycle operations carry no UI attachment. A monitor can switch among active/recent runs; status and results remain available without an App.

After completion, retrieve the exact result. If `hasMore` is true, repeat with `offset` set to the previous `endOffset`:

```json
{ "action": "result", "runId": "RUN_ID", "offset": 0, "maxBytes": 16384 }
```

Continue an incomplete run in place; do not resend `script` or `args`:

```json
{ "action": "resume", "runId": "RUN_ID" }
```

The response keeps the same `runId` without exposing an execution-attempt identity. It reuses the
admitted script, args, immutable routing inputs, journal, event stream, cumulative usage, and
durable checkpoint decisions. Use `status` on that same ID, then `result` after completion.
Explicitly stop with `{ action:"stop", runId:"RUN_ID" }`. Once a run is admitted, client disconnection leaves it owned by the server; process loss preserves durable state for later inspection/recovery.

## What to read next

Read only the references needed for the task:

- [`references/composition-and-failure.md`](references/composition-and-failure.md) — metadata, fan-out, phases, and null semantics.
- [`references/api-agents.md`](references/api-agents.md) — every `agent()` option and structured output.
- [`references/run-lifecycle.md`](references/run-lifecycle.md) — config, run, status, stop, and resume.
- [`references/models-and-config.md`](references/models-and-config.md) — backend routing and live model/config discovery.
- [`references/checkpoints-and-quality.md`](references/checkpoints-and-quality.md) — quality loops and human checkpoints.
- [`references/environment-and-tools.md`](references/environment-and-tools.md) — execution roots, isolation, tools, and custom backends.
- [`references/determinism-and-resume.md`](references/determinism-and-resume.md) — replay identity and continuation.
- [`references/api-control-flow.md`](references/api-control-flow.md) — complete control-flow signatures.
- [`references/api-resume-and-backends.md`](references/api-resume-and-backends.md) — detailed resume and backend-extension contracts.
- [`references/examples.md`](references/examples.md) — complete composition patterns.
