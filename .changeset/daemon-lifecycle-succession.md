---
"@automatalabs/mcp-server": minor
"@automatalabs/workflows": minor
---

Daemon lifecycle: superseded daemons now actually exit, and the two distributions of the server stop superseding each other.

- **One identity for one code version.** `@automatalabs/workflows`' bundled `mcp-server.js` reported the *workflows* package version as the server version (its `require("../package.json")` resolved the wrong manifest), so a client using `npx @automatalabs/workflows` and one using `@automatalabs/mcp-server` saw each other's daemon as "stale" and superseded it on every connect — leaving a lame-duck daemon behind each time. The bundle now bakes in the mcp-server version at build time (`__AGENTPRISM_MCP_SERVER_VERSION__`).
- **Version is a total order.** A shim supersedes only a daemon strictly *older* than itself and adopts an equal or newer one, so an old client migrating off a lame duck can never resurrect its old code and flip discovery back.
- **Env families instead of env supersession.** Clients are keyed by their env fingerprint (`~/.agentprism/workflows/daemons/<fingerprint>.json`, plus `instances/<pid>.json` per live daemon); different env → different daemon, never contending.
- **Lame ducks drain and exit.** A superseded daemon closes its idle sessions (their shims transparently re-initialize on the successor; sessions with a request in flight, an active run, or a REPL workspace mid-turn are kept), and exits on the next reaper tick once nothing is busy — it no longer waits for the idle TTL, even when idle shutdown is disabled.
- **Dead-client sessions are collected in 5 minutes** (`AGENTPRISM_SESSION_TTL_MS`, was 2 h); the REPL client-presence drain keeps its 2 h bound under its own knob, `AGENTPRISM_REPL_DRAIN_BOUND_MS`.
- **Shim recovery.** A lame duck's 503, the 404 of a closed session, a network error, or the standalone GET stream failing all take the same recovery path, now triggered proactively (not only on the client's next frame). Requests that were in flight when their session was lost are answered with a JSON-RPC error instead of hanging the host forever; recovery that loops is rate-limited.
- **Ops.** `daemon status` lists every daemon on the machine (current, draining, other env families, legacy `daemon.json` ones) with in-flight request counts; `daemon stop --all` stops them all; a successor honours an explicit `--port`; the "port taken by another process" log names a draining daemon of ours when that is what holds it.
