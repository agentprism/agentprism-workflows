// CustomAcpBackend — drives ANY registered ACP agent (registry.ts), not just the built-in
// Claude/Codex pair. The generic dialect it speaks is the one this repo already publishes:
//   - schema IN:   the bare turn-level `_meta.outputSchema` (same key the @automatalabs/codex-acp
//                  fork reads), as a plain JSON Schema. An agent that honors it constrains its
//                  final message natively. When the negotiated agent advertises HTTP MCP support,
//                  the runner also injects a client-hosted StructuredOutput tool whose inputSchema
//                  carries the schema; agents that ignore both channels still work via the
//                  validate/re-prompt ladder over final text.
//   - result OUT:  JSON.parse of the final assistant message (with a balanced-block fallback),
//                  exactly like Codex — no vendor extension notification required.
//   - config-level `_meta`: the registry entry's static `sessionMeta` rides every session/new
//                  (per-call RunOptions.meta merges over it in the ACP client; backend-computed
//                  keys and the runId stamp win over both).
// SessionMetaInputs (Codex base/developer instruction overrides) are IGNORED — they are a
// codex-acp vendor contract; a custom agent's knobs travel through the generic meta channels.
import { createHash } from "node:crypto";
import type { TSchema } from "typebox";
import { META_KEYS } from "@automatalabs/shared-types";
import type { Backend, SpawnConfig, StructuredSource } from "../backend.js";
import type { RegisteredBackend } from "../registry.js";
import { toJsonSchema } from "../schema-strict.js";
import { parseFinalJson } from "../structured-output.js";

export class CustomAcpBackend implements Backend {
  readonly id: string;
  /** id + spawn-config hash: two registries (e.g. two scripts' `meta.backends`) may declare
   *  the SAME name with DIFFERENT commands — the pool must never share a process across them. */
  readonly poolKey: string;
  /** The agent may ignore the `_meta.outputSchema` forward, so the runner must also state the
   *  schema in the prompt — otherwise the model returns JSON with keys it invented and the
   *  repair ladder can never converge on a contract the model was never shown. */
  readonly embedSchemaInPrompt = true;
  readonly injectStructuredOutputTool: boolean;
  readonly customCapabilities?: NonNullable<Backend["customCapabilities"]>;

  constructor(private readonly config: RegisteredBackend) {
    this.id = config.name;
    this.injectStructuredOutputTool = config.structuredOutputTool ?? true;
    if (config.customCapabilities) this.customCapabilities = config.customCapabilities;
    const spawnIdentity = JSON.stringify({
      command: config.command,
      args: config.args ?? [],
      env: config.env ?? {},
    });
    this.poolKey = `${config.name}#${createHash("sha256").update(spawnIdentity).digest("hex").slice(0, 12)}`;
  }

  spawnConfig(): SpawnConfig {
    return {
      command: this.config.command,
      args: [...(this.config.args ?? [])],
      // Registry-declared env merges OVER the inherited environment.
      env: { ...process.env, ...(this.config.env ?? {}) },
    };
  }

  sessionMetaDefaults(): Record<string, unknown> | undefined {
    // The registry entry's static `_meta` — DEFAULTS, so per-call RunOptions.meta overrides
    // them. Return a copy so callers can merge without mutating config.
    const staticMeta = this.config.sessionMeta;
    if (!staticMeta || Object.keys(staticMeta).length === 0) return undefined;
    return { ...staticMeta };
  }

  sessionMeta(_schema: TSchema | undefined): Record<string, unknown> | undefined {
    // The schema rides the turn (see promptMeta); a custom backend has no protocol-critical
    // session/new `_meta` of its own.
    return undefined;
  }

  promptMeta(schema: TSchema | undefined): Record<string, unknown> | undefined {
    if (!schema) return undefined;
    // Plain JSON Schema (NOT OpenAI-strict-normalized — strictness is a Codex/Responses-API
    // constraint, not part of the generic dialect). Agents that ignore it are repaired by the
    // runner's ladder.
    return { [META_KEYS.outputSchema]: toJsonSchema(schema) };
  }

  nativeStructured(source: StructuredSource): unknown {
    return parseFinalJson(source.currentTurnText());
  }
}
