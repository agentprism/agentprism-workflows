## Determinism and resume

Runs are journaled: every `agent()` and `checkpoint()` result is recorded under a deterministic call index. A new run may reuse eligible results from a terminal source run. Uncertainty always means live execution.

> **Resume rule:** replay is content-addressed and fail-to-live on correspondence: a completed call replays when its identity and input fingerprint match uniquely. Filesystem or world state never gates replay.

- Direct `Date.now()`, `Math.random()`, and no-arg `new Date()` / `Date()` calls fail static validation. The realm also blocks aliased or computed forms at runtime; `new Date(isoString)` is fine. Pass timestamps and random seeds through `args`.
- The replay identity of an `agent()` call hashes: the prompt, the resolved `model`, `mode` when set, `configOptions` when non-empty (sorted keys), `tier`, `phase`, `agentType`, the resolved agent definition, and `schema`. The resolved agent definition includes its tool allowlist and denylist, model, isolation, and body prompt — editing a definition invalidates the calls that use it.
- A separate input fingerprint hashes: the resolved label, per-call `cwd`, resolved isolation, `keepSession`, `images`, `mcpServers`, `meta`, `promptMeta`, and the approved script-backend digest.
- Host `agentTimeoutMs`, `agentIdleTimeoutMs`, `agentRetries`, and `concurrency`, plus per-call `timeoutMs`, `idleTimeoutMs`, and `retries`, are operational bounds. They enter neither hash and may change freely on resume. A new run resolves them from its own request; it does not inherit the source values.
- `args` is not hashed directly. New args that only raise a loop cap leave earlier identities unchanged, so those calls can replay. New args that change a prompt, model selection, phase, schema, call order, or runner-visible input make the affected calls run live. Unchanged independent calls may still replay.
- Matching tries a unique exact `(kind, call path, identity hash)` row first (`"path-hash"`), then a unique `(kind, identity hash, input fingerprint)` row, so an unchanged call can replay as `"unique-hash"` after insertions or deletions. Source and current input fingerprints must be equal. Duplicate identities, duplicate content, consumed candidates, missing facts, and empty schema-less results run live. The engine never guesses by source order or occurrence.
- Source admission requires: exact `cwd`, compatible call-path/input/checkpoint fingerprint formats, complete call/journal/allocation metadata, and a valid manifest and seed. Git HEAD and dirty digest, `environmentKey`, captured environment values, Node/V8, and producing engine version are diagnostics only. Environment differences may appear in `replayEligibility.provenanceChanges`; they never gate admission or matching.
- A completed writer replays exactly like a reader. A live call, nested workflow, host checkpoint callback, or degraded worktree does not clear unrelated candidates. Nested child calls run live — they are outside the parent's journal — while matching root calls around them still replay. The engine does not reproduce file writes; a later live agent navigates the world it finds.
- Replay costs zero current provider usage: a cached call returns its recorded result without spawning a session. Replayed session records keep their backend and session identity, rebound to the current call index, label, and phase.
- A root call interrupted by `PROVIDER_USAGE_LIMIT` or `AUTH_REQUIRED` can continue its recorded session on either resume API. Continuation requires: the exact call index, identity hash, complete input fingerprint, non-worktree isolation, identical existing cwd, a coherent recorded session, and the runner's current backend/`poolKey`/reopen gates. A successful continuation finishes the unfinished turn and charges only its usage delta. Every failed gate runs fresh, and `fallbacks` records the reopen method or the exact skip reason. No script option controls this.
- Completed checkpoint results replay when the identity and the `default`/`headless`/`timeoutMs` fingerprint match — headless results included. `checkpointReplies` keys always name the checkpoint index in the source run. A moved reply can follow intact prior correspondence; after a live divergence it must reach the exact recorded call site, so a different same-text branch cannot consume it.
- `resumePolicy: "positional"` is a migration escape hatch for index/prefix matching. It cannot bypass format, metadata, manifest, cwd, or input checks. Marker-less, manual, and same-ID legacy journals keep historical hash-only positional behavior. Input formats below 2 use the `inputs-format-legacy` positional bridge and are rewritten under the current format on the next hop. A current-format crash snapshot with a valid identity manifest uses identity matching even without terminal-environment capture.
- `label`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`, and `keepSession` are not identity-hashed: changing one does not invalidate an ordinary replay. They are in the input fingerprint: changing one rejects continuation of an interrupted turn, and that occurrence runs fresh. To force a completed call to run again, change a hashed field — normally the prompt.
- Keep call order deterministic. Derive iteration from `args` and prior agent results, never from ambient state.

Every `resumeFromRunId` result has a bounded `replayEligibility` summary. Background admission, foreground completion, both await shapes, and inspect expose the same fields: strategy, predicted replayable-prefix length, observed replayed prefix and counts, and the first non-replay when known. Active correspondence reasons include `strategy-live`, `positional-miss`, `positional-suffix`, `not-recorded`, `path-missing`, `inputs-missing`, `inputs-changed`, `ambiguous-identity`, `ambiguous-content`, `candidate-consumed`, `empty-output`, `worktree-degraded`, `seed-persistence-error`, and `resume-fatal-latch`. Older reason literals stay exported only so historical journals parse. Engine and input-format versions and environment provenance ride along as diagnostics.

An all-live outcome means correspondence could not be established — not that the world changed. Missing resume metadata, incompatible format literals, or an invalid manifest or seed disable new-format replay. If any source row lacks a captured path or input fact (possible past the raw-frame cap, or with a non-strict-JSON `meta` value), the whole source is `"manifest-invalid"`: dropping the row could make an ambiguous sibling look unique.

### Worked resume — raise a loop cap

The following workflow (shipped as `examples/resume-loop-cap.workflow.js`) requires eight reviews but lets the caller cap how many are attempted in one run:

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

Run it with `args: { "maxRounds": 6 }`. Then send the same content (via `script`, or the absolute `scriptPath` you edit) with `args: { "maxRounds": 8 }` and the first result's `runId` as `resumeFromRunId`. Rounds 1–6 replay for zero current provider tokens; only rounds 7–8 run live, because the cap controls call count but is not interpolated into the round prompt. If every round prompt included `maxRounds`, all eight identities would change and all would run live. Resume always states its content; a bare `resumeFromRunId` never silently reuses the old script.

Give repeated calls stable, descriptive labels and narrate decisions with `log()` — inspection by `labelGlob` then turns a pause or failure into a diagnosis instead of a guess.

### Kill, patch, resume

Stop the live run with `{ action: "stop", runId }`. The returned `aborted` snapshot is the durable acknowledgement: resume is safe immediately, and a further status call adds nothing. Edit the file. Start a new run with its absolute `scriptPath` and `resumeFromRunId`. Every completed call whose recorded identity and input fingerprint correspond replays, regardless of filesystem or environment drift. Read `replayEligibility` and the full `resumeReport` for the per-call decisions. A repeated stop of a terminal run is a successful no-op.

Registration, the per-action contracts, background collection, and the events resource are covered in **Running workflows** ([mcp-server-setup.md](mcp-server-setup.md)). Resume a durable checkpoint pause by re-sending the script with `resumeFromRunId` and `checkpointReplies` keyed by the source run's `checkpointContext.callIndex`.
