// packages/mcp-server/test/auth-tools.test.ts
//
// PR5 (§4.3 / §4.6.2): the two MCP auth tools against a stub AuthCapableRunner —
//   - workflow_auth_status projection (single + enumerate-all), redacted;
//   - workflow_authenticate env/meta/completed → AuthResolution mapping + {status,methodId,recycled};
//   - the interactive-bare-agent cancel (never a no-op completeAuth);
//   - secret-redaction: env/meta never echoed into content or structuredContent (Principle 9);
//   - the formatTerminalSummary auth_required branch reads authContext (never the message);
//   - the pause → workflow_authenticate → workflow(resumeFromRunId) loop;
//   - a plain AgentRunner stub registers ONLY the `workflow` tool (detection contract).
import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import type { AgentRunner, RunOptions } from "@automatalabs/shared-types";
import type {
  AuthCapableRunner,
  AuthController,
  AuthMethodDescriptor,
  AuthOutcome,
  AuthStatusSnapshot,
  CompleteAuthOptions,
} from "@automatalabs/workflows";

import { createWorkflowServer } from "../src/index.js";
import { okRunner, structured, textOf, ONE_AGENT_SCRIPT } from "./_harness.js";

// ── A stub AuthCapableRunner: enough of the structural shape (§4.1) to drive the two tools, plus a
//    toggleable `authenticated` flag so run() can throw AUTH_REQUIRED until completeAuth flips it. ──

interface AuthStub {
  runner: AgentRunner;
  completeCalls: CompleteAuthOptions[];
  describeCalls: Array<{ model?: string }>;
  authenticated: () => boolean;
}

function makeAuthStub(config: {
  descriptorsByBackend: Record<string, AuthMethodDescriptor[]>;
  backends?: string[];
  requireAuthOnRun?: boolean;
  authBackendId?: string;
  startAuthenticated?: boolean;
}): AuthStub {
  let authenticated = config.startAuthenticated ?? false;
  const completeCalls: CompleteAuthOptions[] = [];
  const describeCalls: Array<{ model?: string }> = [];
  const backends = config.backends ?? Object.keys(config.descriptorsByBackend);
  const authBackendId = config.authBackendId ?? backends[0];

  const descriptorsFor = (model?: string): AuthMethodDescriptor[] =>
    (model && config.descriptorsByBackend[model]) ?? config.descriptorsByBackend[backends[0]] ?? [];

  const redact = (descriptors: AuthMethodDescriptor[]): AuthStatusSnapshot["methods"] =>
    descriptors.map((d) => ({ id: d.id, type: d.type, ...(d.name !== undefined ? { name: d.name } : {}) }));

  const snapshotFor = (backendId: string): AuthStatusSnapshot => ({
    backendId,
    poolKey: backendId,
    state: authenticated ? "authenticated" : "unauthenticated",
    authenticated,
    canResume: authenticated,
    methods: redact(descriptorsFor(backendId)),
  });

  const describeAuthMethods = async (opts?: { model?: string }): Promise<AuthMethodDescriptor[]> => {
    describeCalls.push({ model: opts?.model });
    return descriptorsFor(opts?.model);
  };

  const completeAuth = async (opts: CompleteAuthOptions): Promise<AuthOutcome> => {
    completeCalls.push(opts);
    if (opts.resolution.outcome === "cancelled") {
      return { status: "cancelled", methodId: opts.methodId, recycled: false };
    }
    authenticated = true;
    return { status: "authenticated", methodId: opts.methodId, recycled: true };
  };

  const auth: AuthController = {
    methods: (opts) => describeAuthMethods(opts),
    authenticate: (opts) => completeAuth(opts),
    logout: async () => {},
    status: (opts) => (opts?.backend ? [snapshotFor(opts.backend)] : backends.map(snapshotFor)),
    canResume: () => authenticated,
  };

  const run = async (prompt: string, _options?: RunOptions): Promise<unknown> => {
    if (config.requireAuthOnRun && !authenticated) {
      throw new WorkflowError(
        // Deliberately a bland message with NO method ids — so a summary that shows method ids
        // can ONLY have read the structured authContext, not parsed this string.
        `the agent needs authentication before it can run`,
        WorkflowErrorCode.AUTH_REQUIRED,
        {
          recoverable: false,
          authContext: {
            backendId: authBackendId,
            methods: descriptorsFor(authBackendId).map((d) => ({
              id: d.id,
              type: d.type,
              ...(d.name !== undefined ? { name: d.name } : {}),
            })),
          },
        },
      );
    }
    return `ok:${prompt}`;
  };

  const runner = {
    run,
    describeAuthMethods,
    completeAuth,
    listBackends: () => [...backends],
    auth,
  } satisfies AuthCapableRunner & { run: AgentRunner["run"] };

  return {
    runner: runner as unknown as AgentRunner,
    completeCalls,
    describeCalls,
    authenticated: () => authenticated,
  };
}

