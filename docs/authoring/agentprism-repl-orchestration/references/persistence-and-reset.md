# REPL persistence, restore, and reset

The REPL workspace is durable per project. Named bindings, pending agent and checkpoint promises, queue state, and call-id sequencing persist across MCP client disconnects and daemon restarts.

## Snapshot boundaries

Every state-changing eval and settlement drain persists the workspace. On first touch after restart, the server restores the QuickJS snapshot, re-registers host callbacks, and reconciles outstanding calls. The guest library itself is not re-evaluated into a restored VM.

A later call can therefore continue with prior bindings:

```js
workspace().bindings
```

and await a handle created before restart:

```js
const answer = await worker;
```

## Session and queued-turn recovery

Pending founding turns and queued turns are reconciled from durable records. Eligible queued turns reattach lazily to their founding ACP session. The broker never substitutes a blank session if continuity cannot be preserved; lane-fatal recovery faults reject the lane instead.

Strict steering is transient. A pending steering control cannot be replayed as a future prompt after restart and rejects rather than changing semantics. Durable queue turns remain future work.

## Snapshot refusal

Snapshot compatibility is tied to the snapshot format and the exact QuickJS WASM binary hash. Corrupt, incompatible-format, or mismatched-binary snapshots are not restored silently.

A refused snapshot is renamed aside with a `.refused-<timestamp>` suffix and the workspace automatically resets. The next successful eval output begins with a notice naming the file and refusal reason. The refused file is never silently deleted.

Reconciliation summaries and retained drain errors are available under:

```js
workspace().diagnostics
```

## Client disconnect drain

When the last MCP client for a project disconnects, the workspace drains in-flight subagent turns and closes idle children. Persistent workspace state remains. The next eligible queued turn reattaches its founding session lazily.

## Explicit reset

```js
reset()
```

requests teardown after the current eval completes. It discards bindings, pending calls, checkpoints, and the active snapshot for that workspace. The eval that calls `reset()` still completes normally; the next touch creates a fresh VM.

Prefer targeted cleanup first:

- cancel a queued handle with `queued.cancel()`;
- cancel an active call with `handle.cancel()` or `repl` interrupt by id;
- break only a runaway eval with interrupt and no id.

Use `reset()` when the whole interactive state is intentionally disposable or no longer trustworthy.
