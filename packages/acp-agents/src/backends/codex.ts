// CodexBackend — drives the workspace package @automatalabs/codex-acp (packages/codex-acp), our
// maintained fork of @agentclientprotocol/codex-acp imported as a non-squashed subtree (#282),
// which bakes in the outputSchema patch. The patch forwards
// request._meta["outputSchema"] into the Codex App Server's turn/start.outputSchema,
// which the shipped @openai/codex binary honors as an OpenAI Responses-API STRICT constraint —
// applied to EVERY sampled assistant message in the turn (field-verified), not only the last:
// intermediate progress messages between tool calls come back schema-shaped too. So the schema
// rides per-PROMPT `_meta` (not session/new), normalized to OpenAI strict rules first, and
// extraction reads ONLY the turn's final assistant message off the normal agent-message stream —
// a whole-turn scan would pick up a progress object instead of the result.
import { createRequire } from "node:module";
import type { TSchema } from "typebox";
import { CODEX_META_KEYS, META_KEYS } from "@automatalabs/shared-types";
import type { AuthProfile } from "../auth/auth-profile.js";
import type {
  Backend,
  ProviderErrorClassification,
  ProviderErrorMetadata,
  SessionMetaInputs,
  SpawnConfig,
  StructuredSource,
} from "../backend.js";
import { splitArgs } from "../backend.js";
import { BUILTIN_PROTOCOL_COVERAGE } from "../protocol-coverage.js";
import { toStrictJsonSchema } from "../schema-strict.js";
import { parseFinalJson } from "../structured-output.js";
import { TYPED_SESSION_FAILURE_CLIENT_CAPABILITY } from "../typed-failures.js";
import { defineBuiltinBackend } from "./define.js";

const require = createRequire(import.meta.url);

/** Codex auth adaptation, including its existing spawn-time pre-auth environment channel. */
export const codexAuthProfile: AuthProfile = {
  backendId: "codex",
  clientAuthCapabilities: ({ onAuth }) => ({ terminal: false, gateway: onAuth }),
  describe: (_method, base) => base,
  buildMeta: (_method, resolution) => resolution.meta,
  spawnAuthEnv: (intent) => {
    if (intent.methodId !== "api-key" && intent.methodId !== "gateway") return undefined;
    const meta = intent.authenticateMeta;
    return {
      DEFAULT_AUTH_REQUEST: JSON.stringify({
        methodId: intent.methodId,
        ...(meta ? { _meta: meta } : {}),
      }),
    };
  },
};

export class CodexBackend implements Backend {
  readonly id = "codex" as const;
  readonly defaultModeId = "agent" as const;

  constructor(readonly authProfile: AuthProfile = codexAuthProfile) {}

  /** Turn on codex-acp's negotiated typed-session-failures extension at `initialize` (see
   *  typed-failures.ts). Truthful: SessionHandle consumes BOTH delivery channels the server opens
   *  in response — the terminal failure on `PromptResponse._meta` and the asynchronous one on
   *  `session_info_update`. An older codex-acp ignores the block and keeps its legacy behavior. */
  readonly clientCapabilityMeta = TYPED_SESSION_FAILURE_CLIENT_CAPABILITY;

  /** The LEGACY (thrown) provider-wall channel. Still load-bearing with the typed extension
   *  negotiated: it classifies every rejection the typed channel does not cover — an older
   *  codex-acp, and any `session/prompt` rejection raised outside a turn's terminal-failure path
   *  (the server converts only process-exit / unexpected throws into typed responses). The typed
   *  channel's own equivalents are mapped by `mapTypedSessionFailure`. */
  classifyProviderError(
    error: unknown,
    metadata?: ProviderErrorMetadata,
  ): ProviderErrorClassification | undefined {
    const info = errorData(error)?.codexErrorInfo;
    if (info === "usageLimitExceeded") {
      return providerUsageLimit("usageLimitExceeded", metadata);
    }
    if (codexHttpStatus(info) === 429) {
      return providerUsageLimit("http_429", metadata);
    }
    return undefined;
  }

  spawnConfig(): SpawnConfig {
    const env = process.env;
    const override = env.AGENTPRISM_CODEX_ACP_CMD;
    if (override) {
      return { command: override, args: splitArgs(env.AGENTPRISM_CODEX_ACP_ARGS), env };
    }
    // Run codex-acp under the current node. AGENTPRISM_CODEX_ACP_BIN overrides the resolved
    // path; otherwise resolve the package's main (dist/index.js) — the workspace symlink for a
    // monorepo checkout (built by `pnpm build`), node_modules for a published install. Works
    // from both src/ and the compiled dist/.
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
    // fallback if the message also carried leading prose. Final message ONLY — the turn-wide
    // constraint makes intermediate progress messages schema-shaped as well.
    return parseFinalJson(source.finalMessageText());
  }
}

export const codexBackendDefinition = defineBuiltinBackend({
  id: "codex",
  defaultModeId: "agent",
  thoughtLevelDomainSemantics: "ordered",
  authProfile: codexAuthProfile,
  create: (authProfile) => new CodexBackend(authProfile),
  release: {
    engine: { node: ">=22" },
    server: { kind: "workspace-package", package: "@automatalabs/codex-acp", path: "packages/codex-acp" },
    freshness: {
      npm: ["@agentclientprotocol/sdk"],
      sourceUpstreams: [
        {
          package: "@automatalabs/codex-acp",
          path: "packages/codex-acp",
          upstreamUrl: "https://github.com/agentclientprotocol/codex-acp.git",
          upstreamUrlEnv: "AGENTPRISM_CODEX_ACP_UPSTREAM_URL",
          upstreamRef: "main",
        },
      ],
      wrappedRuntimes: [],
    },
  },
  protocolCoverage: BUILTIN_PROTOCOL_COVERAGE.codex,
});

function providerUsageLimit(
  providerCode: string,
  metadata: ProviderErrorMetadata | undefined,
): ProviderErrorClassification {
  return {
    kind: "provider_usage_limit",
    context: {
      backendId: "codex",
      source: "provider",
      providerCode,
      resetAt: metadata?.resetAt,
    },
  };
}

function codexHttpStatus(info: unknown): number | undefined {
  if (!info || typeof info !== "object") return undefined;
  for (const key of [
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
  ]) {
    const detail = (info as Record<string, unknown>)[key];
    if (!detail || typeof detail !== "object") continue;
    const status = (detail as Record<string, unknown>).httpStatusCode;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function errorData(error: unknown): Record<string, unknown> | undefined {
  try {
    if (!error || typeof error !== "object") return undefined;
    const data = (error as { data?: unknown }).data;
    return data && typeof data === "object" ? data as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
