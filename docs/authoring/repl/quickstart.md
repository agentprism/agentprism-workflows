# REPL orchestration: quickstart

**Context:** JavaScript sent to the MCP `repl` tool. This is not workflow-script code: REPL `agent()` takes `(modelSpec, task, options?)`, top-level `return` is a syntax error, and named bindings persist between calls.

The REPL is one persistent QuickJS-in-WASM workspace per absolute `projectDir`. Use it when you want to inspect intermediate results and decide the next step interactively. Use `workflow` when the full orchestration is known up front and should be repeatable as one deterministic script.

## First eval

```js
const audit = agent("codex", "Inspect the parser for correctness bugs");
```

Send that code using:

```json
{ "action": "eval", "projectDir": "/absolute/project", "code": "..." }
```

`agent()` returns a persistent promise-handle immediately. Storing the handle before awaiting preserves its `id`, `queue()`, `steer()`, and `cancel()` methods for later evals.

Inspect or await it in another eval:

```js
agents()
```

```js
const report = await audit;
report
```

A completed eval returns `{ output, result? }`. If the soft hold bound expires while the eval remains suspended, the tool returns `{ output, running: [callIds] }`; execution continues server-side. Poll without running new code by evaluating the empty string:

```json
{ "action": "eval", "projectDir": "/absolute/project", "code": "" }
```

## Essential semantics

- Top-level `await` works; top-level `return` does not.
- `let`, `const`, `var`, functions, and classes remain available to later evals.
- `_` is the previous eval's completion value.
- Console output is returned as text but is not a persistent value. Assign values you need later.
- There is no filesystem, network, import, or general timer API in the VM. Subagents perform external work; `sleep(ms)` is the one host-backed timer.
- The default eval hold is 60 seconds and the per-call maximum is 120 seconds. This is a response hold, not cancellation.
- Use `interrupt` with a call `id` to cancel one subagent/queued turn, or omit `id` to break the currently running eval.
- `workspace()` shows bindings, in-flight calls, checkpoints, and diagnostics. `agents()` shows live agent lanes and queued turns.
- `reset()` tears the workspace down after the current eval completes.

## Structured output

```js
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: { type: "array", items: { type: "string" } },
  },
};
const review = agent("claude", "Review error handling", { schema });
const result = await review;
result.findings
```

Agent options are exactly `schema`, `cwd`, `configOptions`, and `mode`. Unknown keys reject. Model, mode, and option ids are backend-specific; use the `workflow` tool's zero-token `action:"config"` discovery before pinning them.

## What to read next

- `repl/state-and-bindings` — persistence, completion values, polling, and output.
- `repl/agent-handles` — `agent()` options, failures, and handle identity.
- `repl/steering-queueing-and-cancellation` — strict active-turn control and durable future turns.
- `repl/api-reference` — every guest global and tool action.
