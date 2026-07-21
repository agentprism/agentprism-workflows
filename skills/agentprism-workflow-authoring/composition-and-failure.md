## The `meta` header

Every script must **begin** with `export const meta = {...}` as a plain object literal (no computed values — it is parsed from the source text before anything runs):

```js
export const meta = {
  name: "fix-flaky-tests",                        // required
  description: "Find flaky tests and fix them",   // required
  phases: [                                        // optional; one entry per phase() call
    { title: "Find", model: "opencode/zai/glm-5.2" },  // per-phase default model
    { title: "Fix" },
  ],
  model: "claude/sonnet",                          // optional run-wide default model
  backends: { /* optional custom ACP agents — see "Custom ACP backends" */ },
};
```

Per-agent model resolution order: explicit `agent({ model })` > `agent({ tier })` > the current phase's `model` > `meta.model` > the host session's default. So `meta.phases[].model` is how you give a whole phase a backend without repeating it on every call.

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

**Default to `pipeline`** for multi-stage work; use a `parallel` barrier only when the next stage genuinely needs *all* prior results at once (dedup across the full set, early-exit on a zero count, prompts that compare "the other findings"). The test is always the **information dependency**, never the org chart: "these stages are conceptually separate" or "this reads cleaner" are not reasons for a barrier, and a barrier's cost is real — the fastest worker idles for the slowest. Likewise, all coordination lives in script code: never ask an agent to "check with the other reviewers" or "spawn helpers" — agents cannot see each other, and the ones that try will hallucinate colleagues. Passing a promise instead of a thunk to `parallel` is a `TypeError` — wrap every call: `() => agent(...)`.

Fan-out also contends for the **working tree**, not just the concurrency limiter. Two agents running builds or test suites in the same checkout collide on build outputs, caches, and lockfiles, and concurrent `git fetch`es contend on the same `.git` — none of it visible in script code. Give run-things reviewers `isolation: "worktree"` when the commits they must inspect are reachable from the run cwd's repository, or serialize them; fan out freely only the agents that just read. In a shared tree, freshness checks use `git ls-remote` (no local mutation), never `git fetch`.

The host caps concurrent agents per run (default 8); hand `parallel`/`pipeline` as many items as the task needs and let the limiter schedule them. `workflow(nameOrScript, args)` nests another workflow inline (one level deep, sharing this run's budget and limiter) — inline script strings always work; saved names resolve when the host serves a workflows folder (`openWorkflowDir` / the `workflows` run option — see `reference.md`).

## Failure semantics — design for `null`

- A **recoverable** failure (timeout, empty output, transient execution error) is retried per the call's `retries` (default 0), then the call **resolves to `null`** — inside `parallel`/`pipeline` *and* as a bare `await agent(...)`. Null-check anything load-bearing, and set `retries: 1–2` on steps you can't afford to lose.
- A host can settle one runaway in-flight call with MCP `{ action: "stop", runId, callIndex }` or SDK `manager.cancelAgentCall(runId, callIndex)`. The call resolves to `null` with `AGENT_CANCELLED`, skips every configured retry, and does not abort the run or its siblings. Its failed call record is inspectable but is not cached as a journal result, so a later resume runs that occurrence live.
- A **non-recoverable** failure (schema never validated, script bug) throws and fails the run. You *may* `try/catch` around an `agent()` call to degrade gracefully — rethrow anything you can't meaningfully handle. In particular, **always rethrow pause-class errors** (`err.code === "PROVIDER_USAGE_LIMIT"` or `"AUTH_REQUIRED"`): they must propagate out of the script so the engine can pause the run resumably — swallowing one converts that pause into a fake, lossy completion.
- A **provider quota wall, missing backend authentication, or opted-in durable checkpoint pauses a managed run instead of failing it** — the journal checkpoints and the host can resume after the budget refills, authentication completes, or a checkpoint decision is supplied. Direct `runner.run()` calls still receive the `AUTH_REQUIRED` error because they have no manager lifecycle.
- Per-call knobs: `timeoutMs` and `retries`. A finite `timeoutMs` may shorten the host's run-level
  `agentTimeoutMs` ceiling; `null` or omission is uncapped only when the host supplied no ceiling.
  The timeout is total wall-clock time per attempt, and every retry gets a fresh clock. The maximum
  timeout envelope is `(resolved retries + 1) × resolved timeout`, with retries clamped to 3.
- **Make refusal a first-class outcome (STOP-and-report).** For implementation and spec work, give the producer an explicit refusal shape — a `status: "implemented" | "stopped"` enum plus the discrepancy verbatim in a `deviations` field. Prefer the enum over an implicit convention like "empty `commitShas` means refusal": a round can legitimately have both commits and deviations, and the checker should never have to guess. Pair it with the instruction that a cited surface that does not exist as cited means STOP, never improvise. Then make your checker RECOGNIZE that shape: set a flag, exit the loop, skip adjudication, and surface it for the owner. A correct refusal routed into "round failed, try again" wastes every remaining round; the plausible-looking alternative — the agent quietly building around the discrepancy — is worse, because the mismatch is usually a stale base, not a wrong spec.
- **Treat provider failure as an expected path, not an anomaly.** Rate limits, capacity collapse on newly launched models, and schema-repair exhaustion on oversized outputs all happen mid-run. Keep the recovery knobs at the host level where they are NOT identity-hashed — concurrency caps, engine retries, labels — so a resume can turn them without invalidating completed work. When one panel model's provider degrades, swapping that role to a stable model (an owner decision, disclosed) beats burning rounds on retries.

## Budgets and phases

```js
phase("Explore", { budget: 100_000 });   // soft per-phase token sub-budget
// budget.total (null = unbounded) · budget.spent() · budget.remaining() (Infinity when unbounded)

const found = [];
while (budget.total && budget.remaining() > 50_000 && found.length < 20) {
  const r = await agent("Find one more edge case not in: " + JSON.stringify(found.map((f) => f.name)),
                        { label: `edge:${found.length}`, schema: EDGE });
  if (!r) break;
  found.push(r);
}
```

Guard budget-driven loops on `budget.total` being set — with no budget, `remaining()` is `Infinity` and only your own counters stop the loop. The run-level token budget and agent-count cap are hard: once exhausted, further `agent()` calls throw. `phase()` also groups agents in progress UIs and run logs; `log(msg)` (and `console.log`) append to the run log — narrate what matters, especially anything you drop or cap.

The concurrency cap counts active agent attempts, not authored branches. If one `parallel()` branch
is slow, queued branches begin as other attempts finish. A branch that exhausts its timeout settles
to `null` after retries and immediately frees its slot; a host-cancelled branch does the same without
retrying. Finite ceilings and targeted cancellation keep one stalled worker from holding a slot
indefinitely.
