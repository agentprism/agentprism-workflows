## Running workflows — the MCP `workflow` tool

**Context:** JavaScript passed to the MCP `workflow` tool.

The server owns admitted execution: a run keeps going after your client disconnects, and every
later call addresses it by `runId`. Run and Resume prepare inside the request (up to 120 seconds)
and return once execution has started or been parked for setup; every observation request returns
within 45 seconds. Neither bound limits how long a workflow may run. Each project allows four
active runs, including runs preparing or waiting for setup; a settled or rejected run releases its slot.

On the shared daemon, `config` and `run` require an absolute `projectDir`. Every other action locates
the project through `runId` and rejects `projectDir`. The input is one flat object whose nine actions
each accept only their own fields: send only the fields of the selected action, and never an
execution-mode field or an alias.

### Actions

- **Config** (`{ action:"config", projectDir, harnesses?, modelSpecs?, modelFilter? }`): read the live backend, model, mode, and config-option catalog without creating a run. See [models-and-config.md](models-and-config.md).
- **Run** (`{ action:"run", projectDir, script | scriptPath, args?, maxAgents?, concurrency?, agentRetries? }`): provide exactly one source (inline text, or an absolute server-side path read at admission). The request checks the source, runs the mocked dry run and the no-prompt config probes, and only then starts execution. The acknowledgement contains `accepted:true`, `runId`, `status`, `scriptUri` (a `file://` URI) with `scriptPath`, `limits`, and, for scripts that declare custom backends, `setup`. It never contains the result. Malformed source, validation failure, and a full project are tool execution errors (`isError:true`) that create no run. Cancelling the request before it returns abandons preparation without persisting anything.
- **Status** (`{ action:"status", runId, lastN?, labelGlob?, logLines? }`): an immediate bounded snapshot. It reports `status` (`pending`, `running`, `paused`, `completed`, `failed`, `aborted`), `currentPhase`, the latest `calls` (index, kind, label, phase, model, backend, `queued`/`running` state, and a result preview), `latestActivity` per live call, `logTail`, `tokenUsage`, `pendingPermissions`, `setup`, and resource links. A settled run adds `outcome` with `reason`, `errorCode`, `checkpointContext`, or `authContext`. `lastN` (default 20, max 50) and `labelGlob` (whole-label glob with `*` and `?`) filter the calls; `logLines` (default 20, max 50) bounds the log tail. Status never waits for execution.
- **Result** (`{ action:"result", runId, offset?, maxBytes? }`): page the exact JSON result of a completed run in chunks of at most 16,384 UTF-8 bytes. The response carries `chunk`, `totalBytes`, `endOffset`, and `hasMore`; continue from `endOffset` until `hasMore` is false. Code points are never split.
- **Resume** (`{ action:"resume", runId, checkpointReplies?, maxAgents?, concurrency?, agentRetries? }`): continue the exact run using its args, journal, cumulative usage, and checkpoint decisions, re-reading the script from `scriptPath`. An unchanged or missing file continues the admitted script; an edited file is a revision, validated exactly like a new run and limited to backends already approved, that continues with an identity-matched replay (unchanged calls replay, edited or new calls run live). The acknowledgement adds `continuation` (`scriptRevised:true` for a revision). Paused, failed, and stopped runs continue; a stopped run replays its journal and re-runs the interrupted calls. A run that is running or completed, or paused on a checkpoint you did not answer, returns an observation instead. Resume never accepts a replacement `script` or `args`.
- **Setup response** (`{ action:"setup-response", runId, setupId, response }`): answer the pending `status.setup.request` (`setupId` is `setup.request.id`). Acceptance is `{ action:"accept", content:{ approve:true } }`; `{ action:"decline" }` or `{ action:"cancel" }` carry no content and leave an inspectable aborted run. Backend approval is the only setup kind. Identical retransmissions are idempotent.
- **Permission response** (`{ action:"permissions-response", runId, permissionId, response:{ outcome:{ outcome:"selected", optionId } } }`): answer one entry of `status.pendingPermissions`, selecting an `optionId` from that entry's `request.options`. Cancel with `response:{ outcome:{ outcome:"cancelled" } }`. Permission requests arise from backend modes that ask before acting (for example Claude `auto`).
- **Pause** (`{ action:"pause", runId }`): executing agents finish and journal, nothing new starts, and the run settles as `paused` with `reason:"requested"`. The response carries `pauseRequested` and `paused`; it waits up to two seconds, and a run still `running` afterwards settles on its own (poll status). Pausing an already paused run is a no-op; a terminal or setup-parked run is an error. Resume continues from the journal.
- **Stop** (`{ action:"stop", runId }`): interrupt the whole run now, including pending setup. In-flight agents are cancelled and recorded as interrupted, and the run settles as `aborted`; resume continues it from the journal. Add `callIndex` to cancel one live agent while the run keeps going (that call resolves `null` in the script). Status filters are accepted on stop. `forceOwner:true` authorizes stopping a run whose execution owner was superseded and cannot accompany `callIndex`. Closing a monitor or dropping the transport never stops a run.

### Request cancellation and continuation

A Run or Resume request is cancelled the way your transport defines (closing the HTTP response
stream, or `notifications/cancelled` on stdio). Cancellation before admission stops preparation,
persists nothing, and releases capacity; cancellation after admission is ignored and the started
run remains discoverable through its script file resource. Sending the same run input again starts an
independent run. Add `_meta.progressToken` to the run request to receive preparation-stage progress notifications.

One `runId` names one immutable script text, args, event stream, usage total, and final result. Every
`agent()` and `checkpoint()` call must resolve a model before dispatch; a call on a branch the dry run did
not visit still fails at that call if it has no route. Resume reuses the admitted routing; it never
re-selects models or widens backend approval. Replaying a journaled call adds no provider usage.

Every unanswered `checkpoint()` pauses the run. Resume with
`checkpointReplies:{ [checkpointContext.callIndex]: decision }`, using the exact pending index and a
strict-JSON value. The first answer is durable; repeats are idempotent and conflicting later answers
are ignored. Answering an earlier checkpoint again cannot advance a later one. Explicit negative answers
follow the script's authored control flow.

Runtime limits (`maxAgents`, `concurrency`, `agentRetries`) may change on resume; the script text, args,
and routing cannot. An authentication pause resumes after the same backend's credentials are configured.

### Monitor and events

If your host lists the `workflow_monitor` tool, `{ runId }` opens a live view of that run; the view can switch
among the project's active and recent runs. It is never required: status, checkpoint replies, permission
responses, pause, stop, and result work without it. The run's event log is also readable as the MCP resource
`workflow://runs/{runId}/events` (`eventsUri` in status), with a durable cursor for paging. Use
`status.latestActivity` for compact current activity and `result` for the exact final value.
