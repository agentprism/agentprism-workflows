# Running workflows — the MCP `workflow` tool

The shared daemon owns execution, so admitted runs survive client session churn. `config` and
`run` require an absolute `projectDir` on the daemon; every other action locates the project from
the run ID. A single-project in-process server may default `projectDir`.

Discovery and runtime expose the same strict seven-action union: `config`, `run`, `resume`,
`status`, `result`, `permissions-response`, and `stop`. Every request must include its exact
`action`, and every branch rejects fields from another branch. There are no aliases, omitted-action
defaults, wait controls, or hidden cross-action inputs.

## Actions

- **Config** (`{ action:"config", projectDir, harnesses?, modelSpecs?, modelFilter? }`) discovers
  the live model/mode/config catalogs without sending a prompt. Pin only values it advertises.
  Trusted autonomous implementation/review workflows should select Claude `bypassPermissions` or
  Codex `agent` when advertised. Claude `auto` uses a model classifier and may request permission;
  it is not full-access autonomy.
- **Run** (`{ action:"run", projectDir, script | scriptPath, args?, background?, ...runtime }`)
  requires exactly one content source. The server reads a path once, statically validates and mock
  executes the script, then performs routed config checks. When form elicitation is available, each
  observed call shows phase title/detail, label, and a bounded credential-redacted task preview.
  Accepted provider/model/mode/config selections become one versioned canonical host snapshot
  atomically persisted at admission; raw form fields are not stored. An uncovered live occurrence
  fails closed. Invalid preflight creates no run or background reservation.
- **Resume** (`{ action:"resume", runId, checkpointReplies?, background?, ...runtime }`) continues
  that exact paused or failed run ID. It inherits the persisted script, args, cwd, approved script
  backends, canonical agent configuration, journal, events, cumulative usage, and checkpoint
  decisions without re-elicitation. It never creates a child run or accepts edited inputs. Old
  records without required canonical metadata remain inspectable but require a fresh Run.
- **Status** (`{ action:"status", runId, lastN?, labelGlob?, logLines? }`) returns one immediate,
  bounded snapshot. Request another snapshot later; status never polls or waits. It may expose a
  sanitized pending ACP permission request.
- **Result** (`{ action:"result", runId, offset?, maxBytes? }`) pages the exact JSON result of a
  completed run in at most 16,384 UTF-8 bytes without splitting code points.
- **Permission response** (`{ action:"permissions-response", runId, permissionId, response }`)
  selects one exact advertised option ID or cancels the live request. Capable clients instead get a
  form showing run ID, phase, label, backend, tool title/kind, bounded redacted raw input/content/
  locations, and the exact meaning/scope of every option. Private session IDs and secrets are never
  shown.
- **Stop** aborts the whole run, or includes `callIndex` to cancel one live agent call. A targeted
  call settles to `null` with `AGENT_CANCELLED`; siblings continue.

For a checkpoint pause, use the exact `checkpointContext.callIndex` in `checkpointReplies`. The
first strict-JSON answer is durable before continuation. Repeating it is idempotent; later conflicts
are ignored in favor of the first answer.

## Long-running loop

```json
{
  "action": "run",
  "projectDir": "/absolute/project",
  "background": true,
  "script": "export const meta = { name: 'review', description: 'Review a target' }; return await agent(`Review ${args.target}`, { label: 'review', model: 'codex', mode: 'agent' });",
  "args": { "target": "packages/core" }
}
```

Retain the returned run ID, then take snapshots:

```json
{ "action": "status", "runId": "RUN_ID" }
```

After completion, page the exact result:

```json
{ "action": "result", "runId": "RUN_ID", "offset": 0, "maxBytes": 16384 }
```

If the run pauses or fails and is continuable:

```json
{ "action": "resume", "runId": "RUN_ID", "background": true }
```

The returned ID is still `RUN_ID`.

## Run monitor

MCP Apps hosts may replace one panel with another. Every surviving panel is therefore a bounded
multi-run dashboard: it defaults to the initiating tool call's run and obtains active/recent
navigation from the capability-gated app-only `workflow-runs` tool. `workflow-events` supplies
bounded live detail. Neither app-only tool enters the model's tool loop.
