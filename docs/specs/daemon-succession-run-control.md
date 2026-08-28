# Daemon succession and run control

Status: **implemented contract for the daemon run-control release train**.

## Source request

> Okay go ahead and add docs/specs/daemon-succession-run-control.md as the implementation authority for this train, and then get it implemented and shipped in a new release.

This specification is the implementation authority for the train. It deliberately revises the
older succession behavior where discovery moved to a successor while live workflow control remained
process-local on the predecessor.

## 1. Scope and problem

The shared MCP daemon has two identities that must not be conflated:

- the **front door** is the current daemon named by an environment family's discovery pointer;
- the **execution owner** is the process holding a particular workflow run's filesystem lease.

During an upgrade, the front door may move while an execution remains in the predecessor. Persisted
state makes `inspect` and `await` location-independent, but an abort controller and an in-flight ACP
turn are process-local. The former behavior routed `stop` to the successor, which could see the run
but could not control it; `resumeFromRunId` was then also refused because the live predecessor still
held the source lease.

This train makes run control location-independent without attempting to migrate a live JavaScript
VM, promise graph, or ACP connection between processes.

## 2. Required invariants

1. **One execution owner.** A run has at most one live writer/executor. A control timeout is never
   sufficient reason to steal a live lease.
2. **Control follows ownership.** The current daemon can stop a whole run or cancel one in-flight
   agent call owned by a control-capable predecessor.
3. **Durable stop acknowledgement.** A final stop response is returned only after the persisted
   snapshot is terminal and its matching `stopped` event is durably readable.
4. **Durable whole-stop intent.** Once accepted by a daemon, a whole-run stop request survives an
   HTTP reply loss or owner exit and is idempotent by operation ID.
5. **No fabricated cancellation.** Per-agent cancellation is routed to the live owner but is not
   reconstructed after owner death. Owner loss never manufactures an `AGENT_CANCELLED` result.
6. **No automatic execution replay.** Succession never silently creates a `resumeFromRunId`
   execution. Resume remains an explicit new run because replay can spend tokens and repeat
   external effects.
7. **Fail-safe version skew.** A first control-capable shim does not strand work on a predecessor
   that predates this protocol.
8. **Explicit destructive escalation.** Killing an execution-owner process is never inferred from
   elapsed time. It requires `forceOwner:true`, identity revalidation, and an owner that is a
   superseded AgentPrism daemon.
9. **Honest accounting and errors.** Foreground and background executions both count as daemon-owned
   work. Errors identify a live external owner and never recommend resume while that owner holds the
   lease.

## 3. Identity and ownership

Every newly started daemon has an opaque random `instanceId`. Its family pointer and
`daemons/instances/<pid>.json` record add:

```ts
interface DaemonInfo {
  instanceId?: string;       // absent on older daemons
  controlUrl?: string;       // loopback internal endpoint
  controlProtocol?: 1;
}
```

The health response echoes `instanceId` and `controlProtocol`.

A new run lease records the writer's optional opaque `ownerId`; daemon-created managers use their
`instanceId` as that owner ID. The workflow engine exposes read-only lease-owner inspection:

```ts
interface RunLeaseOwner {
  runId: string;
  pid: number;
  startedAt: string;
  ownerId?: string;
}
```

The lease remains the execution fence. MCP-server owner resolution joins the lease owner to the
PID-guarded daemon instance record and, when available, requires `ownerId === instanceId`. Old leases
without `ownerId` remain readable and retain PID-based compatibility behavior.

No control URL or daemon-specific type enters `workflow-engine`; daemon routing stays in
`mcp-server`.

## 4. Internal control protocol

Control-capable daemons expose a non-MCP loopback endpoint under
`/_agentprism/control/v1`. The endpoint remains available while the daemon is a lame duck.

Requests are JSON, size-bounded, timestamped, and authenticated with HMAC-SHA256 using a per-user
mode-`0600` key under the workflow daemon directory. The key is user-scoped rather than
family-scoped so a changed backend environment can still control an existing run. Signatures bind
method, path, timestamp, operation ID, and the exact body; stale timestamps and non-constant-time
signature mismatches are rejected.

The operation is:

```ts
type InternalRunControlRequest =
  | { operationId: string; runId: string; action: "stop" }
  | { operationId: string; runId: string; action: "cancel-agent"; callIndex: number };
```

