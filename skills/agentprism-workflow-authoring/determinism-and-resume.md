## Determinism and resume

Runs are journaled: every `agent()` and `checkpoint()` result is recorded under a deterministic call index. A new run may reuse eligible results from a terminal source, but uncertainty always means live execution.

> **Resume rule:** replay is content-addressed and fail-to-live: an admitted safe call replays only when its identity and input fingerprint match uniquely.

- Direct `Date.now()`, `Math.random()`, and no-arg `new Date()` / `Date()` calls fail static validation. The realm also blocks aliased or computed forms at runtime (`new Date(isoString)` is fine). Need a timestamp or random seed? Pass it through `args`.
- An `agent()` replay identity hashes the prompt, resolved `model`, `mode` when set, `configOptions` when non-empty (with sorted keys), `tier`, `phase`, `agentType`, the resolved agent definition, and `schema`. An omitted or empty config bag preserves existing hash bytes. The resolved definition covers its tool allowlist/denylist, model, isolation, and body prompt, so editing an agent definition invalidates calls that use it.
- `args` is not hashed directly. If new args only raise a loop cap, earlier safe calls with the same identities and input fingerprints can replay. If new args change a prompt, model selection, phase, schema, call order, or runner-visible input, affected calls run live; unchanged independent calls may still replay.
- Identity matching first tries a unique exact `(kind, call path, identity hash)` row (`"path-hash"`), then a unique `(kind, identity hash, input fingerprint)` row so unchanged calls can replay as `"unique-hash"` after insertions/deletions. Source and current input fingerprints must be equal. Duplicate exact identities, duplicate content, consumed candidates, missing facts, changed safety, and empty schema-less results run live—no source-order or occurrence guess.
- Source admission requires exact `cwd`, full Node/V8 plus fingerprint-format equality, and an environment captured after the source settled with no engine-known work outstanding. Git identity is HEAD plus dirty digest; non-git hosts must provide the same `environmentKey`. A safe stable source gets identity replay; an unsafe stable source can get only a safety-checked positional prefix; nested/source-drifted fallback and every invalid/uncertain source are all-live.
- After an unannotated live agent, nested workflow, live host checkpoint callback, or declared worktree that fails/degrades, every remaining candidate runs live. Declared non-worktree readers and successfully isolated declared worktrees may keep the cache open. Do not use unordered `parallel()` siblings to communicate through files or another ambient/persistent side channel.
- Identity replay preserves budget-driven control flow: cached agents add their source logical debit to `budget.spent()`/`remaining()`, but add zero current provider/token usage. Replayed session records keep their backend/session identity and are rebound to the current call index, label, and phase.
- A root agent interrupted by `PROVIDER_USAGE_LIMIT` or `AUTH_REQUIRED` is continuation-eligible on both same-ID and `resumeFromRunId` recovery. The engine requires the exact call index, identity hash, complete input fingerprint, non-worktree isolation, identical existing cwd, coherent recorded session, and the runner's current backend/`poolKey`/reopen gates. A successful resume/load continues the unfinished turn and charges only its usage delta; every failed gate runs fresh. `fallbacks` records the reattached method or exact skip reason. No script option enables or disables this.
- Checkpoint identity replay is host-decision-only. `default`, `headless`, and `timeoutMs` form a separate options fingerprint that must match; source headless decisions run fresh. `checkpointReplies` keys always name the checkpoint index in the source run, even when identity matching injects the answer at a shifted current index.
- `resumePolicy: "positional"` is a migration escape hatch for index/prefix matching, not permission to bypass new-format input, safety, cwd, runtime, or environment gates. Marker-less/manual/same-ID legacy journals keep historical hash-only positional behavior.
- `label`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`, and `keepSession` are not identity-hashed. Changing one does not invalidate an ordinary cached replay, but these fields are in the separate input fingerprint: changing one rejects continuation of an interrupted turn and runs that occurrence fresh. Change a hashed field, normally the prompt, when an already-completed call must execute again.
- Keep call order deterministic. Derive iteration from `args` and prior agent results, never from ambient state.

Two all-live outcomes are expected calibration, not an engine error. If any source result lacks a captured path/input fact—possible when a call stack exceeds the raw-frame cap or `meta` is not strict JSON—the whole source is `"manifest-invalid"`; dropping that row could make an ambiguous sibling look unique. A Node or V8 upgrade likewise invalidates every new-format cache through exact runtime equality, while marker-less legacy journals keep historical positional replay. Any future relaxation needs a new format literal; identity-v1 bytes are never reinterpreted.

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
      { label: `review:${i + 1}`, phase: "Review", resume: { filesystem: "read-only" } },
    ),
  );
}

if (maxRounds < 8) throw new Error(`review cap ${maxRounds} reached before 8 rounds`);
return { rounds };
```

