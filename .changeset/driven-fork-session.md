---
"@automatalabs/acp-agents": minor
"@automatalabs/shared-types": minor
---

Add a driven `runner.forkSession({ sessionId, cwd, ... })` API — ACP `session/fork` through the full managed lifecycle (capability-gated on `sessionCapabilities.fork`, routed under the response's new session id, permissions/modes/configOptions adopted, normal `InteractiveSession` semantics including `keepSession`). Closes the last guarded hole in driven agent-method coverage (16 driven / 0 guarded); the raw escape hatch stays blocked for session-stateful methods. `AgentSessionRef.reopen` gains an optional `fork` flag mirroring the agent's advertisement (absent on records written before this field existed). Verified live against OpenCode, which advertises fork today.
