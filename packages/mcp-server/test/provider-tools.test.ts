// packages/mcp-server/test/provider-tools.test.ts
//
// The three MCP provider tools against a stub ProviderCapableRunner —
//   - detection contract: provider tools register iff the runner duck-types provider-capable,
//     independently of the auth-capable gate;
//   - workflow_providers projection (single + enumerate-all), redacted (`_meta` dropped, current
//     collapsed to { apiType, baseUrl }), and the providersSupported:false degradation for a
//     backend whose providers/* gate throws (never a hard tool failure);
//   - workflow_set_provider passthrough: providerId/apiType/baseUrl/headers reach the runner,
//     the SECRET headers are never echoed into content or structuredContent (Principle 9);
//   - workflow_disable_provider passthrough + non-secret echo;
//   - a gate error on set/disable surfaces as an MCP tool error carrying the runner's message.
import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import type { AgentRunner, RunOptions } from "@automatalabs/shared-types";
import type {
  DisableProviderOptions,
  ListProvidersOptions,
  ListProvidersResponse,
  ProviderCapableRunner,
  SetProviderOptions,
} from "@automatalabs/workflows";

import { createWorkflowServer } from "../src/index.js";
import { okRunner, structured, textOf } from "./_harness.js";

// ── A stub ProviderCapableRunner: the structural shape the composition root duck-types, with a
//    per-backend providers catalog and a call log. Backends absent from the catalog throw the
//    capability-gate error the real runner raises for an unadvertised providers block. ──

interface ProviderStub {
  runner: AgentRunner;
  listCalls: ListProvidersOptions[];
  setCalls: SetProviderOptions[];
  disableCalls: DisableProviderOptions[];
}

function gateError(backend: string, method: string): WorkflowError {
  return new WorkflowError(
    `the ${backend} agent does not advertise ${method} (agentCapabilities.providers absent)`,
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false },
  );
}

function makeProviderStub(config: {
  providersByBackend: Record<string, ListProvidersResponse["providers"]>;
  backends?: string[];
}): ProviderStub {
  const backends = config.backends ?? Object.keys(config.providersByBackend);
  const listCalls: ListProvidersOptions[] = [];
  const setCalls: SetProviderOptions[] = [];
  const disableCalls: DisableProviderOptions[] = [];

  const catalogFor = (model: string | undefined, method: string): ListProvidersResponse["providers"] => {
    const catalog = model !== undefined ? config.providersByBackend[model] : undefined;
    if (!catalog) throw gateError(model ?? "?", method);
    return catalog;
  };

  const runner = {
    run: async (prompt: string, _options?: RunOptions): Promise<unknown> => `ok:${prompt}`,
    listProviders: async (opts: ListProvidersOptions = {}) => {
      listCalls.push(opts);
      return { providers: catalogFor(opts.model, "providers/list") };
    },
    setProvider: async (opts: SetProviderOptions) => {
      catalogFor(opts.model, "providers/set");
      setCalls.push(opts);
      return {};
    },
    disableProvider: async (opts: DisableProviderOptions) => {
      catalogFor(opts.model, "providers/disable");
      disableCalls.push(opts);
      return {};
    },
    listBackends: () => [...backends],
  } satisfies ProviderCapableRunner & { run: AgentRunner["run"] };

  return { runner: runner as unknown as AgentRunner, listCalls, setCalls, disableCalls };
}

interface Connected {
  client: Client;
  server: McpServer;
  dispose: () => Promise<void>;
}

async function connectRunner(runner: AgentRunner): Promise<Connected> {
  const server = createWorkflowServer(runner);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "provider-tools-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    async dispose() {
      await client.close();
      await server.close();
    },
  };
}

// Fixture mirroring the codex-acp 1.6.0 catalog: ONE client-configurable custom gateway provider,
// `current` null until configured, plus `_meta` noise the projection must drop.
const CUSTOM_GATEWAY_UNCONFIGURED: ListProvidersResponse["providers"] = [
  {
    providerId: "custom-gateway",
    supported: ["openai"],
    required: false,
    current: null,
    _meta: { internal: "never-projected" },
  },
];

const CUSTOM_GATEWAY_CONFIGURED: ListProvidersResponse["providers"] = [
  {
    providerId: "custom-gateway",
    supported: ["openai"],
    required: false,
    current: { apiType: "openai", baseUrl: "https://gw.test/v1", _meta: { internal: "never-projected" } },
  },
];

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

// ── Detection contract: provider tools register iff the runner duck-types provider-capable. ──

test("a plain AgentRunner stub registers no provider tools", async () => {
  const { client, dispose } = await connectRunner(okRunner());
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["workflow"], "no provider tools without a provider-capable runner");
  } finally {
    await dispose();
  }
});

test("a ProviderCapableRunner registers workflow + the three provider tools (auth gate independent)", async () => {
  const stub = makeProviderStub({ providersByBackend: { codex: CUSTOM_GATEWAY_UNCONFIGURED } });
  const { client, dispose } = await connectRunner(stub.runner);
  try {
    const { tools } = await client.listTools();
    // The stub is NOT auth-capable, so the auth tools stay off — the two gates are independent.
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "workflow",
      "workflow_disable_provider",
      "workflow_providers",
      "workflow_set_provider",
    ]);
    const list = tools.find((t) => t.name === "workflow_providers");
    assert.ok(list?.outputSchema, "list tool declares an output schema");
    const set = tools.find((t) => t.name === "workflow_set_provider");
    assert.deepEqual(
      set?.inputSchema.required,
      ["backend", "providerId", "apiType", "baseUrl"],
      "backend+providerId+apiType+baseUrl required, headers optional",
    );
  } finally {
    await dispose();
  }
});

