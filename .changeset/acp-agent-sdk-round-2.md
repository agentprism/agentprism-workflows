---
"@automatalabs/acp-agents": major
"@automatalabs/shared-types": minor
"@automatalabs/pi-acp": patch
---

AcpAgent SDK round 2: per-agent traits, `INVALID_ARGUMENT` for SDK misuse, system-prompt discovery.

`@automatalabs/shared-types`

- New `WorkflowErrorCode.INVALID_ARGUMENT`: an SDK call (the `AcpAgent` surface) received invalid
  options or arguments, or was made in an invalid state such as after `close()`. Non-recoverable and
  distinct from `SCRIPT_VALIDATION_ERROR`, which stays the code for workflow scripts and for the
  one-shot runner / `InteractiveSession`.

`@automatalabs/acp-agents`

- **Breaking:** every error the `AcpAgent` surface raises for caller misuse now carries
  `INVALID_ARGUMENT` instead of `SCRIPT_VALIDATION_ERROR` — the constructor's pre-spawn guards (cwd,
  the reserved `"model"` config id, a malformed registry, `clientHandlers`, an unsupported
  `systemPrompt`), unknown config-option ids and modes, the per-turn schema gate, prompt images, the
  fork and cold-reopen routing rules, the lifecycle capability gates, `steer()` with no turn in
  flight, and any operation after `close()` / abort / process death. A shared validator's
  `SCRIPT_VALIDATION_ERROR` is re-coded at the agent boundary with its message, `recoverable=false`,
  `agentLabel`, and `details` preserved; the runner and `InteractiveSession` are unchanged.
- New `AcpAgentTraits` / `describeBackendTraits(backend, registry, live?)`, `agent.traits`, and the
  spawn-free static `AcpAgent.traits(spec?, { backends? })`: `backendId`, `custom`, `defaultModeId`,
  the `fork` row, `systemPrompt` (`replace` / `append` plus `source`: `table` / `declared` /
  `advertised` / `none`), `steering` / `loadedTurn` (`supported` / `not-advertised` / `unknown`),
  `structuredOutput` (`session-meta` / `turn-meta` / `client-tool`, derived from the `Backend`
  object's behavior), and `promptUsage`. The executable protocol-coverage tables answer before the
  agent opens; once the connection is up, the agent's initialize advertisements win — pi's bare
  `_meta.systemPrompt` block, the Codex fork's `agentCapabilities._meta["@automatalabs/codex-acp"]`
  block, and `initializeMeta.steering` / `loadedTurn`. The pre-open validators still read the tables.
- Discovery carries traits: `ProbedConfigOptions.traits` (`AcpAgentRunner.probeConfigOptions` and
  the SDK probe runner) and `ValidateHarnessOptions.traits` on every probed harness of
  `probeHarnessConfig` / `AcpAgent.probe()`, computed from the live probe connection. The MCP
  byte-budgeted projection is unchanged and does not carry it.
- Docs: the system-prompt tables now say what survives `replace` on each backend (Claude: nothing
  of the `claude_code` preset; pi: the append entries, project context files, skills, and cwd line;
  Codex: its other instruction layers, per the app-server protocol's documented field semantics).

`@automatalabs/pi-acp`

- README correction: a replaced system prompt drops pi's default instruction text (the tool list
  with snippets, its guidelines, the docs/examples paths); pi still appends the append entries, the
  project context files, the skills block, and the `Current working directory` line. The previous
  text wrongly claimed the tool snippets and guidelines were kept.
