# Example scripts

Full-scale workflow scripts to study alongside `SKILL.md` — read them when the inline
worked examples aren't enough. Both are **verbatim copies** of the runnable
[`repo-triage` example project](https://github.com/VikashLoomba/agentprism-workflows/tree/main/packages/workflows/examples/repo-triage)
(canonical source in the monorepo; kept byte-identical so a plain `diff` catches drift).

| script | what it teaches |
|---|---|
| [`repo-triage.workflow.js`](repo-triage.workflow.js) | The broadest support-API tour, autonomous end-to-end (no `checkpoint()` — every gate is another agent): `pipeline` with no inter-stage barrier, a cross-vendor adversarial verification panel (`parallel`), `gate()` where the writer and reviewer are always *different* vendors, nesting a saved workflow by name (`workflow("quick-wins", …)`), `completenessCheck()`, budget headroom reservation before an optional stage, string-form `args` hardening, path guards on schema outputs, the unverified-vs-confirmed bucket split, and rethrowing pause-class errors (`PROVIDER_USAGE_LIMIT` / `AUTH_REQUIRED`) out of `try/catch` so managed runs pause resumably instead of fake-completing. |
| [`quick-wins.workflow.js`](quick-wins.workflow.js) | A small nested-or-standalone hunter: `loopUntilDry()` with a per-round vendor rotation, dedup threading via a `seen` list interpolated into each prompt, and a budget floor check inside the round (reads the *parent* run's shared budget when nested). |

Validate either one for free (zero tokens, no agent processes):

```bash
npx @automatalabs/workflows validate repo-triage --workflows-dir <this directory>
```

After running either script through MCP, retain the returned `runId`. Inspect the most recent
triage workers without re-running anything:

```json
{
  "action": "inspect",
  "runId": "mabc1234-k9x2pq",
  "lastN": 10,
  "labelGlob": "verify:*",
  "logLines": 20
}
```

For the nested quick-wins hunt, narrow the same run journal to its round labels:

```json
{
  "action": "inspect",
  "runId": "mabc1234-k9x2pq",
  "lastN": 20,
  "labelGlob": "hunt:*",
  "logLines": 10
}
```

If a run paused or failed, read the execution response's immediate final-20 `logTail` first, then
use inspection for attributed compact results. Host MCP actions stay outside workflow scripts; the
shipped `.workflow.js` files call only DSL globals.
