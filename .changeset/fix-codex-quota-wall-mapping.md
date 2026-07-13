---
"@automatalabs/acp-agents": patch
---

Classify provider usage-limit walls carried in an ACP `RequestError` `.data` payload. Codex-acp reports a quota/usage-limit exhaustion as a JSON-RPC internal error (code `-32603`, message `"Internal error"`) with the real provider text — including any reset time — only in `.data.message`, which the ACP SDK reconstructs verbatim on the client. `errorText()` previously read only `.message`, so the wall classified as a recoverable `AGENT_EXECUTION_ERROR` and the engine retried into the same wall. It now folds string text from `.data.message`/`.data.details` into the classifiable text, so it matches as non-recoverable `PROVIDER_USAGE_LIMIT` with a `resetHint`, restoring the documented pause/resume behavior on the Codex backend. Backend-generic: any ACP agent that stuffs detail into `.data` benefits, and plain-message classification (the Claude path) is unchanged.
