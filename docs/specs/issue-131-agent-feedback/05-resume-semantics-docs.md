# Prominent Resume and Journal Identity Semantics

**Date:** 2026-07-14
**Reference:** [Issue #131](https://github.com/VikashLoomba/agentprism-workflows/issues/131), section 5

## 1. Problem

AgentPrism already supports a valuable recovery pattern: an MCP caller can change `args`, pass `resumeFromRunId`, replay an expensive unchanged call prefix from the prior journal for zero tokens, and continue with newly reachable calls. The feedback in issue #131 reports using exactly that pattern to raise a loop cap after six expensive review rounds. The current public documentation describes journal replay generically, but it does not prominently state that `args` is not directly part of an `agent()` call's replay hash, nor does it teach the important qualification that an args change can still cause a miss when it changes a prompt or another hashed field.

That omission makes authors likely to restart expensive workflows unnecessarily or, in the other direction, assume that every args edit is replay-safe. It also hides the engine's longest-unchanged-prefix rule: after the first changed or new call, that call and the complete suffix run live even if a later call happens to have its old hash. The public rule must therefore be memorable and short, while the surrounding text must state the exact identity fields, the resolved-agent-definition nuance, the non-hashed additive fields, and the suffix invalidation behavior.

This design changes documentation and the `resumeFromRunId` MCP field description only. It
preserves the journal format, hashing bytes, persistence format, resume behavior, SDK types,
defaults, and errors. Within the coordinated pack, the surrounding MCP input union is extended by
`01-run-observability.md` and `02-detached-runs.md`; this item neither adds to nor changes those
run/inspect/await branches.

## 2. Current state

### Engine identity and prefix replay

`packages/workflow-engine/src/workflow.ts` defines the module-private `hashAgentCall()` used by the realm's `agent()` implementation. Before a call enters the concurrency limiter, `agent()` assigns `callIndex = state.callSeq++`, resolves the model and any named agent definition, and calls `hashAgentCall(prompt, modelSpec, mode, assignedPhase, agentOptions, agentDefinitionKey(agentDef))`. `hashAgentCall()` serializes the following canonical object in this field order and hashes the JSON bytes with SHA-256:

```ts
const identity = JSON.stringify({
  prompt,
  model: model ?? null,
  ...(mode !== undefined ? { mode } : {}),
  tier: options.tier ?? null,
  phase: phase ?? null,
  agentType: options.agentType ?? null,
  agentDef: agentDefKey,
  schema: options.schema ?? null,
});
```

The `model` value is the engine-resolved model spec produced by the existing explicit-model, agent-definition, tier, phase, and run-default routing rules before hashing; it is not a runner's later fallback result. `mode` is deliberately omitted when unset rather than serialized as `null`, preserving compatibility with journals created before modes existed.

The issue's shorthand list needs one correction from the code: the hash includes both the `agentType` name and the resolved `agentDef` key. `packages/workflow-engine/src/agent-registry.ts` exports `agentDefinitionKey()`, which serializes the resolved definition's `tools`, `disallowedTools`, `model`, `isolation`, and body `prompt`. Editing a referenced agent Markdown definition therefore invalidates that call even when the `agentType` string is unchanged. This behavior is covered by `packages/workflow-engine/test/agent-registry.test.ts` in `editing a definition invalidates the resume cache for that call`.

`WorkflowRunOptions.args` is exposed in the realm as `args: options.args` by `runWorkflow()` in `packages/workflow-engine/src/workflow.ts`; it is not an argument to `hashAgentCall()` and does not appear in the canonical identity object. An args change therefore has no direct invalidation effect. It has an indirect effect when script evaluation turns the new args into a changed prompt, resolved model, set mode, tier, phase, agent type or resolved definition, schema, call order, or number of calls.

The named additive options in this item—`label`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`, and `keepSession`—are absent from `hashAgentCall()`. The implementation comments on `AgentOptions` and the runner dispatch in `packages/workflow-engine/src/workflow.ts` explicitly call them additive and non-hashed. Tests already pin several parts of that contract in `packages/workflow-engine/test/cwd.test.ts`, `mcp-servers.test.ts`, `images.test.ts`, `meta-passthrough.test.ts`, and `agent-sessions.test.ts`. The hash also omits call-site `isolation`, `timeoutMs`, and `retries`; when isolation comes from a resolved agent definition, however, it is included inside `agentDef`.

`RuntimeState.firstMiss` in `packages/workflow-engine/src/workflow.ts` implements longest-unchanged-prefix replay. A cached `JournalEntry` is returned only when its hash matches, its result is not an empty schema-less text result, and `callIndex < firstMiss`. A missing entry, hash mismatch, or empty cached text result lowers `firstMiss` to that index. The changed call and every later call consequently run live. `packages/workflow-engine/test/workflow-runtime.test.ts` covers this behavior in `resume re-runs the changed call AND everything after it (longest-unchanged-prefix)` and the parallel-call equivalent. `checkpoint()` participates in the same prefix using its own `hashCheckpoint()` identity of `promptText`, normalized `kind`, and `choices`.

`JournalEntry` is exported from `packages/shared-types/src/workflow-result.ts` as `{ index, hash, result, session? }`. `PersistedRunState` in `packages/workflow-engine/src/run-persistence.ts` stores the original `script`, `args`, and `journal`. `workflowProjectPaths()` in `packages/workflow-engine/src/workflow-paths.ts` places current writes under `~/.agentprism/workflows/projects/<cwd-basename>-<cwd-sha256-prefix>/runs/<runId>.json`, subject to the existing `persistenceRoot` and `AGENTPRISM_PERSISTENCE_ROOT` precedence.

### Resume entry points

The engine-level `runWorkflow(script, options)` accepts `options.args`, `options.resumeJournal`, and informational `options.resumeFromRunId`. `WorkflowManager.runSync(script, args, exec)` in `packages/workflow-engine/src/workflow-manager.ts` accepts a hydrated `ExecOptions.resumeJournal`, creates a new managed run and new run ID, seeds that new run with the hydrated entries, and evaluates the supplied script with the supplied args.

`WorkflowManager.resume(runId, exec)` and `resumeInBackground(runId, exec)` are a different public lifecycle path: they reload the persisted run's original script and original args and continue under the same run ID. They do not accept replacement args. This distinction matters when documenting changed-args resume: the issue's pattern is directly available through the MCP `workflow` tool, while an SDK caller wanting replacement args must use the lower-level `runSync(script, newArgs, { resumeJournal })` path rather than `resume(runId)`.

`packages/mcp-server/src/workflow-tool-input.ts` exports `workflowToolInputShape` and `WorkflowToolInput`; the public field remains:

```ts
resumeFromRunId?: string;
```

Its current Zod description says only that the shell loads the journal and that resume is explicit. In `packages/mcp-server/src/server.ts`, `createWorkflowServer()` loads the named persisted run, copies its `journal` into `exec.resumeJournal`, optionally injects a checkpoint reply, and then calls `manager.runSync(input.script, input.args, exec)`. Thus the request's current `script` and current `args` are evaluated against the prior journal and the result receives a fresh run ID. `packages/mcp-server/test/resume.test.ts` pins full replay and the fresh run ID. The same file also pins that an unknown run ID loads no journal and executes fresh; the current schema also accepts an empty string, which follows the same fresh-run path because the handler's resume branch is truthiness-gated.

### Documentation and generated prompt

- The root `README.md` says that unchanged prefixes replay for zero tokens and lists `resumeFromRunId`, but it does not state the args rule or show a loop-cap continuation.
- `skills/agentprism-workflow-authoring/SKILL.md`, under `Determinism and resume`, lists prompt, model, mode, tier, phase, agent type, and schema, but omits the resolved agent-definition key, the direct-vs-indirect args distinction, and a worked resume example.
- `skills/agentprism-workflow-authoring/reference.md`, under `Determinism & the resume journal`, already includes the agent-definition identity and additive-option list, but it does not give the one-line args rule or the loop-cap example.
- `skills/agentprism-workflow-authoring/examples/quick-wins.workflow.js` already demonstrates an args-controlled round cap, but its convergence behavior is not a deterministic demonstration of reaching that cap. `examples/README.md` has no focused resume exercise.
- `scripts/generate-authoring-prompt.mjs` defines `buildAuthoringPromptContent()`, which concatenates the complete `SKILL.md`, `reference.md`, and embedded `examples/quick-wins.workflow.js` into `packages/mcp-server/src/generated/authoring-prompt-content.ts`. `packages/mcp-server/test/authoring-prompt.test.ts` byte-compares the checked-in generated content with a fresh build, so skill/reference edits require regeneration.

## 3. Proposed design

### Normative replay contract

The following sentence is the canonical one-line rule and must appear verbatim on every concise surface specified below:

> **Resume rule:** `args` changes don't invalidate the journal; prompt changes cache-miss from the first changed call.

Every occurrence must be followed closely by these qualifications:

1. `args` is not directly hashed. If changed args produce the same call sequence and the same hashed identities, the prior prefix replays.
2. The actual `agent()` identity is the SHA-256 hash of canonical JSON containing `prompt`, resolved `model`, `mode` only when set, `tier`, `phase`, `agentType`, resolved `agentDef`, and `schema`.
3. If changed args alter any of those fields or the call sequence, replay stops at the first affected or new call. That call and the entire suffix run live.
4. `label`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`, and `keepSession` do not invalidate a cached call. Changed values affect calls that run live; they do not retrofit or rerun a replayed result. To force a particular cached call to execute again, change a hashed identity field, normally the prompt.

No hash input, serialization order, journal entry, replay algorithm, or persistence behavior changes in this item.

### MCP tool metadata

The `resumeFromRunId` member of the final execution branch remains unchanged by this item:

```ts
export interface WorkflowExecuteToolInput {
  // action?: "run", script, args, execution knobs, and background are specified in specs 01 and 02.
  resumeFromRunId?: string;
}
```

The coordinated `WorkflowToolInput` remains the run/inspect/await discriminated union from specs 01
and 02. This item adds no branch, option, validation bound, or result field to that union.

Replace only the `.describe()` text for `workflowToolInputShape.resumeFromRunId` in `packages/mcp-server/src/workflow-tool-input.ts` with this exact string:

```ts
"Start a new run using the persisted journal identified by this run ID. Resume rule: args changes don't invalidate the journal; prompt changes cache-miss from the first changed call. Re-send the script and desired args; the longest unchanged call prefix replays at zero token cost, and the first changed or new call plus its suffix runs live. If the run ID is empty or not found in this project namespace, execution starts fresh."
```

This is a description-only change. On the execution branch, `resumeFromRunId` remains optional, has
no default, accepts any string under the current Zod schema, and introduces no new error. A present,
non-empty ID found in the current project namespace hydrates its journal. An omitted, empty, or
unknown ID executes with no hydrated entries. A malformed script continues to fail before a managed
run exists; normal foreground failures and pauses continue to return the coordinated execution
projection, while `background: true` uses the acceptance/await contract from spec 02.

This item adds no request or response fields, data retention, logging, or disclosure. Existing
script, args, agent snapshots, results, and journals retain their current persistence and redaction
behavior. The observability and detached-run limits from specs 01 and 02 apply to their new payloads;
resume documentation introduces no additional size or redaction rule.

### Worked wire example

The documentation example uses a script whose first six call identities are independent of `args.maxRounds`; only the number of reachable calls changes. The first request intentionally fails after six rounds because completion requires eight:

```json
{
  "script": "export const meta = { name: 'resume-loop-cap', description: 'Run expensive review rounds up to an args-controlled cap', phases: [{ title: 'Review' }] };\nconst input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};\nconst numericCap = Number(input.maxRounds);\nconst maxRounds = Number.isInteger(numericCap) && numericCap > 0 ? numericCap : 8;\nphase('Review');\nconst rounds = [];\nfor (let i = 0; i < maxRounds; i += 1) {\n  rounds.push(await agent(`Review round ${i + 1}: inspect the repository and report unresolved release blockers.`, { label: `review:${i + 1}`, phase: 'Review' }));\n}\nif (maxRounds < 8) throw new Error(`review cap ${maxRounds} reached before 8 rounds`);\nreturn { rounds };",
  "args": { "maxRounds": 6 }
}
```

For the JSON example, the first response's concrete illustrative run ID is `m5z8q7nd-r4v2cx`. The second request repeats the exact script string, raises only the cap, and supplies that returned ID:

```json
{
  "script": "export const meta = { name: 'resume-loop-cap', description: 'Run expensive review rounds up to an args-controlled cap', phases: [{ title: 'Review' }] };\nconst input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};\nconst numericCap = Number(input.maxRounds);\nconst maxRounds = Number.isInteger(numericCap) && numericCap > 0 ? numericCap : 8;\nphase('Review');\nconst rounds = [];\nfor (let i = 0; i < maxRounds; i += 1) {\n  rounds.push(await agent(`Review round ${i + 1}: inspect the repository and report unresolved release blockers.`, { label: `review:${i + 1}`, phase: 'Review' }));\n}\nif (maxRounds < 8) throw new Error(`review cap ${maxRounds} reached before 8 rounds`);\nreturn { rounds };",
  "args": { "maxRounds": 8 },
  "resumeFromRunId": "m5z8q7nd-r4v2cx"
}
```

Calls at indexes 0 through 5 reconstruct the same prompts and other hashed fields, so their stored results replay with zero agent invocations and zero token cost. Indexes 6 and 7 are new and run live. The second MCP call receives its own new run ID. If the prompt had interpolated `maxRounds`, index 0 would instead be the first miss and all eight calls would run live; this contrast must accompany the example anywhere it is condensed.

## 4. Alternatives considered

### Hash the complete `args` value

Rejected because it would destroy the reported recovery pattern. Raising an orchestration-only cap from six to eight would invalidate index 0 even though the first six agent tasks are byte-for-byte identical. It would also change the load-bearing hash format and invalidate existing journals.

### Hash only the args properties read by the script

Rejected because JavaScript property access is dynamic and tracking it would complicate the deterministic realm without improving correctness. The resulting prompt and other existing identity fields already capture whether an args change changes an agent task. Control-flow changes naturally appear as a changed or new call index.

### Replay every individually matching call after a miss

Rejected because a downstream call can retain the same local hash while depending on a changed upstream result through script state or control flow. `RuntimeState.firstMiss` deliberately prevents stale suffix reuse. The documentation must teach the existing longest-prefix rule rather than describe the journal as an unordered per-call cache.

### Add `reuseJournalAcrossArgs` or `invalidateJournal` flags

Rejected because the engine already has deterministic behavior that requires no opt-in. A new flag would add a public API and competing modes without resolving any ambiguity that precise documentation cannot resolve.

### Add additive options to the hash

Rejected because this item documents the existing compatibility contract. Hashing `label`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`, or `keepSession` would alter existing replay behavior and invalidate prior journals. The prose instead makes the consequence explicit: changes to these fields affect live calls only unless the author also changes a hashed identity field.

### Document only the root README

Rejected because agents most often discover this feature through the MCP input schema or the bundled `author-workflow` prompt, while workflow authors using other hosts consume the published authoring skill. All four discovery paths must carry the same rule, and the examples directory must provide a runnable script that demonstrates it.

## 5. Compatibility & semver

There is no runtime or serialized-data migration. Existing scripts, journal files, run IDs, cache hits, misses, persisted args, and MCP requests behave exactly as before. The exact SHA-256 identity bytes remain unchanged, including omission of `mode` when unset and inclusion of `agentDef`.

Package release plan:

| Package | Change | Compatibility | Changesets bump |
|---|---|---|---|
| `@automatalabs/workflow-engine` (`packages/workflow-engine`) | Regression tests pin args-independent hashes and args-driven longest-prefix behavior; no published source change. | Test-only, no API or behavior change. | None. |
| `@automatalabs/workflows` (`packages/workflows`) | Validator test reads the new published-skill example and proves its default path is valid; no published source change. | Test-only, no API or behavior change. | None. |
| `@automatalabs/mcp-server` (`packages/mcp-server`) | Public `resumeFromRunId` schema description, package README, bundled generated authoring prompt, and tests change. | Additive documentation/metadata; this item does not alter the coordinated input/output schemas from specs 01 and 02. | Patch. |

Add one Changesets file with this exact release entry:

```md
---
"@automatalabs/mcp-server": patch
---

Document how changed workflow args interact with journal identity and longest-prefix replay, including an args-controlled loop-cap resume example in the bundled authoring prompt.
```

Root documentation and `skills/agentprism-workflow-authoring` are not npm package version surfaces. They ship in the same PR and require no separate semver entry.

## 6. Test plan

### `packages/workflow-engine`

Extend `packages/workflow-engine/test/journal-hash.test.ts`, using its existing `node:test`, `assert`, observable `onAgentJournal`, and SHA-256 style:

1. Run the same one-call script twice with different `WorkflowRunOptions.args`, while the prompt and hashed options remain identical. Assert that both `JournalEntry.hash` values are byte-identical. This directly pins that `args` is not serialized by `hashAgentCall()`.
2. Keep the existing exact canonical-JSON test unchanged and add an assertion comment naming `agentDef`, so the public prose cannot regress to the shorter but incomplete issue shorthand.

Extend `packages/workflow-engine/test/workflow-runtime.test.ts` with an args-controlled loop test:

1. First run the complete `resume-loop-cap` script with `{ maxRounds: 6 }`, capture all six journal entries, and assert that it rejects with `review cap 6 reached before 8 rounds`.
2. Run the same script with `{ maxRounds: 8 }` and the captured `resumeJournal`. Use the existing `countingAgent()` helper and assert that only two live runner calls occur, the returned result contains eight rounds, and the first six values are the original journaled results.
3. Run a three-call script in which changed args alter only the middle prompt. Resume with the first journal and assert that index 0 replays while indexes 1 and 2 run live, proving that an args-caused prompt change obeys `firstMiss` suffix invalidation.

### `packages/workflows`

Extend `packages/workflows/test/validate.test.ts` in its existing `node:test` style:

1. Read `skills/agentprism-workflow-authoring/examples/resume-loop-cap.workflow.js` as UTF-8 and call `validateWorkflowScript()` without args. Its default cap is eight, so assert `ok === true`, `exitCode === 0`, terminal dry-run status `completed`, and eight recorded agent calls.
2. Validate the same file with `{ args: { maxRounds: 6 } }`. Assert `exitCode === 2`, dry-run status `failed`, six recorded agent calls, and a reason containing `review cap 6 reached before 8 rounds`. This proves the documented first run intentionally leaves a complete six-entry journal rather than failing before the expensive calls.

### `packages/mcp-server`

Extend `packages/mcp-server/test/resume.test.ts` with the existing in-memory MCP harness and counting runner:

1. Call `workflow` with the complete example script and `{ maxRounds: 6 }`; assert `status === "failed"`, six runner invocations, and a non-empty returned run ID.
2. Call `workflow` again with the same script, `{ maxRounds: 8 }`, and the first run ID. Assert `status === "completed"`, the cumulative runner count is eight rather than fourteen, the first six returned values are the first run's values, the last two are new, and the second run ID differs from the first.
3. Add an args-caused middle-prompt change case and assert the unchanged first call replays while the changed middle call and unchanged-looking final call both run live.
4. Preserve the existing unknown-run case, which proves that an unavailable ID executes fresh.

In `packages/mcp-server/test/workflow-tool-input.test.ts`, inspect
`workflowToolInputShape.resumeFromRunId.description` and assert that it contains the exact canonical
sentence, `Resume rule: args changes don't invalidate the journal; prompt changes cache-miss from
the first changed call.` Keep the final run/inspect/await key-set assertion established by specs 01
and 02 unchanged to prove this documentation item adds no field.

In `packages/mcp-server/test/authoring-prompt.test.ts`:

1. Keep the byte-for-byte generator drift assertion.
2. Add sentinels asserting that `AUTHORING_PROMPT_CONTENT` contains the canonical one-line rule, `agent-definition`, `maxRounds: 6`, `maxRounds: 8`, and the explanation that only rounds 7 and 8 run live.
3. Keep `the prompt adds zero model-facing tool surface` unchanged so the work cannot accidentally add a second MCP tool.

Verification commands for the implementation PR are the existing package scripts:

```bash
pnpm --filter @automatalabs/workflow-engine test
pnpm --filter @automatalabs/workflows test
pnpm --filter @automatalabs/mcp-server test
pnpm --filter @automatalabs/mcp-server typecheck
```

## 7. Docs & skill updates

### Root `README.md`

In `Why AgentPrism` → `Durable runs — resume without re-spending tokens`, append this exact block after the current paragraph:

> **Resume rule:** `args` changes don't invalidate the journal; prompt changes cache-miss from the first changed call.
>
> `args` is not itself part of an `agent()` call's replay hash. New args can raise an orchestration-only loop cap while earlier calls keep replaying for zero tokens. If the new args change a prompt or another hashed identity field, replay stops at the first affected call and that call plus every later call runs live. The hashed identity is the prompt, resolved model, mode when set, tier, phase, agent type and resolved agent definition, and schema. `label`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`, and `keepSession` do not invalidate a cached call; changed values apply only to calls that run live.

In `Quickstart — MCP server`, immediately after the paragraph explaining `resumeFromRunId` and checkpoint replies, insert this exact subsection:

#### Raise a loop cap without paying for completed rounds twice

This script intentionally halts after six expensive reviews when called with `{ "maxRounds": 6 }`, although eight are required:

```js
export const meta = {
  name: "resume-loop-cap",
  description: "Run expensive review rounds up to an args-controlled cap",
  phases: [{ title: "Review" }],
};

const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
const numericCap = Number(input.maxRounds);
const maxRounds = Number.isInteger(numericCap) && numericCap > 0 ? numericCap : 8;

phase("Review");
const rounds = [];
for (let i = 0; i < maxRounds; i += 1) {
  rounds.push(
    await agent(
      `Review round ${i + 1}: inspect the repository and report unresolved release blockers.`,
      { label: `review:${i + 1}`, phase: "Review" },
    ),
  );
}

if (maxRounds < 8) throw new Error(`review cap ${maxRounds} reached before 8 rounds`);
return { rounds };
```

Call `workflow` once with that script and `args: { "maxRounds": 6 }`. Copy the returned `runId`, then call `workflow` again with the same script, `args: { "maxRounds": 8 }`, and that ID as `resumeFromRunId`. Rounds 1–6 rebuild the same prompts and replay from the journal at zero token cost; only rounds 7 and 8 run live. Keep the cap out of the round prompt: interpolating `maxRounds` there would change round 1's prompt and make all eight rounds run live.

### `skills/agentprism-workflow-authoring/SKILL.md`

Replace the complete current `Determinism and resume` section, up to but not including `Worked example — cross-vendor build with every major primitive`, with this exact text:

## Determinism and resume

Runs are journaled: every `agent()` and `checkpoint()` result is recorded under a deterministic call index, and a paused, killed, or failed run can resume by replaying the completed prefix from the journal at zero token cost.

> **Resume rule:** `args` changes don't invalidate the journal; prompt changes cache-miss from the first changed call.

- `Date.now()`, `Math.random()`, and no-arg `new Date()` throw inside the realm (`new Date(isoString)` is fine). Need a timestamp or random seed? Pass it through `args`.
- An `agent()` replay identity hashes the prompt, resolved `model`, `mode` when set, `tier`, `phase`, `agentType`, the resolved agent definition, and `schema`. The resolved definition covers its tool allowlist/denylist, model, isolation, and body prompt, so editing an agent definition invalidates calls that use it.
- `args` is not hashed directly. If new args only raise a loop cap, earlier calls with the same prompts and other identity fields replay. If new args change a prompt, model selection, phase, schema, call order, or another hashed field, the first affected call is a miss.
- Resume uses the longest unchanged prefix: the first changed or new call and every later call run live. This prevents an unchanged-looking downstream call from reusing a result produced from stale upstream state.
- `label`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`, and `keepSession` are not hashed. Changing one does not rerun a cached call; the new value affects only calls that run live. Change a hashed field, normally the prompt, when a call must execute again.
- Keep call order deterministic. Derive iteration from `args` and prior agent results, never from ambient state.

### Worked resume — raise a loop cap

The following workflow requires eight reviews but lets the caller cap how many are attempted in one run:

```js
export const meta = {
  name: "resume-loop-cap",
  description: "Run expensive review rounds up to an args-controlled cap",
  phases: [{ title: "Review" }],
};

const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
const numericCap = Number(input.maxRounds);
const maxRounds = Number.isInteger(numericCap) && numericCap > 0 ? numericCap : 8;

phase("Review");
const rounds = [];
for (let i = 0; i < maxRounds; i += 1) {
  rounds.push(
    await agent(
      `Review round ${i + 1}: inspect the repository and report unresolved release blockers.`,
      { label: `review:${i + 1}`, phase: "Review" },
    ),
  );
}

if (maxRounds < 8) throw new Error(`review cap ${maxRounds} reached before 8 rounds`);
return { rounds };
```

With the MCP `workflow` tool, run it first with `args: { "maxRounds": 6 }`. Then send the same script with `args: { "maxRounds": 8 }` and the first result's `runId` as `resumeFromRunId`. Rounds 1–6 replay for zero tokens and only rounds 7–8 run live because the cap controls call count but is not interpolated into the round prompt. If the prompt included `maxRounds`, round 1 would change and the whole eight-call suffix would run live.

### `skills/agentprism-workflow-authoring/reference.md`

Replace the complete current `Determinism & the resume journal` section, up to but not including `Custom backends`, with this exact text:

## Determinism & the resume journal

> **Resume rule:** `args` changes don't invalidate the journal; prompt changes cache-miss from the first changed call.

- Banned in the realm because they break deterministic replay: `Date.now()`, `Math.random()`, no-arg `new Date()` / `Date()`. `new Date(value)` works. There is no `require`, `import`, Node API, or network API in the realm.
- Each `agent()` result is journaled under a monotonic call index and a SHA-256 identity hash. The canonical identity fields, in order, are `prompt`, resolved `model`, `mode` only when set, `tier`, `phase`, `agentType`, resolved `agentDef`, and `schema`. Missing fields other than `mode` serialize as `null`; an unset `mode` key is omitted for compatibility with older journals.
- `agentDef` is the resolved definition's tools, disallowed tools, model, isolation, and body prompt. Changing a named definition therefore invalidates its call even when the `agentType` name is unchanged.
- `args` is exposed to the script but is not directly included in the call hash. An args change cache-misses only when evaluating the script produces a changed hashed field, changed call order, or a new call.
- Resume replays the longest unchanged prefix as cache hits with zero agent tokens. The first changed/new call and every call after it run live. `retry` and `gate` chains naturally cascade because a later attempt's prompt usually includes the preceding live result.
- The additive options `label`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`, and `keepSession` are not hashed. A changed value affects only a live call; it does not invalidate or modify a replayed result.
- `checkpoint()` uses the same monotonic call sequence and hashes its prompt, normalized kind, and choices. Real or synthetic `checkpointReplies` decisions are journaled and replay instead of being requested again.

An args-controlled cap is the useful case. In this complete script, `maxRounds` changes how many calls are reachable but does not appear in an earlier call's prompt:

```js
export const meta = {
  name: "resume-loop-cap",
  description: "Run expensive review rounds up to an args-controlled cap",
  phases: [{ title: "Review" }],
};

const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
const numericCap = Number(input.maxRounds);
const maxRounds = Number.isInteger(numericCap) && numericCap > 0 ? numericCap : 8;

phase("Review");
const rounds = [];
for (let i = 0; i < maxRounds; i += 1) {
  rounds.push(
    await agent(
      `Review round ${i + 1}: inspect the repository and report unresolved release blockers.`,
      { label: `review:${i + 1}`, phase: "Review" },
    ),
  );
}

if (maxRounds < 8) throw new Error(`review cap ${maxRounds} reached before 8 rounds`);
return { rounds };
```

The first MCP request uses `{ "args": { "maxRounds": 6 } }` and returns a failed run with a persisted six-entry journal. The next request sends the same `script`, `{ "args": { "maxRounds": 8 } }`, and the returned run ID as `resumeFromRunId`. Calls 0–5 replay for zero tokens; calls 6–7 are new and run live. This changed-args pattern is specific to entry points that accept new args together with a hydrated journal. The MCP `workflow` tool does. `WorkflowManager.resume(runId)` instead reloads the persisted original script and args; an SDK caller that needs changed args uses `runSync(script, newArgs, { resumeJournal })`.

### `skills/agentprism-workflow-authoring/examples/`

Add `skills/agentprism-workflow-authoring/examples/resume-loop-cap.workflow.js` with this complete content:

```js
// resume-loop-cap — demonstrate raising an orchestration-only cap on resume.
// Run once with maxRounds=6 to journal six expensive rounds and halt; run again
// with maxRounds=8 plus the first runId as resumeFromRunId. The first six prompts
// are unchanged, so they replay for zero tokens and only rounds 7–8 run live.
export const meta = {
  name: "resume-loop-cap",
  description: "Run expensive review rounds up to an args-controlled cap",
  phases: [{ title: "Review" }],
};

const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
const numericCap = Number(input.maxRounds);
const maxRounds = Number.isInteger(numericCap) && numericCap > 0 ? numericCap : 8;

phase("Review");
const rounds = [];
for (let i = 0; i < maxRounds; i += 1) {
  rounds.push(
    await agent(
      `Review round ${i + 1}: inspect the repository and report unresolved release blockers.`,
      { label: `review:${i + 1}`, phase: "Review" },
    ),
  );
}

if (maxRounds < 8) throw new Error(`review cap ${maxRounds} reached before 8 rounds`);
return { rounds };
```

In `skills/agentprism-workflow-authoring/examples/README.md`, change `Both are verbatim copies` to `The first two are verbatim copies`, add this table row, and append the paragraph below the table:

```md
| [`resume-loop-cap.workflow.js`](resume-loop-cap.workflow.js) | Journal identity and longest-prefix replay: run with `maxRounds: 6`, then resume with `maxRounds: 8` so six expensive calls replay for zero tokens and only two new calls run live. |
```

```md
`resume-loop-cap.workflow.js` defaults to eight rounds and therefore validates successfully without args. Its six-round failure is intentional: call the MCP `workflow` tool with `args: { "maxRounds": 6 }`, then repeat the script with `args: { "maxRounds": 8 }` and the returned `runId` as `resumeFromRunId`. Keep the cap out of the agent prompt or the prompt change will invalidate the journal from round 1.
```

### MCP package README and tool parameter

In `packages/mcp-server/README.md`, replace the `resumeFromRunId` input-table row with this exact row:

```md
| `resumeFromRunId` | string | no | — | Start a new run from this prior run's persisted journal. **Resume rule:** `args` changes don't invalidate the journal; prompt changes cache-miss from the first changed call. Re-send the script and desired args; the longest unchanged prefix replays for zero tokens and the first changed/new call plus its suffix runs live. |
```

Replace the `Explicit resume` bullet under `Run model` with this exact bullet:

```md
- **Explicit resume.** A run can pause for a provider usage limit, missing authentication, or an opted-in durable checkpoint, and failed runs retain their completed journal too. Call `workflow` again with the script, the desired `args`, and `resumeFromRunId` set to the prior `runId`. `args` is not directly hashed: an orchestration-only cap change can reveal new calls while the unchanged prefix replays for zero tokens. If new args change a prompt or another hashed identity field, that call and the complete suffix run live. The resumed MCP request creates a new run ID; an empty or unknown prior ID loads no journal and runs fresh.
```

The actual tool metadata change for this item is the exact `.describe()` string specified in
section 3. It makes no further change to the coordinated top-level tool description, single tool
name, input keys, or output keys.

### Regenerated `author-workflow` prompt

After applying the exact `SKILL.md` and `reference.md` prose above, run `node scripts/generate-authoring-prompt.mjs`. Do not hand-edit `packages/mcp-server/src/generated/authoring-prompt-content.ts`. Because `buildAuthoringPromptContent()` embeds both complete source documents, the generated `AUTHORING_PROMPT_CONTENT` will contain the canonical rule twice—once in the guide and once in the exhaustive reference—and both complete worked-example blocks. The checked-in generated module must match `buildAuthoringPromptContent()` byte-for-byte under `packages/mcp-server/test/authoring-prompt.test.ts`.

The new standalone example file does not need another generator input: the complete example is already present in both embedded source documents, while the examples directory provides the runnable copy for skill consumers. The generator's existing `examples/README.md` absolute-link rewrite remains valid.

## 8. Implementation breakdown

This fits in one PR, ordered as follows:

1. **S — Pin the engine contract.** Add the args-independent hash assertion and the two args-driven prefix-replay cases to `packages/workflow-engine/test/journal-hash.test.ts` and `workflow-runtime.test.ts`. Do not edit `hashAgentCall()`, `agentDefinitionKey()`, `RuntimeState.firstMiss`, or shared types.
2. **M — Add the canonical documentation and runnable example.** Apply the exact root README, `SKILL.md`, `reference.md`, `examples/README.md`, and `resume-loop-cap.workflow.js` content from section 7. Add the validator coverage in `packages/workflows/test/validate.test.ts` so the example stays executable.
3. **S — Update the public MCP description.** Replace only the `resumeFromRunId` Zod description in `packages/mcp-server/src/workflow-tool-input.ts`, update the corresponding package README row and run-model bullet, and add the input-description assertion. This item adds no tool, action, flag, type field, validation bound, or error beyond the coordinated run/inspect/await surface already established by specs 01 and 02.
4. **S — Prove MCP changed-args replay.** Add the six-to-eight-round and args-caused prompt-miss cases to `packages/mcp-server/test/resume.test.ts`, retaining the existing full-hit and unknown-ID cases.
5. **S — Regenerate and guard the authoring prompt.** Run `node scripts/generate-authoring-prompt.mjs`, add the canonical-rule and worked-example sentinels to `packages/mcp-server/test/authoring-prompt.test.ts`, and confirm the exact tool list remains `["workflow"]`.
6. **S — Release metadata and verification.** Add the single `@automatalabs/mcp-server` patch Changeset from section 5 and run the four commands in section 6. Review `git diff --check` and confirm that no published package other than `mcp-server` is named in the Changeset.
