---
"@automatalabs/mcp-server": minor
---

The `repl` status renderer exposes the workspace manifest's full provenance surface (phase-D review round 3): each binding line now renders "from what task, when" — `· task "<task>"` (the founding `agent()` call's task text for `worker cN` and agent-handle bindings) and `· at <ISO wall clock>` (`provenanceAtMs`) — and the live-agent lines carry their task (`agent c1: running — task: "…"`), which the renderer previously omitted despite `LiveAgentInfo` already carrying it. Metadata, never content: value fragments still never leak into the render.