interface Connected {
  client: Client;
  server: McpServer;
  dispose: () => Promise<void>;
}

async function connectRunner(runner: AgentRunner): Promise<Connected> {
  const server = createWorkflowServer(runner);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "auth-tools-test", version: "0.0.0" }, { capabilities: {} });
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

// Descriptor fixtures covering all three dispatched types (§1.3).
const GATEWAY_AGENT: AuthMethodDescriptor = {
  type: "agent",
  id: "gateway",
  name: "Gateway",
  description: "gateway auth",
  expectsMeta: true,
  meta: { gateway: { protocol: "http" } },
  interactive: false,
};
const INTERACTIVE_AGENT: AuthMethodDescriptor = {
  type: "agent",
  id: "chat-gpt",
  name: "ChatGPT login",
  expectsMeta: false,
  interactive: true,
};
const TERMINAL_METHOD: AuthMethodDescriptor = {
  type: "terminal",
  id: "terminal-login",
  name: "Terminal login",
  launch: { command: "codex", args: ["login"], label: "codex login" },
  meta: { "terminal-auth": { command: "codex", args: ["login"] } },
};
const ENV_METHOD: AuthMethodDescriptor = {
  type: "env_var",
  id: "api-key",
  name: "API key",
  link: "https://example.test/keys",
  vars: [
    { name: "OPENAI_API_KEY", label: "OpenAI API key", secret: true, optional: false, meta: { provider: "openai" } },
    { name: "OPTIONAL_HINT", secret: false, optional: true },
  ],
  meta: { "api-key": { provider: "openai" } },
};

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

// ── Detection contract (§4.3): a plain AgentRunner gets ONLY `workflow`; an AuthCapableRunner
//    gets all three. ──

test("a plain AgentRunner stub registers only the `workflow` tool", async () => {
  const { client, dispose } = await connectRunner(okRunner());
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["workflow"], "no auth tools without an auth-capable runner");
  } finally {
    await dispose();
  }
});

test("an AuthCapableRunner registers workflow + the two auth tools", async () => {
  const stub = makeAuthStub({ descriptorsByBackend: { codex: [ENV_METHOD] } });
  const { client, dispose } = await connectRunner(stub.runner);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["workflow", "workflow_auth_status", "workflow_authenticate"]);
    const status = tools.find((t) => t.name === "workflow_auth_status");
    assert.ok(status?.outputSchema, "status tool declares an output schema");
    const authTool = tools.find((t) => t.name === "workflow_authenticate");
    assert.deepEqual(authTool?.inputSchema.required, ["backend", "methodId"], "backend+methodId required, env/meta optional");
  } finally {
    await dispose();
  }
});

// ── workflow_auth_status projection ──

