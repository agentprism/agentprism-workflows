# REPL steering, queueing, and exact cancellation

A founding agent handle separates transient control of a running turn from durable future work.

## Strict steering

```js
const worker = agent("codex", "Investigate the parser failure");
```

Only while `agents()` reports its active turn as running:

```js
const outcome = await worker.steer("Focus on the parser state machine");
```

The result is exactly:

- `"injected"`: the instruction was delivered into the active turn.
- `"idle"`: no turn was active; the instruction was not retained.
- `"unsupported"`: the backend does not advertise strict steering.

Transport or protocol failures reject. Steering never starts a new turn and never queues work. An `"idle"` result intentionally loses the instruction. Check `agents()` immediately before steering when timing matters.

Steering support is based on the backend's raw ACP steering advertisement. Do not infer it from the backend name.

## Durable queued turns

After retaining the founding handle, queue future public turns:

```js
const first = await worker;
const implement = worker.queue("Implement the fix");
const test = worker.queue("Run the focused tests");
console.log(implement.id, test.id);
const implemented = await implement;
const tested = await test;
```

Each queue call synchronously returns a distinct promise-handle with its own stable id. Queued turns execute FIFO on the founding session using ordinary public prompts. Queueing is broker-owned and works on every backend that can continue the session; it does not depend on a backend-native queue API.

Queued-turn options are exactly:

```js
{ promptMeta?: object }
```

The prompt must be a string. Malformed queue requests still receive a durable call record and reject directly.

## Cancellation

Cancel the founding session's currently active public turn:

```js
await worker.cancel();
```

Cancel one queued turn exactly:

```js
await test.cancel();
```

Or cancel by stable call id outside the VM through the tool:

```json
{ "action": "interrupt", "projectDir": "/absolute/project", "id": "c4" }
```

A targeted cancellation rejects that call recoverably and leaves unrelated work live. Cancelling a queued handle does not cancel its founding turn or siblings. Cancellation settlement is first-wins; an already-settled target cannot be retroactively cancelled.

Omit `id` only to break the currently running eval itself:

```json
{ "action": "interrupt", "projectDir": "/absolute/project" }
```

That is eval control, not agent-call selection. It breaks an executing eval or terminates a suspended eval that cannot be safely resumed. It returns an honest idle refusal only when nothing is running.

## Ordering and persistence

Queue admission, handoff, settlement, and cancellation are persisted. Pending queue turns survive daemon restart and reattach lazily to their founding session when eligible. Queue delivery has the documented narrow at-least-once crash window around remote acceptance and local handoff persistence; prompts that cause external side effects should therefore be idempotent or guarded.

A lane-fatal persistence/session failure rejects the active and queued turns on that lane. The broker never opens a blank replacement session and pretends context survived.

## Recommended pattern

```js
const worker = agent("claude", "Analyze the issue; do not edit yet");
// While running, optionally steer after checking agents().
const analysis = await worker;
const fix = worker.queue("Implement the agreed fix");
const verify = worker.queue("Run tests and report the exact results");
const fixed = await fix;
const verified = await verify;
({ analysis, fixed, verified })
```
