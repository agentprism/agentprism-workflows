## The `meta` header

**Context:** JavaScript passed to the MCP `workflow` tool.

Every script must **begin** with `export const meta = {...}` as a plain object literal (no computed values and no template interpolation; it is parsed from the source text before anything runs):

```js
export const meta = {
  name: "fix-flaky-tests",                        // required
  description: "Find flaky tests and fix them",   // required
  phases: [                                        // optional; one { title, detail?, model? } entry
    { title: "Find", model: "opencode" },          // per phase() call, matched by exact title;
    { title: "Fix" },                              // a phase model is that phase's default
  ],
  model: "claude",                                 // optional run-wide default model
  backends: { /* optional custom ACP agents — see environment-and-tools.md */ },
};
```

Per-call model resolution order: explicit `agent({ model })`, then the `agentType` definition's model, then the current phase's `model`, then `meta.model`. A call left without any of these is rejected at preflight before anything runs. `meta.phases[].model` gives a whole phase a backend without repeating it on every call. The fragments below inherit the metadata above.

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

The run caps concurrent agents (default 8; the run option `concurrency` raises it to at most 16). Hand `parallel`/`pipeline` as many items as the task needs and let the limiter schedule them. The cap counts active agent attempts, not authored branches: queued branches begin as other attempts finish, and a branch that fails settles to `null` and frees its slot. `workflow(script, args)` runs another workflow script inline, one level deep, sharing this run's limiter and agent count; pass the child script's source as a string.

## Failure semantics — design for `null`

- A **recoverable** failure (timeout, empty output, transient execution error) is retried per the call's `retries` (default: the run's `agentRetries`, which defaults to 0), then the call **resolves to `null`** — inside `parallel`/`pipeline` *and* as a bare `await agent(...)`. Null-check anything load-bearing, and set `retries: 1–2` on steps you can't afford to lose.
- `{ action: "stop", runId, callIndex }` cancels one runaway in-flight call. It resolves to `null` with `AGENT_CANCELLED`, skips every configured retry, and does not abort the run or its siblings. The cancelled call is not journaled, so a later resume runs it live.
- A **non-recoverable** failure (schema never validated, script bug) throws and fails the run. You *may* `try/catch` around an `agent()` call to degrade gracefully — rethrow anything you can't meaningfully handle. In particular, **always rethrow pause-class errors** (`err.code === "PROVIDER_USAGE_LIMIT"` or `"AUTH_REQUIRED"`): they must propagate out of the script so the run pauses resumably — swallowing one converts that pause into a fake, lossy completion.
- A **provider quota wall, missing backend authentication, or unanswered checkpoint pauses the run instead of failing it**. Status reports `status:"paused"` with `reason` `usage_limit`, `auth_required`, or `checkpoint_required`; resume after the quota refills, the credential is configured, or the checkpoint reply is supplied.
- Agent attempts have no wall-clock or idle timeout. They remain live until they complete, fail, or you cancel the call or the run.

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

Terminate every loop on a bound the script controls. The agent-count limit (run option `maxAgents`, default 1000) is hard: once exhausted, further `agent()` calls throw `AGENT_LIMIT_EXCEEDED`. `phase()` groups agents in status output and run logs; `log(msg)` (and `console.log`) append to the run log — narrate what matters, especially anything you drop.
