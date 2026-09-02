# Canonical workflow resume action

Status: **implemented MCP contract**.

## Scope

The model-facing `workflow` tool has a simple stored-content new-run action:

```ts
interface WorkflowResumeToolInput {
  action: "resume";
  runId: string;
  args?: unknown;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  resumePolicy?: "auto" | "positional";
  checkpointReplies?: Record<number, unknown>;
  background?: boolean;
}
```

`runId` always names an existing source. The action never resumes that ID in place: it submits a
new manager execution with `resumeFromRunId` set to the source and returns the fresh target ID. The
manager persists the ordinary `resumeSourceRunId` lineage, inherited replay seed, eligibility, and
terminal report. The source remains immutable.

The server loads the source from its project store and uses the exact persisted script. Omitted
`args` uses the persisted strict-JSON args; an explicit JSON value, including `null`, replaces them.
When the stored value is needed, `argsUnreplayable` fails directly before validation or target
creation. An explicit replacement does not read the unreplayable value. Missing source records,
unreadable/corrupt persistence, and missing/unreadable persisted scripts likewise fail directly and
never silently start live.

Resume accepts only the new run's operational execution overrides, replay policy, durable
checkpoint replies, and background choice. It never copies source limits. Omitted limits resolve
through the current manager defaults exactly like an ordinary new run. `projectDir`, `script`,
`scriptPath`, and `resumeFromRunId` are forbidden on this simple branch because the source `runId`
selects the project, content, and lineage.

## Source lifecycle and replay

Completed, failed, aborted, and resumable paused sources are eligible when their persisted data
passes normal journal-integrity checks. Terminal abort status and `abortSignaled` are diagnostic,
not run-wide replay gates. Completed matching calls from an aborted source therefore retain normal
content-addressed replay and zero current provider usage. Interrupted, failed, ambiguous, changed,
or otherwise uncorrespondable occurrences run live under the existing fail-to-live matcher.

Checkpoint pauses use the same action with `checkpointReplies` keyed by the source
`checkpointContext.callIndex`. Background resume performs the normal critical initial save before
acknowledging. A fresh server process can hydrate and resume the same persisted source without any
in-memory source state.

## Advanced edited replay and compatibility

The existing Run action remains the advanced path:

```ts
{
  action: "run",
  script?: string,
  scriptPath?: string,
  args?: unknown,
  resumeFromRunId: string,
  // ordinary new-run overrides
}
```

Run still requires exactly one explicit content source. This preserves edited-script and
edited-args replay, including kill-patch-resume. It uses the same manager-owned matcher, lineage,
zero-current-usage replay behavior, and operational non-inheritance.

The output's admission-only `scriptSource` union adds `"stored"` for direct foreground and
background simple-resume responses. Later status cannot infer an admission source and continues to
omit that field. MCP Apps must use the result's new `runId` for resume calls, never the input's
source ID.

The completed action train publishes a strict seven-action Zod `oneOf`. Resume is one object branch
with required literal `action` and `runId`, only its optional args/new-run/replay fields, and
`additionalProperties:false`; script/project/status/result/control fields therefore fail at the
MCP schema boundary. The same canonical Zod union performs runtime validation.

## Verification

Focused coverage pins stored-script/default-args replay, explicit args and operational overrides,
fresh IDs and lineage, completed/failed/aborted/checkpoint-paused sources, missing and unreadable
content, unreplayable default args, background admission, zero-usage replay, and persistence restart.
