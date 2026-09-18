---
"@automatalabs/acp-agents": minor
"@automatalabs/shared-types": minor
"@automatalabs/workflow-engine": patch
---

A session reopened by its ref now comes back on the model it was running, on every backend.

`AgentSessionRef` previously carried no model, and `AcpAgent.resume/load/fork(ref)` without a `model` option selected nothing, leaving the outcome to the agent. OpenCode, pi and Codex restore the session's own model; claude-agent-acp ranks `ANTHROPIC_MODEL` and the user's `settings.model` above the resumed transcript's model and re-asserts them on resume, so on a machine with such a pin a session opened on Haiku silently reopened on the pinned model.

- `AgentSessionRef` gains an optional `model`: the routed spec (`<backendId>/<model id>`) of the model **selected** on the session when the ref was captured. `AcpAgent.sessionRef` reads it live (a `setModel()` or per-turn switch included) and keeps it after `close()`; `InteractiveSession.sessionRef` and the runner's `onSessionOpen` ref record it from `SessionHandle.selectedModel`. A session left on its backend's default records none.
- `AcpAgent.resume(ref)`, `AcpAgent.load(ref)` and `AcpAgent.fork(ref)` default to `ref.model` and select it right after the reopen; an explicit `model` option still wins, and a ref without `model` selects nothing as before. A `model` that is present but not a non-empty string fails validation before any process spawns, and invalidates a recorded continuation session in the workflow engine.
- So that the runner's ref can carry the model, `onSessionOpen` now fires once the model selection settled instead of just before it — still before config options, the mode, and the first prompt. A rejected selection still reports the session, without a `model`.
- For `runner.loadSession()` / `resumeSession()` / `forkSession()`, which route by a `model` spec rather than a ref, pass `model: ref.model ?? ref.backendId`.

Contract change: the previously documented and tested statement that "an `AgentSessionRef` carries no model" is replaced; the three tests that pinned it now pin the new contract, and the fork/resume live e2e asserts a reopen by ref alone lands on the ref's model.
