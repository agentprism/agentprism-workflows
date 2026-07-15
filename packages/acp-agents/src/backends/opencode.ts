// OpenCodeBackend — drives the OpenCode ACP server (`opencode acp`). OpenCode does not expose
// a native structured-output result channel and ignores request._meta today, so the backend uses
// the repo's generic schema dialect plus prompt embedding. When OpenCode advertises HTTP MCP, the
// runner can also inject the client-hosted StructuredOutput MCP tool.
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { TSchema } from "typebox";
import { META_KEYS } from "@automatalabs/shared-types";
import type {
  Backend,
  ProviderErrorClassification,
  ProviderErrorMetadata,
  SpawnConfig,
  StructuredSource,
} from "../backend.js";
import { splitArgs } from "../backend.js";
import { opencodeAuthProfile } from "../auth/auth-profiles.js";
import { toJsonSchema } from "../schema-strict.js";
import { parseFinalJson } from "../structured-output.js";

const require = createRequire(import.meta.url);

export class OpenCodeBackend implements Backend {
  readonly id = "opencode" as const;
  /** Pure-data opencode auth profile (§3.4): terminal follows the host TTY; no gateway/logout. */
  readonly authProfile = opencodeAuthProfile;
  readonly stripsRoutingPrefix = true;
  readonly embedSchemaInPrompt = true;
  readonly injectStructuredOutputTool = true;

  classifyProviderError(
    error: unknown,
    metadata?: ProviderErrorMetadata,
  ): ProviderErrorClassification | undefined {
    const statusCode = errorDataNumber(error, "statusCode");
    if (statusCode === 429) return providerUsageLimit("http_429", "provider", metadata);
    if (isUsageCreditsError(error)) {
      // OpenCode 1.17's ACP error data exposes only the generic `APIError` name and drops the
      // provider status/body. This narrow boundary fallback covers the live #149 wording.
      return providerUsageLimit(undefined, "adapter_fallback", metadata);
    }
    return undefined;
  }

  spawnConfig(): SpawnConfig {
    const env = process.env;
    const override = env.AGENTPRISM_OPENCODE_ACP_CMD;
    if (override) {
      return { command: override, args: splitArgs(env.AGENTPRISM_OPENCODE_ACP_ARGS), env };
    }

    const bin = resolveOpenCodePackageBin();
    return { command: bin ?? "opencode", args: ["acp"], env };
  }

  sessionMeta(): Record<string, unknown> | undefined {
    // OpenCode ignores session _meta today; there is no protocol-critical session channel.
    return undefined;
  }

  promptMeta(schema: TSchema | undefined): Record<string, unknown> | undefined {
    if (!schema) return undefined;
    // Plain JSON Schema in the repo's generic dialect. OpenCode ignores it today, but forwarding
    // is harmless and keeps the backend ready if it starts honoring this extension.
    return { [META_KEYS.outputSchema]: toJsonSchema(schema) };
  }

  nativeStructured(source: StructuredSource): unknown {
    // Final assistant message only — never the whole-turn concatenation (a schema-shaped
    // progress message earlier in the turn must not win over the result).
    return parseFinalJson(source.finalMessageText());
  }
}

function providerUsageLimit(
  providerCode: string | undefined,
  source: "provider" | "adapter_fallback",
  metadata: ProviderErrorMetadata | undefined,
): ProviderErrorClassification {
  return {
    kind: "provider_usage_limit",
    context: {
      backendId: "opencode",
      source,
      providerCode,
      resetAt: metadata?.resetAt,
    },
  };
}

function errorDataNumber(error: unknown, key: string): number | undefined {
  try {
    if (!error || typeof error !== "object") return undefined;
    const data = (error as { data?: unknown }).data;
    if (!data || typeof data !== "object") return undefined;
    const value = (data as Record<string, unknown>)[key];
    return typeof value === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

function isUsageCreditsError(error: unknown): boolean {
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

function resolveOpenCodePackageBin(): string | undefined {
  try {
    return require.resolve("opencode-ai/bin/opencode");
  } catch {
    // The package may block direct bin subpath resolution through exports; fall back to the
    // package root plus its documented bin entry.
  }

  try {
    const packageJson = require.resolve("opencode-ai/package.json");
    return join(dirname(packageJson), "bin", "opencode");
  } catch {
    return undefined;
  }
}
