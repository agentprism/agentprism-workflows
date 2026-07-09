// ClaudeBackend — drives @agentclientprotocol/claude-agent-acp@0.56.0 (over the Claude
// Agent SDK). Structured output rides the vendor `_meta.claudeCode` channel at session/new:
//   options.outputFormat = { type:"json_schema", schema }   // the SDK's native constraint
//   emitRawSDKMessages = true                                // MANDATORY to READ the result
// The parsed object lands on SDKResultSuccess.structured_output, observable ONLY off the raw
// `_claude/sdkMessage` extension notification (the runner's ACP client captures it).
import { createRequire } from "node:module";
import type { TSchema } from "typebox";
import type { ClaudeCodeSessionMeta } from "@automatalabs/shared-types";
import type { Backend, SpawnConfig, StructuredSource } from "../backend.js";
import { splitArgs } from "../backend.js";
import { claudeAuthProfile } from "../auth/auth-profiles.js";
import { toAnthropicJsonSchema } from "../schema-strict.js";

const require = createRequire(import.meta.url);

export class ClaudeBackend implements Backend {
  readonly id = "claude" as const;
  /** Pure-data claude auth profile (§3.2): terminal follows the host TTY, gateway follows `onAuth`. */
  readonly authProfile = claudeAuthProfile;

  spawnConfig(): SpawnConfig {
    const env = process.env;
    const override = env.AGENTPRISM_CLAUDE_ACP_CMD;
    if (override) {
      return { command: override, args: splitArgs(env.AGENTPRISM_CLAUDE_ACP_ARGS), env };
    }
    // Prefer the installed package's bin script run under the current node; fall back to npx
    // when it is not resolvable from this install.
    try {
      const bin = require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
      return { command: process.execPath, args: [bin], env };
    } catch {
      return { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"], env };
    }
  }

  sessionMeta(schema: TSchema | undefined): Record<string, unknown> | undefined {
    // Claude has no analog to Codex's base/developer instruction overrides, so it ignores the
    // optional SessionMetaInputs (the seam still accepts them via the Backend interface).
    if (!schema) return undefined;
    // Anthropic structured outputs accept only a JSON-Schema subset (additionalProperties:false
    // required on every object; numeric/string/array constraints rejected). Normalize the wire
    // copy so the native constraint always engages — an incompatible schema would fail the SDK
    // constraint and silently degrade the run to unconstrained text + the repair ladder.
    const meta: ClaudeCodeSessionMeta = {
      claudeCode: {
        options: {
          outputFormat: { type: "json_schema", schema: toAnthropicJsonSchema(schema) },
        },
        emitRawSDKMessages: true,
      },
    };
    return meta;
  }

  promptMeta(): Record<string, unknown> | undefined {
    // Claude's schema is session-scoped (read at session/new); nothing on the turn.
    return undefined;
  }

  nativeStructured(source: StructuredSource): unknown {
    return source.rawStructuredOutput();
  }
}
