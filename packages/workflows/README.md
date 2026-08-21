# @automatalabs/workflows

The programmatic **SDK** for AgentPrism — run dynamic, multi-agent **workflow scripts**
(`agent()` / `parallel()` / `pipeline()` / …) over real coding-agent backends through the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP).

You author a small JavaScript **script** (a string), the engine runs it in a deterministic,
journaled, resumable realm, and every `agent()` call inside it is fanned out to a pooled ACP
backend — **Claude** (`claude-agent-acp`), **Codex** (`codex-acp`), **OpenCode** (`opencode acp`), **pi** (`pi-acp`),
or a registered custom ACP agent — driving the actual subprocess to completion.

This package is the **canonical SDK** that the stdio MCP server
[`@automatalabs/mcp-server`](https://www.npmjs.com/package/@automatalabs/mcp-server) is built on.
Its CLI can also delegate to a build-time embedded copy of that server with the `mcp` subcommand,
so an MCP host can expose the `workflow` and `repl` tools without a separate package install. The
standalone MCP server package remains independently published, while programs embedding the runner
continue to use this package's workflow/runner APIs.

The SDK itself remains a thin programmatic facade over the engine + ACP packages, with
ACP-defaulted helpers for ordinary runs (`runDynamicWorkflow`) and substitution tests
(`runIsolation`). The ACP layer also uses `@modelcontextprotocol/sdk` internally when it hosts the
optional StructuredOutput tool for eligible agents.

---

## Install

```bash
pnpm add @automatalabs/workflows
```

> The Claude, Codex, and pi ACP servers ship as transitive dependencies and are spawned on demand.
> OpenCode is host-resolved: install `opencode-ai` or make `opencode` available on `PATH` before
> routing a call to it.

---

## Requirements

- **Node.js ≥ 22.**
- **Backend auth** — the SDK spawns the ACP backend as a child process that inherits your
  `process.env`, so it uses whatever credentials those agents already use:
  - **Claude** — a logged-in Claude Code install (`~/.claude`) **or** `ANTHROPIC_API_KEY` in the
    environment.
  - **Codex** — a logged-in Codex install (`~/.codex`).
  - **OpenCode** — credentials configured for the provider OpenCode will use.
  - **pi** — a selected provider API key or credentials in `~/.pi/agent/auth.json`.

You only need auth for the backend(s) your scripts actually route to. The default backend is
Claude (override with `AGENTPRISM_DEFAULT_BACKEND`; see [Backend selection](#backend-selection)).

---

## Core API

### a) `runDynamicWorkflow(script, opts?)` — run a script to a terminal result

The one-call entry point. It builds a one-off `WorkflowManager` whose agent backend defaults to
`createAcpRunner()` and runs the script to a **terminal** `WorkflowRunResult`. It never throws for
an ordinary pause/fail/abort — read `result.status` directly.

```ts
import { runDynamicWorkflow } from "@automatalabs/workflows";

const script = `
  export const meta = {
    name: "repo-scan",
    description: "describe a repo as JSON, two ways in parallel",
    phases: [{ title: "Fan" }],
  };

  const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["repo", "fileCount"],
    properties: { repo: { type: "string" }, fileCount: { type: "number" } },
  };

  phase("Fan");
  log("scanning " + args.repo);
  return await parallel([
    () => agent("Report this repo as JSON {repo, fileCount}.", { label: "a1", schema: SCHEMA }),
    () => agent("Report this repo as JSON {repo, fileCount}.", { label: "a2", schema: SCHEMA }),
  ]);
`;

const run = await runDynamicWorkflow(script, { args: { repo: "agentprism" } });

run.status;      // "completed" | "paused" | "failed" | "aborted"
run.result;      // [{ repo, fileCount }, …] — the script's return value (schema-validated)
run.tokenUsage;  // { input, output, total, cost, … } | undefined
run.runId;       // stable id; pass back to resume a paused run from its journal
```

Options (`RunDynamicWorkflowOptions`):

| field    | type           | meaning |
|----------|----------------|---------|
| `args`   | `unknown`      | The value handed to the script's `args` global. |
| `cwd`    | `string`       | Base working directory for the run (e.g. the project root): every subagent session runs here (a per-agent `agent({ cwd })` or worktree isolation overrides it), worktrees branch from it, and `agentType` definitions are scanned from it. Omitted ⇒ `process.cwd()`. |
| `runner` | `AgentRunner`  | Swap the backend (or stub it in tests). Omitted ⇒ `createAcpRunner()`. |
| `exec`   | `ExecOptions`  | Per-run controls forwarded to the manager: total-wall-clock-per-attempt `agentTimeoutMs`, `concurrency`, `agentRetries`, `signal`, `onProgress`, `confirm`, `resumeFromRunId`, `resumePolicy`, `checkpointReplies`, … |
| `allowScriptBackends` | `boolean \| callback` | Approve the commands declared in `meta.backends`; declarations are inert without host approval. |
| `workflows` | `string \| string[] \| WorkflowDir` | Resolve the first argument and nested `workflow("name")` calls from one or more directories. |

```ts
const run = await runDynamicWorkflow(script, {
  args: { repo: "agentprism" },
  exec: {
    concurrency: 4,
    onProgress: (snapshot) => console.error(snapshot.doneCount, "/", snapshot.agentCount),
  },
});
```

Every script **must** begin with `export const meta = { name, description, phases? }` as its first
statement, and must be **deterministic** — `Date.now()`, `Math.random()`, and `new Date()` are
unavailable inside the realm (they would break journal replay on resume).

Completed reader/worktree calls both use ordinary journal replay:

```js
const [audit, experiment] = await parallel([
  () => agent("Audit src/api without changing files.", {
    label: "audit:api",
  }),
  () => agent("Try the worker fix in isolation; return a unified diff.", {
    label: "try:worker", isolation: "worktree",
  }),
]);
```

The worktree and edits are discarded; return the diff as data. Replay requires matching journal
identity/input facts, not a filesystem-safety declaration. See the
[incremental resume API](../../docs/api.md#content-addressed-incremental-resume).

### Substitution testing (isolation mode)

Record a normal managed run, then re-run its recorded script with one selected step live while all
other calls are served from the recording:

```ts
import { runIsolation } from "@automatalabs/workflows";

const isolated = await runIsolation({
  baselineRunId: recorded.runId,
  live: [{ label: "step-2", model: "codex/gpt-5.3-codex" }],
});

const target = isolated.report.calls.find((call) => call.mode === "live-target");
console.log(isolated.status, target?.recordedUsage, target?.liveUsage);
```

The SDK defaults the live runner to ACP and disposes it; pass `runner` to inject and retain your own.
See the [Isolation mode API](../../docs/api.md#isolation-mode) for baseline admissibility, target
selection, typed refusals, report semantics, and the lower-level `createReplayRunner` composition.

### b) `createAcpRunner().run(...)` — drive a single agent

Skip the script realm entirely and call one agent directly. The runner is the default ACP
`AgentRunner`. With a `schema`, `run()` returns the **validated object**; without one, it returns
the assistant's final **text**.

```ts
import { createAcpRunner } from "@automatalabs/workflows";

const runner = createAcpRunner();           // optional: { size } pool option, default 1
try {
  const data = await runner.run("Summarize this repo as JSON {summary}.", {
    schema: {
      type: "object", additionalProperties: false,
      required: ["summary"], properties: { summary: { type: "string" } },
    },
    model: "claude/opus[1m]", // registered prefix routes; the remaining id is verbatim
    cwd: process.cwd(),     // absolute working dir for the agent's session
  });
  // data is the schema-validated object (not text)

  const text = await runner.run("Name this repo in one word.");  // no schema ⇒ string
} finally {
  await runner.dispose();   // close the pooled backend processes when you're done
}
```

`run(prompt, options?)` accepts the seam's `RunOptions`: `schema`, `maxSchemaRetries`, `model`, `mode`, `configOptions`, `tier`, `cwd`,
`instructions`, `label`, `toolNames` / `disallowedToolNames`, `signal`, `mcpServers`, `images`,
`backends`, `meta` / `promptMeta` (generic ACP `_meta` passthroughs merged into `session/new` /
`session/prompt`), `baseInstructions` / `developerInstructions` (Codex-only), `keepSession`, and
the out-of-band callbacks `onUsage` / `onModelResolved` / `onModelFallback` / `onHistory` /
`onSessionOpen`. Token/cost usage is delivered via `onUsage` (it may never fire — ACP usage is
experimental), never via the return value.

> **Codex session instructions.** When the run routes to the Codex backend, `baseInstructions`
> **replaces** Codex's built-in base system prompt and `developerInstructions` adds developer-role
> instructions for the session. They ride ACP `session/new` `_meta` into Codex `thread/start` and
> are **ignored by the Claude backend** (which has no analog) — unlike `instructions`, which is
> folded into the prompt text for either backend.
>
> ```ts
> await runner.run("Cut the release.", {
>   model: "codex/gpt-5.6-sol",
>   baseInstructions: "You are a release bot. Only touch CHANGELOG.md.",
>   developerInstructions: "Prefer conventional-commit summaries.",
> });
> ```

> The ACP server **process** is pooled and reused across `run()` calls; each `run()` opens and
> closes one **session** on it. Call `dispose()` once at shutdown to tear the pool down. Pool size
> is `AcpPoolOptions.size` (default 1) or `AGENTPRISM_ACP_POOL_SIZE`.

> **Custom backends.** Any ACP agent can serve `run()` / `agent()` calls — register it by name and
> route to it with `model`:
>
> ```ts
> const runner = createAcpRunner({
>   backends: { browser: { command: "node", args: ["/abs/browser-acp.js"] } },
> });
> await runner.run("Verify the checkout flow.", { model: "browser" });
> ```
>
> `model: "browser/vision-large"` additionally sends exactly `vision-large` as the agent's model
> config option. The same registry can be declared via `AGENTPRISM_BACKENDS` (JSON env var; the
> programmatic option wins per name). A `schema` is forwarded as turn-level `_meta.outputSchema`
> and embedded in the prompt. Eligible HTTP-MCP agents also receive the client-hosted
> `StructuredOutput` capture tool; otherwise the result is JSON-parsed from the final message.
> Every path still goes through the validate/re-prompt ladder.
>
> A workflow **script** can also declare backends itself via `meta.backends` (same config shape,
> keyed by name). Because script-declared backends spawn commands on your machine, they are inert
> unless you approve them: pass `allowScriptBackends: true` to `runDynamicWorkflow`, or a callback
> `(backend) => boolean | Promise<boolean>` to decide per backend — an unapproved declaration
> throws with guidance, and a declined backend aborts the run (it would otherwise silently reroute
> its `agent()` calls to the default backend). Host-registered names always win over script
> declarations. Lower-level callers can thread a pre-approved registry via `exec.scriptBackends`.

#### Authentication lifecycle

`createAcpRunner()` is auth-capable. It exposes `describeAuthMethods()` / `completeAuth()` and the
`runner.auth` controller (`status`, `authenticate`, `logout`) while preserving the minimal
`AgentRunner.run()` seam. Existing environment variables and backend-native credential stores are
used normally. A direct `runner.run()` throws `WorkflowError { code: "AUTH_REQUIRED" }` when no
resolver can satisfy the backend; a `WorkflowManager` catches that code and returns a resumable
`paused` result with redacted `authContext`.

Pass `onAuth` and `authCapabilities` to `createAcpRunner()` when the embedding host can collect
credentials inline. Secret env/meta resolutions live in the runner's in-memory auth store, are
redacted from events/errors, and are cleared on logout. Browser/TTY methods still require a host
that can actually complete them.

### c) `WorkflowManager` — stateful / resumable runs

`runDynamicWorkflow` is a thin wrapper over a fresh `WorkflowManager`. Construct one yourself to
keep run state across calls, persist journals, and **resume** a paused run.

```ts
import { WorkflowManager, createAcpRunner } from "@automatalabs/workflows";

const manager = new WorkflowManager({ agent: createAcpRunner() });

const run = await manager.runSync(script, { repo: "agentprism" });

const background = manager.startInBackground(script, { repo: "agentprism" });
console.log(background.runId, manager.getSnapshot(background.runId));
// background.promise resolves only on completion and rejects on pause/failure/abort.

// Settle one runaway agent to null without aborting the run or retrying that call.
await manager.cancelAgentCall(background.runId, 4);

const status = manager.inspectRun(run.runId, {
  lastN: 10,
  labelGlob: "review-*",
  logLines: 20,
});
console.log(status?.status, status?.logTail, status?.calls);

if (run.status === "paused") {
  // resume() reloads the original script, args, cwd, and journal under the SAME runId,
  // then continues in the background. Observe manager events or getRun(runId) for status.
  const accepted = await manager.resume(run.runId);
  console.log(accepted); // true when the paused run was accepted for resume
}

// Edited-script/current-args resume is a NEW managed run with a correspondence report.
const next = await manager.runSync(script, { repo: "agentprism", expanded: true }, {
  resumeFromRunId: run.runId,
  resumePolicy: "auto",
});
console.log(next.runId, next.replayEligibility, next.resumeReport);
```

`runSync(script, args?, exec?)` always resolves to a terminal `WorkflowRunResult`. A run **pauses**
(rather than fails) on a provider usage limit, ACP authentication requirement, or an explicitly
durable checkpoint. An auth pause carries `reason: "auth_required"` plus a non-secret `authContext`;
complete auth on an auth-capable runner before resuming. A checkpoint with a live `ExecOptions.confirm`
resolves immediately; without one, the default mode still takes `default ?? true` and
`headless: "abort"` aborts. Only `headless: "pause"` returns `reason: "checkpoint_required"` plus
`checkpointContext`; resume with `checkpointReplies: { [context.callIndex]: decision }` (or a live
`confirm`). The injected answer is journaled and replayed, so a detached run never pauses for a
checkpoint unless the author opts in. `checkpointReplies` works with the default `"auto"` policy;
it does not require `resumePolicy: "positional"` or any other particular policy. The supplied JSON
decision is returned verbatim from `checkpoint()` (`kind: "confirm"` therefore normally receives a
boolean).

Resume guarantees journal/script replay integrity and checkpoint-reply targeting only. It never
assumes or guarantees that the filesystem, external systems, agent output semantics, or any other
part of the world stayed fresh between runs. If a prior correspondence miss runs live, a supplied reply is
injected only when execution reaches the exact recorded checkpoint call site with the same
checkpoint identity and inputs; content-only matching is insufficient after that live prefix. A
reply that is not applied is reported in `resumeReport` and terminal summaries. Authors who want a
decision bound to changing content should interpolate that content into the checkpoint prompt so it
participates in the checkpoint's hashed replay identity and a divergence re-asks instead of
injecting.

`WorkflowManagerOptions` lets you set a default `agent`, `concurrency`, `cwd`, a
`loadSavedWorkflow` resolver (enables nested `workflow('name')`), a custom `persistence`
implementation, and per-agent timeout/retry defaults.

A finite run-level `agentTimeoutMs` is the ceiling for every attempt. Script-level `timeoutMs` may
tighten it but cannot raise or disable it; without a host ceiling, per-call `null`/omission is
uncapped. The clock covers total attempt wall time rather than idle time. Retries each get a fresh
clock, so the maximum envelope is `(resolved retries + 1) × resolved timeout` (retries are clamped
at 3). After the final timeout, the call resolves to `null` with recoverable `AGENT_TIMEOUT`,
releases its concurrency slot, and the ACP runner closes/recycles a backend session that ignores
cancellation.

`cancelAgentCall(runId, callIndex)` is the stateful host seam for a single live attempt. It returns
`WorkflowAgentCallCancellation` after the failed record and agent-end state are committed, while
the script receives `null` and siblings continue. `AGENT_CANCELLED` never retries, never sets the
run's abort state, and never creates a journal result; inspect exposes the error and a later resume
runs that occurrence live. A missing, settled, checkpoint, or duplicate scoped index errors with
the currently in-flight call-index/label pairs.

Usage-limit and auth resumes are continuation-aware by default on both `resumeFromRunId` and
same-ID `resume()` / `resumeInBackground()`: when the interrupted root call's index, identity hash,
full execution-input fingerprint, backend identity, cwd, and reopen support still agree, the manager
reattaches its recorded ACP session and continues the unfinished turn. Worktree calls, changed or
legacy inputs, missing cwd, and every uncertain/rejected reopen run fresh. This is internal manager →
engine plumbing; the public SDK accepts no continuation option.

Every terminal result may also carry `fallbacks` (including `kind: "continuation"` notices that
record a reattached `resume`/`load` method or an exact skip reason) and `checkpointsTaken` (one
resolved checkpoint per call with the journaled decision and `live` / `headless-default` /
`journal-replay` / `injected` source). They are absent when empty, persist for cold reads, never
enter replay hashes, and are not part of `WorkflowRunStatus` inspection.

`startInBackground(script, args?, exec?)` is detached only for the lifetime of this process and
returns `{ runId, promise: Promise<WorkflowRunResult> }`. The facade keeps an ACP event bridge for a
per-execution `exec.agent` until that promise settles, including rejection. Read live state with
`getRun()`, `getSnapshot()`, or `inspectRun()`, and subscribe to cumulative `tokenUsage` events while
work is running. Live attempts update `snapshot.tokenUsage` monotonically; replayed calls add zero.
Run results expose `effectiveLimits`; inspect status exposes the same values as `limits`, and failed
agent rows carry their resolved `timeoutMs` plus `errorCode`.

`exec.resumeFromRunId` asks the manager to admit a terminal source, persist a self-contained seed
under a new run ID, and match completed calls by exact path/hash or unique hash+input fingerprint.
Every allocated call receives a terminal manifest row even when the run halts around it. A
non-result occurrence remains live on resume and stays in the identity seed as an ambiguity
blocker until reached, so completed siblings on either side can replay. Uncertain,
ambiguous, or mismatched calls run live. Filesystem/current-environment and Node/V8 differences are
reported as provenance without changing admission or matching. Identity hits preserve the recorded per-call provenance while adding zero current provider usage;
replayed session records are rebound to the current call index/label/phase. `resumePolicy: "positional"` requests
index/prefix matching but cannot bypass new-format format/metadata/manifest/input checks. The distinct
same-ID `resume()` and low-level `resumeJournal` paths remain permanently legacy positional and
emit no `resumeReport`. See the [full contract](../../docs/api.md#content-addressed-incremental-resume).
Operational limits are resolved from the new execution's `exec` options and manager defaults, not
copied from the source run; pass the desired timeout/retry/concurrency values again. Host
`agentTimeoutMs`, `agentRetries`, and `concurrency`, plus per-call `timeoutMs` and `retries`, enter
neither replay identity nor the execution-input fingerprint and may change without invalidating
completed calls or interrupted-turn continuation.

Current-format crash snapshots reconciled to `paused` / `interrupted` use identity correspondence
even without terminal-environment capture. Sources with an input-fingerprint format below 2 use the
`inputs-format-legacy` positional bridge. That bridge also accepts ancestor-scoped rows carried by a
≤0.23 resume hop when the ancestor run still exists in the same persistence directory; nested and deleted-run scopes stay live. Engine
package versions are persisted and surfaced as diagnostics but never gate replay. Every new-run
resume exposes `WorkflowReplayEligibility` on the foreground result and inspection status: strategy,
an admission-time upper bound and the observed replayable prefix, counts, the first non-replay when known, source/current
engine and input-format versions, non-gating runtime/environment provenance changes, and operational changes.

The manager's critical initial save contains the complete inherited seed before a background
acknowledgement. A manager-prepared `resumeFromRunId` hit re-journals the selected value under its
current target index; same-ID/manual legacy cache hits retain the historical no-journal-callback
behavior and rely on the already-seeded prefix. Each new run is independently resumable across
multiple pause/resume hops. Process loss can stop in-flight work; construction and cold
inspect/list/resume lookups reconcile a dead owner's durable `pending`/`running` record under its
lease to `paused` with `pauseReason: "interrupted"`. An unjournaled in-flight call may run again.

`inspectRun(runId, options?)` is inherited through this facade and returns the shared
`WorkflowRunStatus` without importing `@automatalabs/workflow-engine`. It reads the freshest live
snapshot first and project-scoped persistence second and never executes the script. A cold
`pending`/`running` row may take a short reconciliation lease when its owner is dead; other rows are
not changed. It returns `undefined` for an unknown/unreadable ID. The facade also re-exports
`WorkflowRunInspectionOptions`, `WorkflowLogTail`, `WorkflowRunCallStatus`,
`WorkflowRunStatusTruncation`, `WorkflowRunStatus`, and `JournalCallMetadata`. Inspection defaults
to 20 calls and 20 log lines, supports case-sensitive whole-label `*`/`?`/backslash globs, redacts
and compacts previews, and enforces the shared 24,576-byte structured cap. Non-completed terminal
execution results carry an immediate redacted final-20 `logTail`; completed results omit it.

Manager events are Node `EventEmitter` notifications: `agentStart`, `agentEnd`, `agentHistory`,
`agentProgress`, `agentTranscript`,
`journal`, `tokenUsage`, `log`, `phase`, `complete`, `paused`, `resumed`, `stopped`, `error`,
and `agentEvent`. Their overloads infer exact payloads from `EngineRunEventPayloadMap` and
`WorkflowAgentEventPayloadMap`; `WorkflowRunEvent` is the exhaustive union when a host wants one
dispatcher. Every engine event carries the owning root `runId` and originating engine `scope`.
`journal` emits `{ runId, scope, entry }` for each live journal append, even when file journaling is
disabled via `journaling: false`.

For journaling ACP runs, `agentProgress` provides redacted content while a call is still running
(immediate first sample, one-second activity sampling, and content-bearing heartbeats), and
`agentTranscript` provides execution-partitioned assistant/tool upserts before settlement. Both use
the same durable JSONL cursor as lifecycle events; terminal run JSON and `agentHistory` keep their
existing finalization semantics. The facade also exports `workflowAgentEventSource(runner)` so an
eval or telemetry sink can share the one raw ACP subscription without reparsing provider traffic.

An MCP client tails the same stream without holding the originating tool request:

```ts
const uri = `workflow://runs/${runId}/events`;
await client.subscribeResource({ uri });
const tail = JSON.parse(resourceText(await client.readResource({ uri })));
const catchUp = `${uri}?after=${tail.cursor}&limit=1000&streamId=${tail.streamId}`;
```

```ts
import {
  WorkflowManager,
  createAcpRunner,
  type EngineRunEventPayloadMap,
  type WorkflowRunEvent,
} from "@automatalabs/workflows";

const manager = new WorkflowManager({ agent: createAcpRunner() });

const onAgentEnd = (event: EngineRunEventPayloadMap["agentEnd"]) => {
  console.error(event.scope, event.callIndex, event.label, event.result);
};
manager.on("agentEnd", onAgentEnd); // the overload infers the same payload without annotation

const target = { scope: "build-abc-nested1", callIndex: 3 };
manager.on("agentEvent", (event) => {
  if (event.scope === target.scope && event.callIndex === target.callIndex) {
    renderAcpUpdate(event.name, event.event);
  }
});

function consumeEvent(event: WorkflowRunEvent): void {
  switch (event.type) {
    case "phase":
      console.error(event.scope, event.title);
      break;
    case "agentEvent":
      console.error(event.scope, event.callIndex, event.name);
      break;
    default:
      break;
  }
}
```

`agentEvent` forwards the live ACP stream from an ACP-capable runner with `name`, `event`, and the
runner context fields (`runId`, `scope`, `callIndex`, `label`, `sessionId`, `backendId`) when present.
`scope` repeats the runner's originating engine `runId`, so nested calls filter directly on
`(scope, callIndex)`. Direct runner/interactive sessions can omit `callIndex`; `backend_error` is
connection-scoped and carries `backendId` only. ACP `session/update` traffic is emitted once under
its inner discriminant name, while permission/elicitation/session/raw/backend events keep their
runner names.

Every live ACP-backed `agent()` call records a non-secret re-attach handle in
`run.agentSessions`. Set `agent(..., { keepSession: true })` to skip release-time `session/close`,
then use the runner's `loadSession()` or `resumeSession()` host API with that record. Session
handles are additive and are also preserved in journals; pause-class failures skip `session/close`
automatically, and eligible managed resumes consume the recorded handle internally. A continued
result carries a diagnostic journal marker, but neither the handle nor marker changes deterministic
resume identity.

### d) Bring your own backend — implement the `AgentRunner` seam

`AgentRunner` is the single, frozen coupling point between the engine and any backend. Implement
its one method and inject it anywhere a runner is accepted (`runDynamicWorkflow({ runner })`,
`new WorkflowManager({ agent })`, or `runSync(script, args, { agent })`).

```ts
import {
  runDynamicWorkflow,
  type AgentRunner,
  type RunOptions,
  type AgentResult,
} from "@automatalabs/workflows";
import type { TSchema } from "typebox";

const echoRunner: AgentRunner = {
  async run<S extends TSchema | undefined>(prompt: string, options?: RunOptions<S>) {
    // schema present ⇒ return the validated object; absent ⇒ return text.
    options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
    return `echo: ${prompt}` as AgentResult<S>;
  },
};

const run = await runDynamicWorkflow(script, { runner: echoRunner });
```

Seam contract (summarized): `run()` returns the **raw** value (schema ⇒ validated object, no schema
⇒ string) — never an envelope; usage flows out-of-band via `options.onUsage`; on failure **throw**
(ideally a `WorkflowError` so `instanceof` holds across packages); honor `options.signal` but do
**not** implement your own timeout (the engine owns timeout/abort). This makes the SDK fully
testable without a live agent — pass a stub runner.

---

## Loading workflows from folders — `openWorkflowDir`

Integrators who keep a versioned folder of workflow scripts don't need to hand-roll
`readFileSync` plumbing or a `loadSavedWorkflow` resolver:

```ts
import { openWorkflowDir, runDynamicWorkflow } from "@automatalabs/workflows";

const flows = openWorkflowDir("./workflows");        // or ["./workflows", teamDir] — first hit wins

flows.list();               // [{ name, file, meta }] — meta parsed per call, browsable by a UI
flows.read("review-pr");    // name → script string; throws with searched dirs + did-you-mean
flows.resolve;              // (name) => string | undefined — IS a loadSavedWorkflow resolver

const run = await runDynamicWorkflow("review-pr", {  // a NAME works when `workflows` is set
  workflows: flows,                                  // also accepts "./workflows" or [dir, dir]
  args: { pr: 42 },
});
```

Semantics worth knowing:

- **Construction does no I/O** — nothing is created, nothing is scanned or cached. Every method
  reads the filesystem at call time, so a long-lived view always reflects the current working
  tree (a cached scan would serve stale scripts after a `git checkout`/pull/save). Missing
  directories simply contribute nothing.
- **The filename stem is the name** (`review-pr.workflow.js` or `review-pr.js` ⇒ `review-pr`),
  mirroring the agentType registry convention; across dirs the first hit wins, within a dir
  `.workflow.js` beats `.js`.
- **`workflows` also wires nested calls**: with the option set, `workflow("<name>")` inside the
  script resolves from the same view. (Without it, `runDynamicWorkflow` has no saved-workflow
  resolver and nested names cannot resolve.) A top-level string containing `export const meta`
  is always treated as a verbatim script, never a name.
- **Versioning is git's job.** Same-ID `resume()` reloads the exact persisted script. A new
  `resumeFromRunId` execution can use an edited script: changed calls run live, while uniquely
  matching completed calls may move and replay after admission.
- **`resolve()` validates name shape strictly** (one flat path segment) — inline nested scripts
  fall through to verbatim parsing, and path traversal out of the configured dirs is impossible.

---

## Listening in on the live ACP stream (events)

`createAcpRunner()` returns an `AcpAgentRunner` with a **typed event bus**. Subscribe with
`runner.on(name, listener)` to observe the live ACP stream of every run on that runner — streaming
assistant text, tool calls, usage, permissions — without touching the `run()` return value or the
`AgentRunner` seam.

```ts
import { createAcpRunner } from "@automatalabs/workflows";

const runner = createAcpRunner();

// ACP `sessionUpdate` discriminants are the event names; the listener payload is typed to each.
runner.on("agent_message_chunk", (e) => {
  if (e.content.type === "text") process.stdout.write(e.content.text); // stream tokens as they land
});
runner.on("tool_call", (e) => console.error(`[${e.label}] tool: ${e.title}`));
runner.on("usage_update", (e) => console.error(`ctx ${e.used}/${e.size} tokens`));

// One catch-all for "everything": fires for EVERY session/update, carrying the raw update.
const off = runner.on("session_update", (e) => console.error(e.update.sessionUpdate));

await runner.run("Refactor this module and run the tests.", { label: "refactor", cwd });
off(); // on()/once() return an unsubscribe thunk; off(name, listener) and removeAllListeners() also exist
await runner.dispose();
```

**Event names.** The ACP `sessionUpdate` discriminants verbatim — `user_message_chunk`,
`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`,
`plan_update`, `plan_removed`, `available_commands_update`, `current_mode_update`,
`config_option_update`, `session_info_update`, `usage_update`, and (ACP schema 1.21.0, UNSTABLE)
`compaction_update`, `compaction_summary_chunk` — plus a few cross-cutting events:

| event | payload |
|-------|---------|
| `session_update` | `{ update }` — catch-all for **every** update, regardless of kind |
| `permission_pending` | `{ request }` — resolver-only; emitted after the request is parked and before the resolver is invoked |
| `permission_request` | `{ request, outcome }` — the final permission outcome returned to the agent |
| `elicitation_pending` | `{ request }` — resolver-only; emitted after the elicitation is parked and before the resolver is invoked |
| `elicitation_request` | `{ request, outcome }` — the final elicitation response returned to the agent |
| `elicitation_complete` | `{ notification }` — a URL elicitation completion notification |
| `raw_message` | `{ method, message }` — a vendor extension notification (e.g. Claude `_claude/sdkMessage`) |
| `steering` | `{ outcome }` — a resolved live `_session/steering` response; prompt content and request metadata are never emitted |
| `session_open` / `session_close` | an ACP session opened / was released |
| `backend_error` | `{ backendId, error }` — a pooled backend process crashed |

**Context envelope.** A pooled runner multiplexes many concurrent runs over one process, so every
event (except `backend_error`) carries `{ sessionId, backendId, label?, runId?, callIndex? }`.
`callIndex` echoes the optional `RunOptions.callIndex` used to open the session and is never sent on
the ACP wire. Engine-created calls supply it; direct/interactive runner callers may omit it.

**Best-effort.** Listeners are observers: a throwing listener is isolated and never breaks the run,
the update drain, or sibling listeners.

**With `runDynamicWorkflow` / `WorkflowManager`.** Subscribe at the manager layer:
`manager.on("agentEvent", ({ scope, callIndex, name, event }) => …)`. Every `agent()` call in the
script then streams live ACP events through the manager; the bridge sets `scope = runId` and repeats
the optional `callIndex` for direct call filtering. ACP `session/update` traffic is forwarded once
under `name = event.sessionUpdate`, so hosts do not receive both the catch-all and the
per-discriminant runner event.

---

## The in-script DSL

The orchestration primitives are **not importable symbols**. They are **globals injected into the
script's `vm` realm**, available only **inside** the script string you pass to
`runDynamicWorkflow` / `runSync`. There is nothing to import to obtain them. Their shapes are
documented for editor IntelliSense by the **ambient `dsl.d.ts`** shipped with this package (it
ships no runtime code).

| global | what it does |
|--------|--------------|
| `agent(prompt, options?)` | Run ONE subagent to completion; returns its result (text, or the validated object with `options.schema`). The legacy `options.resume` annotation is accepted but replay-neutral. |
| `parallel(thunks)` | Run an array of **thunks** (`() => Promise`) concurrently; resolves in input order. |
| `pipeline(items, ...stages)` | Map `items` through sequential async stages, concurrently across items. |
| `workflow(nameOrScript, args?)` | Run a saved (or inline) workflow nested in this run, sharing its limiter. |
| `verify(item, options?)` | Adversarial verification panel — N reviewers vote whether `item` is real/correct. |
| `judgePanel(attempts, options?)` | LLM-judge panel — score candidates against a rubric, return the best. |
| `loopUntilDry(options)` | Repeat a round, collecting deduped new items until it dries up. |
| `completenessCheck(args, results)` | Ask a critic what is still missing. |
| `retry(thunk, options?)` | Bounded retry until `until(result)` holds. |
| `gate(thunk, validator, options?)` | Validate-and-feed-back loop returning `{ ok, value, verdict, attempts }`; `verdict` is the raw last validator return on either pass or exhaustion. |
| `checkpoint(text, options?)` | Deterministic, journaled human gate: live confirm, headless default/abort, or opt-in durable `headless: "pause"`. |
| `phase(title)` | Open a named phase. |
| `log(message)` | Append a line to the run log. |
| `args` | The input bag passed in via `{ args }`. |

(`console.log/info/warn/error` route to `log` too.) Pass these primitives **thunks**, not
promises — `parallel([() => agent("a"), () => agent("b")])`, not `parallel([agent("a"), …])`.

---

## Validating scripts — `agentprism-workflows validate`

The package ships a bin that validates a workflow script **without spending tokens**:

```bash
npx @automatalabs/workflows validate my-workflow.js --args '{"target":"src/"}'
```

Three passes: a **static parse** (the `meta` literal, syntax, and direct nondeterministic call
expressions), then a **dry run** — the script executes in the real engine realm while every
`agent()` call is served by an in-process mock `AgentRunner` that fabricates schema-conforming
results. The dry run catches what a parse can't: thunk-vs-promise mistakes, reference errors,
broken plumbing between calls. Finally, validation opens one no-prompt session for every distinct
routed `{ backend, model }` pair, selects that call's model verbatim when one was authored, surfaces
the echoed model-specific config-option catalog, and checks every authored `configOptions` bag
against it. This probe uses zero tokens. A pair that cannot spawn, authenticate, select its model,
or open a session contributes one warning and `probed:false`; only that pair's option checks are
skipped, so probe failure alone never invalidates the script. There is no cached catalog or opt-out
flag.
A mock live confirm answers checkpoints with `default ?? true`, so `headless: "pause"`
dry-runs cleanly; `headless: "abort"` warns because a truly unattended run would abort.
Script-declared `meta.backends` are treated as approved (with a warning that real runs require
approval). The report lists every agent call with its backend attribution and `configOptions`
echo, every checkpoint, the full option table for every routed backend/model pair (even when no call authors
options), and warnings. Unknown ids, invalid select values, non-boolean boolean values, and the
reserved `"model"` id make the report invalid with exit code `2`; each diagnostic names the call,
authored value, and advertised alternatives. For select options carrying
`_meta["@automatalabs/agentprism"].recognizedValues`, a supported value passes, an unsupported but
recognized value passes with a warning naming the effective clamp target, and an unrecognized value
is invalid. Pi's `thinkingLevel` option publishes this metadata from Pi's own ordered domain and
therefore needs no extra probes. For an ordered built-in that omits the metadata (Claude or Codex),
validation reads its advertised model picker, probes each selectable model through the same
per-`{ backend, model }` cache, merges consistent per-model thought-level orders, and applies the
same recognized-value/clamp path. Claude models that omit `effort` do not inherit another model's
option, and its `default` sentinel is recognized but excluded from ceiling ordering. Enumeration is
skipped, with a warning, when a picker advertises more than 32 models or the orders cannot be merged.
OpenCode and custom/unknown backends are exact-set: an unadvertised thought-level value is invalid
instead of clamping. Exit codes are `0` valid, `1` parse failure, `2` dry-run or config-option failure,
`3` usage error.

Flags: `--args <json>` / `--args-file <path>`, `--workflows-dir <dir>` (repeatable — validate by
NAME and resolve nested `workflow("<name>")` calls from your folder), `--parse-only`,
`--cwd <dir>`, `--max-agents <n>`, `--timeout-ms <n>`, `--mock-answers <json>`,
`--mock-answers-file <path>`, `--json`. The two mock-answer flags are mutually exclusive.

Mock answers select the final resolved agent label with case-sensitive, whole-label globs: `*`
matches any characters (including `:` and `/`), `?` matches one character, and `\` escapes the
next character. Rules are captured once in object-member order and the **last matching rule wins**,
so put broad defaults before narrow exceptions. Raw canonical array-index property names (`"0"`
through `"4294967294"`, with no leading zero) are rejected because JavaScript reorders them;
escape a digit to match a numeric label, for example the JSON key `"\\10"` matches label `10`.
`"01"` and `"4294967295"` are ordinary keys.

A rule is either one reusable JSON answer or `{ "$sequence": [...] }`, a finite sequence consumed
only when that rule wins. A raw JSON array is one array-valued answer. Each schema-bearing answer
deep-merges over a fresh `fabricateFromSchema()` base: objects merge recursively, while arrays,
`null`, scalars, and falsy primitives replace. The merged value is checked without coercion. Any
answer-caused schema violation fails with `SCHEMA_NONCOMPLIANCE`; an identical failure inherited
from an untouched limitation of the simple fabricator may be accepted with a grouped warning.
Schema-less answers must be nonblank strings. Sequences never repeat or fall back: exhaustion fails
the dry run, while unconsumed singles/items remain non-fatal and appear in structured `unused`
records plus grouped warnings. Supplying mock answers serializes dry-run agent service for stable
FIFO sequence allocation, so this mode is not a concurrency/load simulator.

Fixture input is capped at 256 KiB (raw CLI UTF-8 and canonical programmatic JSON), 256 rules,
256 UTF-16 code units per glob, 256 sequence entries, and answer nesting depth 32. Values must be
plain JSON data. Reports and fixture errors expose only globs, counters, positions, and schema
diagnostics—not answer bodies. A fixture is still handed to workflow code like a real agent result,
so the script can deliberately expose it through `log()` or its return value; do not put credentials
or production data in mock-answer files.

The same check is available programmatically. Invalid workflow scripts still resolve to reports;
an invalid `mockAnswers` option is an option-contract error and throws `TypeError` before parsing:

```ts
import { validateWorkflowScript, type MockAnswers } from "@automatalabs/workflows";

const mockAnswers: MockAnswers = {
  "*": { approved: true },
  "refute:*": { real: false },
  "quality:review": {
    $sequence: [
      { ok: false, feedback: "exercise the revision path" },
      { ok: true },
    ],
  },
};
const report = await validateWorkflowScript(script, { args: { target: "src/" }, mockAnswers });
report.ok;                 // parse ok AND dry run completed
report.dryRun?.agentCalls; // calls include mockAnswer: { glob, sequenceIndex?, sequenceLength? }
report.dryRun?.harnessOptions;
// [{ backendId, model?, probed, options?: SessionConfigOption[], error?: string }]
report.dryRun?.mockAnswers;// normalized rule counters + item-level unused records
report.warnings;           // approval reminders, phase mismatches, headless-abort checkpoints, …
```

---

## Discovering harness options — `agentprism-workflows config`

Validate's sibling command runs the same no-prompt config probe **standalone** — no script
required — so `model` / `configOptions` values can be read off the live catalog before a
workflow exists:

```bash
npx @automatalabs/workflows config                  # every routable harness
npx @automatalabs/workflows config codex opencode   # only the named harnesses
npx @automatalabs/workflows config claude --json    # machine-readable report
```

Harness names are the routing names: built-in `claude` / `codex` / `opencode` / `pi` plus any custom
backend registered via `AGENTPRISM_BACKENDS` (registered customs also join the no-argument
default set). Each harness opens one session without a prompt — zero tokens — and reports its
advertised config-option catalog: model ids (including bracket variants), effort
levels, modes, boolean knobs. A harness that cannot spawn or authenticate reports
`probed: false` with the reason and never blocks the others. Flags: `--cwd <dir>` (probe
session cwd; default the current directory), `--timeout-ms <n>` (per-harness bound, default
60000), `--models[=<filter>]`, `--json`. Exit codes: `0` all probed, `1` at least one probe
failed, `3` usage error.

A harness with a large model catalog (pi, opencode advertise hundreds) has its `model` choices —
any select above ~24 leaves — collapsed to a grouped summary (total + per-provider/group counts)
on BOTH the human table and `--json`, so neither floods context; small catalogs (claude, codex)
print in full. The leaves are reachable only through `--models`: bare prints the provider/group
breakdown, `--models=<provider|substring|/regex/>` prints the matching leaf ids. There is no
unfiltered full-leaf dump on any surface.

Programmatic:

```ts
import { probeHarnessConfig, formatHarnessConfigReport } from "@automatalabs/workflows";

const report = await probeHarnessConfig({ harnesses: ["codex"] });
report.ok;             // every requested harness probed
report.harnessOptions; // [{ backendId, model?, probed, options?: SessionConfigOption[], error?: string }]
formatHarnessConfigReport(report); // the CLI's human table
```

`probeHarnessConfig({ harnesses?, backends?, cwd?, timeoutMs? })` — `backends` merges over
`AGENTPRISM_BACKENDS` exactly like `createAcpRunner({ backends })`.

---

## Launching the MCP server — `agentprism-workflows mcp`

Register the bundled MCP entry directly from the workflows package; no separate
`@automatalabs/mcp-server` installation is required:

```json
{
  "mcpServers": {
    "agentprism-workflow": {
      "command": "npx",
      "args": ["-y", "@automatalabs/workflows", "mcp"]
    }
  }
}
```

By default `mcp` runs a thin **stdio shim** that proxies to the shared local **workflow
daemon** (Streamable HTTP on loopback, auto-started on first use), so workflow runs survive
the MCP client killing the stdio process. Every `run` call names its project via the required
`projectDir` tool argument, so one registration — even in global MCP settings — serves every
project; `inspect`/`await`/`stop` locate a runId's project automatically. `--in-process`
restores the pre-daemon single-process stdio server (there `projectDir` is optional and
defaults to that server's own cwd). Manage the daemon with `agentprism-workflows daemon
<start|stop|status|url|run|logs>` — `daemon url` prints registration snippets for HTTP-capable
hosts (Claude Code `--transport http`, Codex `config.toml` `url`), which can skip the shim
entirely. See the [`@automatalabs/mcp-server` README](../mcp-server#the-workflow-daemon) for
the daemon's full contract (discovery, project routing, idle shutdown, security posture).

The bundled server exposes **two** model-facing tools — `workflow` and **`repl`** — and no auth
tools. The `repl` tool is a persistent QuickJS-in-WASM JavaScript REPL, **one VM per `projectDir`**
(the same per-project model as `workflow`), for live, stateful subagent orchestration: workspace
state (bindings, pending subagent calls, checkpoints, logged values) persists in the VM across tool
calls and daemon restarts through the per-project `repl/` store, and drains when the project's last
MCP client disconnects. See [The `repl` tool](../mcp-server#the-repl-tool) for its full contract.

For the source inner loop, build workflows before launching its compiled CLI:

```bash
pnpm --filter @automatalabs/workflows build
node packages/workflows/dist/cli.js mcp
```

If the embedded bundle is absent in a monorepo checkout, the command falls back to the built
`packages/mcp-server/dist/cli.js`. A root `pnpm build` therefore also supports development before
running `node packages/workflows/dist/cli.js mcp`. The independently published
`@automatalabs/mcp-server` package and `agentprism-workflow` bin remain available.

---

## Structured output

Pass a JSON Schema to `agent({ schema })` (in a script) or `runner.run(prompt, { schema })` (direct)
and the result is a **validated object** instead of text. Claude and Codex use their agent-specific
schema channels; Pi and OpenCode use the injected client-hosted HTTP `StructuredOutput` MCP tool plus
the common prompt/validated-last-text fallback. The value is coerced and validated client-side (typebox `Convert` → `Check`); on a miss the runner re-prompts a bounded number of
times before failing with a non-recoverable `SCHEMA_NONCOMPLIANCE`.

A **plain JSON Schema object literal** works everywhere (this is the only option inside a script —
no schema-builder is injected into the realm):

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["title", "score"],
  "properties": {
    "title": { "type": "string" },
    "score": { "type": "number" }
  }
}
```

In TypeScript you may instead build the schema with [typebox](https://github.com/sinclairzx81/typebox)
(`Type.Object({ … })`) for static result typing. Two helpers convert a typebox schema to the exact
wire JSON Schema each backend expects:

```ts
import { toJsonSchema, toStrictJsonSchema } from "@automatalabs/workflows";
import { Type } from "typebox";

const schema = Type.Object({ title: Type.String(), score: Type.Number() });
toJsonSchema(schema);        // plain JSON Schema (Claude outputFormat)
toStrictJsonSchema(schema);  // OpenAI-strict-normalized (Codex outputSchema)
```

---

## Backend selection

The backend for each agent is chosen from its effective `model` (preferred) or `tier` string. Split
the string on its first `/`. If the first segment, ASCII-case-insensitively, is `claude`, `codex`,
`opencode`, `pi`, or a registered custom backend name, it selects that harness and is stripped exactly
once; a custom registration wins on a built-in-name collision. A registered harness name alone is
backend-only and preserves that harness's configured default model. Any other first segment sends
the entire authored string unchanged to `AGENTPRISM_DEFAULT_BACKEND` (default `claude`). Omitting
the spec also uses the configured default backend and its default model.

```ts
import { selectBackend } from "@automatalabs/workflows";

selectBackend({ model: "claude/opus[1m]" }).id;      // "claude"
selectBackend({ model: "codex/gpt-5.6-sol" }).id;    // "codex"
selectBackend({ model: "opencode/zai/glm-5.2" }).id; // "opencode"
selectBackend({ model: "pi/openrouter/vendor/model" }).id; // "pi"
```

When an id remains after routing, it becomes the exact ACP `session/set_config_option` value
(surfaced as `SessionHandle.selectModel()`): no normalization, catalog matching, bracket parsing,
retry, echo verification, or fallback. Brackets, dots, slashes, and provider-style prefixes are
ordinary id characters. A harness error follows the existing agent-error path. Per-backend pool
size is `AGENTPRISM_ACP_POOL_SIZE` (or `AcpPoolOptions.size`).

`agent({ configOptions })` applies the rest of that selected harness's ACP option surface with the
same verbatim philosophy. Exact ids and string/boolean values are sent in ascending option-id
order, after model selection and before the prompt; there are no aliases, coercion, defaults,
catalog matching, or client-side option vocabulary. The `"model"` key is rejected before a session
opens because the dedicated `model` field is its only channel. Run `validate` and read the routed
harness's advertised-options table before choosing ids or select values. A live harness rejection
otherwise follows the existing agent-error path.

Pi exposes `thinkingLevel` through that same surface. The validator selects each call's Pi model
before reading the option, so a call can safely differ from the session default. Values shown in the
model-specific choices are applied unchanged. A Pi-recognized value above the model ceiling or in a
model gap validates with a warning and clamps in Pi's order; a value outside Pi's recognized domain
fails validation with exit code `2`.

---

## Exports

```ts
// ── Run entry & helper ──
runDynamicWorkflow,           // (script, { args?, runner?, exec? }) => Promise<WorkflowRunResult>
runIsolation,                 // ACP-defaulted single-target substitution over a recorded run
createReplayRunner,           // backend-neutral in-memory replay composition primitive
runWorkflow,                  // the bare engine run (no status trio)
parseWorkflowScript,          // parse a script's meta + body
validateWorkflowScript,       // token-free parse + mock dry run + no-prompt harness option probes
probeHarnessConfig,           // the same no-prompt option probe standalone (the `config` CLI command)
fabricateFromSchema,          // the dry run's JSON-Schema value fabricator
formatValidateReport,         // render a ValidateWorkflowReport as CLI text
formatHarnessConfigReport,    // render a HarnessConfigReport as CLI text
openWorkflowDir,              // read-only view over folders of workflow scripts (name = filename stem)
WorkflowManager,              // stateful / resumable run manager
RESUME_FALLBACK_REASONS, RESUME_DISABLED_REASONS,
RESUME_CALL_LIVE_REASONS, RESUME_CALL_FAILED_REASONS,

// ── ACP backend ──
createAcpRunner,              // () => AcpAgentRunner (the default AgentRunner; has .on(...) events)
AcpAgentRunner,               // class — implements AgentRunner over ACP
InteractiveSession,           // held-open multi-turn ACP session returned by openSession()
selectBackend,                // pick a built-in/custom backend from a model/tier spec
ClaudeBackend, CodexBackend, OpenCodeBackend, PiBackend, CustomAcpBackend,
resolveBackendRegistry, BACKENDS_ENV,
AGENT_METHODS, CLIENT_METHODS, ACP_AUTH_REQUIRED_ERROR_CODE,
clientCapabilitiesFor, adaptPromptContent,
toJsonSchema, toStrictJsonSchema,
TypedEventEmitter,            // the tiny typed emitter backing runner.on(...)

// ── Errors ──
WorkflowError, WorkflowErrorCode, isWorkflowError, isProviderUsageLimit, isAuthRequired,

// ── Persistence paths ──
AGENTPRISM_PERSISTENCE_ROOT_ENV,

// ── Types ──
RunDynamicWorkflowOptions, RunIsolationSdkOptions, RunIsolationOptions, IsolationRunResult,
IsolationTarget, ReplayRunnerOptions, ReplayRunner, ReplayObservation, ReplayReport,
ReplayCallReport, ReplayDivergenceEvent, ResolvedIsolationTarget,
WorkflowRunOptions, AgentOptions, ExecOptions, CheckpointCallContext,
WorkflowAgentAttemptControl, WorkflowAgentCallCancellation,
MockAnswerJson, MockAnswerSequence, MockAnswerRule, MockAnswers,
ValidatedMockAnswerUse, ValidatedMockAnswerRule, UnusedMockAnswer, ValidatedMockAnswers,
ValidateWorkflowOptions, ValidateWorkflowReport, ValidateHarnessOptions,
ValidatedAgentCall, ValidatedCheckpoint,
ProbeHarnessConfigOptions, HarnessConfigReport,
WorkflowManagerOptions, CheckpointOptions, WorkflowRunResult, WorkflowRunFallback,
WorkflowCheckpointTaken, WorkflowCheckpointSource, WorkflowSnapshot,
ResumePolicy, WorkflowResumeStrategy, WorkflowResumeMatch, WorkflowResumeSafety,
WorkflowResumeFallbackReason, WorkflowResumeDisabledReason,
WorkflowResumeCallLiveReason, WorkflowResumeCallFailedReason,
WorkflowCallReplayProvenance, WorkflowResumeCallDecision, WorkflowResumeReport,
WorkflowReplayOperationalOption, WorkflowReplayOperationalChange,
WorkflowReplayFirstNonReplay, WorkflowReplayEligibility,
WorkflowPathOptions, RunPersistence, RunPersistenceOptions,
AcpPoolOptions, AcpRunnerOptions, AgentRunner, RunOptions, AgentResult, AgentUsage, JournalEntry,
AgentSessionRef, AgentSessionRecord, WorkflowBackendConfig, WorkflowCallRecord, WorkflowRecordedError,
InteractiveSessionOptions, InteractiveTurn, SteeringOutcome, ProbeConfigOptionsOptions, ProbedConfigOptions, SessionConfigOption,
PermissionResolver,
AuthResolver, AuthContext, AuthResolution, AuthMethodDescriptor, AuthCapableRunner,
ProviderCapableRunner,        // duck-type gate for the MCP provider tools (providers/list|set|disable)
ClientHandlers, FsHandlers, TerminalHandlers, McpHandlers, AcpSessionContext, NegotiatedCapabilities,
// ACP events: the runner.on(...) surface
AcpRunnerEventMap, AcpEventName, AcpEventListener, AcpEventContext, AcpSteeringEvent,
AcpSessionUpdate, AcpUpdateKind, AcpPermissionPendingEvent, AcpPermissionEvent,
AcpElicitationPendingEvent, AcpElicitationEvent, AcpElicitationCompleteEvent,
AcpRawMessageEvent, AcpBackendErrorEvent,
```

(The DSL globals — `agent`, `parallel`, `pipeline`, … — are **not** exported; they are realm
globals documented by the ambient `dsl.d.ts`.)

---

## Skill for AI agents that write workflows

The repository publishes an **agent skill** — a self-contained, backend-agnostic authoring guide
in the standard `SKILL.md` format — at
[`skills/agentprism-workflow-authoring/`](https://github.com/agentprism/agentprism-workflows/tree/main/skills/agentprism-workflow-authoring).
Install it into whatever coding agent you use (Claude Code, Codex, Cursor, OpenCode, …) with the
[skills](https://skills.sh) CLI:

```bash
npx skills add agentprism/agentprism-workflows
```

It teaches the full script DSL: routing each `agent()` call to a different ACP backend inside one
script, structured outputs across all backends, `checkpoint()` gates, worktree isolation, and
the determinism rules that make runs resumable. `reference.md` alongside it holds
the exhaustive option tables.

---

## See also

- **[`examples/`](examples/)** — runnable examples: `repo-triage`, a complete standalone
  project (own `package.json`, TypeScript host, external workflow scripts) running an
  autonomous cross-vendor triage; and `image-gate`, a single gated script with an
  MCP-wired image producer.
- **[`@automatalabs/mcp-server`](https://www.npmjs.com/package/@automatalabs/mcp-server)** — the
  stdio MCP server built on this SDK. It wraps the same engine + ACP backend behind the `workflow`
  and `repl` tools (bin: `agentprism-workflow`; no auth tools) for any MCP host. Use it when you want
  the **MCP-tool route** instead of embedding the runner in code.

## License

Apache-2.0
