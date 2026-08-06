---
"@automatalabs/repl-engine": minor
---

Phase-D review round 5 fixes for the client-presence drain, the lazy re-attach, and settlement provenance:

- **The drain latch never skips in-flight work**: a fresh agent dispatch and a lazy re-attach start now clear the broker's `drained` latch the moment a child may open (it used to stay set until the open/load RESOLVED). A second disconnect after a reconnect with a parked `openSession` (or a parked lazy load) drains again — the parked open is stopped and the late child is closed before it ever prompts.
- **The drain/disposal generation fence**: the drain deadline and `dispose` bump a generation; an `openSession` or lazy `loadSession` that lands after the bump is released immediately — it never registers a session entry and never prompts (a child can never open or run after the last client disconnected, nor after a reset/dispose).
- **`cancelCall`'s wire phase runs OUTSIDE the serialized operation chain**: the lazy re-attach (and the session cancel) no longer hold the chain, so a hung backend `loadSession` can never delay `drainForDisconnect`'s entry — the documented outer drain bound is effective even then. A consume phase under the chain re-checks the entry and rolls the cancellation marker back on an idle session (a settled turn is a settled turn; queued steers are never dropped by a stale cancel).
- **Per-call settlement provenance**: the settlement pump now delivers ONE ready call at a time, running one drain + one provenance pass per settled call (each with its own settlement boundary). Two simultaneously ready independent continuations producing separate bindings are attributed to their OWN worker and task (`worker c1` / `worker c2` with the matching task text), never a joined batch label.
