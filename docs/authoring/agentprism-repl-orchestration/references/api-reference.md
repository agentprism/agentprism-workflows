# REPL API reference

**Context:** code evaluated by the MCP `repl` tool. Workflow scripts use a different `agent(prompt, options?)` signature and have additional run/journal APIs.

## MCP tool actions

```text
repl({ action: "eval", projectDir, code, timeoutMs? })
repl({ action: "interrupt", projectDir, id? })
```

`projectDir` is required on the shared daemon and optional in a single-project server. `eval` requires a code string; an empty string is the idempotent settlement poll. `timeoutMs` is an integer from 0 through 120000, default 60000, and bounds only how long the tool call pumps settlements. `interrupt` with `id` cancels exactly that live call; without `id` it breaks the running eval. Fields from the other action are rejected.

Finished eval result:

```ts
{ output: string; result?: string }
```

Still-running eval result:

```ts
{ output: string; running: string[] }
```

## Guest globals

```text
agent(modelSpec, task, options?) -> PromiseHandle
checkpoint(question, options?) -> Promise
checkpoint.answer(callId, value) -> boolean
parallel(thunks) -> Promise<results[]>
pipeline(items, ...stages) -> Promise<results[]>
verify(item, { reviewers = 2, threshold = 0.5, lens? })
  -> { real, realCount, total, votes }
judgePanel(attempts, { judges = 3, rubric = "overall quality and correctness" })
  -> { index, attempt, score, judgments }
gate(thunk, validator, { attempts = 3 })
  -> { ok, value, verdict, attempts }
retry(thunk, { attempts = 3, until? }) -> last result
loopUntilDry({ round, key = JSON.stringify, consecutiveEmpty = 2, maxRounds = 50 })
  -> unique items[]
sleep(ms) -> Promise<undefined>
workspace() -> { bindings, inFlight, checkpoints, diagnostics }
agents() -> live agent/queued-turn rows
reset() -> undefined
console.log/info/warn/error/debug(...values) -> undefined
_ -> previous eval completion value
```

Top-level `await` is accepted. Top-level `return` is a syntax error.

## `agent()`

```js
agent(modelSpec, task, {
  schema?: object,
  cwd?: string,
  configOptions?: Record<string, string | boolean>,
  mode?: string,
})
```

All arguments except options are required strings. The option vocabulary is exact. Options cross the bridge as JSON. Without `schema`, the handle resolves to assistant text; with `schema`, to the validated object.

Founding promise-handle members:

```text
handle.id: string
handle.queue(prompt, { promptMeta?: object }?) -> QueuedPromiseHandle
handle.steer(prompt, { promptMeta?: object }?) -> Promise<"injected" | "idle" | "unsupported">
handle.cancel() -> Promise
```

Queued promise-handle members:

```text
queued.id: string
queued.cancel() -> Promise
```

## Combinator semantics

`parallel` requires functions, not promises, and preserves input order. A recoverable rejection becomes `null` in its slot; a non-recoverable rejection propagates.

`pipeline` runs each item through each stage in order while items progress concurrently. A stage receives `(previousValue, originalItem, index)`. Recoverable item failure yields `null` for that item.

`verify` uses the host's configured default backend for adversarial votes. Failed reviewers are dropped. `lens` may be one string or an array rotated across reviewers.

`judgePanel` uses the host default backend to score every candidate from 0 to 1 and returns the highest mean; ties prefer the lower input index.

`retry` calls `thunk(attempt)` up to the bound. Without `until`, the first result is accepted. With `until`, the last result is returned if no attempt passes.

`gate` calls `thunk(feedback, attempt)`, then awaits `validator(result)`. The verdict may be boolean or `{ ok, feedback?, ... }`; object feedback enters the next producer attempt. The complete last verdict is returned.

`loopUntilDry` repeatedly calls `round(index)`, deduplicates non-null items using `key`, and stops after the configured consecutive empty rounds or maximum rounds.

## Checkpoints

`checkpoint(question, options?)` accepts a string question and any JSON-serializable options object. The promise parks until a later eval calls `checkpoint.answer(id, value)`. Answer delivery is explicit, first-wins, and returns whether a pending checkpoint was settled.

## Environment

The VM has ordinary deterministic JavaScript data/control APIs but no imports, `require`, filesystem, network, or general timers. `sleep(ms)` is host-backed. Console calls never throw and return output only. Bind values explicitly when they must persist.
