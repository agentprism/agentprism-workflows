## Running workflows — the MCP `workflow` tool

**Context:** JavaScript passed to the MCP `workflow` tool. Workflow scripts use `agent(prompt, options?)`; REPL evals use a different API.

The server owns admitted execution across client-session churn. Both legacy 2025 and modern
`2026-07-28` transports expose the same lifecycle. Run and Resume prepare inside the request under
a 120-second preparation ceiling and honor request cancellation; every observation request has a
45-second bound. Neither bound limits live workflow duration. Each project allows four active runs,
including runs preparing or waiting for setup; a settled or rejected run releases its slot.

On the shared daemon, Config and Run require absolute `projectDir`. Other actions locate the
project through `runId` and reject `projectDir`. A single-project server defaults to its own project.
The input schema is a strict eight-action union. Omitted actions, aliases, execution-mode fields,
cross-action fields, and retired request-state tokens are rejected in both protocol eras.

### Actions

- **Config** (`{ action:"config", projectDir, harnesses?, modelSpecs?, modelFilter? }`): read bounded no-prompt model/mode/config catalogs without creating a run. Use `modelSpecs` for a selected model's exact option domain. Preserve backend-advertised ids and descriptions.
- **Run** (`{ action:"run", projectDir, script | scriptPath, args?, maxAgents?, concurrency?, agentRetries? }`): provide exactly one source. The request reads the source, checks its structure, runs the mocked dry run and routed no-prompt probes, and only then admits execution; a path is read at admission, and later edits cannot change the admitted source. The acknowledgement contains `accepted:true`, `runId`, current `status`, resource links, limits, and optional `setup`. It contains no final result. Malformed source, validation failure, and a full project are tool execution errors that create no run. A script declaring custom backends is parked in durable setup instead of started; decline/cancel leaves an aborted run. Cancelling the request before admission abandons preparation without persisting anything.
- **Resume** (`{ action:"resume", runId, checkpointReplies?, maxAgents?, concurrency?, agentRetries? }`): continue the exact run using stored source, args, configuration, journal, events, usage, and checkpoint decisions. An accepted acknowledgement adds `continuation`; observe later state with Status. Running, completed, aborted, auth-blocked, or unanswered-checkpoint states return an observation when no continuation is admitted. Resume never accepts replacement logical inputs or opens an inline human interaction.
- **Setup response** (`{ action:"setup-response", runId, setupId, response }`): answer `status.setup.request.id`. Acceptance is exactly `{ action:"accept", content:{ ... } }`, matching the advertised `requestedSchema`. Backend approval is the only setup kind and requires `{ approve:true }`; it never chooses agent routes. `{ action:"decline" }` and `{ action:"cancel" }` have no content and stop setup. Identical retransmissions are idempotent; conflicting or stale responses cannot authorize a new request.
- **Status** (`{ action:"status", runId, lastN?, labelGlob?, logLines? }`): return an immediate bounded observation with calls, durable `latestActivity`, log tail, usage, safe pending permissions, setup state, and resource links. Settled runs add `outcome`; a checkpoint appears at `outcome.checkpointContext`. Reading a failed workflow is a successful tool request. Status never waits for execution or collects input.
- **Result** (`{ action:"result", runId, offset?, maxBytes? }`): page exact completed JSON results in chunks up to 16,384 UTF-8 bytes. If `hasMore`, continue from `endOffset`; code points are never split.
- **Permission response** (`{ action:"permissions-response", runId, permissionId, response:{ outcome:{ outcome:"selected", optionId } } }`): select an exact advertised ACP option. Cancellation is `response:{ outcome:{ outcome:"cancelled" } }`. The request must still belong to the live execution owner. Caller response `_meta` is forbidden. These bounded controls work with or without an App.
- **Stop** (`{ action:"stop", runId }`): durably abort a whole run, including pending setup. Add `callIndex` to cancel one live agent while preserving the run. Status filters are accepted. `forceOwner:true` authorizes a whole-run superseded-owner stop and cannot accompany `callIndex`; cross-daemon forwarding targets the owner. Losing a panel or transport never implies Stop.

### Cancellation, continuation, and checkpoint rules

A Run or Resume request is cancelled the way its transport defines: closing the Streamable HTTP
response stream, or `notifications/cancelled` on stdio. Cancellation before admission stops
preparation, persists nothing, and releases capacity; cancellation after admission is ignored and
the started run stays discoverable through the `workflow://runs/` resources. A Run carries no
retry identity: sending the same input again starts an independent run. Progress notifications
report preparation stages when the request carries `_meta.progressToken`.

One run ID names one immutable source, event stream, usage total, and final result. Before live
dispatch, the host persists format-3 routing admission: `strict:true`, captured tier configuration
and named-agent definitions, optional host default, approved backends, integrity hash, and timestamp.
Every actual call must resolve a model. Configured calls on unseen live branches are valid; missing
routes fail before dispatch with bounded discovery guidance. There is no agent-configuration setup
or automatic default selection. Continuation validates admission and reuses its immutable inputs
without routing-file drift; old admissions remain inspectable but cannot execute. Same-ID replay
adds no duplicate journal rows or provider usage.

Every unanswered script checkpoint pauses. Resume with `checkpointReplies:{ [context.callIndex]:
decision }`, using the exact pending index and a strict-JSON value. The first answer is durable
under the run lease before continuation; repeats are idempotent and conflicts are reported but
ignored. A repeat/conflict cannot answer another pending checkpoint. Explicit negative answers
follow the authored script. Current checkpoint journals and result call records require
`checkpointDecision:"explicit-v1"`; ambiguous historical answers cannot authorize replay, same-run
continuation, or isolation reuse. Unsupported records remain readable but require a fresh run.

Runtime controls may change on a fresh continuation; logical inputs cannot. Authentication pauses
use a fresh Resume after the same provider's credentials are configured. Live sessions survive
client disconnect; after execution-owner process loss, persisted unfinished work is reconciled
under the lease and can be continued from its durable prefix. Pending setup can recover from its
stored source and exact pending request. Stop intent remains durable through cold recovery.

### Monitor, events, and notifications

Call the model-facing **`workflow_monitor`** with `{ runId }` to open a view for an existing run.
Only that tool advertises the shared static UI resource. Lifecycle calls never attach a panel,
and the server has no hyphenated monitor alias. A host may retain multiple views or replace one;
each surviving monitor can switch among active/recent runs in its anchor run's project.

App data tools (`workflow-runs`, `workflow-events`, and notification coordination) are capability
gated and app-only. All state-changing controls use the same bounded lifecycle actions described
above. Events are also available at `workflow://runs/{runId}/events` with a durable `streamId` and
cursor. Use `status.latestActivity` for compact current activity; fetch exact results separately.

Required-input and terminal transitions notify through available host capabilities. Routine
selection, phase, and activity changes stay quiet. Multiple/reopened panels share notification
receipts to suppress duplicates; reopening history does not replay a backlog. Hosts without
unsolicited delivery use bounded Status. No notification or panel is required to retain work,
answer a checkpoint/permission, stop, or retrieve the result.
