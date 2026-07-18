## MCP Server Setup — how workflows actually run

Agents run workflows through the single `workflow` tool served by `@automatalabs/mcp-server` over stdio. Register it once in the host's MCP configuration (project-scoped is typical):

```json
{ "mcpServers": { "agentprism-workflows": { "command": "npx", "args": ["-y", "@automatalabs/mcp-server@latest"] } } }
```

The server resolves at spawn time, so a reconnect (`/mcp` in Claude Code) picks up the latest published version. Runs, journals, and logs persist under `~/.agentprism/workflows/` per project namespace, which is what makes background execution, inspection, and resume durable across tool calls.

### The `workflow` tool, by action

- **Run** (default, no `action`): supply exactly one of `script` (the raw source string, no Markdown fences) or `scriptPath` (an absolute path on the server's filesystem). A path is read once at admission and its content snapshotted, so later edits affect only a new run. `args` arrives in the script as the `args` global; the run's base directory is the `cwd` global. Some hosts hand `args` through as a JSON **string** — a robust script tolerates both shapes (`typeof args === "string" ? JSON.parse(args) : args`) before reading knobs off it. Foreground streams progress but is bound to the request (and its timeout); pass `background: true` for anything that may outlive one request — it acknowledges after durable admission with a `runId` and, for a resume, the admission-time `replayEligibility` plan.
- **Await** (`{ action: "await", runId, waitMs }`): bounded collection for background runs — a timeout is progress, not failure; call again. The top-level status includes current `replayEligibility`; at terminal status the response adds `outcome` (the authored result or pause context, with the same eligibility plus `resumeReport`, `fallbacks`, and `checkpointsTaken`).
- **Inspect** (`{ action: "inspect", runId, lastN, labelGlob, logLines }`): a read-only bounded snapshot — latest matching calls with compact result previews plus the newest log lines. It includes current `replayEligibility` for resumed runs. Use a narrow `labelGlob` to diagnose before deciding whether to resume, edit, or stop. Inspection never resumes anything.
- **Stop** (`{ action: "stop", runId }`): durably aborts a live run and returns the final snapshot; resume is safe immediately (only backend session wind-down may linger). Stopping an already-terminal run is a successful no-op.
- **Resume**: a NEW run with `resumeFromRunId` plus the script re-sent (same `script` content or `scriptPath`) and the desired `args` (+ `checkpointReplies` when answering a durable checkpoint). Read the returned `replayEligibility` for the predicted/observed prefix and first miss, and the terminal `resumeReport` for every per-call decision; never assume a prefix hit. The exact semantics live in **Determinism and resume**.

### Operational rules that save runs

- **Always retain the returned `runId`.** Paused/failed/aborted responses carry a redacted final-20 `logTail` — read it before changing anything. Every admitted script is also an immutable resource at `workflow://runs/{runId}/script` (results link the full resume lineage), so a later session can recover a lost inline script verbatim.
- **Operational bounds are not replay inputs**: host `concurrency`, `agentRetries`, and `agentTimeoutMs`, plus per-call `timeoutMs` and `retries`, can change on a resume without invalidating completed work. A resume admission does not inherit host bounds from its source, so pass the desired values on every new run. `agentTimeoutMs` is a total wall-clock ceiling per attempt; per-call `timeoutMs` may tighten it but cannot escape it. Run, inspect, and await structured content report the resolved `limits`; `replayEligibility.operationalChanges` diagnoses source/current differences without gating replay.
- **Compatibility is explicit**: pre-input-format-2 sources use `positional-v1` with `fallbackReason: "inputs-format-legacy"`; carried ancestor-scoped rows from ≤0.23 resume chains replay only while that ancestor run remains persisted. The producing engine version and input formats are surfaced in `replayEligibility`; an engine package-version difference is diagnostic, while an unsupported future input format is a named runtime mismatch.
- **Background is detached from the request, not the server process** — a stdio server exit stops in-flight work. Background starts have no live checkpoint channel, so authored `headless` checkpoint modes apply.
- Embedding hosts can instead call `runDynamicWorkflow` / `WorkflowManager` from `@automatalabs/workflows` directly — see the reference section on how hosts run scripts; the script contract is identical either way.
