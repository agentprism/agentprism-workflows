## Determinism and resume

Runs are journaled: every `agent()` and `checkpoint()` result is recorded under a deterministic call index. A new run may reuse eligible results from a terminal source, but uncertainty always means live execution.

> **Resume rule:** replay is content-addressed and fail-to-live on correspondence: a completed call replays when its identity and input fingerprint match uniquely. Filesystem or world state never gates replay.

- Direct `Date.now()`, `Math.random()`, and no-arg `new Date()` / `Date()` calls fail static validation. The realm also blocks aliased or computed forms at runtime (`new Date(isoString)` is fine). Need a timestamp or random seed? Pass it through `args`.
- An `agent()` replay identity hashes the prompt, resolved `model`, `mode` when set, `configOptions` when non-empty (with sorted keys), `tier`, `phase`, `agentType`, the resolved agent definition, and `schema`. An omitted or empty config bag preserves existing hash bytes. The resolved definition covers its tool allowlist/denylist, model, isolation, and body prompt, so editing an agent definition invalidates calls that use it.
- A separate execution-input fingerprint hashes the resolved label, per-call `cwd`, resolved isolation, `keepSession`, `images`, `mcpServers`, `meta`, `promptMeta`, and the approved script-backend digest. Host `agentTimeoutMs`, `agentRetries`, and `concurrency`, plus per-call `timeoutMs` and `retries`, are operational bounds: they enter neither identity nor the input fingerprint and may change freely on resume. A new run resolves them from its own request instead of inheriting the source values.
- `args` is not hashed directly. If new args only raise a loop cap, earlier calls with the same identities and input fingerprints can replay. If new args change a prompt, model selection, phase, schema, call order, or runner-visible input, affected calls run live; unchanged independent calls may still replay.
- Identity matching first tries a unique exact `(kind, call path, identity hash)` row (`"path-hash"`), then a unique `(kind, identity hash, input fingerprint)` row so unchanged calls can replay as `"unique-hash"` after insertions/deletions. Source and current input fingerprints must be equal. Duplicate exact identities, duplicate content, consumed candidates, missing facts, and empty schema-less results run live—no source-order or occurrence guess.
- Source admission requires exact `cwd`, compatible call-path/input/checkpoint fingerprint formats, complete call/journal/allocation metadata, and a valid manifest/seed. Git HEAD/dirty digest, `environmentKey`, captured start/terminal environment values, Node/V8, and producing engine version are diagnostics only. Provenance compares the recorded terminal environment (or start environment when no terminal capture exists) with the current environment; differences may appear in `replayEligibility.provenanceChanges` but never gate admission or matching.
- A completed matching writer replays exactly like a reader. A live call, nested workflow, host checkpoint callback, or degraded worktree does not clear unrelated candidates. Nested child calls themselves run live because they are outside the parent's journal; matching root calls around them remain replayable. The engine does not reproduce file writes or decide whether the live world is safe—that is deliberately left to the live agent's intelligence.
- Identity replay preserves budget-driven control flow: cached agents add their source logical debit to `budget.spent()`/`remaining()`, but add zero current provider/token usage. Replayed session records keep their backend/session identity and are rebound to the current call index, label, and phase.
- A root agent interrupted by `PROVIDER_USAGE_LIMIT` or `AUTH_REQUIRED` is continuation-eligible on both same-ID and `resumeFromRunId` recovery. The engine requires the exact call index, identity hash, complete input fingerprint, non-worktree isolation, identical existing cwd, coherent recorded session, and the runner's current backend/`poolKey`/reopen gates. A successful resume/load continues the unfinished turn and charges only its usage delta; every failed gate runs fresh. `fallbacks` records the reattached method or exact skip reason. No script option enables or disables this.
- Completed checkpoint results replay when identity and the `default`/`headless`/`timeoutMs` fingerprint match, including headless results. `checkpointReplies` keys always name the checkpoint index in the source run. A moved reply can follow intact prior journal correspondence; after a prior live divergence it must reach the exact recorded call site, so a different same-text branch cannot consume it.
- `resumePolicy: "positional"` is a migration escape hatch for index/prefix matching, not permission to bypass new-format format, metadata, manifest, cwd, or input checks. It does not require safety annotations. Marker-less/manual/same-ID legacy journals keep historical hash-only positional behavior. A current-format crash snapshot with a valid identity manifest uses identity matching even without a terminal environment; old input formats use the `inputs-format-legacy` hash-only positional bridge and are rewritten under the current format for the next hop. A carried prefix from a ≤0.23 resume hop is eligible when each row is unscoped, scoped to the immediate source, or scoped to an ancestor run still persisted beside it. Engine-minted nested scopes and deleted ancestor scopes are excluded.
- `label`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`, and `keepSession` are not identity-hashed. Changing one does not invalidate an ordinary cached replay, but these fields are in the separate input fingerprint: changing one rejects continuation of an interrupted turn and runs that occurrence fresh. Change a hashed field, normally the prompt, when an already-completed call must execute again.
- Keep call order deterministic. Derive iteration from `args` and prior agent results, never from ambient state.

Every `resumeFromRunId` result has a bounded `replayEligibility` summary. MCP background admission, foreground completion, both await shapes, and inspect expose the same strategy, predicted replayable-prefix length, observed replayed prefix/counts, and first non-replay when one is known. Active correspondence reasons include `strategy-live`, `positional-miss`, `positional-suffix`, `not-recorded`, `path-missing`, `inputs-missing`, `inputs-changed`, `ambiguous-identity`, `ambiguous-content`, `candidate-consumed`, `empty-output`, `worktree-degraded`, `seed-persistence-error`, and `resume-fatal-latch`. Older safety/world reason literals remain exported only so historical journals and consumers parse. Engine/input-format versions and environment/Node/V8 provenance appear alongside the report as diagnostics.

An all-live outcome is expected when correspondence cannot be established, not when the world changed. Missing resume metadata, incompatible format literals, or an invalid manifest/seed can disable new-format replay. If any source result lacks a captured path/input fact—possible when a call stack exceeds the raw-frame cap or `meta` is not strict JSON—the whole source is `"manifest-invalid"`; dropping that row could make an ambiguous sibling look unique. Identity-v1 fingerprint bytes are never reinterpreted: format-1 sources enter the input-format bridge, and a format greater than the current format is `"runtime-mismatch"`.

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
`{ action: "inspect", runId, lastN, labelGlob?, logLines }`. Inspection never executes the script or
spends tokens; a cold dead-owner row may be lease-reconciled to `paused` / `interrupted`. Use a
narrow label glob and latest-N tail to identify the last relevant work before deciding whether to
resume, edit, or stop. `resumeFromRunId` executes a new run; inspection does not.

Every admitted script is also an immutable MCP resource at
`workflow://runs/{runId}/script`. Run results link the new script; inspect/await link the complete
resume lineage oldest-to-newest. If a later session has lost an inline script, read that URI and
explicitly send the retrieved text as `script` with `resumeFromRunId` (and `checkpointReplies` when
recovering a durable checkpoint). Resource content is the admission snapshot, never a re-read path.

To kill, patch, and resume a live run, call
`{ action: "stop", runId, lastN?, labelGlob?, logLines? }`. The returned `aborted` snapshot is the
authoritative durable acknowledgement: resume is safe immediately and an additional await adds
nothing. Edit the file, then start a new run with its absolute `scriptPath` plus
`resumeFromRunId: runId`. The manager replays every completed call whose recorded identity and
input fingerprint correspond, regardless of filesystem or environment drift. Read
`replayEligibility` and the full `resumeReport` to see correspondence decisions.
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
durably inherits the complete replay prefix. Await and inspect never execute or resume the script;
their cold preflight may only reconcile dead-owner status.
