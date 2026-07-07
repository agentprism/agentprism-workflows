# @automatalabs/mcp-server

## 0.3.15

### Patch Changes

- Updated dependencies [b94b824]
  - @automatalabs/shared-types@0.11.0
  - @automatalabs/workflows@0.17.0

## 0.3.14

### Patch Changes

- Updated dependencies [f743d0f]
  - @automatalabs/shared-types@0.10.0
  - @automatalabs/workflows@0.16.0

## 0.3.13

### Patch Changes

- Updated dependencies [8768dc5]
  - @automatalabs/workflows@0.15.0

## 0.3.12

### Patch Changes

- Updated dependencies [f1a42fb]
  - @automatalabs/workflows@0.14.0

## 0.3.11

### Patch Changes

- Updated dependencies [8fea18f]
  - @automatalabs/shared-types@0.9.0
  - @automatalabs/workflows@0.13.0

## 0.3.10

### Patch Changes

- Updated dependencies [d637882]
  - @automatalabs/workflows@0.12.0

## 0.3.9

### Patch Changes

- Updated dependencies [efa034a]
  - @automatalabs/workflows@0.11.0

## 0.3.8

### Patch Changes

- @automatalabs/workflows@0.10.1

## 0.3.7

### Patch Changes

- cd20994: Integrator hygiene: `recoverStaleRuns()` is now gated on the manager's `journaling` default — a `journaling: false` WorkflowManager (host keeps its own transcript/audit store) never rewrites persisted run state that belongs to journaling processes. All five published manifests now declare `engines.node >= 22` (previously only the private workspace root did).
- Updated dependencies [cd20994]
- Updated dependencies [cd20994]
  - @automatalabs/shared-types@0.8.0
  - @automatalabs/workflows@0.10.0

## 0.3.6

### Patch Changes

- Updated dependencies [1597c87]
  - @automatalabs/workflows@0.9.0

## 0.3.5

### Patch Changes

- @automatalabs/workflows@0.8.1

## 0.3.4

### Patch Changes

- Updated dependencies [dab0568]
  - @automatalabs/workflows@0.8.0

## 0.3.3

### Patch Changes

- Updated dependencies [bb771df]
  - @automatalabs/workflows@0.7.0

## 0.3.2

### Patch Changes

- Updated dependencies [96c6429]
  - @automatalabs/shared-types@0.7.0
  - @automatalabs/workflows@0.6.2

## 0.3.1

### Patch Changes

- Updated dependencies [e560e70]
  - @automatalabs/shared-types@0.6.0
  - @automatalabs/workflows@0.6.1

## 0.3.0

### Minor Changes

- a8c5453: Script-declared backends (`meta.backends`) — a workflow script can now declare the custom ACP backends it needs, making workflows self-contained artifacts and letting agent-authored workflows bring their own ACP servers.

  - **`meta.backends`**: `{ <name>: { command, args?, env?, sessionMeta? } }` in the script's meta block; route with `agent(p, { model: "<name>" })` or `"<name>/<inner-model>"`. The engine parses and validates the block but NEVER acts on it — script backends are inert until a composition root approves them (secure-by-default at every layer). Host-registered names always win on conflict.
  - **SDK approval**: `runDynamicWorkflow(script, { allowScriptBackends: true })` or a per-backend callback; unapproved declarations throw with guidance and a declined backend aborts the run (never a silent reroute). Lower-level callers thread pre-approved registries via `exec.scriptBackends`.
  - **MCP server approval**: clients that advertise the elicitation capability are asked to approve each unique spawn config (command/args/env shown; approvals session-sticky; an elicitation failure is a deny). Non-eliciting clients get an informative tool error naming the `AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1` env opt-in.
  - **Pool correctness**: pooled connections are now keyed by spawn-config hash (`Backend.poolKey`), so two runs declaring the same backend NAME with different COMMANDS never share a process.
  - **Handshake deadline**: the one-time ACP `initialize` now has a timeout (`AGENTPRISM_ACP_INIT_TIMEOUT_MS`, default 60s) — a configured command that is not an ACP server fails fast with a legible error instead of hanging the first call.

### Patch Changes

- Updated dependencies [a8c5453]
  - @automatalabs/shared-types@0.5.0
  - @automatalabs/workflows@0.6.0

## 0.2.1

### Patch Changes

- @automatalabs/workflows@0.5.1

## 0.2.0

### Minor Changes

- 3395bbf: Custom ACP backends + generic `_meta` passthrough — run **any** ACP agent as an `agent()` target, not just the built-in Claude/Codex pair.

  - **Backend registry**: register named ACP backends via `createAcpRunner({ backends: { name: { command, args?, env?, sessionMeta? } } })` or the `AGENTPRISM_BACKENDS` env var (JSON, same shape; the programmatic option wins per name; `claude`/`codex` reserved). Registered names route `model`/`tier` specs **before** the built-in heuristics: `model: "browser"` routes to the backend; `model: "browser/vision-large"` additionally selects `vision-large` from the agent's config-option catalog. `AGENTPRISM_DEFAULT_BACKEND` may name a registered backend. Custom backends speak the published generic dialect: a `schema` is forwarded as turn-level `_meta.outputSchema` (plain JSON Schema) and the result is JSON-parsed off the final assistant message, with the client-side validate/re-prompt ladder as the repair path.
  - **Generic `_meta` passthrough**: `RunOptions.meta` / `RunOptions.promptMeta` (script-level `agent(p, { meta, promptMeta })`) merge into the outgoing ACP `session/new` / `session/prompt` `_meta`, so workflows can drive any ACP agent's custom extension surface. Precedence: a custom backend's static `sessionMeta` defaults < per-call `meta` < backend protocol-critical keys (schema channels, Codex instruction forwards) < the engine `runId` stamp. Both fields are additive run inputs and never enter the resume identity hash — resume keys stay stable across meta changes.

### Patch Changes

- Updated dependencies [3395bbf]
  - @automatalabs/shared-types@0.4.0
  - @automatalabs/workflows@0.5.0

## 0.1.6

### Patch Changes

- 087e566: Docs-only: refresh package READMEs so npmjs.org reflects the current state — drop stale
  "pre-release / install from source" framing (the packages are published), and complete the
  `RunOptions` field lists (`baseInstructions` / `developerInstructions` on shared-types, `runId`
  on acp-agents). No code or API changes.
- Updated dependencies [087e566]
  - @automatalabs/shared-types@0.3.1
  - @automatalabs/workflows@0.4.1

## 0.1.5

### Patch Changes

- Updated dependencies [f2948b3]
  - @automatalabs/shared-types@0.3.0
  - @automatalabs/workflows@0.4.0

## 0.1.4

### Patch Changes

- Updated dependencies [93e4906]
  - @automatalabs/shared-types@0.2.0
  - @automatalabs/workflows@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [548815f]
  - @automatalabs/workflows@0.2.0

## 0.1.2

### Patch Changes

- f65e7a7: Per-package READMEs; mcp-server now consumes the @automatalabs/workflows SDK.
- Updated dependencies [f65e7a7]
  - @automatalabs/shared-types@0.1.2
  - @automatalabs/workflows@0.1.2

## 0.1.1

### Patch Changes

- b8303f6: Validate the OIDC trusted-publishing release pipeline (no functional changes).
- Updated dependencies [b8303f6]
  - @automatalabs/shared-types@0.1.1
  - @automatalabs/workflow-engine@0.1.1
  - @automatalabs/acp-agents@0.1.1
