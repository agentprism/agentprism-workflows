# Per-backend steering mechanism table

<!-- GENERATED — do not edit by hand. Sourced from the live capability probes in
`@automatalabs/acp-agents`'s `ACP_EXTENSION_SUPPORT_MATRIX`
(`packages/acp-agents/src/protocol-coverage.ts`; claude/codex probed against the installed
distributions by the protocol-coverage suite, pi workspace-owned and covered in its own
suite, opencode `typed-unsupported`). Regenerate:
`pnpm --filter @automatalabs/repl-engine generate:steering-table`. The gate test
(`test/steering-table.test.ts`) fails when this file drifts from the probes. -->

The per-backend inventory — which backends advertise `_session/steering` today versus
fall back to queued-for-next-turn delivery (the roadmap doc's spec-owed table, generated
from the capability probes; the mechanism per disposition is the broker's decision, see
`src/broker.ts`'s module docs):

| Backend | `_session/steering` | Steering mechanism |
|---|---|---|
| claude | advertised (probed: claude) | live injection via `session.steer()` |
| codex | advertised (probed: codex) | live injection via `session.steer()` |
| opencode | NOT advertised | queued delivery via `session.prompt()/queue` |
| pi | advertised | live injection via `session.steer()` |
| custom backend | whatever the agent's initialize response advertises (capability-gated per session at open) | live injection when advertised, queued delivery otherwise |

The per-session capability is read ONCE at session open (`session.capabilities.supportsSteering`);
the mechanism table for one session:

| Case | Mechanism | Outcome the handle resolves with |
|---|---|---|
| backend advertises `_session/steering`, turn in flight | `session.steer(content)` — live injection | the backend's verbatim outcome: `injected` \| `startedNewTurn` \| `failed` |
| backend advertises `_session/steering`, session idle | `session.prompt(content)` — a new turn (there is nothing to inject into) | `startedNewTurn` |
| backend does NOT advertise steering, turn in flight | content enqueued for next-turn delivery | `queued` (immediately — accepted for next-turn delivery; if the call is later cancelled the queue is dropped, and a delivery-turn failure surfaces as a warn-level line in the next tool result) |
| backend does NOT advertise steering, session idle | `session.prompt(content)` — a new turn | `startedNewTurn` |
| ANY backend, session idle, but the workspace cap is exhausted | content enqueued for the next free slot (the same durable queue) | `queued` (a follow-up turn IS the subagent working — the six-agent ceiling is absolute; the steer starts the moment a slot frees) |
| any backend/wire failure on the steering path | — | `failed` (never a hard rejection) |
| the founding call is still OPENING (its session does not exist yet — a steer in the same eval as the dispatch) | content queued for the call's next-turn boundary | `queued` |
| no live session for the founding call at all (never opened, or lost) | — | `failed` (nothing was steered) |
| `cancel()` with a turn in flight | ACP `session/cancel` | `cancelled` (the cancelled call itself rejects with the recoverable `CancelledError`) |
| `cancel()` with the session idle | no-op — the agent is already stopped | `idle` |
| `cancel()` while the call is still opening | the opening call is fenced and settled durably as cancelled (an eventual late child is closed without prompting) | `cancelled` (the cancelled call rejects with the recoverable `AGENT_CANCELLED`) |

The outcome surface therefore mirrors acp-agents' `SteeringOutcome` values (`injected` /
`startedNewTurn` / `failed`) with one honest addition (`queued`) for the no-extension
enqueue case, plus the cancel vocabulary (`cancelled` / `idle`) — the orchestrator can always
tell urgency delivery (injected) from next-turn delivery (queued / startedNewTurn), which is the
doc's stated requirement.
