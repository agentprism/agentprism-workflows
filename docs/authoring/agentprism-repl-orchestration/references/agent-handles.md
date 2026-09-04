# REPL agent calls and persistent handles

REPL delegation uses:

```js
agent(modelSpec, task, options?) -> PromiseHandle
```

This differs from workflow scripts, whose signature is `agent(prompt, options?)`.

## Model routing

`modelSpec` is required. Use a registered backend name alone to preserve its configured default model:

```js
const worker = agent("codex", "Investigate the failing parser test");
```

Use `backend/model-id` only after model discovery:

```js
const worker = agent("claude/verified-model-id", "Review the implementation");
```

The known built-ins are Claude, Codex, OpenCode, and pi, plus host-registered custom backends. Unknown backend names reject and enumerate known backends. Use the `workflow` tool's `action:"config"` with `harnesses`/`modelFilter`, then `modelSpecs`, before pinning model, mode, or config-option values. Read the selected entry's harness-owned mode names/descriptions before pinning an exact advertised id. Omission uses `defaultModeId` (Claude auto, Codex agent, OpenCode build; none for Pi).

## Exact option vocabulary

```js
const worker = agent("codex", "Inspect the parser", {
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: { summary: { type: "string" } },
  },
  cwd: "/absolute/path",
  mode: "advertised-mode-id",
  configOptions: { advertisedOptionId: "advertised-value" },
});
```

Options are exactly:

- `schema`: plain JSON Schema object; the promise resolves to its validated object.
- `cwd`: absolute worker session working directory.
- `mode`: exact ACP mode explicitly listed in the selected backend/model's discovered `modes.availableModes`.
- `configOptions`: exact string/boolean ACP option ids and values.

Unknown option keys reject. Options must be JSON-serializable.

## Preserve the handle

The returned promise is also the live handle:

```js
const worker = agent("pi", "Research the issue");
const id = worker.id;
const answer = await worker;
```

Do not write this if you intend to reuse the session:

```js
const worker = await agent("pi", "Research the issue");
```

That variable stores only the answer and loses access to handle methods.

The founding handle exposes non-enumerable, immutable members:

- `id`: stable call id such as `"c1"`.
- `queue(prompt, options?)`: create a distinct durable FIFO future turn.
- `steer(prompt, options?)`: attempt strict control of only the currently active turn.
- `cancel()`: cancel the session's current public turn.

A queued-turn handle exposes its own `id` and `cancel()`.

## Settlement and failures

Without `schema`, the founding promise resolves to final assistant text. With `schema`, it resolves to the validated object.

A rejected call carries an error with call/backend attribution where available. Errors whose `recoverable` field is not `false` are treated as recoverable by `parallel()` and `pipeline()` and become `null` slots. A non-recoverable error rejects the surrounding combinator/eval.

Direct `await worker` propagates rejection; catch only errors you can handle meaningfully:

```js
let answer;
try {
  answer = await worker;
} catch (error) {
  console.error(error);
  answer = null;
}
```

## Session continuity

The founding answer settling does not erase the handle binding. Queue later prompts on the founding handle to continue the same ACP session. Session continuity depends on the backend's continuation capability and the workspace's durable lane state. Never fabricate a new handle from a saved id; retain the actual promise-handle binding.
