// OpenCodeBackend — drives the OpenCode ACP server (`opencode acp`). OpenCode does not expose
// a native structured-output result channel and ignores request._meta today, so the backend uses
// the repo's generic schema dialect plus prompt embedding. When OpenCode advertises HTTP MCP, the
// runner can also inject the client-hosted StructuredOutput MCP tool.
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { TSchema } from "typebox";
import { META_KEYS } from "@automatalabs/shared-types";
import type { Backend, SpawnConfig, StructuredSource } from "../backend.js";
import { splitArgs } from "../backend.js";
import { toJsonSchema } from "../schema-strict.js";
import { parseFinalJson } from "../structured-output.js";

const require = createRequire(import.meta.url);

export class OpenCodeBackend implements Backend {
  readonly id = "opencode" as const;
  readonly stripsRoutingPrefix = true;
  readonly embedSchemaInPrompt = true;
  readonly injectStructuredOutputTool = true;

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
    return parseFinalJson(source.currentTurnText());
  }
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
