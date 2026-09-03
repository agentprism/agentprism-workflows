# Example scripts

Full-scale workflow scripts to study alongside `SKILL.md` — read them when the inline
worked examples aren't enough. The first two are **verbatim copies** of the runnable
[`repo-triage` example project](https://github.com/agentprism/agentprism-workflows/tree/main/packages/workflows/examples/repo-triage)
(canonical source in the monorepo; kept byte-identical so a plain `diff` catches drift).

| script | what it teaches |
|---|---|
| [`repo-triage.workflow.js`](repo-triage.workflow.js) | The broadest support-API tour, autonomous end-to-end (no `checkpoint()` — every gate is another agent): `pipeline` with no inter-stage barrier, a cross-vendor adversarial verification panel (`parallel`), `gate()` where the writer and reviewer are always *different* vendors and the terminal review verdict is returned, nesting a saved workflow by name (`workflow("quick-wins", …)`), `completenessCheck()`, stage gating before an optional stage, string-form `args` hardening, path guards on schema outputs, the unverified-vs-confirmed bucket split, and rethrowing pause-class errors (`PROVIDER_USAGE_LIMIT` / `AUTH_REQUIRED`) out of `try/catch` so managed runs pause resumably instead of fake-completing. |
| [`quick-wins.workflow.js`](quick-wins.workflow.js) | A small nested-or-standalone hunter: `loopUntilDry()` with a per-round vendor rotation, dedup threading via a `seen` list interpolated into each prompt, and a tracked round bound inside the round. |

Validate either script for free (zero tokens; each routed backend/model pair opens one no-prompt option probe,
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

The host retains that ID and requests immediate bounded snapshots:

```json
{ "action": "status", "runId": "mabc1234-k9x2pq" }
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
  "truncation": { "maxStructuredBytes": 24576, "byteCapApplied": false, "phases": { "total": 2, "returned": 2, "shortened": 0 }, "logs": { "total": 1, "returned": 1, "shortened": 0, "redacted": 0 }, "calls": { "total": 0, "matched": 0, "returned": 0, "shortenedResults": 0, "redactedResults": 0 } }
}
```

Call status again later until it is terminal; then `outcome.result` is the complete authored result
and `outcome.logs` the foreground-equivalent full logs.

For a workflow that pauses at `checkpoint(..., { headless:"pause" })`, terminal status returns
`outcome.checkpointContext.callIndex`. Continue the exact run with a durable answer:

```json
{
  "action": "resume",
  "runId": "mabc1234-k9x2pq",
  "background": true,
  "checkpointReplies": { "11": true }
}
```

```json
{ "runId": "mabc1234-k9x2pq", "status": "running" }
```

The first strict-JSON checkpoint answer is durable before acknowledgement. Repeating the same answer
is idempotent; a conflicting later answer is ignored in favor of the first. Script, args, canonical
agent configuration, journal, event stream, and cumulative usage all remain attached to this ID.
