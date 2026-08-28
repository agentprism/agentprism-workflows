import assert from "node:assert/strict";
import test from "node:test";

import { McpServer, type ServerContext } from "@modelcontextprotocol/server";

import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "../src/mcp-apps.js";
import { CapabilityAwareToolCatalog } from "../src/tool-catalog.js";

function context(capabilities?: Record<string, unknown>): ServerContext {
  return {
    mcpReq: {
      id: 1,
      method: "tools/list",
      signal: new AbortController().signal,
      requestState: () => undefined,
      send: async () => ({}),
      notify: async () => undefined,
      log: async () => undefined,
      elicitInput: async () => ({ action: "cancel" }),
      requestSampling: async () => ({ model: "", role: "assistant", content: { type: "text", text: "" } }),
      ...(capabilities === undefined
        ? {}
        : {
            envelope: {
              "io.modelcontextprotocol/clientCapabilities": capabilities,
            },
          }),
    },
  } as unknown as ServerContext;
}

const matching = { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } };

test("modern Apps decisions are request-scoped while legacy ignores envelope lookalikes", () => {
  const modernServer = new McpServer({ name: "modern", version: "1" }, { capabilities: { tools: {} } });
  const modern = new CapabilityAwareToolCatalog(modernServer, "modern");
  assert.equal(modern.supportsApps(context(matching)), true);
  assert.equal(modern.supportsApps(context({})), false);
  assert.equal(modern.supportsApps(context(matching)), true, "an incapable request did not poison the next request");

  const legacyServer = new McpServer({ name: "legacy", version: "1" }, { capabilities: { tools: {} } });
  const legacy = new CapabilityAwareToolCatalog(legacyServer, "legacy");
  legacy.setLegacyCapabilities({});
  assert.equal(
    legacy.supportsApps(context(matching)),
    false,
    "legacy capability comes only from initialize, never a request envelope lookalike",
  );
  legacy.setLegacyCapabilities(matching);
  assert.equal(legacy.supportsApps(context({})), true);
});
