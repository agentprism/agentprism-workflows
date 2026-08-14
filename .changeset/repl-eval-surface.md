---
"@automatalabs/repl-engine": minor
"@automatalabs/mcp-server": minor
"@automatalabs/workflows": minor
"@automatalabs/workflow-engine": minor
"@automatalabs/acp-agents": patch
---

Redesign the interactive REPL around `eval` and `interrupt`. `eval` now waits up to its soft
bound, returns either `{ output, result }`, `{ output, running }`, or `{ output }`, and supports an
empty-string polling call. Workspace inspection and teardown move into the guest as `workspace()`,
`agents()`, and `reset()`; printing uses the depth-limited repr and `_` retains the previous
completion value. Dispatches beyond the workspace concurrency limit queue in order, follow-up turns
return their answers, invalid backend/options fail at admission, snapshots that cannot be restored
auto-reset with a recovery notice, and reconcile/drain details move under workspace diagnostics.

This is a breaking removal of the workflow execution `tokenBudget` option, the script-visible
`budget` global, and the per-phase `phase(title, { budget })` option from both
`@automatalabs/workflows` and `@automatalabs/workflow-engine`. Workflow scripts must use explicit
loop bounds; `phase()` now accepts only its title. Agent-count, concurrency, timeout, and inspection
limits remain available.

ACP assistant message chunks are now joined with a blank line, preventing adjacent chunks from
being concatenated into a single malformed sentence.