// ── workflow_providers projection ──

test("workflow_providers (single backend): redacted projection — _meta dropped, current collapsed", async () => {
  const stub = makeProviderStub({ providersByBackend: { codex: CUSTOM_GATEWAY_CONFIGURED } });
  const { client, dispose } = await connectRunner(stub.runner);
  try {
    const res = await client.callTool({ name: "workflow_providers", arguments: { backend: "codex" } });
    const backends = field(structured(res), "backends") as Array<Record<string, unknown>>;
    assert.equal(backends.length, 1);
    assert.equal(backends[0].backendId, "codex");
    assert.equal(backends[0].providersSupported, true);
    const providers = backends[0].providers as Array<Record<string, unknown>>;
    assert.deepEqual(providers, [
      {
        providerId: "custom-gateway",
        supported: ["openai"],
        required: false,
        current: { apiType: "openai", baseUrl: "https://gw.test/v1" },
      },
    ]);
    assert.ok(!JSON.stringify(res).includes("never-projected"), "provider _meta is not projected");
    // Routing proof: the scoped call probed exactly that backend.
    assert.deepEqual(stub.listCalls.map((c) => c.model), ["codex"]);
  } finally {
    await dispose();
  }
});

test("workflow_providers (backend omitted): enumerates listBackends; a gated backend degrades to providersSupported:false", async () => {
  const stub = makeProviderStub({
    providersByBackend: { codex: CUSTOM_GATEWAY_UNCONFIGURED },
    backends: ["claude", "codex"], // claude advertises no providers -> the stub's gate throws
  });
  const { client, dispose } = await connectRunner(stub.runner);
  try {
    const res = await client.callTool({ name: "workflow_providers", arguments: {} });
    const backends = field(structured(res), "backends") as Array<Record<string, unknown>>;
    assert.deepEqual(
      backends.map((b) => [b.backendId, b.providersSupported]),
      [
        ["claude", false],
        ["codex", true],
      ],
    );
    assert.deepEqual(field(backends[0], "providers"), [], "an unsupported backend reports an empty catalog");
    const codexProviders = backends[1].providers as Array<Record<string, unknown>>;
    assert.equal(codexProviders[0].current, null, "an unconfigured provider reports current: null");
    assert.match(textOf(res), /providers not supported/, "the summary names the unsupported backend state");
  } finally {
    await dispose();
  }
});

// ── workflow_set_provider / workflow_disable_provider passthrough ──

test("workflow_set_provider: full passthrough to the runner; SECRET headers never echoed", async () => {
  const stub = makeProviderStub({ providersByBackend: { codex: CUSTOM_GATEWAY_UNCONFIGURED } });
  const { client, dispose } = await connectRunner(stub.runner);
  const SECRET = "Bearer super-secret-gateway-token";
  try {
    const res = await client.callTool({
      name: "workflow_set_provider",
      arguments: {
        backend: "codex",
        providerId: "custom-gateway",
        apiType: "openai",
        baseUrl: "https://gw.test/v1",
        headers: { Authorization: SECRET },
      },
    });
    assert.deepEqual(structured(res), { backend: "codex", providerId: "custom-gateway", status: "configured" });

    // The runner call carries the secret (it must reach the agent)…
    assert.equal(stub.setCalls.length, 1);
    assert.equal(stub.setCalls[0].model, "codex");
    assert.equal(stub.setCalls[0].providerId, "custom-gateway");
    assert.equal(stub.setCalls[0].apiType, "openai");
    assert.equal(stub.setCalls[0].baseUrl, "https://gw.test/v1");
    assert.deepEqual(stub.setCalls[0].headers, { Authorization: SECRET });

    // …but the secret appears NOWHERE in the tool result (content or structuredContent).
    assert.ok(!JSON.stringify(res).includes(SECRET), "secret header value never echoed into the tool result");
    assert.ok(!textOf(res).includes(SECRET));
  } finally {
    await dispose();
  }
});

test("workflow_disable_provider: passthrough + non-secret echo", async () => {
  const stub = makeProviderStub({ providersByBackend: { codex: CUSTOM_GATEWAY_CONFIGURED } });
  const { client, dispose } = await connectRunner(stub.runner);
  try {
    const res = await client.callTool({
      name: "workflow_disable_provider",
      arguments: { backend: "codex", providerId: "custom-gateway" },
    });
    assert.deepEqual(structured(res), { backend: "codex", providerId: "custom-gateway", status: "disabled" });
    assert.equal(stub.disableCalls.length, 1);
    assert.equal(stub.disableCalls[0].model, "codex");
    assert.equal(stub.disableCalls[0].providerId, "custom-gateway");
  } finally {
    await dispose();
  }
});

test("workflow_set_provider on a backend without the providers capability: tool error with the gate message", async () => {
  const stub = makeProviderStub({
    providersByBackend: { codex: CUSTOM_GATEWAY_UNCONFIGURED },
    backends: ["claude", "codex"],
  });
  const { client, dispose } = await connectRunner(stub.runner);
  try {
    const res = await client.callTool({
      name: "workflow_set_provider",
      arguments: { backend: "claude", providerId: "custom-gateway", apiType: "openai", baseUrl: "https://gw.test" },
    });
    assert.equal(res.isError, true, "an action tool surfaces the capability gate as a tool error");
    assert.match(textOf(res), /does not advertise providers\/set/);
    assert.equal(stub.setCalls.length, 0, "the gate fired before any configuration was applied");
  } finally {
    await dispose();
  }
});
