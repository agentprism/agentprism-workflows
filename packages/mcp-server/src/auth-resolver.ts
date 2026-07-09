// packages/mcp-server/src/auth-resolver.ts
//
// The OPT-IN inline MCP auth resolver (§4.3), the analogue of `createConfirm` in server.ts. It is
// built only when the composition root sets AGENTPRISM_MCP_INLINE_AUTH=1 (default OFF — the clean
// headless behavior is pure pause-and-resume). When wired, a `-32000` at session/new resolves
// inline through masked MCP elicitation forms instead of pausing the run.
//
// DEFERRED BINDING: the runner and the server form a construction cycle (the runner needs the
// resolver; the resolver needs the server that is built FROM the runner). `createDeferredMcpAuthResolver`
// returns a resolver that closes over a mutable server-ref box, plus a `bind(server)` the root calls
// after the server exists — exactly the seam §4.3 specifies.
//
// SECRETS (Principle 9): env/gateway values are collected through elicitation and returned in the
// `AuthResolution`; they flow only into the runner's AuthStore. Nothing here logs them.
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import type { AuthContext, AuthMethodDescriptor, AuthResolution, AuthResolver } from "@automatalabs/workflows";

const CANCELLED: AuthResolution = { outcome: "cancelled" };

/** A `_meta` object is gateway-shaped iff it carries a non-null `gateway` key (§2.1). Recognized by
 *  literal name; not an SDK schema field. */
function isGatewayShaped(meta: Record<string, unknown> | undefined): boolean {
  return meta != null && typeof meta === "object" && meta.gateway != null;
}

/** Collect the env_var values for one method through one masked elicitation form per var, honoring
 *  `secret`/`optional`. Returns the collected values, or `undefined` if the user declined/failed a
 *  REQUIRED var (a cancellation of the whole resolution). */
async function collectEnvVars(
  server: Server,
  ctx: AuthContext,
  method: Extract<AuthMethodDescriptor, { type: "env_var" }>,
): Promise<Record<string, string> | undefined> {
  const values: Record<string, string> = {};
  for (const v of method.vars) {
    const params: ElicitRequestFormParams = {
      mode: "form",
      message:
        `Enter ${v.label ?? v.name} for backend "${ctx.backendId}"` +
        (v.secret ? " (secret — stored in memory only, never logged)." : ".") +
        (v.optional ? " Leave blank to skip." : ""),
      requestedSchema: {
        type: "object",
        properties: {
          value: {
            type: "string",
            title: v.label ?? v.name,
            description: v.secret ? "Secret credential value — not echoed or logged." : undefined,
          },
        },
        required: v.optional ? [] : ["value"],
      },
    };
    let elicited: Awaited<ReturnType<Server["elicitInput"]>>;
    try {
      elicited = await server.elicitInput(params);
    } catch {
      if (v.optional) continue;
      return undefined;
    }
    if (elicited.action !== "accept") {
      if (v.optional) continue;
      return undefined; // declined/cancelled a required var
    }
    const value = elicited.content?.value;
    if (typeof value === "string" && value.length > 0) {
      values[v.name] = value;
    } else if (!v.optional) {
      return undefined;
    }
  }
  return values;
}

/** Collect a gateway `{ baseUrl, headers }` payload through one form. Returns the gateway-keyed
 *  `_meta`, or `undefined` on decline/failure/malformed headers. */
async function collectGatewayMeta(
  server: Server,
  ctx: AuthContext,
): Promise<Record<string, unknown> | undefined> {
  const params: ElicitRequestFormParams = {
    mode: "form",
    message: `Gateway configuration for backend "${ctx.backendId}" (values are secret — stored in memory only, never logged).`,
    requestedSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", title: "Base URL", description: "Gateway base URL." },
        headers: {
          type: "string",
          title: "Headers (JSON object, optional)",
          description: 'Optional JSON object of request headers, e.g. {"Authorization":"Bearer …"}.',
        },
      },
      required: ["baseUrl"],
    },
  };
  let elicited: Awaited<ReturnType<Server["elicitInput"]>>;
  try {
    elicited = await server.elicitInput(params);
  } catch {
    return undefined;
  }
  if (elicited.action !== "accept") return undefined;
  const baseUrl = elicited.content?.baseUrl;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return undefined;
  const gateway: Record<string, unknown> = { baseUrl };
  const rawHeaders = elicited.content?.headers;
  if (typeof rawHeaders === "string" && rawHeaders.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawHeaders);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        gateway.headers = parsed;
      } else {
        return undefined; // malformed headers → cancel rather than send junk
      }
    } catch {
      return undefined;
    }
  }
  return { gateway };
}

/** Show the terminal-login instruction as a one-shot acknowledgement form. Best-effort; the run
 *  cancels regardless (MCP has no TTY). */
async function instructTerminal(
  server: Server,
  method: Extract<AuthMethodDescriptor, { type: "terminal" }>,
): Promise<void> {
  const cmd = [method.launch.command, ...method.launch.args].filter((p) => p.length > 0).join(" ");
  try {
    await server.elicitInput({
      mode: "form",
      message:
        `This backend requires a terminal login, which this MCP host cannot run. In a terminal, run:\n\n${cmd}\n\n` +
        `then re-call the workflow tool with resumeFromRunId to continue.`,
      requestedSchema: {
        type: "object",
        properties: {
          acknowledged: { type: "boolean", title: "Acknowledged", description: "Dismiss this instruction." },
        },
        required: [],
      },
    });
  } catch {
    /* best-effort: the run cancels regardless */
  }
}

/**
 * Build the deferred inline MCP auth resolver. The returned `resolver` is handed to
 * `createAcpRunner({ onAuth })`; `bind(server)` is called by the composition root once the server is
 * constructed. Until bound (or when the host does not advertise elicitation) the resolver returns
 * `{ outcome: "cancelled" }`, so the run falls back to the spec-faithful pause-and-resume path.
 */
export function createDeferredMcpAuthResolver(): { resolver: AuthResolver; bind(server: Server): void } {
  const box: { server?: Server } = {};

  const resolver: AuthResolver = async (ctx: AuthContext): Promise<AuthResolution> => {
    const server = box.server;
    if (!server || !server.getClientCapabilities()?.elicitation) return CANCELLED;

    // Prefer a headlessly-collectable method: env_var, then gateway meta. A terminal method gets a
    // one-shot text instruction; an interactive bare-`agent` method cannot be completed here.
    for (const method of ctx.methods) {
      if (method.type === "env_var") {
        const values = await collectEnvVars(server, ctx, method);
        return values ? { outcome: "env", values, methodId: method.id } : CANCELLED;
      }
    }
    for (const method of ctx.methods) {
      if (method.type === "agent" && method.expectsMeta && isGatewayShaped(method.meta)) {
        const meta = await collectGatewayMeta(server, ctx);
        return meta ? { outcome: "meta", methodId: method.id, meta } : CANCELLED;
      }
    }
    for (const method of ctx.methods) {
      if (method.type === "terminal") {
        await instructTerminal(server, method);
        return CANCELLED;
      }
    }
    return CANCELLED;
  };

  return {
    resolver,
    bind(server: Server): void {
      box.server = server;
    },
  };
}
