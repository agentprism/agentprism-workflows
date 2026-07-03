---
"@automatalabs/acp-agents": minor
"@automatalabs/shared-types": minor
---

Integrator surface, milestone 1: client-side fs/terminal interposition, image prompts, and backend-declared capability negotiation.

- **Client-side fs/terminal handlers** (`createAcpRunner({ clientHandlers })`): register `fs.readTextFile` / `fs.writeTextFile` (per-method) and `terminal` (all five methods or nothing — validated at construction). `initialize` now advertises `clientCapabilities` computed from exactly what was registered, and the agent's `fs/*` / `terminal/*` requests route to the handlers with an `AcpSessionContext` (`sessionId`, the session's **own** `cwd`, `label`, `runId`). Unregistered methods are rejected with a JSON-RPC method-not-found error instead of the SDK's silent `{}` coalescing. Confinement (worktree roots, symlink resolution, env scoping, output caps, timeouts) is explicitly the consumer's job.
- **Image prompts** (`RunOptions.images`, new `PromptImage` type in shared-types): base64 image `ContentBlock`s appended to the first prompt turn; `SessionHandle.prompt` widened to `string | ContentBlock[]`. Content adapts to the negotiated `promptCapabilities`: agents that don't advertise `image` get a bracketed text note per attachment (never an error, never silently dropped). Repair turns stay text-only.
- **Backend-declared custom-capability gating**: the codex-specific `_meta` gating is generalized — each `Backend` (and each custom registry entry via `customCapabilities: { namespace, gatedKeys }`, options or `AGENTPRISM_BACKENDS`) declares which `agentCapabilities._meta` namespace it negotiates and which bare `_meta` keys are gated. Codex declares the existing fork trio (wire behavior unchanged); no declaration = never gated. `negotiateCapabilities` takes the declaration; `gateCustomMeta` takes the gated-key list (defaulted for source compatibility).
