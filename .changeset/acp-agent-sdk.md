---
"@automatalabs/acp-agents": minor
"@automatalabs/shared-types": minor
"@automatalabs/workflow-engine": patch
"@automatalabs/workflows": minor
---

Add the `AcpAgent` SDK to `@automatalabs/acp-agents` (re-exported by `@automatalabs/workflows`
together with `isAcpAgentTurnError` and the `AcpAgent*` types): a lazy, one-process-per-agent front
door with FIFO turns (`prompt` returns the verbatim `PromptResponse` plus every session update, vendor
notification, tool call, permission, this turn's usage and the agent's running session usage; a typed
session failure rejects with the runner's mapped `WorkflowError` carrying the complete turn as
`error.turn`), `steer`/`cancel`, live `fork()` (id-only backends are reattached automatically —
`FORK_SESSION_TRAITS` pins claude/codex as `id-only` and opencode/pi as `live`, with dist probes;
custom backends declare `fork: { disposition }`), cold `AcpAgent.resume/load/fork(ref)` routed by the
ref's backend (never the default backend), `close({ keep })`, `Symbol.asyncDispose`, a single
process-exit hook, and `AcpAgent.probe()` returning the harness config catalog plus a models view.

- `PROMPT_USAGE_SCOPES` pins that every installed agent reports `PromptResponse.usage` per turn
  (dist-probed); `AcpAgent` sums turns into `usage.session` itself.
- `SessionHandle.promptOutcome()` returns `{ response, failure? }` without throwing on a typed session
  failure; `prompt()` is unchanged. `StructuredOutputToolRegistration.takeCaptured()` returns and clears
  the capture.
- `CustomBackendConfig.fork?: { disposition: "id-only" | "live", cwd?: "source-only" | "free" }`
  (`CustomBackendForkConfig`, validated at registry load) tells the SDK how a custom agent answers
  `session/fork`; entries wrapping claude-agent-acp or codex-acp must declare `id-only`.
- The harness config catalog (`probeHarnessConfig`, `buildHarnessModelsView`, `buildModelFilter`,
  `buildHarnessConfigSummary`, `formatHarnessConfigSummary`, the select-choice helpers,
  `HarnessConfigReport`, `ValidateHarnessOptions`, `ValidateProbeRunner`) now lives in
  `@automatalabs/acp-agents`; `@automatalabs/workflows` re-exports the same names unchanged and keeps
  `formatHarnessConfigReport` and the `config` CLI.
- `resolveModelRoute` / `ModelRoute` are exported from `@automatalabs/acp-agents` (moved out of the
  runner unchanged).
- `redactText` and `truncateUtf8` moved to `@automatalabs/shared-types` (now byte-counting with
  `TextEncoder`, no Node globals); `@automatalabs/workflow-engine` and `@automatalabs/workflows`
  re-export them unchanged.
- `Backend.rawMessagesMeta()` (optional) lets a backend switch its vendor notification stream on; the
  Claude backend implements it so schema-less `AcpAgent` sessions receive `_claude/sdkMessage` by
  default.
- The fake ACP agent fixture gains fork knobs (`idOnly`, `replay`, `turns`) and `tool_call` name
  passthrough; the pre-push hook runs the new `AcpAgent` fork/resume live leg.
