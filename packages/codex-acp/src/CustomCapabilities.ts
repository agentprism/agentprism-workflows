import type * as acp from "@agentclientprotocol/sdk";

/** The `agentCapabilities._meta` namespace under which this fork advertises its custom
 *  capabilities. Keyed by the fork's published package identity so callers can detect the
 *  fork's non-standard `_meta` inputs before sending them, without colliding with other
 *  extensions (ACP extensibility convention). */
export const CUSTOM_CAPABILITY_NAMESPACE = "@automatalabs/codex-acp";

/** Custom agent capabilities this fork adds on top of upstream, advertised in
 *  `agentCapabilities._meta` so callers can check availability before sending the fork's
 *  non-standard `_meta` inputs. Each flag mirrors the bare `_meta` wire key it gates:
 *  - `outputSchema`: the turn-level `session/prompt` `_meta.outputSchema` forwarded into the
 *    Codex App Server's `turn/start.outputSchema` (a strict-mode constraint on the final
 *    assistant message).
 *  - `baseInstructions` / `developerInstructions`: the session-scoped `_meta` overrides folded
 *    into the Codex `thread/start` / `thread/resume` params of the same name at
 *    `session/new` / `session/resume` / `session/load`. */
export const customAgentCapabilities: NonNullable<acp.AgentCapabilities["_meta"]> = {
    [CUSTOM_CAPABILITY_NAMESPACE]: {
        outputSchema: true,
        baseInstructions: true,
        developerInstructions: true,
    },
};
