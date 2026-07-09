// Unit tests for the OPT-IN inline MCP auth resolver (§4.3) — the secret-carrying elicitation
// path. The resolver's entire Server surface is getClientCapabilities() + elicitInput(), so a
// plain stub drives every branch deterministically: env / gateway / terminal / declined /
// unbound / elicitation-less / interactive-only, plus method priority. Where secrets are entered,
// the closing assertion proves no collected value ever appears in any OUTBOUND elicitation params
// (Principle 9 — the form asks, it never echoes).
import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AuthContext, AuthMethodDescriptor } from "@automatalabs/workflows";
import { createDeferredMcpAuthResolver } from "../src/auth-resolver.js";

type ElicitParams = Parameters<Server["elicitInput"]>[0];
type ElicitResult = Awaited<ReturnType<Server["elicitInput"]>>;

function stubServer(opts: {
  elicitation?: boolean;
  respond?: (params: ElicitParams, call: number) => ElicitResult;
}): { server: Server; calls: ElicitParams[] } {
  const calls: ElicitParams[] = [];
  const server = {
    getClientCapabilities: () => (opts.elicitation === false ? {} : { elicitation: {} }),
    elicitInput: async (params: ElicitParams): Promise<ElicitResult> => {
      calls.push(params);
      if (!opts.respond) throw new Error("unexpected elicitInput");
      return opts.respond(params, calls.length);
    },
  } as unknown as Server;
  return { server, calls };
}

function ctx(methods: AuthMethodDescriptor[]): AuthContext {
  return { backendId: "fake", methods, cause: "required" };
}

const ENV_METHOD: AuthMethodDescriptor = {
  type: "env_var",
  id: "api-key",
  name: "API key",
  vars: [
    { name: "FAKE_AUTH_TOKEN", label: "API key", secret: true, optional: false },
    { name: "FAKE_ORG", secret: false, optional: true },
  ],
};

const GATEWAY_METHOD: AuthMethodDescriptor = {
  type: "agent",
  id: "gateway",
  name: "Gateway",
  expectsMeta: true,
  interactive: false,
  meta: { gateway: {} },
};

const TERMINAL_METHOD: AuthMethodDescriptor = {
  type: "terminal",
  id: "cli-login",
  name: "CLI login",
  launch: { command: "fake-agent", args: ["login", "--device"] },
};

const INTERACTIVE_METHOD: AuthMethodDescriptor = {
  type: "agent",
  id: "chat-gpt",
  name: "ChatGPT",
  expectsMeta: false,
  interactive: true,
};

test("unbound resolver cancels without elicitation (pause-and-resume fallback)", async () => {
  const { resolver } = createDeferredMcpAuthResolver();
  const resolution = await resolver(ctx([ENV_METHOD]));
  assert.deepEqual(resolution, { outcome: "cancelled" });
});

test("host without the elicitation capability cancels without a single elicit call", async () => {
  const { resolver, bind } = createDeferredMcpAuthResolver();
  const { server, calls } = stubServer({ elicitation: false });
  bind(server);
  const resolution = await resolver(ctx([ENV_METHOD]));
  assert.deepEqual(resolution, { outcome: "cancelled" });
  assert.equal(calls.length, 0);
});

test("env_var: one masked form per var; accepted values become an env resolution; no secret is echoed", async () => {
  const { resolver, bind } = createDeferredMcpAuthResolver();
  const { server, calls } = stubServer({
    respond: (_params, call): ElicitResult =>
      call === 1
        ? { action: "accept", content: { value: "sk-live-SECRET" } }
        : { action: "accept", content: { value: "org-42" } },
  });
  bind(server);
  const resolution = await resolver(ctx([ENV_METHOD]));
  assert.equal(resolution.outcome, "env");
  if (resolution.outcome === "env") {
    assert.deepEqual(resolution.values, { FAKE_AUTH_TOKEN: "sk-live-SECRET", FAKE_ORG: "org-42" });
    assert.equal(resolution.methodId, "api-key");
  }
  assert.equal(calls.length, 2);
  // The secret var's form says so, and every outbound form is free of the collected secret.
  assert.match(String(calls[0]?.message), /secret — stored in memory only/);
  assert.ok(!JSON.stringify(calls).includes("sk-live-SECRET"), "a collected secret leaked into an elicitation form");
});

test("env_var: declining a REQUIRED var cancels the whole resolution", async () => {
  const { resolver, bind } = createDeferredMcpAuthResolver();
  const { server } = stubServer({ respond: (): ElicitResult => ({ action: "decline" }) });
  bind(server);
  assert.deepEqual(await resolver(ctx([ENV_METHOD])), { outcome: "cancelled" });
});

