---
"@automatalabs/workflow-engine": minor
"@automatalabs/workflows": minor
---

Add `openWorkflowDir` — a read-only, per-call-fresh view over folders of versioned
workflow scripts, for integrators who keep their workflows in a directory instead of
hand-rolling `readFileSync` plumbing. Construction does no I/O; every method reads the
filesystem at call time so the view always reflects the current working tree. The
filename stem is the workflow name (`review-pr.workflow.js` ⇒ `review-pr`; first dir
wins across dirs, `.workflow.js` beats `.js` within one). Surface: `dirs`, `list()`
(parsed `meta` per file), `read(name)` (throws with searched dirs + did-you-mean), and
`resolve(name)` — the exact `loadSavedWorkflow` contract, with strict name-shape
validation so inline nested scripts fall through and path traversal is impossible.

`runDynamicWorkflow` gains a `workflows` option (a `WorkflowDir` view or dir path(s)):
the first argument may then be a workflow NAME, and nested `workflow("<name>")` calls
resolve from the same view — previously impossible through the one-shot path, which
never wired `loadSavedWorkflow`. The validator gains the same power via
`ValidateWorkflowOptions.workflows` and `agentprism-workflows validate <file-or-name>
--workflows-dir <dir>` (repeatable); without it, a dry-run failure caused by a nested
bare name now carries a warning naming the fix.
