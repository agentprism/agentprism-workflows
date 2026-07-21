---
"@automatalabs/shared-types": minor
"@automatalabs/workflow-engine": minor
"@automatalabs/workflows": minor
"@automatalabs/mcp-server": minor
---

Add default-on live observability for journaling workflow runs. The additive
`agentProgress` and `agentTranscript` events persist redacted, per-scalar-bounded content while an
agent is still running; consumers with exhaustive event switches must accept both new members.

Expose the append-only stream through the subscribable
`workflow://runs/{runId}/events` MCP resource with generation-pinned cursor paging,
constant-space notification coalescing, and explicit integrity-error mapping. Same-ID resume now
durably saves the running snapshot before publishing `resumed` or starting execution, and a
post-crash start opens a fresh validation partition without making the abandoned execution's
records unreadable.
