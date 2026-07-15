---
"@automatalabs/acp-agents": minor
---

Add optional `AcpEventContext.callIndex` correlation and thread it through session state,
tombstones, and every contextual runner event. The value echoes `RunOptions.callIndex` when
supplied; it is never sent on the ACP wire, placed in `_meta`, or used as session identity.
