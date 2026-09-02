# Workflow scripts: quickstart

**Context:** JavaScript passed to the MCP `workflow` tool. This is not REPL code: workflow scripts use `agent(prompt, options?)`, allow top-level `return`, and start from a required metadata export.

A workflow script is a deterministic orchestrator. Script code owns loops, fan-out, conditionals, aggregation, and checkpoints; `agent()` workers perform repository or research tasks. Workers start fresh sessions and do not share memory, so interpolate every prior result a later worker needs into its prompt.

## Minimal valid script

```js
export const meta = {
  name: "review-target",
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

Omit `model` for the server default, or use a backend-only value such as `"codex"` to retain that backend's configured default model. When `AGENTPRISM_DEFAULT_BACKEND` is truly unset, the MCP server probes backend readiness without prompting, pins one project default before validation/execution, and keeps that backend for the run and resume; an explicit environment default always wins. Before pinning a model id, `mode`, or `configOptions`, call `workflow` with `action:"config"`. After choosing a model, use `modelSpecs` to read that exact model's option domain. Config preserves each advertised mode's id, name, description, and `_meta`, plus `defaultModeId`. When mode is omitted, AgentPrism applies Claude `auto`, Codex `agent`, OpenCode `build`, or no Pi mode. Pin only exact advertised ids and never guess model or option ids.

## Validation and execution

Every `{ action:"run", ... }` request is statically parsed, mock-executed, and checked against no-prompt backend configuration before admission. A rejection creates no run ID, reserves no background slot, and spends no tokens. Read the diagnostic, correct the script, and submit it again.

Use foreground execution for short work. Use `background:true` for work that may outlive one tool request; retain the returned `runId`, then use bounded `status` or `stop` calls.

The input is a strict action union: send only fields belonging to the selected action. In particular, `projectDir` belongs to `config` and `run`, not `status`, `result`, `resume`, or `stop`. Some MCP clients report every rejected union branch; when that happens, first check the branch matching your `action` and remove cross-action fields.

## Minimal MCP lifecycle

This is the complete long-running loop. First admit a background run and retain its `runId`:

```json
{
  "action": "run",
  "projectDir": "/absolute/project",
  "background": true,
  "script": "export const meta = { name: 'review', description: 'Review a target' }; return await agent(`Review ${args.target}`, { label: 'review' });",
  "args": { "target": "packages/core" }
}
```

Observe without imposing an execution deadline. A `waitMs` timeout returns current progress and never cancels the run:

```json
{ "action": "status", "runId": "RUN_ID", "waitMs": 25000 }
```

After completion, retrieve the exact result. If `hasMore` is true, repeat with `offset` set to the previous `endOffset`:

```json
{ "action": "result", "runId": "RUN_ID", "offset": 0, "maxBytes": 16384 }
```

To retry an incomplete source from its stored immutable script and args, create a new run; do not resend `script`:

```json
{ "action": "resume", "runId": "RUN_ID", "background": true }
```

The new admission reports a predicted replayable prefix. Use `status` on the new `runId` for observed replayed/live/failed counts, then use `result` after completion.

## What to read next

- `workflow/composition-and-failure` — metadata, fan-out, phases, and null semantics.
- `workflow/api-agents` — every `agent()` option and structured output.
- `workflow/run-lifecycle` — config, run, status, stop, and resume.
- `workflow/examples` — complete composition patterns.
