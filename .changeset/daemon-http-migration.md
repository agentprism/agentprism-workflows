---
"@automatalabs/mcp-server": minor
"@automatalabs/workflows": minor
"@automatalabs/workflow-engine": minor
---

Workflow execution moves into a shared per-user local daemon serving spec-compliant
Streamable HTTP (MCP 2025-11-25) on loopback, so runs survive MCP clients killing their
server processes (session end, restarts, tool timeouts).

- The stdio entries (`agentprism-workflow`, `agentprism-workflows mcp`) are now thin shims
  that auto-start the daemon and proxy stdio↔HTTP; existing host registrations keep working
  unchanged. `--in-process` restores the previous single-process stdio server.
- **New `projectDir` tool argument** (absolute path): every `run` names its project, selecting
  the project-scoped run store and default execution cwd. Required on the daemon — one
  registration, even in global MCP settings, serves every project concurrently; optional on
  an in-process server, defaulting to its own project. `inspect`/`await`/`stop`/
  `resumeFromRunId` take only a runId and locate its project store automatically (live
  contexts first, then the on-disk `project.json` store manifests the engine now writes).
  Cross-project resume redirects with an explicit error naming the right projectDir.
- New `daemon <start|stop|status|url|run|logs>` commands; `daemon url` prints direct HTTP
  registration snippets for Claude Code and Codex (a bare URL — no headers, no per-project
  registration).
- Spec transport contract throughout: per-session `Mcp-Session-Id`, SSE resumability with
  priming events and `Last-Event-ID` replay (dropped connections recover missed messages,
  including tool responses), `DELETE` termination, 404-driven re-initialize (handled
  transparently by the shim, including across daemon restarts and daemon death), mandatory
  Origin validation, loopback-only binding.
- The daemon idles out after 15 minutes with no sessions and no active runs
  (`AGENTPRISM_DAEMON_IDLE_TTL_MS`), evicts dead-client sessions without touching their runs,
  and records discovery info in `~/.agentprism/workflows/daemon.json`.
- `MAX_BACKGROUND_RUNS` is now a per-project cap shared across sessions. `WorkflowManager`
  exposes `readonly cwd`. `@automatalabs/workflows` re-exports `workflowHomeDir`,
  `workflowProjectKey`, `workflowProjectPaths`, and `WORKFLOW_PROJECTS_SUBDIR`;
  `@automatalabs/mcp-server` exports the daemon building blocks (`createDaemon`, `runShim`,
  `ensureDaemonRunning`, `WorkflowProjectRegistry`, `BoundedEventStore`, `validateRequest`,
  `BackgroundRunRegistry`, …) for hosts that mount the tool on their own transport.
