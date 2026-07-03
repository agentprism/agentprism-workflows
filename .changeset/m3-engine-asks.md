---
"@automatalabs/workflow-engine": minor
"@automatalabs/workflows": minor
---

Integrator surface, milestone 3: live event forwarding, embeddable persistence, and script-fault guarantees.

- **`agentEvent` live stream** (`@automatalabs/workflows` WorkflowManager): every runner ACP event — streaming text, tool calls, permissions (including the parked `permission_pending` phase), session lifecycle — is forwarded through the manager as `agentEvent { name, event, sessionId, backendId, label?, runId? }`, so hosts can render live progress per agent. Bridged runners are reference-counted: per-exec runners unsubscribe when their run settles; the manager's own runner unsubscribes on `dispose()`.
- **Manager events are now uniformly best-effort**: a throwing host observer on ANY manager event (`agentStart`, `log`, `agentEvent`, …) is isolated and can never fail, pause, or mask cleanup for a run.
- **`persistenceRoot` option** (+ `AGENTPRISM_PERSISTENCE_ROOT` env; precedence option > env > home default) relocates run state + logs to a host-chosen root, resolved exactly once at manager construction. **`journaling: false`** (manager-wide or per-exec) skips journal/log/run-state writes for hosts that keep their own transcript store — resume for such runs fails with a legible "journaling disabled" error (explicit trade-off), while run leases (cross-process double-execution protection) and on-disk run listing are unaffected.
- **Script-fault containment pinned by tests**: an uncaught throw in a workflow script — sync `Error`, thrown string, thrown object (including throwing `message` getters and circular objects), or post-`await` rejection — always surfaces as a `failed` result with a legible reason, releases the run lease, and never escapes as an unhandled rejection (direct and `startInBackground` paths).
