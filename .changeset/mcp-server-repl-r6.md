---
"@automatalabs/mcp-server": minor
---

REPL orchestrator phase D, review round 6 at the daemon boundary: the client-presence drain aborts when a client reconnects mid-drain (children stay warm), and a failed drain is surfaced loudly and retained for retry.

- **Mid-drain reconnect aborts the drain** (review: presence was checked only before the drain started, then the broker's release phase closed every child unconditionally — directly contradicting the doc's "children remain warm while any client is connected"; `repl-presence.ts` documented the contradictory behavior instead of preventing it). `drainReplProject` now passes the project's live client set as the broker's abort probe; the drain consults it every iteration and before every destructive phase. A project whose client set is non-empty again keeps its children warm, and the next disconnect drains again.
- **A failed drain is never silent** (review: the ledger swallowed drain failures, including snapshot-flush failures, and the store cleared its dirty boundary before the write succeeded — a failed last-disconnect snapshot was neither surfaced loudly nor retained for retry). The failure is recorded on the project state (`drainError`), surfaced in every repl tool result (`status` reports `LAST DRAIN FAILED`; eval/wait results carry a warn line), and the drain latch stays clear so the next disconnect retries. `ReplWorkspaceStore`'s snapshot writer clears the dirty boundary only after the write succeeds, so the next flush — the next burst or the retried drain — persists the SAME state.
