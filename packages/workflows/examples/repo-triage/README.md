# repo-triage — a standalone project on the workflows SDK

A complete, copy-out-able **project** (own `package.json`, TypeScript host, external
workflow scripts) that runs an **autonomous, unattended repo triage** across all three
first-class backends — Claude Code, Codex, and OpenCode — in a single run. The host
(`src/main.ts`) loads a workflow **by name** from `./workflows/` via the SDK, runs it
against a target repository, prints the structured result, and writes the gated
markdown report to disk.

```
┌───────────────────────────────────────────────────────────────┐
│ Map     one agent (host's default backend) picks the areas    │
│         most worth auditing                                   │
└─────────────────────────────┬─────────────────────────────────┘
                              ▼   one pipeline — no barrier between stages
┌───────────────────────────────────────────────────────────────┐
│ Sweep   each area audited by the next vendor in the pool      │
│         (opus[1m] / gpt-5.6-sol[xhigh] / zai glm-5.2[max])    │
│ Verify  every finding adversarially re-checked by the TWO     │
│         vendors that did not produce it; unanimity to survive │
└─────────────────────────────┬─────────────────────────────────┘
                              ▼   skipped when the token budget runs low
┌───────────────────────────────────────────────────────────────┐
│ Hunt    workflow("quick-wins") — the saved sibling script,    │
│         nested by name: loopUntilDry() rounds, rotating       │
│         vendors, until two consecutive rounds come up dry     │
└─────────────────────────────┬─────────────────────────────────┘
                              ▼
┌───────────────────────────────────────────────────────────────┐
│ Report  gate(): writer drafts markdown from the findings      │
│         JSON, a DIFFERENT vendor reviews it against the data, │
│         rejected drafts rotate to the next vendor (≤3 tries)  │
│         + completenessCheck(): "what did we not cover?"       │
└───────────────────────────────────────────────────────────────┘
```

There is deliberately **no `checkpoint()`** here: every gate is another agent, so the
run needs no human from start to finish. (In a workflow that *applies* changes you
would put a `checkpoint()` before the irreversible step — see the SDK README.)

## What it demonstrates

| SDK / DSL surface | where |
|---|---|
| `openWorkflowDir` + `runDynamicWorkflow` (list saved workflows, run one by **name**) | `src/main.ts` |
| `exec` knobs: `tokenBudget`, `agentTimeoutMs`, `agentRetries`, `onProgress` | `src/main.ts` |
| Per-call **backend routing** (`model`) + bracket modifiers riding each agent's advertised options (`[xhigh]`/`[max]` effort ladders; `opus[1m]` selects Claude's catalog-encoded 1M-context variant) | the vendor pool in both scripts |
| **Read-only session modes** (`mode: "plan"` / `"read-only"`) on pinned calls | the vendor pool in both scripts |
| `pipeline()` (barrier-less multi-stage flow) + `parallel()` (verification panel) | `repo-triage.workflow.js` |
| Structured output via `schema`, placeholder guards in script code | both scripts |
| `gate()` produce-until-approved loop and exposed terminal `reportVerdict` | Report stage |
| `workflow()` nesting a saved sibling script by name | Hunt stage |
| `loopUntilDry()` unknown-size discovery | `quick-wins.workflow.js` |
| `completenessCheck()` final gap critic | Report stage |
| `phase()`, `log()`, `args` hardening (string-form args), `budget` guards | both scripts |
| Null-safe degradation (a failed agent resolves to `null`, the run continues) | Map, Sweep + Verify stages |

## Layout

```
repo-triage/
├── package.json                     # depends on @automatalabs/workflows from npm
├── src/main.ts                      # the SDK host: load by name, run, print, write report
└── workflows/
    ├── repo-triage.workflow.js      # Map → Sweep → Verify → Hunt → Report
    └── quick-wins.workflow.js       # nested by repo-triage; also runs standalone
```

## Prerequisites

1. **Node ≥ 22.**
2. **Backend auth** for the vendors in the pool: Claude via a logged-in Claude Code
   install or `ANTHROPIC_API_KEY`; Codex via `~/.codex/auth.json`; OpenCode via
   `opencode auth login` (its CLI must be installed). A degraded setup fails in
   well-defined ways, not mysteriously — but know the mechanics:
   - a **model id its backend doesn't list** logs a fallback line and the call runs
     on that backend's default model (never a different backend);
   - a backend whose **CLI is missing** fails its calls after retries (they resolve
     to `null`): the script skips that vendor's areas and returns findings whose
     jurors are all gone in `unverified` instead of `findings`;
   - a backend that is **installed but not authenticated pauses the run** with
     `authContext` (the host prints which backend) so you can log in and resume.

   For the full cross-vendor experience, edit the pool at the top of each script to
   the vendors you actually have.

## Run

```bash
cd packages/workflows/examples/repo-triage
npm install

npm start                                        # triage the nearest enclosing git repo
npm start -- --target /path/to/repo              # triage a specific checkout
npm start -- --max-areas 2 --hunt-rounds 0       # a smaller, cheaper run
npm start -- --focus "flaky async code and race conditions"
npm start -- --workflow quick-wins               # run the nested hunter standalone
```

All flags are documented at the top of `src/main.ts`. The confirmed findings, quick
wins, and stats print to stdout; the gated report lands in `triage-report.md` (override
with `--out`). The run result also exposes the terminal review as `reportVerdict`.
Exit code 0 = the run completed.

Runs are **unbounded by default** — an autonomous triage should finish, not die at an
arbitrary cap. Pass `--budget <tokens>` to set a hard cap and watch the budget support
APIs engage: the workflow checks `budget.remaining()`, skips the optional Hunt stage
to reserve headroom for the Report stage (logging why), and if the cap is hit anyway,
Report and the completeness critic degrade gracefully — the confirmed findings always
come back. Size caps generously: budget "spent" aggregates whatever the backends
report (input **and** output, cache reads included), so a capped run burns budget far
faster than output volume alone suggests.

## Validate before you run

```bash
npm run validate
```

Zero tokens, no agent processes: a static parse plus a dry run of **both** scripts in
the real engine realm against a mock backend (`--workflows-dir` is what lets the
nested `workflow("quick-wins")` call resolve). Do this after any script edit.

## Notes

- **This folder is a self-contained project.** Copy it out of the monorepo, `npm
  install`, and it works unchanged — the dependency comes from npm, not the workspace.
- **The vendor pool is yours to edit** (top of each workflow script). The three
  entries are peers; sweeps rotate through the pool and every finding is judged by
  the two vendors that did not produce it, so no agent family gets to approve its own
  blind spots. `mode` is strict per backend, so it is only set next to a pinned
  `model` (OpenCode mode ids are config-specific, hence unset there).
- **Why the scripts don't share code:** a workflow script is one self-contained
  string executed in a deterministic realm — no imports — which is also why the pool
  appears in both scripts.
- **Unattended failure semantics:** a recoverable agent failure resolves to `null`
  after retries; the script null-checks and degrades (falls back to a whole-repo
  sweep, skips a failed area, buckets juror-less findings as `unverified`, returns
  the last report draft unapproved) instead of dying. Pause-class errors — a
  provider quota wall, a backend needing auth — are deliberately **rethrown** by the
  script's catch blocks so the engine can pause the run resumably instead of faking
  a completion.
