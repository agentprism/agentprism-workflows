---
"@automatalabs/repl-engine": patch
"@automatalabs/acp-agents": patch
---

Phase-F review round 1: the re-attach arm's unobservable-completion degradation is replaced
by the doc's honest re-issue fallback — the undocumented fourth reconciliation arm
("pending until interrupt/reset") is gone. The doc's restore path settles every outstanding
call exactly once through exactly one of the three arms (settle from the store / re-attach /
re-issue); the old `registerUnobservableReattach` path left a successfully re-attached call
permanently pending when the loaded session's founding-turn completion was unobservable,
which is the case for the built-in claude and opencode backends (they do not advertise the
`_session/loaded_turn` extension, per the live-verified `ACP_EXTENSION_SUPPORT_MATRIX`).
Now:

- A loaded session WITHOUT the `awaitCurrentTurn` seam (a third-party adapter) is released
  and the call is re-issued under the same id — the same degradation the catch arm already
  used for load failures, surfaced guest-visibly with a warn line naming the reason.
- A NON-re-armable `LoadedTurnStillRunningError` (backend without the extension, or a
  failed `_session/loaded_turn/query` wire) degrades the same way: release + re-issue under
  the same id. Never settled from a quiet gap (partial output is still never settled),
  never left pending.
- The RE-ARMABLE class is unchanged: a `running` turn past the max-wait bound on a backend
  that DOES carry the extension keeps the loaded session attached and re-arms the seam — the
  doc's second arm (re-attach to a still-running task); a later `_session/loaded_turn/ended`
  notification or a cancel still settles the call.
- The drain/disposal fences are unchanged: while the broker is draining or disposed, even
  safe-re-issue rejections resolve `hold` — the drain's forced stop settles every
  still-pending call DURABLY at its bound (recorded `AGENT_CANCELLED`, guest-settled), so a
  drained call is never left pending, and a disposed broker's state is being torn down.
  These are now the only `hold` producers left in the pump.

The seam's rejection messages in acp-agents (`LoadedTurnStillRunningError` text) and the
`awaitCurrentTurn` documentation were re-worded to match (the broker re-issues; the
re-armable form keeps the wait on the attached session); repl-engine module docs, the
package READMEs, and docs/api.md document the degradation and the exhaustive three-arm
contract. Regressions: the seam-absent adapter test and the non-re-armable rejection test
now pin the re-issue path end to end (loaded session released, reissue recorded, fresh
turn settles the SAME guest promise exactly once, warn line names the reason), and the
acp-agents integration test pins the re-worded non-re-armable message.
