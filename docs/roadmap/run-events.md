# Run events: typed contract & durable event log

**Status:** implementing · **Contract:** frozen · **Updated:** 2026-07-15

A run already emits a rich in-process event stream — `WorkflowManager` extends `EventEmitter`
and forwards every engine callback (`log`, `phase`, `agentStart`, `agentEnd`, `tokenUsage`,
`paused` with checkpoint/auth context, `complete`, `stopped`, `resumed`), and the SDK manager
bridges live ACP session updates (message chunks, tool calls, usage) as `agentEvent`. What's
missing was a **contract** and a **durable form**: the events were untyped strings over
`EventEmitter`, consumers hand-rolled payload types, ACP deltas could not join directly to an
`agent()` call, and another process had no tailable source. The contract is now frozen in
[`docs/specs/run-events-spec.md`](../specs/run-events-spec.md), and its staged implementation is in
progress. The specification—not this roadmap summary—is authoritative for event shapes, ordering,
durability, compatibility, and semver.

## Direction

1. **Typed `RunEvent` union** — a discriminated union in `shared-types` covering the full
   manager event surface, with exported payload types. The emitter keeps its current names;
   the union is the stable schema consumers import instead of re-deriving.
2. **`callIndex` on ACP event context** — echo the engine's deterministic per-call index onto
   bridged agent events so streaming deltas correlate to `agent()` calls directly.
3. **Append-only per-run event log** — a JSONL stream written through the manager's existing
   persistence hooks: monotonic per-run sequence numbers, a sequence watermark stamped on the
   persisted run snapshot (so a reader can do *snapshot + events after N* with no gaps or
   double-counting), a per-event-type persistence policy (lifecycle events persisted;
   high-frequency token deltas relay-only), and the same write-time redaction the bounded
   inspection surface applies. Background runs gain progress reporting as a side effect.
4. **A read/tail seam** — read events from a sequence cursor and watch for appends, extending
   the run-persistence module. Deliberately transport-agnostic: hosts own any wire (an MCP
   server, an OTel exporter, an editor extension, a process supervisor) and consume the same
   seam.

The formerly open choices are frozen for v1: the per-event persistence policy is fixed, transcript
traffic remains relay-only, records are bounded while the complete file follows run retention with
no rotation/TTL, every JSONL line carries schema version 1, and the existing `onProgress` callback
remains compatible alongside typed events.

## Staged rollout

| Stage | Scope | State |
| --- | --- | --- |
| PR1 | Shared live/persisted event types and optional ACP `callIndex` correlation | implemented |
| PR2 | Event projection, JSONL persistence, generation-pinned read/watch seam, and failure validation | implemented |
| PR3 | Lease-owned manager publication, snapshot watermarks, nested scopes, crash recovery, and deletion ordering | implemented |
| PR4 | SDK/OTel consumers and MCP background-await tail progress | implemented |
| PR5 | API/design/package documentation, authoring guidance, generated prompt, and coordinated release metadata | implemented |

Integration and publication remain release work; the contract is no longer open to design changes
inside these implementation stages.
