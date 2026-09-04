# REPL state, bindings, and eval results

Every project has one persistent JavaScript VM. A later `eval` sees the same global lexical environment and the same unresolved promise-handles as earlier evals.

## Persist values explicitly

```js
const target = "src/parser";
const findings = [];
```

Both names remain available later. Console output does not create a value:

```js
console.log({ target }); // emits output only
```

The special `_` binding contains the previous eval's completion value, similar to an interactive language shell:

```js
[1, 2, 3].map((x) => x * 2)
// later:
_.reduce((sum, x) => sum + x, 0)
```

Assign important results to descriptive names instead of depending on `_`, because each completed eval replaces it.

## Top-level syntax

Top-level `await` is supported:

```js
const answer = await worker;
answer
```

Top-level `return` is a syntax error. The final expression becomes the eval completion value. Standard JavaScript control flow works, including async functions and `for await`.

## Eval result shapes

Finished:

```js
{ output: "zero or more console/error lines", result: "value repr when present" }
```

Still running after the soft hold bound:

```js
{ output: "lines emitted so far", running: ["c1", "c2"] }
```

The eval continues after the second shape. Any later eval drains settlements first. An empty code string is the idempotent poll and runs no user code.

`output` is newline-joined console, checkpoint, and uncaught-error rendering. Direct strings passed to console print in full. Objects and arrays use a depth-limited preview; evaluate a narrower property or slice to inspect more. Preserve large values in bindings rather than repeatedly printing them into model context.

## Concurrency and serialization

VM operations serialize, so concurrent clients cannot reorder individual eval operations. Subagents run concurrently under the workspace's host limit. The eval call pumps promise settlements until completion or its response bound; the bound does not terminate the underlying eval.

Use `sleep(ms)` for a host-backed delay:

```js
await sleep(250);
```

No other timer API is available.

## Introspection

```js
workspace()
```

returns a plain object containing `bindings`, `inFlight`, `checkpoints`, and `diagnostics`. Binding rows include the name, type/size preview, provenance, task/call id where relevant, and settlement status.

```js
agents()
```

returns live agent/queued-turn rows with call ids, model specs, task previews, state, steering support, and queued-turn counts. Use these functions instead of guessing whether a handle is active.

## Cleanup

```js
reset()
```

requests teardown after the current eval completes. All bindings and pending work in that project workspace are discarded. It returns `undefined`; the next eval creates a fresh workspace.
