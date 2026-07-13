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
