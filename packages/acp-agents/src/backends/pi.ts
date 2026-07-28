// PiBackend — drives @automatalabs/pi-acp, the ACP server for the pi coding agent.
// pi-acp consumes the same client-hosted StructuredOutput MCP server as other HTTP-capable agents.
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { TSchema } from "typebox";
import type { AuthProfile } from "../auth/auth-profile.js";
import type {
  Backend,
  ProviderErrorClassification,
  ProviderErrorMetadata,
  SpawnConfig,
} from "../backend.js";
import { splitArgs } from "../backend.js";
import { BUILTIN_PROTOCOL_COVERAGE } from "../protocol-coverage.js";
import { defineBuiltinBackend } from "./define.js";

const require = createRequire(import.meta.url);

const PI_AUTH_REMEDIATION: Readonly<Record<string, string>> = {
  "anthropic-api-key": "Set ANTHROPIC_API_KEY, then retry or resume the workflow.",
  "openai-api-key": "Set OPENAI_API_KEY, then retry or resume the workflow.",
  "gemini-api-key": "Set GEMINI_API_KEY, then retry or resume the workflow.",
  "xai-api-key": "Set XAI_API_KEY, then retry or resume the workflow.",
  "openrouter-api-key": "Set OPENROUTER_API_KEY, then retry or resume the workflow.",
  "pi-stored-credentials":
    "Configure pi credentials in ~/.pi/agent/auth.json, then retry or resume the workflow.",
};

/** Pi auth adaptation for provider environment keys and its ambient credential store. */
export const piAuthProfile: AuthProfile = {
  backendId: "pi",
  clientAuthCapabilities: () => ({ terminal: false, gateway: false }),
  describe: (method, base) => ({
    ...base,
    ...(PI_AUTH_REMEDIATION[method.id]
      ? { description: PI_AUTH_REMEDIATION[method.id] }
      : {}),
  }),
};

export class PiBackend implements Backend {
  readonly id = "pi" as const;

  constructor(readonly authProfile: AuthProfile = piAuthProfile) {}

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

export const piBackendDefinition = defineBuiltinBackend({
  id: "pi",
  thoughtLevelDomainSemantics: "ordered",
  authProfile: piAuthProfile,
  create: (authProfile) => new PiBackend(authProfile),
  release: {
    engine: { node: ">=22.19.0" },
    server: {
      kind: "workspace-package",
      package: "@automatalabs/pi-acp",
      path: "packages/pi-acp",
    },
    freshness: {
      npm: ["@agentclientprotocol/sdk", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
      sourceUpstreams: [],
      wrappedRuntimes: [],
    },
  },
  protocolCoverage: BUILTIN_PROTOCOL_COVERAGE.pi,
});

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
