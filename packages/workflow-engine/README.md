# @automatalabs/workflow-engine

The deterministic core that runs a workflow script. It is a **vm-realm script runtime**
plus a small DSL (`agent()`, `parallel()`, `pipeline()`, …), a resume journal, a token
budget, and optional git-worktree isolation. It drives subagents **only** through an
injected `AgentRunner` seam — it never imports or names a concrete agent backend.

> **Most users want [`@automatalabs/workflows`](../workflows).** That package wires this
> engine to the ACP backend (`@automatalabs/acp-agents`) for you, so `agent()` actually
> talks to a real coding agent. Reach for `@automatalabs/workflow-engine` directly only
> when you are building your own host and want to supply your own `AgentRunner`.

## Install

```bash
npm install @automatalabs/workflow-engine
```

ESM-only, Node 22+.

## The one thing you inject: `AgentRunner`

The engine references the backend through a single frozen method. Supply anything that
matches this shape (re-exported from `@automatalabs/shared-types`):

```ts
import type { AgentRunner, RunOptions, AgentResult } from "@automatalabs/workflow-engine";
import type { TSchema } from "typebox";

// Minimal stand-in. A real runner spawns/streams an agent; the ACP one lives in
// @automatalabs/acp-agents. With no `schema` the return is the assistant's text;
// with a typebox `schema` it is the parsed, validated object. Usage is reported
// out-of-band via options.onUsage — never in the return value.
const myRunner: AgentRunner = {
  async run<S extends TSchema | undefined = undefined>(
    prompt: string,
    _options?: RunOptions<S>,
  ): Promise<AgentResult<S>> {
    return `(stub) ${prompt}` as AgentResult<S>;
  },
};
```

## Minimal use

A workflow is a script whose **first statement** is `export const meta = {...}`; the rest
of the body runs inside the vm realm with the DSL injected as globals.