test("env_var: declining an OPTIONAL var skips it; the rest still resolve", async () => {
  const { resolver, bind } = createDeferredMcpAuthResolver();
  const { server } = stubServer({
    respond: (_params, call): ElicitResult =>
      call === 1 ? { action: "accept", content: { value: "sk-live-SECRET" } } : { action: "decline" },
  });
  bind(server);
  const resolution = await resolver(ctx([ENV_METHOD]));
  assert.equal(resolution.outcome, "env");
  if (resolution.outcome === "env") {
    assert.deepEqual(resolution.values, { FAKE_AUTH_TOKEN: "sk-live-SECRET" });
  }
});

test("gateway: one form collects baseUrl + JSON headers into gateway-shaped _meta; no secret echoed", async () => {
  const { resolver, bind } = createDeferredMcpAuthResolver();
  const { server, calls } = stubServer({
    respond: (): ElicitResult => ({
      action: "accept",
      content: { baseUrl: "https://gw.test", headers: '{"Authorization":"Bearer gw-SECRET"}' },
    }),
  });
  bind(server);
  const resolution = await resolver(ctx([GATEWAY_METHOD]));
  assert.equal(resolution.outcome, "meta");
  if (resolution.outcome === "meta") {
    assert.equal(resolution.methodId, "gateway");
    const gateway = resolution.meta.gateway as { baseUrl: string; headers?: Record<string, string> };
    assert.equal(gateway.baseUrl, "https://gw.test");
    assert.deepEqual(gateway.headers, { Authorization: "Bearer gw-SECRET" });
  }
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls).includes("gw-SECRET"), "a collected secret leaked into an elicitation form");
});

test("gateway: malformed headers JSON cancels rather than sending junk", async () => {
  const { resolver, bind } = createDeferredMcpAuthResolver();
  const { server } = stubServer({
    respond: (): ElicitResult => ({ action: "accept", content: { baseUrl: "https://gw.test", headers: "{not json" } }),
  });
  bind(server);
  assert.deepEqual(await resolver(ctx([GATEWAY_METHOD])), { outcome: "cancelled" });
});

test("terminal: shows the launch command once as an instruction, then cancels (MCP has no TTY)", async () => {
  const { resolver, bind } = createDeferredMcpAuthResolver();
  const { server, calls } = stubServer({ respond: (): ElicitResult => ({ action: "accept", content: {} }) });
  bind(server);
  assert.deepEqual(await resolver(ctx([TERMINAL_METHOD])), { outcome: "cancelled" });
  assert.equal(calls.length, 1);
  assert.match(String(calls[0]?.message), /fake-agent login --device/);
  assert.match(String(calls[0]?.message), /resumeFromRunId/);
});

test("interactive bare-agent methods cannot be completed here: cancelled with zero elicit calls", async () => {
  const { resolver, bind } = createDeferredMcpAuthResolver();
  const { server, calls } = stubServer({});
  bind(server);
  assert.deepEqual(await resolver(ctx([INTERACTIVE_METHOD])), { outcome: "cancelled" });
  assert.equal(calls.length, 0);
});

test("priority: env_var wins over a gateway method when both are advertised", async () => {
  const { resolver, bind } = createDeferredMcpAuthResolver();
  const { server, calls } = stubServer({
    respond: (): ElicitResult => ({ action: "accept", content: { value: "v" } }),
  });
  bind(server);
  const resolution = await resolver(ctx([GATEWAY_METHOD, ENV_METHOD]));
  assert.equal(resolution.outcome, "env");
  // Both elicit calls were env-var forms — the gateway form never rendered.
  assert.equal(calls.length, 2);
  for (const call of calls) assert.doesNotMatch(String(call.message), /Gateway configuration/);
});

test("elicitInput throwing on a required var degrades to cancelled (never rejects the run)", async () => {
  const { resolver, bind } = createDeferredMcpAuthResolver();
  const calls: ElicitParams[] = [];
  const server = {
    getClientCapabilities: () => ({ elicitation: {} }),
    elicitInput: async (params: ElicitParams): Promise<ElicitResult> => {
      calls.push(params);
      throw new Error("host closed the form");
    },
  } as unknown as Server;
  bind(server);
  assert.deepEqual(await resolver(ctx([ENV_METHOD])), { outcome: "cancelled" });
  assert.equal(calls.length, 1);
});
