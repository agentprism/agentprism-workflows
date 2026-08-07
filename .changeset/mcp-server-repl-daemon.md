---
"@automatalabs/mcp-server": minor
---

REPL orchestrator phase E: the `repl` tool's daemon-boundary suite — the tool registered alongside `workflow` exercised against a REAL daemon instance (`createDaemon` on an ephemeral loopback port with StreamableHTTPClientTransport clients, the `_http-harness` pattern).

- **Tool schema**: `repl` advertises exactly the doc's action enum (`eval` / `wait` / `status` / `interrupt` / `reset`) and field set on the wire — snapshotting stays implicit, there is no user-facing snapshot action; `projectDir` must be absolute; `timeoutMs` is bounded to [0, 120 000].
- **Daemon-mode actions**: projectDir is required on the shared daemon for every stateful action; eval / wait / status / interrupt / reset round-trip over HTTP; wait is bounded ("still running" on timeout) and absorbs a mid-wait backend settlement; a named `status` is a first touch exactly like the other stateful actions (restore/reconcile included); status without projectDir lists every known context and never creates one.
- **Project keying**: two projectDirs on one daemon are fully isolated — separate VMs, separate per-project `repl/` stores (one enveloped snapshot each), and a `reset` of one never touches the other.
- **MCP-session churn**: a client disconnect + fresh-client reconnect never touches the workspace — bindings stay live in the VM.
- **Lifecycle drain via the session registry**: last-client disconnect (the daemon's `onLastConnectionClosed`) drains the in-flight subagent turn to completion, closes the idle child, and the next connect's `followUp` lazily re-attaches the recorded backend session (`loadSession` with the same session id).
- **Output caps on the wire**: an eval-through-MCP round trip applies the doc's 256-line / 10 KB caps (whichever trips first) to the tool result, and the `$N` refs the kept lines carry reach the truncated values in later evals (the cap costs reads, never data).
