# ACP v2 readiness

**Status:** watching · **Updated:** 2026-07-10

The [ACP v2 draft](https://agentclientprotocol.com/protocol/v2/migration) was published
2026-07-08. It is a consolidation release with real breaking changes, explicitly meant to be
adopted **side by side with v1** (per-connection version negotiation, feature-flagged until
stabilization). Nothing is actionable for this codebase until the TypeScript SDK ships v2
codegen — the v2 schemas exist in the protocol repo (`schema/v2/`), but
`@agentclientprotocol/sdk` currently generates only v1 types. This item tracks readiness so
the migration is a planned train, not a scramble.

## What changes in v2 (the parts that hit this codebase)

1. **The prompt no longer owns the turn.** `session/prompt` returns an acceptance ack (`{}`);
   turn progress and completion move to `state_update` notifications
   (`running`/`idle`/`requires_action`), with the stop reason on the idle update. Turn
   completion logic in the engine and runner must be driven off notifications instead of the
   prompt response. The `requires_action` state maps naturally onto the existing
   pause-for-auth/checkpoint machinery.
2. **Updates become upserts with three-state patch semantics** (omitted = unchanged, `null` =
   cleared, value = replaced, chunks append). `tool_call` is removed (first
   `tool_call_update` creates), message IDs become required, plans get `plan_update` +
   `planId`. The shared-types normalizer needs a v2 surface, and TypeScript modeling must
   preserve the `undefined` vs `null` distinction the protocol now depends on.
3. **The client fs/terminal surface is removed.** Clients that want to offer file access or
   command execution provide an MCP server via `mcpServers` instead. Our served client-method
   surface shrinks; the MCP injection machinery already exists to carry replacements.
4. **Auth regrouped:** `authenticate` → `auth/login`, `logout` → `auth/logout` (mandatory),
   `methodId` + required `type` discriminator on auth methods.
5. **Session lifecycle baseline:** `new/list/resume/close/prompt/cancel/update` become
   required as a set; `session/load` is removed in favor of `session/resume` +
   `replayFrom: {"type": "start"}`; the modes API is removed in favor of config options
   (`category: "mode"`).
6. **Extensibility by default:** open enums everywhere with `_`-prefixed implementation
   extensions; receivers must preserve unknown values. Strict normalization needs an
   open-enum mode for v2; a legitimate `_`-namespace opens up for implementation extensions.
7. Also: role-agnostic required `info`/`capabilities` on initialize, object capability
   markers, a structured diff format (`changes[]` + optional `git_patch`), permission
   requests with required `title` and extensible `subject`, and mandatory JSON-RPC batch
   acceptance on stdio.

## Posture

- Keep v1 fully working; add a parallel v2 surface selected per connection after
  `initialize`, gated behind a feature flag until the draft stabilizes.
- Point a second schema-drift tripwire at `schema/v2/schema.json` when work starts.
- Trigger to move this item to **next**: `@agentclientprotocol/sdk` publishing v2 types.

## Upstream watch list (RFDs and draft surfaces)

| Item | State | Why it matters here |
| --- | --- | --- |
| [Remote transport](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport) | Active, v1-additive | Foundation of [remote execution](remote-execution.md); v2 adds stream resumability |
| [MCP-over-ACP](https://agentclientprotocol.com/rfds/mcp-over-acp) (`mcp/connect|message|disconnect`) | v2 unstable | Tunnels client-hosted MCP over the session connection — the endgame for remote structured-output capture |
| Elicitation (`elicitation/create|complete`) | Preview | Protocol-native structured agent→user questions; maps onto checkpoint approvals |
| `session/inject` (queue & steer) | Open RFD | Standard ACP form of mid-turn steering; until then the first-class Claude/Codex/Pi adapters expose the explicitly negotiated `_session/steering` extension |
| Subagents (discovery, delegation, parent/child sessions) | Open RFD | Standardizes territory this orchestrator occupies |
| `session/fork` | v2 unstable | The existing `forkSession` support maps directly onto it |
| Session rewind (truncate/edit history) | Open RFD | Relevant to checkpoint-restore semantics |
