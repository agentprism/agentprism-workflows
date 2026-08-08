---
"@automatalabs/mcp-server": patch
---

Run-monitor panel: live updates on pi via its native server→app push channel, and graceful behavior
on hosts that do not serve app-originated resource reads.

pi's MCP-Apps host bridge never implemented `resources/read` for app-originated requests (it answers
with JSON-RPC `-32601`), so the panel's event-poll resource read cannot work there. Instead of
degrading into a permanent "reconnecting…"/"disconnected" latch, the panel now resolves a live-update
channel per host:

- **pi (eager stream)** — the `workflow` (and app-only `workflow-events`) tool declares
  `_meta.ui["pi-mcp-adapter.streamMode"] = "eager"`. pi then stamps a per-call stream token onto the
  `tools/call`; the server reads it and pushes cursor-bearing, self-contained event windows to the
  panel as `notifications/pi-mcp-adapter/result-patch` frames (an initial checkpoint baseline, live
  patches with periodic checkpoint resync baselines, and a single terminal frame). The panel folds
  the pushed windows into the same model the resource poll feeds, handling out-of-order delivery and
  replay. This channel is invisible to the host: no narration, no agent turn, and no app-originated
  tool polling.
- **resource-capable hosts** — unchanged. The events resource poll remains the primary channel and is
  byte-for-byte identical where reads succeed.
- **hosts with neither** — the panel classifies the `-32601` read failure as a permanent host property
  (never a transient fault), stops polling for good, and renders an honest "live updates aren't
  supported by this host" state seeded from the tool delivery — never the reconnect spinner. The
  DetailView script read degrades the same graceful way.

Also: a truly-unknown run's events read now carries a matchable `RUN_NOT_FOUND` token so the panel
routes it to its fatal path immediately instead of spinning ~42s; reads for runs that do exist are
untouched.
