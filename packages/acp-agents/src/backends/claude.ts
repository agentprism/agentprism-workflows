// ClaudeBackend — drives @agentclientprotocol/claude-agent-acp@0.59.0 (over the Claude
// Agent SDK). Structured output rides the vendor `_meta.claudeCode` channel at session/new:
//   options.outputFormat = { type:"json_schema", schema }   // the SDK's native constraint
//   emitRawSDKMessages = true                                // MANDATORY to READ the result
// The parsed object lands on SDKResultSuccess.structured_output, observable ONLY off the raw
// `_claude/sdkMessage` extension notification (the runner's ACP client captures it).
import { createRequire } from "node:module";
import type { TSchema } from "typebox";
import type { ClaudeCodeSessionMeta } from "@automatalabs/shared-types";
import type { AuthProfile } from "../auth/auth-profile.js";
import type {
  Backend,
  ProviderErrorClassification,
  ProviderErrorMetadata,
  SpawnConfig,
  StructuredSource,
} from "../backend.js";
import { splitArgs } from "../backend.js";
import { BUILTIN_PROTOCOL_COVERAGE } from "../protocol-coverage.js";
import { toAnthropicJsonSchema } from "../schema-strict.js";
import { defineBuiltinBackend } from "./define.js";

const require = createRequire(import.meta.url);

/** Claude auth adaptation: terminal follows host TTY and gateway follows the host resolver. */
export const claudeAuthProfile: AuthProfile = {
  backendId: "claude",
  clientAuthCapabilities: ({ onAuth, terminal }) => ({ terminal, gateway: onAuth }),
  describe: (_method, base) => base,
  buildMeta: (_method, resolution) => resolution.meta,
};

export class ClaudeBackend implements Backend {
  readonly id = "claude" as const;

  constructor(readonly authProfile: AuthProfile = claudeAuthProfile) {}

  classifyProviderError(
    error: unknown,
    metadata?: ProviderErrorMetadata,
  ): ProviderErrorClassification | undefined {
    const providerCode = errorDataString(error, "errorKind");
    if (providerCode === "rate_limit" || providerCode === "billing_error") {
      return providerUsageLimit(providerCode, "provider", metadata);
    }
    if (providerCode === undefined && isLegacyUsageCreditsError(error)) {
      // Boundary fallback for older/non-conformant claude-agent-acp processes that predate the
      // typed `data.errorKind` field. Keep this live #149 wording out of generic control flow.
      return providerUsageLimit(undefined, "adapter_fallback", metadata);
    }
    return undefined;
  }

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

export const claudeBackendDefinition = defineBuiltinBackend({
  id: "claude",
  authProfile: claudeAuthProfile,
  create: (authProfile) => new ClaudeBackend(authProfile),
  release: {
    engine: { node: ">=22" },
    server: {
      kind: "npm-package",
      package: "@agentclientprotocol/claude-agent-acp",
    },
    freshness: {
      npm: [
        "@agentclientprotocol/sdk",
        "@agentclientprotocol/claude-agent-acp",
      ],
      forks: [],
      wrappedRuntimes: [
        {
          adapterPackage: "@agentclientprotocol/claude-agent-acp",
          runtimePackage: "@anthropic-ai/claude-agent-sdk",
        },
      ],
    },
  },
  protocolCoverage: BUILTIN_PROTOCOL_COVERAGE.claude,
});

function providerUsageLimit(
  providerCode: string | undefined,
  source: "provider" | "adapter_fallback",
  metadata: ProviderErrorMetadata | undefined,
): ProviderErrorClassification {
  return {
    kind: "provider_usage_limit",
    context: {
      backendId: "claude",
      source,
      providerCode,
      resetAt: metadata?.resetAt,
    },
  };
}

function errorDataString(error: unknown, key: string): string | undefined {
  try {
    if (!error || typeof error !== "object") return undefined;
    const data = (error as { data?: unknown }).data;
    if (!data || typeof data !== "object") return undefined;
    const value = (data as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function isLegacyUsageCreditsError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("out of usage credits") || message.includes("/usage-credits");
}

function errorMessage(error: unknown): string {
  try {
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    return "";
  }
  return typeof error === "string" ? error : "";
}
