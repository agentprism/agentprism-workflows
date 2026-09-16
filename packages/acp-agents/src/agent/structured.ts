// Schema plumbing for the AcpAgent SDK: the per-session injection decision (the same rule the
// runner applies — the backend opts in AND the initialized agent strictly advertises HTTP MCP),
// the client-hosted StructuredOutput tool registration each agent owns, the per-turn schema gate,
// and the no-repair result ladder (capture → native → final-message extraction → structuredError).
import type { TSchema } from "typebox";
import type { McpServerConfig } from "@automatalabs/shared-types";
import type { PooledConnection } from "../acp-client.js";
import type { Backend, StructuredSource } from "../backend.js";
import { extractValidated, validateValue } from "../structured-output.js";
import {
  STRUCTURED_OUTPUT_SERVER_NAME,
  describeSchemaErrors,
  type StructuredOutputToolHost,
  type StructuredOutputToolRegistration,
} from "../structured-tool.js";
import { agentValidationError } from "./errors.js";

export interface StructuredPlan {
  readonly schema: TSchema | undefined;
  /** An injected StructuredOutput tool is on this session. */
  readonly toolActive: boolean;
  /** The caller's `mcpServers` (+ the injected http server when `toolActive`). */
  readonly mcpServers: McpServerConfig[] | undefined;
  readonly host?: StructuredOutputToolHost;
  readonly registration?: StructuredOutputToolRegistration;
}

/** What `planStructured` reads from the agent (kept as a small seam so it needs no class access). */
export interface StructuredPlanInputs {
  readonly schema: TSchema | undefined;
  readonly backend: Backend;
  readonly mcpServers: McpServerConfig[] | undefined;
  /** The agent's lazily created tool host (one per agent, disposed on close). */
  readonly host: () => StructuredOutputToolHost;
}

/** The runner's injection rule: the backend opts in AND the initialized agent advertises HTTP MCP. */
function shouldInjectStructuredOutputTool(
  schema: TSchema | undefined,
  backend: Backend,
  capabilities: PooledConnection["capabilities"],
): schema is TSchema {
  return Boolean(schema && backend.injectStructuredOutputTool && capabilities?.agent.mcpCapabilities?.http === true);
}

/** `structured_output`, then `structured_output_2`, `_3`, … — never colliding with a caller's server. */
export function availableMcpServerName(base: string, servers: readonly McpServerConfig[] | undefined): string {
  const used = new Set((servers ?? []).map((server) => server.name));
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** Decide (after initialize, so the capabilities are known) whether this session gets the injected
 *  tool, and register it on the agent's host when it does. */
export async function planStructured(inputs: StructuredPlanInputs, connection: PooledConnection): Promise<StructuredPlan> {
  const { schema, backend, mcpServers } = inputs;
  if (!shouldInjectStructuredOutputTool(schema, backend, connection.capabilities)) {
    return { schema, toolActive: false, mcpServers };
  }
  const host = inputs.host();
  const registration = await host.register(schema);
  return {
    schema,
    toolActive: true,
    mcpServers: [
      ...(mcpServers ?? []),
      {
        type: "http",
        name: availableMcpServerName(STRUCTURED_OUTPUT_SERVER_NAME, mcpServers),
        url: registration.url,
        headers: [],
      },
    ],
    host,
    registration,
  };
}

/** A per-turn schema is allowed only where the backend carries the schema on the turn and does not
 *  embed it in the prompt (Codex among the built-ins). */
export function assertPerTurnSchemaAllowed(backend: Backend, schema: TSchema | undefined, label: string | undefined): void {
  if (schema === undefined) return;
  if (backend.promptMeta(schema) !== undefined && backend.embedSchemaInPrompt !== true) return;
  throw agentValidationError(
    `per-turn schema is not supported on backend "${backend.id}" (its schema is bound at session open); ` +
      "pass `schema` to the AcpAgent constructor instead",
    label,
  );
}

/** The slice of a SessionHandle the result ladder reads. */
export type StructuredHandle = StructuredSource;

/**
 * The no-repair ladder for one turn: this turn's StructuredOutput capture (already validated by
 * the tool host) → the backend's native result, validated → a validated JSON block in the final
 * assistant message → otherwise `structuredError` naming every channel that applied.
 */
export function resolveTurnStructured(args: {
  schema: TSchema;
  handle: StructuredHandle;
  backend: Backend;
  captured: unknown;
}): { structured?: unknown; structuredError?: string } {
  const { schema, handle, backend, captured } = args;
  if (captured !== undefined) return { structured: captured };
  const reasons: string[] = ["no StructuredOutput capture"];
  const native = backend.nativeStructured?.(handle);
  if (native !== undefined && native !== null) {
    const validated = validateValue(native, schema);
    if (validated !== undefined) return { structured: validated };
    reasons.push(`native result rejected: ${describeSchemaErrors(schema, native)}`);
  }
  const extracted = extractValidated(handle.finalMessageText(), schema);
  if (extracted !== undefined) return { structured: extracted };
  reasons.push("no JSON object in the final message");
  return { structuredError: reasons.join("; ") };
}
