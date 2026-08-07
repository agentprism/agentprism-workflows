---
"@automatalabs/mcp-server": patch
---

Run-monitor panel: quieter, self-terminating live polling.

- The panel now stays live by **reading the events resource** (`workflow://runs/{runId}/events?after=N&limit=M&streamId=S`) instead of calling the app-only `workflow-events` tool. Some Apps-capable hosts narrate every app-originated `tools/call` into the model's conversation but leave resource reads silent, so a 2s poll was flooding an affected agent's turn with no-op echoes. The `workflow-events` tool stays registered with an unchanged contract for other clients; only the panel's transport changed.
- **Adaptive idle backoff**: a poll that brings no new events doubles the next delay (2s → 4s → 8s → 15s cap) and resets to 2s the moment new events arrive; `hasMore` catch-up pages still reschedule immediately.
- **Dead-run reconciliation on the events read path**: `readEventsPage`/`readEventsTail` now reconcile a run orphaned by a dead daemon (the same seam `workflow` action `await`/`stop` already use), so a run left `status: "running"` with a frozen journal flips to a finalized state and the panel stops polling it forever.
- **Bounded error retries**: after a bounded run of consecutive read faults the panel gives up for good and renders a disconnected/stale state instead of retrying a long-gone run at the backoff cap indefinitely.
- **Deferred first model-context push**: the panel holds every `ui/update-model-context` push until it has folded at least one events page, so it no longer pushes an empty seed snapshot (workflow name falling back to "workflow", agents-settled 0/0) before real data lands.
- Added `annotations: { readOnlyHint: true }` to the `workflow-events` tool registration. This is metadata only — it lets hosts that gate on the hint treat the tool as read-only (e.g. VS Code skips its pre-run confirmation; ChatGPT dev mode stops classifying it as a write action). It does not change how any host narrates app-originated calls.
