---
"@automatalabs/mcp-server": major
"@automatalabs/workflow-engine": minor
"@automatalabs/workflows": minor
"@automatalabs/shared-types": minor
---

Resume re-reads the run's script file and continues an edited script as a validated revision. `ExecOptions.script` on a same-run continuation with text that differs from the persisted script parses the revision, refuses backends the admission never approved (`backends-changed`) or text that does not parse (`script-invalid`), and continues through an identity-matched replay of the run's own journal: unchanged calls replay, edited or new calls run live. The persisted record adopts the revised text, records `scriptRevisions`, and marks the generation with `continuation.scriptRevised`. The MCP `resume` action reads the run's `file://` script back, validates a changed file exactly like a new run, and reports refusals as tool execution errors that change nothing; MCP inspection no longer projects the engine's `replayEligibility` diagnostic.
