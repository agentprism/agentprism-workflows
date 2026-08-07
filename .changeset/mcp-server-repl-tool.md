---
"@automatalabs/mcp-server": minor
---

The `repl` MCP tool and the REPL workspace's daemon wiring (REPL orchestrator phase D): one persistent QuickJS-in-WASM VM per project context, addressed by the same validated `projectDir` the `workflow` tool uses.

- **The `repl` tool** (roadmap doc's Surface section): `eval` (top-level-await semantics, captured console output, pending/checkpoint/completed summaries), `wait` (bounded server-side pump — "still running" on timeout), `status` (workspaces, live agents, pending ops), `interrupt` (ACP `session/cancel` for one call id, or the per-project eval-break signal — single-threaded semantics documented: the signal breaks the next VM execution that runs with it armed), and `reset` (teardown + store clear).
- **Per-project persistence wiring** (phase-D review: `ReplWorkspaceStore` used to be exported/tested only): each daemon project context opens the `repl/` store under `workflowHomeDir()/projects/<key>/repl`, attaches the broker's state-changing-boundary sink (a snapshot after every eval and every settlement drain that changed VM state — atomic tmp+rename, debounced per drain burst), and on FIRST TOUCH restores the stored workspace from the enveloped snapshot (wasm-hash-verified, version-checked) and runs the three-way reconcile — or creates a fresh workspace. The workspace survives MCP-session churn and daemon restarts.
- **Contained snapshot refusals**: a stored snapshot that refuses (corrupt/truncated, format-version bump, wasm-hash mismatch naming both hashes) is surfaced loudly in every `repl` result and cleared by `reset` — the daemon never crash-loops on a bad store and never silently discards the data.
- `WorkflowProjectRegistry.disposeReplStates()` (wired into the daemon's close path) releases every held ACP session at shutdown; the registry exports the new `repl` state types.