The receiver resolves the run, verifies that its local manager is still the lease owner, applies the
normal manager operation, and returns one of:

- applied with a terminal status or cancellation summary;
- already terminal;
- not owner, with no mutation;
- unknown run;
- rejected request.

The forwarding daemon never treats the HTTP response alone as proof of a stop. It reloads and
verifies the shared persisted snapshot and event log before returning a final stop result.

## 5. Durable whole-stop intents

Before forwarding a whole-run stop, the front-door daemon creates an immutable request file in the
project store's control sidecar directory. Creation is `wx`, atomic, and mode `0600`. The request
contains version, operation ID, run ID, requester instance ID, and request time. A separate immutable
acknowledgement records application or an already-terminal outcome. Multiple whole-stop intents are
commutative and idempotent.

The execution owner is woken through the internal endpoint and also scans pending intents on the
daemon reaper cadence. Therefore a lost notification does not lose the stop request.

If the owner exits before applying an intent, a successor may apply it only after acquiring the run
lease. It reloads under that lease, lets a concurrent terminal result win, otherwise writes
`aborted`, clears pause/error/checkpoint fields, appends exactly one `stopped` event, and releases the
lease. A retry observes the acknowledgement or terminal snapshot rather than appending a duplicate
stop event.

Deleting a run removes its control sidecars. Acknowledged sidecars may be compacted after the run is
terminal; unacknowledged stop intents are never discarded while the run exists.

Per-agent cancellation is deliberately not stored as a durable intent. It has meaning only while a
specific call is live in the owning process.

## 6. Public workflow behavior

### 6.1 Whole-run stop

`{ action:"stop", runId }` follows this order:

1. If terminal, return the existing successful no-op result.
2. If live in this process, perform the existing local durable stop.
3. If no live owner holds the lease, perform a lease-safe cold stop.
4. If a control-capable daemon owns the lease, persist/reuse a whole-stop operation, forward it, and
   wait for bounded settlement.
5. If settlement is durable, return the existing terminal `WorkflowStopResult`.
6. If the intent remains outstanding after the bound, return a successful nonterminal acknowledgement:

```ts
interface WorkflowStopPendingResult extends WorkflowRunStatus {
  status: "pending" | "running";
  stopped: false;
  alreadyTerminal: false;
  control: {
    state: "pending";
    operationId: string;
    requestedAt: string;
    owner?: {
      pid: number;
      instanceId?: string;
      version?: string;
      lameDuck?: boolean;
    };
  };
}
```

A later `stop`, `inspect`, or `await` observes the same run. Final success retains the stronger
existing guarantee: resume is safe immediately and a follow-up await adds nothing.

### 6.2 Per-agent cancellation

`{ action:"stop", runId, callIndex }` routes synchronously to a control-capable live owner. It returns
only after the owner durably records `AGENT_CANCELLED`. If the owner is absent, unreachable, or
predates the protocol, the request fails with owner-aware guidance. It never returns pending and
never falls back to killing a daemon.

### 6.3 Explicit force escalation

Whole-run stop additionally accepts `forceOwner:true`; it is forbidden with `callIndex`.

Force is permitted only when all of the following still hold after a final re-read:

- the lease names the same PID and, when present, the same owner/instance ID;
- the instance record names an AgentPrism daemon;
- a different daemon owns that family's current pointer, so the target is a predecessor;
- the target is not the caller process.

The implementation logs/reports the predecessor's known active-run count because terminating one
process may interrupt sibling runs. The explicit flag authorizes that collateral effect. It sends a
gracious termination, waits a bounded interval, and may use a hard kill only within the same
explicit force operation. It then waits for confirmed process death, acquires the target run lease,
and cold-stops the requested run. Sibling nonterminal records reconcile normally to
`paused/interrupted` on their next cold touch.

A live non-daemon owner, current daemon, identity mismatch, or unverifiable reused PID is never
killed.

## 7. Succession and first-upgrade compatibility

A control-capable predecessor may be superseded immediately. It admits no new MCP work but keeps its
internal control endpoint, processes durable stop intents, and remains alive while it owns an
execution or REPL drain. Drainable MCP sessions may migrate independently of workflow execution.