With the MCP `workflow` tool, run it first with `args: { "maxRounds": 6 }`. Then send the same
content (again via `script`, or via the absolute `scriptPath` you are editing) with
`args: { "maxRounds": 8 }` and the first result's `runId` as `resumeFromRunId`. Rounds 1–6 replay
for zero current provider tokens and only rounds 7–8 run live because the cap controls call count
but is not interpolated into the round prompt. If every round prompt included `maxRounds`, all
eight identities would change and all would run live. Resume always states its content; a bare
`resumeFromRunId` never silently reuses the old script.

- Narrate decisions and round summaries with `log()`, and give repeated calls stable, descriptive
  labels. MCP hosts can safely retrieve the latest log lines and compact results by label after a
  pause or failure; useful narration turns that inspection into a diagnosis instead of a guess.

When you run through MCP, always retain the returned `runId`. A paused, failed, or aborted response
already includes a redacted final-20 `logTail`; read it before changing the script. If the cause is
still unclear, call the same single `workflow` tool with
`{ action: "inspect", runId, lastN, labelGlob?, logLines }`. Inspection is read-only: use a narrow
label glob and latest-N tail to identify the last relevant work before deciding whether to resume,
edit, or stop. `resumeFromRunId` executes a new run; inspection does not.

Every admitted script is also an immutable MCP resource at
`workflow://runs/{runId}/script`. Run results link the new script; inspect/await link the complete
resume lineage oldest-to-newest. If a later session has lost an inline script, read that URI and
explicitly send the retrieved text as `script` with `resumeFromRunId` (and `checkpointReplies` when
recovering a durable checkpoint). Resource content is the admission snapshot, never a re-read path.

To kill, patch, and resume a live run, call
`{ action: "stop", runId, lastN?, labelGlob?, logLines? }`. The returned `aborted` snapshot is the
authoritative durable acknowledgement: resume is safe immediately and an additional await adds
nothing. Edit the file, then start a new run with its absolute `scriptPath` plus
`resumeFromRunId: runId`. The manager replays only calls whose safety and environment facts remain
provable; an in-flight stop may make the resumed run conservatively execute live, so read its
`resumeReport` instead of assuming a prefix hit.
Only backend session wind-down can remain after stop, so inspect per-agent states only if cleanup
appears hung. The stopped run frees its background slot immediately. A repeated stop of a terminal
run is a successful no-op.

Choose `background: true` for work that may outlive one MCP request. The start call returns
`{ runId, status: "running", scriptSource, scriptUri }` plus a script resource link after durable
admission; retain that new ID and normally collect with
20-second bounded calls: `{ action: "await", runId, waitMs: 20000 }`. A timeout is progress, not
failure: it returns the newest safe status and cumulative usage, so call await again. Use
`action:"inspect"` (or `waitMs:0`) when you need an immediate filtered diagnostic instead of waiting.
The background start has no enduring request channel: it returns immediately and emits no progress
after returning, even if that initiating request supplied a progress token. A later bounded
`action:"await"` is a separate request; when that await carries a progress token, it can stream
coarse phase and distinct started/ended-call progress while pending. A legacy/inconsistent-log
polling fallback still returns bounded status without progress notifications.
At terminal status await adds `outcome`, the foreground-equivalent authored result/pause context.
That outcome carries optional `fallbacks` and `checkpointsTaken`; inspect and the top-level await
status intentionally do not. It carries `scriptUri` but not the admission-only, unpersisted
`scriptSource`. `checkpointsTaken` identifies resolved live, headless-default,
journal-replay, and injected `checkpointReplies` decisions without repeating prompt text.

Background is detached from the initiating request, not from the MCP server process; a stdio child
exit can stop in-flight work. The start request has no live checkpoint elicitation, so authored
headless checkpoint modes apply. Resume only a paused durable journal: submit a new run with the
script, `resumeFromRunId`, and any `checkpointReplies`. That execution gets a new run ID and
durably inherits the complete replay prefix. Await and inspect are read-only and never resume
anything.