```ts
const script = `
export const meta = { name: "greet", description: "Summarize a topic" };
const draft = await agent(\`Write three bullet points about \${args.topic}.\`);
return draft;
`;
```

Run it through the manager (background tracking, pause/resume, terminal status):

```ts
import { WorkflowManager } from "@automatalabs/workflow-engine";

const manager = new WorkflowManager({ agent: myRunner });
const result = await manager.runSync(script, { topic: "otters" });
// result.status is always terminal: "completed" | "paused" | "failed" | "aborted"
console.log(result.status, result.result, result.tokenUsage);
```

Or call the bare engine function (no manager, no persistence layer):

```ts
import { runWorkflow } from "@automatalabs/workflow-engine";

const run = await runWorkflow(script, { agent: myRunner, args: { topic: "otters" } });
console.log(run.result, run.agentCount, run.durationMs);
```

`runWorkflow` returns the `EngineRunResult` (meta / result / logs / phases / agentCount /
durationMs / runId / tokenUsage). `WorkflowManager` stamps the terminal
`status` / `reason` / `resetHint` on top to produce a `WorkflowRunResult`.

## The script DSL

Inside a workflow body these are available as globals (no imports):

- `agent(prompt, opts?)` — run one subagent. `opts` includes `label`, `phase`, `schema`
  (typebox → validated object), `model`, `tier`, `agentType`, `isolation: "worktree"`,
  `mcpServers`, `timeoutMs`, `retries`. The single call into your `AgentRunner`.
- `parallel([() => agent(...), ...])` — run thunks concurrently (bounded by the run's
  concurrency limiter).
- `pipeline(items, stage1, stage2, ...)` — map each item through ordered stages.
- `workflow(nameOrScript, args?)` — run a saved/inline workflow inline (one level deep),
  sharing the parent run's caps and budget.
- `checkpoint(prompt, opts?)` — a deterministic, journaled human-in-the-loop gate
  (resolved via the host's `confirm`; takes its declared `default` when headless).
- Quality combinators built on the above: `verify`, `judgePanel`, `loopUntilDry`,
  `completenessCheck`, `retry`, `gate`.
- `phase(title, { budget? })`, `log(msg)`, and the read-only `args`, `cwd`, `budget`.

The realm is hardened for determinism: `Math.random()`, `Date.now()`, and `new Date()`
throw, so a re-run reproduces the journaled values. Pass any timestamps/randomness in via
`args`.

## Resume & token budget

Every `agent()` / `checkpoint()` result is journaled by a deterministic call index. Feed
the journal back (and the prior `runId`) to replay the unchanged prefix and only re-run
what changed:

```ts
const first = await runWorkflow(script, { agent: myRunner, args, onAgentJournal: save });
// ...later, after an edit or a usage-limit pause:
const resumeJournal = new Map(/* index -> { index, hash, result } */);
const again = await runWorkflow(script, { agent: myRunner, args, resumeJournal, resumeFromRunId: first.runId });
```

`tokenBudget` caps total spend (per-phase sub-budgets via `phase(title, { budget })`);
`maxAgents`, `concurrency`, `agentTimeoutMs`, and `agentRetries` bound the run. Defaults
are exported as `MAX_AGENTS_PER_RUN`, `MAX_CONCURRENCY`, `MAX_AGENT_RETRIES`, and
`DEFAULT_AGENT_TIMEOUT_MS`.

`WorkflowManager` persists run state under `~/.agentprism/workflows` by default. Hosts can
set `new WorkflowManager({ persistenceRoot: "/absolute/data/root" })`; when omitted,
`AGENTPRISM_PERSISTENCE_ROOT` is used, then the homedir default. The root must be absolute.
Hosts that own storage can instead pass `new WorkflowManager({ persistence })` with a custom
`RunPersistence`. Set `journaling: false` on the manager or per `runSync`/`startInBackground`
call when the host owns transcript storage. That mode writes no engine run-state/log journal
files and otherwise preserves run results, events, retries, status transitions,
cross-process leases, and listing of persisted runs written by other executions; resume is
intentionally unavailable and rejects with `journaling disabled for this run` for those runs.
The manager-level `journal` event still emits live `{ runId, entry }` observations when file
journaling is disabled.

## Key exports

From `@automatalabs/workflow-engine` (see `src/index.ts`):

- **Engine** — `runWorkflow`, `parseWorkflowScript`; types `EngineRunResult`,
  `WorkflowRunOptions`, `AgentOptions`, `CheckpointOptions`, `WorkflowAgentOptions`,
  `SharedRuntime`.
- **Manager & persistence** — `WorkflowManager` (`WorkflowManagerOptions`, `ExecOptions`,
  `ManagedRun`); `createRunPersistence`, `generateRunId`, and types `RunPersistence`,
  `RunLease`, `RunStatus`, `PersistedRunState`, `PersistedAgentState`, `FsLayer`.
- **Errors** — `WorkflowError`, `WorkflowErrorCode`, `isWorkflowError`, `wrapError`,
  `isProviderUsageLimit`, `classifyProviderLimit`, `isAbortError`, `isTimeoutError`.
- **Config caps** — `MAX_AGENTS_PER_RUN`, `MAX_CONCURRENCY`, `MAX_AGENT_RETRIES`,
  `DEFAULT_AGENT_TIMEOUT_MS`, `AGENTS_DIR`.
- **Model routing / tiers** — `parseModelRoutingFromMeta`, `resolveModelForPhase`,
  `buildDefaultTierConfig`, `loadModelTierConfig`, `saveModelTierConfig`,
  `resolveTierModel`, `sortedTierNames`, `getModelTierConfigPath`.
- **Agent registry** (`agentType` definitions) — `loadAgentRegistry`, `resolveAgentType`,
  `parseAgentDefinition`, `applyToolPolicy`, `agentDefinitionKey`, `listAgentTypes`.
- **Worktree isolation** — `createWorktree`, `removeWorktree`, type `Worktree`.
- **Display / snapshots** — `preview`, `renderWorkflowText`, `renderWorkflowLines`,
  `createWorkflowSnapshot`, `recomputeWorkflowSnapshot`, `statusIcon`, `shorten`.
- **Paths / logger / frontmatter** — `workflowProjectPaths`, `workflowHomeDir`,
  `workflowUserSavedDir`, `workflowProjectKey`, `createWorkflowLogger`, `parseFrontmatter`.
- **Seam re-exports** (from `@automatalabs/shared-types`) — `AgentRunner`, `RunOptions`,
  `AgentResult`, `AgentUsage`, `WorkflowMeta`, `WorkflowRunResult`, `JournalEntry`,
  `TokenUsage`, …

## License

Apache-2.0
