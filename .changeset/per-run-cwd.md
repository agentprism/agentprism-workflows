---
"@automatalabs/workflow-engine": minor
"@automatalabs/workflows": minor
---

Per-run `cwd` on `ExecOptions` — the missing piece for worktree-per-run hosts. `startInBackground(script, args, { cwd })` / `runSync(...)` now run every subagent ACP session in that directory, overriding the manager's constructor `cwd` (which remains the key for run STATE, so `listRuns()`/`resume()` survive the run directory's deletion). The per-run cwd is persisted with the run and `resume()` re-runs in the SAME directory (e.g. the same worktree) unless explicitly overridden — confinement no longer rides on every script remembering `agent({ cwd })`. Also ships `docs/api.md`, the API reference covering the manager surface (options, ExecOptions, lifecycle, events + payload shapes), the runner surface (RunOptions, model routing, event bus, interactive sessions, capabilities), backend resolution + environment variables, and the WorkflowError code table.