test("workflow_auth_status (single backend): redacted projection of descriptors + snapshot state", async () => {
  const stub = makeAuthStub({
    descriptorsByBackend: { codex: [GATEWAY_AGENT, INTERACTIVE_AGENT, TERMINAL_METHOD, ENV_METHOD] },
  });
  const { client, dispose } = await connectRunner(stub.runner);
  try {
    const res = await client.callTool({ name: "workflow_auth_status", arguments: { backend: "codex" } });
    const sc = structured(res);
    const backends = field(sc, "backends") as Array<Record<string, unknown>>;
    assert.equal(backends.length, 1);
    const b = backends[0];
    assert.equal(b.backendId, "codex");
    assert.equal(b.state, "unauthenticated");
    assert.equal(b.authenticated, false);
    assert.equal(b.canResume, false);

    const methods = b.methods as Array<Record<string, unknown>>;
    assert.deepEqual(methods.map((m) => m.id), ["gateway", "chat-gpt", "terminal-login", "api-key"]);

    // agent methods carry `interactive`; the bare-agent one is true, gateway false.
    const gateway = methods.find((m) => m.id === "gateway")!;
    assert.equal(gateway.interactive, false);
    const chatgpt = methods.find((m) => m.id === "chat-gpt")!;
    assert.equal(chatgpt.interactive, true);

    // env_var carries redacted vars (name/label/secret/optional only) + link — NO per-var meta.
    const env = methods.find((m) => m.id === "api-key")!;
    assert.equal(env.link, "https://example.test/keys");
    const vars = env.vars as Array<Record<string, unknown>>;
    assert.deepEqual(vars, [
      { name: "OPENAI_API_KEY", label: "OpenAI API key", secret: true, optional: false },
      { name: "OPTIONAL_HINT", secret: false, optional: true },
    ]);
    assert.ok(!("meta" in env), "descriptor meta is not projected");
    for (const v of vars) assert.ok(!("meta" in v), "per-var meta is not projected");
  } finally {
    await dispose();
  }
});

test("workflow_auth_status (backend omitted): enumerates every registered backend via listBackends", async () => {
  const stub = makeAuthStub({
    descriptorsByBackend: { claude: [GATEWAY_AGENT], codex: [ENV_METHOD], opencode: [TERMINAL_METHOD] },
    backends: ["claude", "codex", "opencode"],
  });
  const { client, dispose } = await connectRunner(stub.runner);
  try {
    const res = await client.callTool({ name: "workflow_auth_status", arguments: {} });
    const backends = field(structured(res), "backends") as Array<Record<string, unknown>>;
    assert.deepEqual(backends.map((b) => b.backendId), ["claude", "codex", "opencode"]);
    // Each backend was probed with its own id (routing proof).
    assert.deepEqual(stub.describeCalls.map((c) => c.model).sort(), ["claude", "codex", "opencode"]);
  } finally {
    await dispose();
  }
});

// ── workflow_authenticate mapping ──

test("workflow_authenticate: env → {outcome:env}, output {status,methodId,recycled}, secret never echoed", async () => {
  const stub = makeAuthStub({ descriptorsByBackend: { codex: [ENV_METHOD] } });
  const { client, dispose } = await connectRunner(stub.runner);
  const SECRET = "sk-super-secret-value-123";
  try {
    const res = await client.callTool({
      name: "workflow_authenticate",
      arguments: { backend: "codex", methodId: "api-key", env: { OPENAI_API_KEY: SECRET } },
    });
    const sc = structured(res);
    assert.deepEqual(sc, { status: "authenticated", methodId: "api-key", recycled: true });

    // The resolution handed to completeAuth carries the secret (it must reach the AuthStore)…
    assert.equal(stub.completeCalls.length, 1);
    const resolution = stub.completeCalls[0].resolution;
    assert.equal(resolution.outcome, "env");
    assert.deepEqual(resolution.outcome === "env" ? resolution.values : undefined, { OPENAI_API_KEY: SECRET });

    // …but the secret appears NOWHERE in the tool result (content or structuredContent).
    assert.ok(!JSON.stringify(res).includes(SECRET), "secret env value never echoed into the tool result");
    assert.ok(!textOf(res).includes(SECRET));
  } finally {
    await dispose();
  }
});

test("workflow_authenticate: meta → {outcome:meta}, gateway secret never echoed", async () => {
  const stub = makeAuthStub({ descriptorsByBackend: { claude: [GATEWAY_AGENT] } });
  const { client, dispose } = await connectRunner(stub.runner);
  const HEADER = "Bearer super-secret-gateway-token";
  try {
    const res = await client.callTool({
      name: "workflow_authenticate",
      arguments: {
        backend: "claude",
        methodId: "gateway",
        meta: { gateway: { baseUrl: "https://gw.test", headers: { Authorization: HEADER } } },
      },
    });
    assert.deepEqual(structured(res), { status: "authenticated", methodId: "gateway", recycled: true });
    const resolution = stub.completeCalls[0].resolution;
    assert.equal(resolution.outcome, "meta");
    assert.ok(!JSON.stringify(res).includes(HEADER), "gateway header value never echoed");
  } finally {
    await dispose();
  }
});

