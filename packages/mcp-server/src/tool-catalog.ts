import {
  CLIENT_CAPABILITIES_META_KEY,
  type ClientCapabilities,
  type ListToolsResult,
  type McpServer,
  type RegisteredTool,
  type ServerContext,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";

import { appResourceToolMeta, supportsMcpApps } from "./mcp-apps.js";

type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: StandardSchemaWithJSON;
  outputSchema?: StandardSchemaWithJSON;
  annotations?: Record<string, unknown>;
  icons?: unknown[];
  execution?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

interface CatalogEntry {
  name: string;
  config: ToolConfig;
  enabled: boolean;
}

const EMPTY_INPUT_SCHEMA = { type: "object", properties: {} };

function modernCapabilities(ctx: ServerContext): ClientCapabilities | undefined {
  if (ctx.mcpReq.envelope === undefined) return undefined;
  const value = (ctx.mcpReq.envelope as unknown as Record<string, unknown>)[CLIENT_CAPABILITIES_META_KEY];
  return value !== null && typeof value === "object" ? value as ClientCapabilities : undefined;
}

function appOnly(config: ToolConfig): boolean {
  const ui = config._meta?.ui;
  if (ui === null || typeof ui !== "object") return false;
  const visibility = (ui as { visibility?: unknown }).visibility;
  return Array.isArray(visibility) && visibility.includes("app");
}

async function schemaJson(
  schema: StandardSchemaWithJSON | undefined,
  direction: "input" | "output",
): Promise<Record<string, unknown> | undefined> {
  if (schema === undefined) return direction === "input" ? EMPTY_INPUT_SCHEMA : undefined;
  const converted = await schema["~standard"].jsonSchema[direction]({ target: "draft-2020-12" });
  return converted as Record<string, unknown>;
}

/**
 * Request-aware tools/list projection for Apps capability gating. Native registerTool and
 * tools/call remain authoritative for validation and execution; this catalog records the same
 * public registration configs and varies only Apps visibility/metadata at listing time.
 */
export class CapabilityAwareToolCatalog {
  private readonly entries = new Map<string, CatalogEntry>();
  private legacyCapabilities: ClientCapabilities | undefined;
  private workflowAppResourceUri: string | undefined;

  constructor(
    private readonly mcp: McpServer,
    private readonly protocolEra: "legacy" | "modern",
  ) {
    const registerNative = mcp.registerTool.bind(mcp);
    mcp.registerTool = ((name: string, config: ToolConfig, callback: (...args: unknown[]) => unknown) => {
      const entry: CatalogEntry = { name, config: { ...config }, enabled: true };
      const wrapped = appOnly(config)
        ? (...args: unknown[]) => {
            const ctx = args.at(-1) as ServerContext;
            if (!this.supportsApps(ctx)) {
              throw new Error(`Tool ${name} is available only to clients that advertise MCP Apps support`);
            }
            return callback(...args);
          }
        : callback;
      const registered = registerNative(name, config as never, wrapped as never) as RegisteredTool;
      this.entries.set(name, entry);

      const nativeUpdate = registered.update.bind(registered);
      registered.update = (updates) => {
        const previousName = entry.name;
        entry.config = { ...entry.config, ...updates } as ToolConfig;
        if (typeof updates.name === "string" && updates.name !== previousName) {
          this.entries.delete(previousName);
          entry.name = updates.name;
          this.entries.set(entry.name, entry);
        }
        nativeUpdate(updates);
      };
      const nativeEnable = registered.enable.bind(registered);
      registered.enable = () => {
        entry.enabled = true;
        nativeEnable();
      };
      const nativeDisable = registered.disable.bind(registered);
      registered.disable = () => {
        entry.enabled = false;
        nativeDisable();
      };
      const nativeRemove = registered.remove.bind(registered);
      registered.remove = () => {
        this.entries.delete(entry.name);
        nativeRemove();
      };
      return registered;
    }) as typeof mcp.registerTool;
  }

  setLegacyCapabilities(capabilities: ClientCapabilities | undefined): boolean {
    this.legacyCapabilities = capabilities;
    return supportsMcpApps(capabilities);
  }

  setWorkflowAppResource(uri: string): void {
    this.workflowAppResourceUri = uri;
  }

  clientCapabilities(ctx: ServerContext): ClientCapabilities | undefined {
    return this.protocolEra === "modern" ? modernCapabilities(ctx) : this.legacyCapabilities;
  }

  supportsApps(ctx: ServerContext): boolean {
    return supportsMcpApps(this.clientCapabilities(ctx));
  }

  installListHandler(): void {
    this.mcp.server.removeRequestHandler("tools/list");
    this.mcp.server.setRequestHandler("tools/list", async (_request, ctx) => {
      const apps = this.supportsApps(ctx);
      const tools = [];
      for (const entry of this.entries.values()) {
        if (!entry.enabled || (appOnly(entry.config) && !apps)) continue;
        const inputSchema = await schemaJson(entry.config.inputSchema, "input");
        const outputSchema = await schemaJson(entry.config.outputSchema, "output");
        const meta = apps && entry.name === "workflow" && this.workflowAppResourceUri !== undefined
          ? { ...(entry.config._meta ?? {}), ...appResourceToolMeta(this.workflowAppResourceUri) }
          : entry.config._meta;
        tools.push({
          name: entry.name,
          title: entry.config.title,
          description: entry.config.description,
          inputSchema: inputSchema ?? EMPTY_INPUT_SCHEMA,
          ...(outputSchema === undefined ? {} : { outputSchema }),
          annotations: entry.config.annotations,
          icons: entry.config.icons,
          execution: entry.config.execution,
          _meta: meta,
        });
      }
      return { tools } as unknown as ListToolsResult;
    });
  }
}
