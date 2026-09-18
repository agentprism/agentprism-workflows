---
"@automatalabs/mcp-server": major
"@automatalabs/workflows": major
"@automatalabs/acp-agents": patch
"@automatalabs/pi-acp": patch
---

Remove the `repl` MCP tool and the `@automatalabs/repl-engine` package behind it.

The MCP server's model-facing surface is now the `workflow` tool plus the capability-gated `workflow_monitor` view (and the app-only `workflow-events`, `workflow-runs`, `workflow-notifications` tools). The interactive per-project QuickJS REPL, its broker, its snapshot store, and everything in the server that existed only to serve it are gone. `@automatalabs/repl-engine` is deleted from the workspace and will receive no further releases; no other package imported it.

**`@automatalabs/mcp-server` (breaking)**

- The `repl` tool is no longer registered; `SERVER_INSTRUCTIONS` describes `workflow` only.
- Removed exports: `replToolInputShape`, `replToolOutputShape`, `ReplToolOptions`, `createReplProjectState`, `ensureReplWorkspace`, `disposeReplProjectState`, `resetReplProjectState`, `renameAsideNeverOverwriting`, `ReplProjectState`, `ReplPresenceLedger`.
- `CreateWorkflowServerOptions` drops `replRunner`, `replPresence`, `replEvalBreakChannel`, `replDrainBoundMs` and `disconnectReplClientOnClose`. `replClientId` had one non-REPL job — scoping `workflow_monitor` notification claims per legacy-era MCP client — and is kept under its honest name, `clientId`.
- `WorkflowServerControl` drops `replBreakUrl()` (previously required), `replDefaultProjectDir()` and `disposeReplEvalBreakChannel()`. The shutdown hook the stdio entry used through the last of those is now the generic optional `dispose()`.
- The in-process stdio entry serves over the SDK's `StdioServerTransport`; the worker-thread relay transport that existed to break a synchronous eval out of band is removed, and the shim no longer intercepts `tools/call` to fire it.
- The daemon drops the REPL client-presence ledger and drain: `CreateDaemonOptions.replRunner` / `replDrainBoundMs` / `sessionTtlMs` / `evalBreakChannel`, `DaemonHandle.activeReplDrainCount()`, `WorkflowProjectRegistry.disposeReplStates()`, `ProjectContext.repl`, `DaemonInfo.replBreakUrl`, the `SessionRegistry` presence hooks (`onConnectionOpened`, `onLastConnectionClosed`, `onSessionDeleted`) and `evictDrainable`'s `keep` veto. Daemon idleness is sessions, runs and in-flight requests.
- Removed environment knobs: `AGENTPRISM_REPL_EVAL_TIMEOUT_MS`, `AGENTPRISM_REPL_DRAIN_BOUND_MS`.
- Existing per-project `repl/` stores on disk are left untouched and are no longer read.

**`@automatalabs/workflows` (breaking)**

- The MCP server bundled behind `npx @automatalabs/workflows mcp` no longer serves the `repl` tool, and the package no longer depends on `@automatalabs/repl-engine`. The programmatic SDK is unchanged.

**`@automatalabs/acp-agents`, `@automatalabs/pi-acp`**

- Documentation only: comments and README passages that attributed `InteractiveSession.awaitCurrentTurn()`, the `_session/loaded_turn` extension, the turn-text passthroughs, `onHandoff` and `runner.defaultBackendId()` to "the REPL broker" now describe them as the host re-attach surface they are. Those SDK and wire surfaces are unchanged and remain supported.