test("workflow_authenticate: non-interactive descriptor, no env/meta → {outcome:completed}", async () => {
  const stub = makeAuthStub({ descriptorsByBackend: { opencode: [TERMINAL_METHOD] } });
  const { client, dispose } = await connectRunner(stub.runner);
  try {
    const res = await client.callTool({
      name: "workflow_authenticate",
      arguments: { backend: "opencode", methodId: "terminal-login" },
    });
    assert.deepEqual(structured(res), { status: "authenticated", methodId: "terminal-login", recycled: true });
    assert.equal(stub.completeCalls[0].resolution.outcome, "completed");
  } finally {
    await dispose();
  }
});

test("workflow_authenticate: interactive bare-agent → cancelled, completeAuth is NEVER called (no no-op)", async () => {
  const stub = makeAuthStub({ descriptorsByBackend: { codex: [INTERACTIVE_AGENT] } });
  const { client, dispose } = await connectRunner(stub.runner);
  try {
    const res = await client.callTool({
      name: "workflow_authenticate",
      arguments: { backend: "codex", methodId: "chat-gpt" },
    });
    assert.deepEqual(structured(res), { status: "cancelled", methodId: "chat-gpt", recycled: false });
    assert.equal(stub.completeCalls.length, 0, "an interactive method is never mapped to a completeAuth no-op");
    assert.match(textOf(res), /browser|TTY/i, "the cancel explains a browser/TTY-capable surface is needed");
  } finally {
    await dispose();
  }
});

test("workflow_authenticate: unknown method id, no env/meta → cancelled (never silently completed)", async () => {
  const stub = makeAuthStub({ descriptorsByBackend: { codex: [ENV_METHOD] } });
  const { client, dispose } = await connectRunner(stub.runner);
  try {
    const res = await client.callTool({
      name: "workflow_authenticate",
      arguments: { backend: "codex", methodId: "does-not-exist" },
    });
    assert.equal(field(structured(res), "status"), "cancelled");
    assert.equal(stub.completeCalls.length, 0);
  } finally {
    await dispose();
  }
});

// ── formatTerminalSummary auth_required branch + the pause → authenticate → resume loop ──

test("paused auth_required run: summary reads authContext (method ids), not the error message", async () => {
  const stub = makeAuthStub({
    descriptorsByBackend: { codex: [ENV_METHOD] },
    requireAuthOnRun: true,
    authBackendId: "codex",
  });
  const { client, dispose } = await connectRunner(stub.runner);
  try {
    const res = await client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });
    const sc = structured(res);
    assert.equal(field(sc, "status"), "paused");
    const text = textOf(res);
    assert.match(text, /backend "codex"/, "summary names the authContext backendId");
    assert.match(text, /api-key \(env_var\)/, "summary lists the authContext method id/type (only sourced from authContext)");
    assert.match(text, /workflow_authenticate/, "summary points at the auth tool");
  } finally {
    await dispose();
  }
});

test("loop: workflow pauses (auth_required) → workflow_authenticate → workflow(resumeFromRunId) completes", async () => {
  const stub = makeAuthStub({
    descriptorsByBackend: { codex: [ENV_METHOD] },
    requireAuthOnRun: true,
    authBackendId: "codex",
  });
  const { client, dispose } = await connectRunner(stub.runner);
  try {
    const paused = await client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });
    const runId = field(structured(paused), "runId");
    assert.equal(field(structured(paused), "status"), "paused");
    assert.equal(typeof runId, "string");

    const authed = await client.callTool({
      name: "workflow_authenticate",
      arguments: { backend: "codex", methodId: "api-key", env: { OPENAI_API_KEY: "sk-live" } },
    });
    assert.equal(field(structured(authed), "status"), "authenticated");
    assert.equal(stub.authenticated(), true);

    const resumed = await client.callTool({
      name: "workflow",
      arguments: { script: ONE_AGENT_SCRIPT, resumeFromRunId: runId as string },
    });
    assert.equal(field(structured(resumed), "status"), "completed", "the re-run lands on the now-authenticated runner");
    assert.equal(resumed.isError, false);
  } finally {
    await dispose();
  }
});
