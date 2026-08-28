import type { ClientCapabilities } from "@modelcontextprotocol/server";

/** Stable MCP Apps extension identifier from the 2026-01-26 Apps specification. */
export const EXTENSION_ID = "io.modelcontextprotocol/ui";
/** Exact MCP Apps HTML resource MIME type. */
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
/** Deprecated flat tool metadata key retained for older Apps hosts. */
export const RESOURCE_URI_META_KEY = "ui/resourceUri";

export interface UiCapability {
  mimeTypes?: unknown;
}

/** Read the legacy initialize-scoped Apps capability without trusting its runtime shape. */
export function getUiCapability(capabilities: ClientCapabilities | undefined): UiCapability | undefined {
  const value = capabilities?.extensions?.[EXTENSION_ID];
  return value !== null && typeof value === "object" ? value as UiCapability : undefined;
}

/** Exact affirmative Apps capability check used at every legacy capability boundary. */
export function supportsMcpApps(capabilities: ClientCapabilities | undefined): boolean {
  const ui = getUiCapability(capabilities);
  return Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(RESOURCE_MIME_TYPE);
}

/** Emit the current nested key and the deprecated flat key for older Apps hosts. */
export function appResourceToolMeta(resourceUri: string, visibility?: readonly string[]): Record<string, unknown> {
  return {
    ui: {
      resourceUri,
      ...(visibility === undefined ? {} : { visibility: [...visibility] }),
    },
    [RESOURCE_URI_META_KEY]: resourceUri,
  };
}
