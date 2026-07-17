// PiBackend — drives @automatalabs/pi-acp, the ACP server for the pi coding agent.
// pi-acp consumes the same client-hosted StructuredOutput MCP server as other HTTP-capable agents.
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { TSchema } from "typebox";
import type {
  Backend,
  ProviderErrorClassification,
  ProviderErrorMetadata,
  SpawnConfig,
} from "../backend.js";
import { splitArgs } from "../backend.js";
import { piAuthProfile } from "../auth/auth-profiles.js";

const require = createRequire(import.meta.url);

export class PiBackend implements Backend {
  readonly id = "pi" as const;
  /** Pure-data pi auth profile: five provider env keys plus ambient pi stored credentials. */
  readonly authProfile = piAuthProfile;
  readonly stripsRoutingPrefix = true;
  readonly embedSchemaInPrompt = true;
  readonly injectStructuredOutputTool = true;

  classifyProviderError(
    error: unknown,
    metadata?: ProviderErrorMetadata,
  ): ProviderErrorClassification | undefined {
    const providerCode = errorDataString(error, "errorKind");
    if (providerCode === "rate_limit" || providerCode === "billing_error") {
      return {
        kind: "provider_usage_limit",
        context: {
          backendId: "pi",
          source: "provider",
          providerCode,
          resetAt: metadata?.resetAt,
        },
      };
    }
    // auth_error is reserved to the server's -32000 authRequired response and is classified
    // before this hook. provider_error remains a recoverable execution failure.
    return undefined;
  }

  spawnConfig(): SpawnConfig {
    const env = process.env;
    const override = env.AGENTPRISM_PI_ACP_CMD;
    if (override) {
      return { command: override, args: splitArgs(env.AGENTPRISM_PI_ACP_ARGS), env };
    }

    try {
      // The package's side-effect-free main is dist/lib.js; its declared bin is the sibling
      // dist/index.js. Run that resolved package bin under this process's Node executable.
      const library = require.resolve("@automatalabs/pi-acp");
      const bin = join(dirname(library), "index.js");
      return { command: process.execPath, args: [bin], env };
    } catch {
      return { command: "npx", args: ["-y", "@automatalabs/pi-acp"], env };
    }
  }

  sessionMeta(): Record<string, unknown> | undefined {
    return undefined;
  }

  promptMeta(_schema: TSchema | undefined): Record<string, unknown> | undefined {
    return undefined;
  }
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
