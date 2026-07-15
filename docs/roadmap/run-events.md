# Run events: typed contract & durable event log

**Status:** next · **Updated:** 2026-07-15

A run already emits a rich in-process event stream — `WorkflowManager` extends `EventEmitter`
and forwards every engine callback (`log`, `phase`, `agentStart`, `agentEnd`, `tokenUsage`,
`paused` with checkpoint/auth context, `complete`, `stopped`, `resumed`), and the SDK manager
bridges live ACP session updates (message chunks, tool calls, usage) as `agentEvent`. What's
missing is a **contract** and a **durable form**: the events are untyped strings over
`EventEmitter`, so every consumer hand-rolls its own payload types (`agentprism-otel` does
exactly this today); ACP deltas carry `sessionId`/`label`/`runId` but not `callIndex`, so
joining a token stream to a specific `agent()` call takes an indirect session lookup; and
events exist only in the emitting process — a consumer that attaches after a run starts, or
reads from another process, has no event source at all. Background runs currently emit no
progress for the same reason. Run-state persistence is a wholesale atomic rewrite of
`<runId>.json` plus an unstructured text log — neither is a tailable event stream.

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

## Open questions

- The exact persisted-vs-relay-only split per event type, and whether the policy is
  host-tunable.
- Event-log retention and growth: rotation, caps, and cleanup alongside the existing run
  records.
- Schema versioning for the event union across engine releases.
- Whether the existing `onProgress` snapshot callback is re-expressed over the new contract or
  kept as-is for compatibility.
