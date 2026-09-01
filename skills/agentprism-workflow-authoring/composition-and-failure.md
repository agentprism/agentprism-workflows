## The `meta` header

Every script must **begin** with `export const meta = {...}` as a plain object literal (no computed values — it is parsed from the source text before anything runs):

```js
export const meta = {
  name: "fix-flaky-tests",                        // required
  description: "Find flaky tests and fix them",   // required
  phases: [                                        // optional; one { title, detail?, model? } entry
    { title: "Find", model: "opencode/zai/glm-5.2" },  // per phase() call, matched by exact title;
    { title: "Fix" },                                  // a phase model is that phase's default
  ],
  model: "claude/sonnet",                          // optional run-wide default model
  backends: { /* optional custom ACP agents — see "Custom ACP backends" */ },
};
```

Per-agent model resolution order: explicit `agent({ model })` > `agent({ tier })` > the current phase's `model` > `meta.model` > the host session's default. So `meta.phases[].model` gives a whole phase a backend without repeating it on every call.

## Fan-out: `parallel` and `pipeline`

```js
// parallel: an array of THUNKS (not promises!) run concurrently — a barrier that
// resolves in input order. A failed slot resolves to null; filter before use.
const sweeps = (await parallel([
  () => agent("Audit error handling in src/server", { label: "sweep:errors", schema: FINDINGS }),
  () => agent("Audit input validation in src/api",  { label: "sweep:input",  schema: FINDINGS }),
])).filter(Boolean);

// pipeline: each item flows through the stages independently — NO barrier between
// stages, so item A can be in stage 2 while item B is still in stage 1.
// Stages receive (previousResult, originalItem, index).
const verified = (await pipeline(
  sweeps.flatMap((s) => s.findings),
  (f) => agent(`Adversarially verify this finding — try to refute it:\n${JSON.stringify(f)}`,
               { label: `verify:${f.file}`, schema: VERDICT }),
  (verdict, f) => ({ ...f, real: verdict.real }),
)).filter(Boolean).filter((f) => f.real);
```

**Default to `pipeline`** for multi-stage work. Add a `parallel` barrier only when the next stage needs *all* prior results at once: dedup across the full set, early-exit on a zero count, or prompts that compare "the other findings". The test is the **information dependency** — a barrier's cost is real, because the fastest worker idles for the slowest. All coordination lives in script code: agents cannot see each other, so never ask an agent to "check with the other reviewers" or "spawn helpers". Passing a promise instead of a thunk to `parallel` is a `TypeError` — wrap every call: `() => agent(...)`.

Fan-out also contends for the **working tree**, not just the concurrency limiter. Two agents running builds or test suites in the same checkout collide on build outputs, caches, and lockfiles, and concurrent `git fetch`es contend on the same `.git`. Give run-things agents `isolation: "worktree"` when the commits they must inspect are reachable from the run cwd's repository, or serialize them; fan out freely only the agents that just read.

The host caps concurrent agents per run (default 8); hand `parallel`/`pipeline` as many items as the task needs and let the limiter schedule them. The cap counts active agent attempts, not authored branches: queued branches begin as other attempts finish, and a branch that exhausts its timeout settles to `null` and frees its slot. `workflow(nameOrScript, args)` nests another workflow inline (one level deep, sharing this run's limiter) — inline script strings always work; saved names resolve when the host serves a workflows folder (see `reference.md`).

## Failure semantics — design for `null`

- A **recoverable** failure (timeout, empty output, transient execution error) is retried per the call's `retries` (default 0), then the call **resolves to `null`** — inside `parallel`/`pipeline` *and* as a bare `await agent(...)`. Null-check anything load-bearing, and set `retries: 1–2` on steps you can't afford to lose.
- A host can settle one runaway in-flight call with MCP `{ action: "stop", runId, callIndex }` or SDK `manager.cancelAgentCall(runId, callIndex)`. The call resolves to `null` with `AGENT_CANCELLED`, skips every configured retry, and does not abort the run or its siblings. Its failed call record is not cached as a journal result, so a later resume runs that occurrence live.
- A **non-recoverable** failure (schema never validated, script bug) throws and fails the run. You *may* `try/catch` around an `agent()` call to degrade gracefully — rethrow anything you can't meaningfully handle. In particular, **always rethrow pause-class errors** (`err.code === "PROVIDER_USAGE_LIMIT"` or `"AUTH_REQUIRED"`): they must propagate out of the script so the engine can pause the run resumably — swallowing one converts that pause into a fake, lossy completion.
- A **provider quota wall, missing backend authentication, or opted-in durable checkpoint pauses a managed run instead of failing it** — the journal checkpoints and the host can resume after the provider quota refills, authentication completes, or a checkpoint decision is supplied. Direct `runner.run()` calls still receive the `AUTH_REQUIRED` error because they have no manager lifecycle.
- Per-call `retries` can override the host retry default. Agent attempts otherwise remain live until they complete, fail, or the host explicitly cancels the call or run.

## Phases

```js
phase("Explore");   // open a named phase: subsequent agents group under it

const found = [];
while (found.length < 20) {
  const r = await agent("Find one more edge case not in: " + JSON.stringify(found.map((f) => f.name)),
                        { label: `edge:${found.length}`, schema: EDGE });
  if (!r) break;
  found.push(r);
}
```

Terminate every loop on a bound the script controls. The agent-count limit (`maxAgents`) is hard: once exhausted, further `agent()` calls throw `AGENT_LIMIT_EXCEEDED`. `phase()` groups agents in progress UIs and run logs; `log(msg)` (and `console.log`) append to the run log — narrate what matters, especially anything you drop.
