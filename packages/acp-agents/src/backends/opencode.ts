// OpenCodeBackend — drives the OpenCode ACP server (`opencode acp`). OpenCode does not expose
// a native structured-output result channel and ignores request._meta today, so the backend uses
// the repo's generic schema dialect plus prompt embedding. When OpenCode advertises HTTP MCP, the
// runner can also inject the client-hosted StructuredOutput MCP tool.
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { TSchema } from "typebox";
import { META_KEYS } from "@automatalabs/shared-types";
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
import { toJsonSchema } from "../schema-strict.js";
import { parseFinalJson } from "../structured-output.js";
import { defineBuiltinBackend } from "./define.js";

const require = createRequire(import.meta.url);

/** Per-spawn OpenCode isolation env: fresh XDG data/state/cache trees seeded with the user's
 *  credentials, plus autoupdate off so a concurrent TUI upgrade never swaps state formats
 *  underneath a running server. Config (XDG_CONFIG_HOME) is deliberately NOT overridden. */
function isolatedOpenCodeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const root = join(tmpdir(), `agentprism-opencode-${randomUUID()}`);
  const dataHome = join(root, "data");
  const dataDir = join(dataHome, "opencode");
  const stateHome = join(root, "state");
  const cacheHome = join(root, "cache");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  mkdirSync(cacheHome, { recursive: true });
  // Credentials live in the REAL data dir; seed them so the isolated instance authenticates.
  // Refresh-token write-back stays in the isolated copy — re-auth churn is the accepted cost of
  // not letting concurrent instances revoke each other's tokens (anomalyco/opencode#37059).
  const sourceData = base.XDG_DATA_HOME && base.XDG_DATA_HOME.trim() !== ""
    ? join(base.XDG_DATA_HOME, "opencode")
    : join(homedir(), ".local", "share", "opencode");
  for (const file of ["auth.json", "mcp-auth.json"]) {
    const source = join(sourceData, file);
    if (existsSync(source)) copyFileSync(source, join(dataDir, file));
  }
  return {
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
    XDG_CACHE_HOME: cacheHome,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
}

/** OpenCode auth adaptation: its terminal login follows host TTY and has no gateway flow. */
export const opencodeAuthProfile: AuthProfile = {
  backendId: "opencode",
  clientAuthCapabilities: ({ terminal }) => ({ terminal, gateway: false }),
  describe: (_method, base) => base,
};

export class OpenCodeBackend implements Backend {
  readonly id = "opencode" as const;

  constructor(readonly authProfile: AuthProfile = opencodeAuthProfile) {}

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
    // Concurrent OpenCode instances share every user+project-keyed store: the sqlite database
    // (WAL behind an UNTIMED in-process statement semaphore — a busy wait stalls the whole
    // process, ACP stdout pump included), one snapshot git index, the log, tool-output, and
    // auth.json. Overlapping processes — routine since process-exclusive injected pooling
    // (#292) — surface that as mid-run "ACP connection closed" and cross-instance auth
    // revocation (upstream: anomalyco/opencode#31307, #29395, #21215, #38366, #37059).
    // Give every spawned server its own XDG data/state/cache trees with credentials seeded in
    // (OPENCODE_DB alone is insufficient per #33321 — the snapshot gitdir stays shared).
    // XDG_CONFIG_HOME stays shared so the user's opencode.jsonc and providers apply, and an
    // explicitly exported OPENCODE_DB still wins over the isolated tree's database. Tradeoff:
    // agent-persisted sessions live in the spawned process's isolated tree, so cross-process
    // session/load|resume falls back to the runner's fresh-session path.
    const env: NodeJS.ProcessEnv = { ...process.env, ...isolatedOpenCodeEnv(process.env) };
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

export const opencodeBackendDefinition = defineBuiltinBackend({
  id: "opencode",
  thoughtLevelDomainSemantics: "exact-set",
  authProfile: opencodeAuthProfile,
  create: (authProfile) => new OpenCodeBackend(authProfile),
  release: {
    engine: { node: ">=22" },
    server: {
      kind: "system-command",
      command: "opencode",
      optionalPackageProbe: "opencode-ai",
    },
    freshness: {
      npm: ["@agentclientprotocol/sdk"],
      sourceUpstreams: [],
      wrappedRuntimes: [],
    },
  },
  protocolCoverage: BUILTIN_PROTOCOL_COVERAGE.opencode,
});

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
