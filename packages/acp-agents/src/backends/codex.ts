// CodexBackend — drives the installed npm dep @automatalabs/codex-acp, a published fork of
// @agentclientprotocol/codex-acp that bakes in the outputSchema patch. The patch forwards
// request._meta["outputSchema"] into the Codex App Server's turn/start.outputSchema,
// which the shipped @openai/codex binary honors end-to-end as an OpenAI Responses-API STRICT
// constraint on the final assistant message. So the schema rides per-PROMPT `_meta` (not
// session/new), normalized to OpenAI strict rules first. Output needs no special channel: the
// constrained final message flows back over the normal agent-message stream, so the backend
// reads the final text and JSON.parses it.
import { createRequire } from "node:module";
import type { TSchema } from "typebox";
import { CODEX_CUSTOM_CAPABILITY_NAMESPACE, CODEX_META_KEYS, META_KEYS } from "@automatalabs/shared-types";
import type { Backend, SessionMetaInputs, SpawnConfig, StructuredSource } from "../backend.js";
import { splitArgs } from "../backend.js";
import { GATED_CUSTOM_META_KEYS } from "../capabilities.js";
import { toStrictJsonSchema } from "../schema-strict.js";
import { parseFinalJson } from "../structured-output.js";

const require = createRequire(import.meta.url);

export class CodexBackend implements Backend {
  readonly id = "codex" as const;
  readonly customCapabilities = {
    namespace: CODEX_CUSTOM_CAPABILITY_NAMESPACE,
    gatedKeys: GATED_CUSTOM_META_KEYS,
  } as const;

  spawnConfig(): SpawnConfig {
    const env = process.env;
    const override = env.AGENTPRISM_CODEX_ACP_CMD;
    if (override) {
      return { command: override, args: splitArgs(env.AGENTPRISM_CODEX_ACP_ARGS), env };
    }
    // Run the installed codex-acp under the current node. AGENTPRISM_CODEX_ACP_BIN overrides the
    // resolved path; otherwise resolve the package's main (dist/index.js) from node_modules so it
    // ships on a clean `git clone && pnpm install` (the @automatalabs/codex-acp fork already bakes
    // in the outputSchema patch). Works from both src/ and the compiled dist/.
    const bin =
      env.AGENTPRISM_CODEX_ACP_BIN ?? require.resolve("@automatalabs/codex-acp");
    return { command: process.execPath, args: [bin], env };
  }

  sessionMeta(_schema: TSchema | undefined, inputs?: SessionMetaInputs): Record<string, unknown> | undefined {
    // Codex carries the SCHEMA on the turn (see promptMeta), so nothing schema-related rides
    // session/new. But the optional base/developer instruction overrides ARE session-scoped: the
    // @automatalabs/codex-acp fork reads these bare `_meta` keys and threads them into
    // thread/start.{baseInstructions,developerInstructions}. Emit them only when set so an
    // unconfigured run sends no `_meta` at all (preserving the "Codex default" path).
    const meta: Record<string, unknown> = {};
    if (inputs?.baseInstructions !== undefined) meta[CODEX_META_KEYS.baseInstructions] = inputs.baseInstructions;
    if (inputs?.developerInstructions !== undefined) meta[CODEX_META_KEYS.developerInstructions] = inputs.developerInstructions;
    return Object.keys(meta).length > 0 ? meta : undefined;
  }

  promptMeta(schema: TSchema | undefined): Record<string, unknown> | undefined {
    if (!schema) return undefined;
    return { [META_KEYS.outputSchema]: toStrictJsonSchema(schema) };
  }

  nativeStructured(source: StructuredSource): unknown {
    // The constrained final message is pure JSON; parse it directly, with a balanced-block
    // fallback if the turn also emitted leading prose.
    return parseFinalJson(source.currentTurnText());
  }
}
