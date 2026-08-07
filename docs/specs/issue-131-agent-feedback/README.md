# Issue #131 Agent Feedback Solution Pack

**Date:** 2026-07-14

**Issue:** [#131](https://github.com/agentprism/agentprism-workflows/issues/131)

> **Historical scope (superseded surface count).** These specs predate the `repl` tool and describe
> the MCP server when its only model-facing tool was `workflow`. The server now registers **two**
> model-facing tools — `workflow` and `repl` — so the "single / one model-facing tool" language
> throughout this pack is historical: it describes the `workflow` surface these specs govern, not a
> claim that the server exposes exactly one tool today. Every design point below still applies to
> the `workflow` tool; the later `repl` tool is out of scope here.

This pack turns the operational feedback from a five-run, roughly 200-agent-call workflow into one
coordinated design: safe run inspection and failure context, request-detached execution with bounded
result collection, complete `gate()` verdicts, deterministic dry-run branch fixtures, and prominent
journal-resume guidance. Together the specs extend the then-single `workflow` MCP tool (see the
historical-scope note above), shared run contracts, engine lifecycle, public SDK, validator CLI, and
authoring guidance while keeping journal replay deterministic and package releases additive.

## Specs

### [01 — Run observability](01-run-observability.md)

Adds the shared, bounded `WorkflowRunStatus` projection and
`WorkflowManager.inspectRun(runId, options)`, then exposes that projection through
`workflow({ action: "inspect", ... })`. Journal entries gain optional diagnostic attribution,
inspection applies allowlist projection, redaction, result compaction, glob filtering, and hard byte
budgets, and paused/failed/aborted execution results gain a redacted 20-line `logTail` that is also
rendered in the terminal MCP summary.

### [02 — Detached runs](02-detached-runs.md)

Adds `background: true` to the run branch and `action: "await"` with a bounded `waitMs`, reusing the
exact status payload from spec 01 for every poll. The design fixes background resume-journal seeding,
reports cumulative live token usage, reconstructs terminal outcomes after restart, limits each MCP
server instance to four active or starting background runs, and defines cancellation, checkpoint,
authentication, persistence, and process-lifetime behavior.

### [03 — Gate verdict](03-gate-verdict.md)

Extends fulfilled `gate()` results from `{ ok, value, attempts }` to
`{ ok, value, verdict, attempts }`, where `verdict` is the exact last completed validator return.
The ambient DSL signature preserves producer and structured-verdict inference, bare booleans and
`null` receive defined behavior, exception semantics remain intact, and replay continues to journal
only the producer and validator calls rather than a new gate aggregate.

### [04 — Dry-run mock answers](04-dry-run-mock-answers.md)

Adds `ValidateWorkflowOptions.mockAnswers` plus `--mock-answers` and `--mock-answers-file` so authors
can drive label-selected dry-run branches with reusable values or finite `$sequence` fixtures. The
validator uses deterministic last-match glob selection, fresh-base deep merge, strict
override-caused schema validation, serialized sequence consumption, redacted attribution, and
unused-rule reporting, while calls without a matching rule retain existing fabrication behavior.

### [05 — Resume semantics](05-resume-semantics-docs.md)

Publishes the canonical rule that `args` changes do not directly invalidate the journal while prompt
changes cache-miss from the first changed call. It documents the full agent-call identity, resolved
agent-definition contribution, non-hashed additive options, longest-unchanged-prefix behavior, the
different SDK resume entry points, and a six-to-eight-round MCP example, then carries the same rule
into `resumeFromRunId` tool metadata and the generated authoring prompt.

## Combined API surface at a glance

The MCP server still registers one model-facing tool, `workflow`; `action` selects the operation and
an omitted action preserves foreground execution.

| Operation | Input | Result |
| --- | --- | --- |
| Run | `action?: "run"`, `script`, existing execution knobs, `resumeFromRunId?`, `checkpointReplies?`, `background?: boolean` | Foreground: `WorkflowExecutionToolResult<T>`; background: `WorkflowBackgroundAccepted` with `{ runId, status: "running" }` |
| Inspect | `action: "inspect"`, `runId`, `lastN?`, `labelGlob?`, `logLines?` | Exact shared `WorkflowRunStatus` |
| Await | `action: "await"`, `runId`, `waitMs?`, `lastN?`, `labelGlob?`, `logLines?` | `WorkflowRunAwaitResult<T>`: the same status fields plus `wait`, optional cumulative `tokenUsage`, and a terminal `outcome` |

`WorkflowRunStatus` contains `runId`, lifecycle `status`, `workflowName`, ordered `phases`, optional
`currentPhase`/`reason`/`errorCode`, `logTail`, compact attributed `calls`, normalized `filter`, and
`truncation` counters. `lastN` defaults to 20 with range 1–50, `logLines` defaults to 20 with range
0–50, and status structured content is capped at 24,576 UTF-8 bytes. `waitMs` defaults to 20,000 with
range 0–25,000; completed await outcomes omit the execution-result `logTail` just like completed
foreground results, while the enclosing status-level `logTail` is always present.

| Package surface | Addition |
| --- | --- |
| `@automatalabs/shared-types` | `JournalCallMetadata`, optional `JournalEntry.call`, `WorkflowRunInspectionOptions`, `WorkflowLogTail`, `WorkflowRunCallStatus`, `WorkflowRunStatusTruncation`, `WorkflowRunStatus`, and optional non-completed terminal `WorkflowRunResult.logTail` |
| `@automatalabs/workflow-engine` | Safe `WorkflowManager.inspectRun()`, enriched journal persistence, replay-safe background journal seeding, and incremental cumulative token snapshots |
| `@automatalabs/workflows` | Re-exported inspection contracts; generic four-field `gate()` declaration; `MockAnswers` input and mock-answer report types; `mockAnswers` validator option; `--mock-answers` and `--mock-answers-file` |
| `@automatalabs/mcp-server` | Run/inspect/await input union; background acceptance and bounded-await result types; safe inspection, terminal tails, detached admission, outcome retrieval, and revised `resumeFromRunId` metadata |

Inspection `labelGlob` and mock-answer rule keys both match whole labels case-sensitively with `*`,
`?`, and backslash escaping. Their terminal-escape contracts remain distinct: inspection treats a
trailing backslash as literal, while prevalidated mock-answer configuration rejects it.

## PR train

| Order | PR | Specs | Packages | Dependency |
| ---: | --- | --- | --- | --- |
| 1 | Add safe workflow run inspection and terminal log tails | 01 | `shared-types`, `workflow-engine`, `workflows`, `mcp-server` | None |
| 2 | Add detached workflow execution and bounded await | 02 | `workflow-engine`, `workflows`, `mcp-server` | PR 1: consumes `WorkflowRunStatus` and `inspectRun()` |
| 3 | Expose complete validator verdicts from `gate()` | 03 | `workflow-engine`, `workflows`, `mcp-server` | PR 2 in the train, so shared authoring docs and generated prompt update from one base; no runtime dependency |
| 4 | Add scripted mock answers to validator dry runs | 04 | `workflows`, `mcp-server` | PR 3: exercises the final gate result in reject-then-approve fixtures and updates the same authoring surfaces |
| 5 | Publish resume identity and changed-args replay semantics | 05 | `workflow-engine`, `workflows`, `mcp-server` | PR 4: documents and tests the final coordinated MCP execution branch and regenerated prompt |

Each PR that changes the DSL, validator, or MCP surface updates the relevant root/package API docs
and `skills/agentprism-workflow-authoring` sources in the same commit, then regenerates
`packages/mcp-server/src/generated/authoring-prompt-content.ts` with
`scripts/generate-authoring-prompt.mjs` so the drift test remains authoritative.

## Combined Changesets plan

When the train releases together, consolidate overlapping entries so each package receives the
highest bump required anywhere in the pack.

| Package | Specs contributing release work | Combined bump | Release summary |
| --- | --- | --- | --- |
| `@automatalabs/shared-types` | 01 | minor | Add shared inspection, log-tail, truncation, and journal-attribution contracts. |
| `@automatalabs/workflow-engine` | 01, 02, 03 | minor | Add inspection and safe projection, background replay/usage guarantees, and the expanded gate runtime result. |
| `@automatalabs/acp-agents` | — | none | Existing runner callbacks already provide the required model, backend, and usage data. |
| `@automatalabs/workflows` | 01, 02, 03, 04 | minor | Publish inspection access, the typed gate verdict, and scripted validator mock answers; the detached-run patch is subsumed. |
| `@automatalabs/mcp-server` | 01, 02, 03, 04, 05 | minor | Publish run/inspect/await behavior and detached lifecycle; generated-prompt and resume-metadata patches are subsumed. |
