## Running workflows — the MCP `workflow` tool

**Context:** JavaScript passed to the MCP `workflow` tool. Workflow scripts use `agent(prompt, options?)`; REPL evals use a different API.

Use the connected `workflow` tool for deterministic batch orchestration. The shared daemon owns
execution, so admitted runs survive client-session churn and request timeouts. Runs, canonical
admission data, journals, event streams, cumulative usage, logs, and stop intents persist per
project namespace. Both the legacy 2025 transport and modern `2026-07-28` transport expose the same
lifecycle.

Every `config` and `run` call on the shared daemon names its project with absolute `projectDir`.
`resume`, `status`, `result`, and `stop` take a `runId`, which locates that store. In a
single-project server, `projectDir` defaults to the server project.

Tool discovery publishes a strict seven-action `oneOf`. Always send the required canonical
`action`; each branch accepts only its documented fields. There are no omitted-action defaults,
retired action aliases, waiting status inputs, or hidden cross-action inputs.

### The `workflow` tool, by action

- **Config** (`{ action:"config", projectDir, harnesses?, modelSpecs?, modelFilter? }`): discover live model, mode, effort, and `configOptions` from no-prompt backend sessions. Use `modelSpecs` for the selected model's option domain. Raw mode ids, names, descriptions, and `_meta` are preserved. For trusted implementation/review work, choose Claude `bypassPermissions` or Codex `agent` when those exact modes are advertised. Claude `auto` uses a model classifier and may still request permission; it is not the full-access autonomous mode. Config starts no workflow and spends no prompt tokens.
- **Run** (`{ action:"run", script | scriptPath, projectDir, ... }`): provide exactly one content source. The server statically validates, mock-runs, probes routed configuration, and—when supported—presents one configuration form covering only observed agents whose effective model is unresolved. Explicit and inherited models, including backend-only specs, are preserved; optional mode/config omissions do not trigger a form. Each form row shows phase title/detail, label, and a bounded credential-redacted task preview so the user knows what the selected model will do. Authored and accepted effective occurrence configurations are validated together and atomically persisted as a complete versioned host-owned admission snapshot before live dispatch. Raw form fields are not persisted. Strict occurrence coverage remains enabled; an unobserved live occurrence fails closed and is recorded. A path is snapshotted at admission. `args` becomes the script's `args` global. `background:true` acknowledges only after durable admission. A form-capable foreground run presents each live ACP permission in that same call; the accepted response continues the same run and can reach later permissions or checkpoints before the call completes.
- **Resume** (`{ action:"resume", runId, checkpointReplies?, background?, maxAgents?, concurrency?, agentRetries? }`): continue that exact run ID using its persisted script, args, canonical agent configuration, journal, event stream, cumulative usage, and checkpoint decisions. Resume never creates a child run and never re-runs configuration elicitation. Script/args/config cannot be replaced. Old records without valid canonical admission remain observable but cannot continue; start a fresh Run. A checkpoint reply names this run's call index. The first strict-JSON answer is durable before continuation, the same answer is idempotent, and later conflicts are ignored in favor of the durable first answer. A repeat or conflict never stands in for a still-pending checkpoint: the run stays paused and the response shows what is pending. A foreground resume from a form-capable client is asked pending and newly reached checkpoints or live ACP permissions directly; clients without forms receive the paused/running observation and use `checkpointReplies` or `permissions-response`.
- **Status** (`{ action:"status", runId, lastN?, labelGlob?, logLines? }`): return an immediate bounded snapshot. Status never waits, elicits, or changes execution. Request another snapshot only when an on-demand sample is needed. It includes calls, compact durable `latestActivity`, logs, cumulative usage, safe pending-permission state, and resource links; terminal snapshots add `outcome`. A permission projection includes run, phase, agent, backend, tool title/kind, bounded credential-redacted `rawInput`, `content`, and `locations`, plus the exact one-request/session scope of each advertised option. Private ACP session IDs and unredacted secrets never appear.
- **Result** (`{ action:"result", runId, offset?, maxBytes? }`): retrieve a completed exact JSON result in chunks of at most 16,384 UTF-8 bytes. Continue at the prior `endOffset`; code points are never split.
- **Permission response** (`{ action:"permissions-response", runId, permissionId, response }`): clients without form elicitation select one exact advertised option id or cancel. Caller-supplied response `_meta` is forbidden. The request must still belong to the live execution owner.
- **Stop**: `{ action:"stop", runId }` durably aborts a whole run; `{ action:"stop", runId, callIndex }` cancels one live agent call and leaves the run alive. Across daemon succession, signed forwarding targets the execution owner. `forceOwner:true` is an explicit whole-run authorization and cannot accompany `callIndex`.

### Operating rules

- **Keep the `runId`.** One ID names the immutable script resource, one event stream, cumulative usage, and final result across every continuation. MCP exposes no separate attempt identity. A completed result is available at `workflow://runs/{runId}/result`; large results remain out of bounded summary text and are paged with `result`.
- **Admission is immutable.** The host persists a canonical effective occurrence map, default model, approved script backends, and selection hash before execution. Same-ID continuation inherits it. Missing/invalid metadata or an uncovered occurrence fails closed; no migration or mapping guess is attempted.
- **Journal replay is same-run reconstruction.** Exact index/hash hits are reused while execution rebuilds state; they add no new provider usage and are not appended as new journal entries. An interrupted eligible ACP call may reattach and charge only new usage.
- **Checkpoint answers are first-writer-wins under the lease.** A durable answer is replayed forever. Repeats are idempotent; conflicts are reported but cannot replace it.
- **Runtime controls are not logical inputs.** `maxAgents`, `concurrency`, and `agentRetries` may be supplied for the continuing execution. Agent attempts otherwise remain live until completion, failure, or explicit cancellation.
- **A background start returns after durable admission.** It emits no progress after the request returns. Request an immediate status snapshot when you need machine-readable state, or consume the events resource. Background runs have no live checkpoint channel, so authored `headless` behavior applies.
- A run paused for authentication continues with the same `{ action:"resume", runId }` after credentials are configured; it never switches provider.

### Execution logs and the multi-run App

Every journaling run publishes `workflow://runs/{runId}/events`. Use its cursor and `streamId` for
durable redacted detail; `status.latestActivity` is the compact model-facing projection. MCP
Apps-capable hosts also receive the run-monitor panel. Because a host may replace a panel, every
surviving panel is a multi-run dashboard: an app-only, capability-gated `workflow-runs` query returns
a bounded active/recent list from the anchor run's authoritative project manager. The initiating
tool run is selected by default, and the selector navigates active and recent runs. Incapable
clients never see the app-only tools.
