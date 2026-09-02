# Example scripts

Full-scale workflow scripts to study alongside `SKILL.md` — read them when the inline
worked examples aren't enough. The first two are **verbatim copies** of the runnable
[`repo-triage` example project](https://github.com/agentprism/agentprism-workflows/tree/main/packages/workflows/examples/repo-triage)
(canonical source in the monorepo; kept byte-identical so a plain `diff` catches drift).

| script | what it teaches |
|---|---|
| [`repo-triage.workflow.js`](repo-triage.workflow.js) | The broadest support-API tour, autonomous end-to-end (no `checkpoint()` — every gate is another agent): `pipeline` with no inter-stage barrier, a cross-vendor adversarial verification panel (`parallel`), `gate()` where the writer and reviewer are always *different* vendors and the terminal review verdict is returned, nesting a saved workflow by name (`workflow("quick-wins", …)`), `completenessCheck()`, stage gating before an optional stage, string-form `args` hardening, path guards on schema outputs, the unverified-vs-confirmed bucket split, and rethrowing pause-class errors (`PROVIDER_USAGE_LIMIT` / `AUTH_REQUIRED`) out of `try/catch` so managed runs pause resumably instead of fake-completing. |
| [`quick-wins.workflow.js`](quick-wins.workflow.js) | A small nested-or-standalone hunter: `loopUntilDry()` with a per-round vendor rotation, dedup threading via a `seen` list interpolated into each prompt, and a tracked round bound inside the round. |
| [`resume-loop-cap.workflow.js`](resume-loop-cap.workflow.js) | Content-addressed journal replay: run with `maxRounds: 6`, then resume with `maxRounds: 8` so identity matching serves the six unchanged calls from the recording for zero tokens and only two new calls run live. No filesystem-safety annotation is needed. |

`resume-loop-cap.workflow.js` defaults to eight rounds and therefore validates successfully without args. Its six-round failure is intentional: call the MCP `workflow` tool with `args: { "maxRounds": 6 }`, then call `{ "action":"resume", "runId":"…", "args":{ "maxRounds":8 } }`. The immutable stored script is reused. Identity matching pairs each call by its content (prompt, model, options, input fingerprint), so keep the cap out of the agent prompt — a changed prompt is a changed identity and that round runs live. Filesystem/world drift is diagnostic only and does not force the unchanged rounds live.

Validate either one for free (zero tokens; each routed backend/model pair opens one no-prompt option probe,
with a warning-only degradation when unavailable):

```bash
npx @automatalabs/workflows validate repo-triage --workflows-dir <this directory>
npx @automatalabs/workflows validate repo-triage --workflows-dir <this directory> \
  --mock-answers-file <this directory>/report-gate.mock-answers.json
```

The byte-identical `report-gate.mock-answers.json` fixture scripts `report:review` to
reject once and approve once. Its first partial `{ "ok": false }` answer demonstrates
fresh-base deep merge; the second supplies `{ "ok": true, "feedback": "" }` and
finishes the existing gate.

After running either script through MCP, retain the returned `runId`. Check the most recent
triage workers without re-running anything:

```json
{
  "action": "status",
  "runId": "mabc1234-k9x2pq",
  "lastN": 10,
  "labelGlob": "verify:*",
  "logLines": 20
}
```

For the nested quick-wins hunt, narrow the same run journal to its round labels:

```json
{
  "action": "status",
  "runId": "mabc1234-k9x2pq",
  "lastN": 20,
  "labelGlob": "hunt:*",
  "logLines": 10
}
```

If a run paused or failed, read the execution response's immediate final-20 `logTail` first, then
use status for attributed compact results. Host MCP actions stay outside workflow scripts; the
shipped `.workflow.js` files call only DSL globals.

## Complete background host-call transcript

Start the shipped `repo-triage.workflow.js` by passing its file contents as `script` (the workflow
script does not call MCP actions itself):

```json
{
  "action": "run",
  "script": "<contents of repo-triage.workflow.js>",
  "args": { "target": "." },
  "background": true
}
```

```json
{ "runId": "mabc1234-k9x2pq", "status": "running" }
```

The host retains that ID and waits in bounded 20-second calls. A first timeout returns status rather
than failing the workflow:

```json
{ "action": "status", "runId": "mabc1234-k9x2pq", "waitMs": 20000 }
```

```json
{
  "runId": "mabc1234-k9x2pq",
  "status": "running",
  "workflowName": "repo-triage",
  "phases": ["Discover", "Review"],
  "logTail": { "lines": ["review wave started"], "totalLines": 1, "omittedLines": 0, "truncatedLines": 0, "redactedLines": 0 },
  "calls": [],
  "filter": { "lastN": 20, "logLines": 20 },
  "truncation": { "maxStructuredBytes": 24576, "byteCapApplied": false, "phases": { "total": 2, "returned": 2, "shortened": 0 }, "logs": { "total": 1, "returned": 1, "shortened": 0, "redacted": 0 }, "calls": { "total": 0, "matched": 0, "returned": 0, "shortenedResults": 0, "redactedResults": 0 } },
  "wait": { "requestedMs": 20000, "elapsedMs": 20003, "returnedBecause": "timeout" }
}
```

Call the same status request again until `returnedBecause:"terminal"`; then `outcome.result` is the complete
authored result and `outcome.logs` the foreground-equivalent full logs.

For a workflow that pauses at `checkpoint(..., { headless:"pause" })`, terminal status returns
`outcome.checkpointContext.callIndex`. Resume through a second background run:

```json
{
  "action": "run",
  "script": "<the same workflow source>",
  "args": { "target": "." },
  "background": true,
  "resumeFromRunId": "mabc1234-k9x2pq",
  "checkpointReplies": { "11": true }
}
```

```json
{ "runId": "mabc5678-z1n4rs", "status": "running" }
```

The second ID is intentional: resume executes a new run. Retain it and check its status in turn. Before its
acknowledgement, the new record already contains the inherited call prefix and checkpoint answer, so
another pause/crash can resume from `mabc5678-z1n4rs` without re-running that prefix.
