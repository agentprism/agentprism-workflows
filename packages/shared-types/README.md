# @automatalabs/shared-types

> Internal package. The shared type contract every other `@automatalabs/*` package imports.
> You normally consume these **transitively** via [`@automatalabs/workflows`](../workflows) —
> you only depend on this package directly if you're **implementing a custom agent backend**.

This is the one module both the workflow engine and the agent backend import (they never
import each other). It has zero ACP/MCP/engine deps — only `typebox` (type-level) plus the
runtime `WorkflowError` class, so `instanceof` checks hold across package boundaries.

## The AgentRunner seam

`AgentRunner` is the single, frozen coupling point between the engine and any agent backend.
The engine calls exactly **one** method — `run(prompt, options)` — once per subagent:

```ts
import type { AgentRunner, RunOptions, AgentResult } from "@automatalabs/shared-types";
import type { TSchema } from "typebox";

interface AgentRunner {
  run<S extends TSchema | undefined = undefined>(
    prompt: string,
    options?: RunOptions<S>,
  ): Promise<AgentResult<S>>;
}
```

Contract, in brief:

- **`prompt`** is a positional string; **`options`** is one optional bag (defaults to `{}`).
- **Return is the RAW value, never an envelope:** `schema` present ⇒ `Static<schema>` (a
  parsed + validated object); no schema ⇒ the assistant's final text (`string`). It must be
  JSON-serializable and stable, because the engine journals it verbatim and replays it on resume.
- **Usage is delivered out-of-band** via `options.onUsage(usage)` — it is *not* in the return.
- **On failure, throw** — ideally a `WorkflowError` from this package. `recoverable` errors are
  retried then resolved to `null`; non-recoverable ones halt the run. Timeout and abort are the
  engine's job (it races a timeout and passes `options.signal`); the runner should honor the
  signal but must not implement its own timeout.

The manager has two intentional exceptions to ordinary non-recoverable failure: it converts
`PROVIDER_USAGE_LIMIT` and `AUTH_REQUIRED` into persisted, resumable `paused` results. Direct
`AgentRunner` consumers still receive the thrown error.

A minimal custom backend:

```ts
import { WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import type { AgentRunner, RunOptions, AgentResult } from "@automatalabs/shared-types";
import type { TSchema } from "typebox";

export const myRunner: AgentRunner = {
  async run<S extends TSchema | undefined = undefined>(
    prompt: string,
    options: RunOptions<S> = {},
  ): Promise<AgentResult<S>> {
    const text = await callMyBackend(prompt, { signal: options.signal });
    options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });

    if (!options.schema) {
      if (!text) {
        throw new WorkflowError("no output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
          recoverable: true,
        });
      }
      return text as AgentResult<S>;
    }
    return parseAndValidate(text, options.schema) as AgentResult<S>; // Static<schema>
  },
};
```

## Exported types

From [`src/index.ts`](./src/index.ts):

**The seam**
- `AgentRunner` — the `run(prompt, options) => result` interface above.
- `RunOptions<S>` — the options bag: `label`, `schema`, `instructions`, `signal`, `model`,
  `mode`, `tier`, `cwd`, `toolNames`, `disallowedToolNames`, `maxSchemaRetries`, `mcpServers`,
  `images`, `runId`, `backends`, `meta`, `promptMeta`, the Codex-only `baseInstructions` /
  `developerInstructions`, `keepSession`, and the out-of-band callbacks `onUsage`,
  `onModelResolved`, `onModelFallback`, `onHistory`, `onSessionOpen`.
- `AgentResult<S>` — `S extends TSchema ? Static<S> : string`.
- `AgentUsage` — per-run token/cost: `input`, `output`, `cacheRead`, `cacheWrite`, `total`, `cost`.
- `AgentRunOptions` / `AgentRunResult` — lift-compat aliases for `RunOptions` / `AgentResult`.

**Errors** (runtime, not just types)
- `WorkflowError` (class) + `WorkflowErrorCode` (enum) + `WorkflowErrorOptions`.
- `AuthErrorContext` — the non-secret backend/method summary carried by `AUTH_REQUIRED`.
- `isWorkflowError`, `isProviderUsageLimit`, `isAuthRequired`, `classifyProviderLimit`
  (guards / classifier).

**Workflow result**
- `WorkflowRunResult<T>` — the public, host-facing run result (`runId`, `status`, `meta`,
  `result`, `phases`, `agentCount`, `durationMs`, `tokenUsage?`, `logs`, `reason?`, `resetHint?`,
  `authContext?`, `agentSessions?`). Paused, failed, and aborted results additionally carry the
  optional redacted final-20 `logTail`; completed results omit it and `logs` remains the full
  compatibility array.
- `RunStatus`, `WorkflowMeta`, `WorkflowMetaPhase`, `WorkflowBackendConfig`, `TokenUsage`,
  `JournalEntry`, `AgentSessionRef`, `AgentSessionRecord`.
- `JournalCallMetadata` and optional `JournalEntry.call` — replay-neutral agent/checkpoint
  attribution (`kind`, label, phase, resolved model, actual backend). Legacy entries without it
  remain valid.
- `WorkflowRunInspectionOptions`, `WorkflowLogTail`, `WorkflowRunCallStatus`,
  `WorkflowRunStatusTruncation`, and `WorkflowRunStatus` — the shared bounded status contract used
  by SDK and MCP polling/inspection hosts.

**MCP config**
- `McpServerConfig` (union) + `McpStdioServerConfig`, `McpHttpServerConfig`,
  `McpSseServerConfig`, `McpAcpServerConfig`, `McpNameValue`.

**History & meta**
- `AgentHistoryEntry`, `AgentHistoryRole`, `AgentHistoryKind` (diagnostic, via `onHistory`).
- `META_KEYS`, `CODEX_META_KEYS`, `ClaudeCodeSessionMeta`, `ClaudeJsonSchemaOutputFormat`.

## License

Apache-2.0