When a newer shim encounters a stale predecessor that does **not** advertise control protocol v1 and
that predecessor reports active runs or in-flight requests, the shim enters compatibility drain:

- it temporarily adopts that predecessor instead of repointing discovery;
- it periodically rechecks health;
- when active runs and in-flight requests reach zero, normal version-ordered succession runs;
- sessions alone do not defer succession;
- version ordering is never reversed in the family pointer, so clients cannot create a ping-pong.

If such a predecessor is already unresponsive, the successor may start so persisted reads remain
available, but no live lease is stolen. Owner-aware diagnostics and the explicitly fenced force path
are the recovery surface.

After control protocol v1 has shipped for one generation, ordinary upgrades use immediate
succession and cross-generation forwarding.

## 8. Lame-duck lifecycle and accounting

`activeRuns` means manager-owned running executions, not merely background admission promises.
Project health snapshots report that same quantity. Background admission slots remain a separate
per-process concern.

A lame duck:

- rejects new MCP sessions and modern MCP work;
- accepts authenticated internal control requests;
- scans durable whole-stop intents;
- evicts drainable idle sessions even while workflow executions remain;
- retains only actual workflow execution, in-flight request, and REPL-drain responsibilities;
- exits when those responsibilities settle.

There is no elapsed-time auto-abort. A healthy hours-long run is not destroyed because code was
upgraded.

## 9. Persistence and fencing rules

- Control routing never changes the lease owner.
- Cold stop and force recovery mutate only while holding the run lease.
- Force waits for confirmed process death before lease acquisition; it does not unlink a live lock.
- Lease release is token-guarded.
- New owner IDs are additive. Old lock files remain valid.
- Persistence/event failure preserves the existing fail-closed stop behavior: no final stop
  acknowledgement is returned unless both snapshot and event are readable.
- A process that discovers its lease token no longer matches must fail closed before any later
  persisted write. This is defense in depth against stale-writer bugs; it does not authorize lease
  expiry or timeout-based stealing.

## 10. Observability and diagnostics

- `/healthz` reports daemon instance/control identity and accurate execution counts.
- `daemon status` shows control protocol support and whether an instance is current or draining.
- Succession logs distinguish immediate control-capable handoff from compatibility drain.
- Forwarding logs include operation ID, run ID, source and owner instance IDs, and the terminal or
  pending outcome, without script or prompt content.
- A live external-owner refusal names PID, version when known, control capability, and whether it is
  draining. It never says to resume while the lease remains live.

## 11. Compatibility and non-goals

Additive daemon-info, health, lease-owner, input, and output fields are a backward-compatible minor
release. Old readers ignore them; new readers accept their absence.

This train does not:

- transfer a live VM or ACP socket;
- automatically create a resumed run;
- add heartbeat/TTL lease stealing;
- turn the stdio shim into a run-aware request router;
- impose an automatic drain deadline;
- provide cross-machine control or handoff;
- make the per-project background admission cap global across overlapping daemon generations.

A stable external HTTP front door or per-run worker process may be designed separately; neither is
required for local stdio-shim succession correctness.

## 12. Executable acceptance matrix

The deterministic suite must cover:

1. A predecessor owns a blocked background run; successor whole-stop reaches it and returns one
   durable aborted snapshot/event.
2. The same path works through legacy-session and modern request-scoped MCP traffic.
3. Per-call cancellation reaches the predecessor and the workflow remains live.
4. Completion racing stop wins as an already-terminal no-op.
5. Owner applies stop but its reply is lost; retry returns the same fate without a second event.
6. Owner dies after intent creation; successor acquires the stale lease and cold-stops.
7. A live owner lease is never stolen on timeout.
8. A cold paused run can be stopped without resume.
9. A pre-v1 busy predecessor is temporarily adopted; once idle, exactly one successor takes over.
10. Sessions alone do not indefinitely defer that first upgrade.
11. Foreground and background executions both appear in lifecycle accounting.
12. Force rejects current, non-daemon, mismatched, and live-unverifiable owners; an authorized
    superseded owner termination cold-stops the target and leaves sibling recovery resumable.
13. Wrong/missing/stale HMAC requests are rejected and cannot mutate a run.
14. `inspect`, `await`, event reads, and stop retries remain coherent across generations.
15. Existing total-version-order, stale-lock recovery, stop durability-fault, and session-recovery
    tests remain green.
