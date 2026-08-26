# Per-backend steering mechanism table

<!-- GENERATED — do not edit by hand. Sourced from the executable distribution probes in
`@automatalabs/acp-agents`'s `ACP_EXTENSION_SUPPORT_MATRIX`. Regenerate:
`pnpm --filter @automatalabs/repl-engine generate:steering-table`. Runtime behavior does
NOT read this table; it parses each session's raw initialize metadata. -->

The installed-distribution inventory:

| Backend | `_session/steering` | Strict steering behavior |
|---|---|---|
| claude | advertised (probed: claude) | strict active-turn injection via `session.steer()` |
| codex | advertised (probed: codex) | strict active-turn injection via `session.steer()` |
| opencode | NOT advertised | unsupported (no steering wire request) |
| pi | advertised | strict active-turn injection via `session.steer()` |
| custom backend | whatever its raw initialize metadata advertises | strict active-turn injection when advertised; unsupported otherwise |

Runtime steering availability is read from the session's raw initialize metadata only:
`initializeMeta.steering.supported === true`. The distribution matrix above is documentation,
not a runtime router.

| Case | Wire behavior | Result |
|---|---|---|
| ACP prompt in flight; raw steering advertised | one strict `_session/steering` request with `idleBehavior: "promptRequired"` | `injected`, or `idle` for `promptRequired` |
| ACP prompt in flight; raw steering not advertised | no request | `unsupported` |
| no ACP prompt in flight, including opening/extraction/repair gaps | no request | `idle` |
| steering transport/server failure | no prompt fallback | rejects `AGENT_EXECUTION_ERROR` |
| malformed response or `startedNewTurn` | cancel + fatal session lane | rejects non-recoverably |

Future work is always explicit: `handle.queue(prompt)` creates a distinct, durable FIFO public
turn and the broker sends it through ordinary `session/prompt` only when it reaches the queue
head. Queueing never uses `_session/steering` or a backend-native queue.
