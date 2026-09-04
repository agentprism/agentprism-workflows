# REPL checkpoints and introspection

REPL checkpoints park a promise until a later eval explicitly supplies the human answer.

## Raise a checkpoint

```js
const approval = checkpoint("Proceed with the destructive migration?", {
  choices: ["approve", "reject"],
  default: "reject",
});
```

The eval output includes a line such as:

```text
checkpoint c3: Proceed with the destructive migration?
```

The promise remains live in the workspace. The host does not infer an answer from conversation text; answer delivery is an explicit data-plane operation.

## Inspect pending checkpoints

```js
workspace().checkpoints
```

Each pending row identifies the call id, question, and available option metadata. Retain the promise binding or recover its call id through `workspace()`.

## Answer from a later eval

```js
checkpoint.answer("c3", "approve")
```

This returns `true` if that checkpoint was pending and the answer settled it, or `false` if the id was unknown/already settled. Delivery is first-wins and idempotent. The answer must be JSON-serializable; `undefined` is normalized to `null`.

The original continuation resumes during the same eval's settlement drain:

```js
const decision = await approval;
decision
```

Checkpoint promises and questions survive daemon restart through the workspace snapshot.

## Workspace introspection

```js
const state = workspace();
```

The returned plain object contains:

- `bindings`: persistent user bindings with bounded type/size/status previews and call provenance where applicable.
- `inFlight`: all unsettled bridge calls, including agents, queue/steer/cancel controls, sleeps, and checkpoints.
- `checkpoints`: currently pending human questions.
- `diagnostics`: restore reconciliation notes and retained settlement-drain faults.

Inspect it narrowly to avoid unnecessary context:

```js
workspace().bindings.map(({ name, type, status }) => ({ name, type, status }))
```

## Agent-lane introspection

```js
agents()
```

returns only live agent/queued-turn entries, including call id, model spec, task preview, state, strict-steering support, and queued-turn count. This is the authority for deciding whether `handle.steer()` has an active target.

## Error diagnosis

Uncaught errors render into eval output. Errors associated with an agent/queued call include its stable call id and resolved backend when known. A drain or reconciliation problem that did not lose state is retained under `workspace().diagnostics`; state loss additionally produces a notice in the next eval output.

Use the empty eval to drain late settlements, then inspect `workspace()` and `agents()` before deciding to cancel or reset.
