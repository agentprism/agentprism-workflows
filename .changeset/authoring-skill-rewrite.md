---
"@automatalabs/mcp-server": patch
---

Rewrite the workflow-authoring skill (and the `author-workflow` prompt generated from it)
around the script API, run operations, and resume rules, in plain simplified-technical-English
prose. Prescriptive prompting methodology (the source contract, review-lens design, the
long-running-train playbook, and the implementation-train example) moves out of the skill to
`docs/patterns/` in the repository. Duplicated content between the guide documents and the
reference is consolidated to one canonical home per fact; the events resource gets a dedicated
operations section. Backend `mode` documentation now defers to the live config probe instead of
enumerating catalog values that drift, and the validator's dry run is described accurately as a
mocked control-flow run, not an execution of the workflow. The generated prompt shrinks by
roughly 30%.
