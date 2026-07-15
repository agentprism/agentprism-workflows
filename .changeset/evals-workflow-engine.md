---
"@automatalabs/workflow-engine": minor
---

Add call identity, per-call manifests and sealed telemetry, honest persisted run typing, budget-trajectory replay, and the backend-neutral isolation runner/report surface.

This release also includes the complete set of observable behavior fixes made by that substrate:

1. Throwing terminal observers are now logged and swallowed; they never retry or fail the call.
2. Agent results and checkpoint replies must be strict-JSON snapshots; lossy values now fail with a typed error instead of being persisted in coerced form.
3. Journal and event payloads are frozen snapshots, so listener mutation no longer reaches persistence.
4. For strict-JSON args, persisted `args` is the pre-execution snapshot on all three run-creation paths and the VM receives an independent clone.
5. Post-terminal events from floated calls are dropped.
6. The VM compile filename is sanitized.
7. Sequential nested siblings receive distinct child run IDs, observable at the runner seam and in ACP session metadata.
8. `agentEnd` and `agentHistory` snapshot rows match by `(scope, callIndex)`, fixing duplicate-label and nested mis-attribution.
9. Non-strict-JSON args still execute verbatim, but are marked `argsUnreplayable` and refused as isolation baselines; they are not rejected at run time.
10. Timed-out attempts are actively aborted through a per-attempt signal.
11. Run-ID starts acquire the lease before checking existence, closing the cross-process overwrite race.
