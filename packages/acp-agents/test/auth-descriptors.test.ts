import test from "node:test";
import assert from "node:assert/strict";
import type { AuthMethod } from "@agentclientprotocol/sdk";
import { buildAuthDescriptor, buildAuthDescriptors, isGatewayShapedMeta } from "../src/index.js";
import type { SpawnConfig } from "../src/index.js";

const SPAWN: SpawnConfig = { command: "/usr/bin/agent-bin", args: ["acp", "--stdio"], env: {} };

test("agent method with no _meta is a bare interactive agent descriptor", () => {
  const method: AuthMethod = { id: "chat-gpt", name: "ChatGPT" };
  const d = buildAuthDescriptor(method, SPAWN);
  assert.equal(d.type, "agent");
  if (d.type !== "agent") return;
  assert.equal(d.expectsMeta, false);
  assert.equal(d.interactive, true);
  assert.equal(d.meta, undefined);
});

test("agent method with gateway-shaped _meta expects meta and is not interactive", () => {
  const method: AuthMethod = { id: "gateway", name: "Gateway", _meta: { gateway: { protocol: "anthropic" } } };
  const d = buildAuthDescriptor(method, SPAWN);
  assert.equal(d.type, "agent");
  if (d.type !== "agent") return;
  assert.equal(d.expectsMeta, true);
  assert.equal(d.interactive, false);
  assert.deepEqual(d.meta, { gateway: { protocol: "anthropic" } });
  assert.equal(isGatewayShapedMeta(method._meta), true);
});

test("agent method with a NON-gateway _meta (codex api-key) expects meta but is not gateway-shaped", () => {
  const method: AuthMethod = { id: "api-key", name: "API Key", _meta: { "api-key": { provider: "openai" } } };
  const d = buildAuthDescriptor(method, SPAWN);
  assert.equal(d.type, "agent");
  if (d.type !== "agent") return;
  assert.equal(d.expectsMeta, true);
  assert.equal(d.interactive, false);
  assert.equal(isGatewayShapedMeta(method._meta), false);
});

test("terminal descriptor launch comes from _meta[terminal-auth] verbatim when present", () => {
  const method: AuthMethod = {
    id: "claude-ai-login",
    name: "Claude Subscription",
    type: "terminal",
    args: ["--cli", "auth", "login"],
    _meta: { "terminal-auth": { command: "/proc/self/exe", args: ["--cli", "auth", "login"], label: "Login" } },
  };
  const d = buildAuthDescriptor(method, SPAWN);
  assert.equal(d.type, "terminal");
  if (d.type !== "terminal") return;
  assert.equal(d.launch.command, "/proc/self/exe");
  assert.deepEqual(d.launch.args, ["--cli", "auth", "login"]);
  assert.equal(d.launch.label, "Login");
});

test("terminal descriptor launch falls back to the agent binary + AuthMethodTerminal.args/env", () => {
  const method: AuthMethod = {
    id: "console-login",
    name: "Anthropic Console",
    type: "terminal",
    args: ["--cli", "auth", "login", "--console"],
    env: { FOO: "bar" },
  };
  const d = buildAuthDescriptor(method, SPAWN);
  assert.equal(d.type, "terminal");
  if (d.type !== "terminal") return;
  assert.equal(d.launch.command, SPAWN.command);
  assert.deepEqual(d.launch.args, [...SPAWN.args, "--cli", "auth", "login", "--console"]);
  assert.deepEqual(d.launch.env, { FOO: "bar" });
});

test("a bare agent method carrying a terminal-auth hint becomes a terminal descriptor (opencode-login)", () => {
  const method: AuthMethod = {
    id: "opencode-login",
    name: "Login with opencode",
    _meta: { "terminal-auth": { command: "opencode", args: ["auth", "login"], label: "OpenCode Login" } },
  };
  const d = buildAuthDescriptor(method, SPAWN);
  assert.equal(d.type, "terminal");
  if (d.type !== "terminal") return;
  assert.equal(d.launch.command, "opencode");
  assert.deepEqual(d.launch.args, ["auth", "login"]);
});

test("agent method with a non-gateway _meta (codex api-key shape) expects meta, is not interactive, and carries the meta through", () => {
  const method: AuthMethod = {
    id: "api-key",
    name: "API Key",
    _meta: { "api-key": { provider: "openai", env: ["OPENAI_API_KEY"] } },
  };
  const d = buildAuthDescriptor(method, SPAWN);
  assert.equal(d.type, "agent");
  if (d.type !== "agent") return;
  assert.equal(d.expectsMeta, true);
  assert.equal(d.interactive, false);
  assert.deepEqual(d.meta, { "api-key": { provider: "openai", env: ["OPENAI_API_KEY"] } });
});

test("a method carrying the removed env_var discriminant on the wire is dispatched as the SDK parses it: a bare agent method", () => {
  // ACP schema 1.21.0 dropped `env_var`; the SDK's lenient `zAuthMethod` union now parses such an
  // object through the `agent` arm (type/vars stripped). The dispatcher must agree with the SDK, so
  // it never produces a descriptor type the protocol no longer has.
  const legacy = { id: "api-key", name: "API Key", type: "env_var", vars: [{ name: "K" }] } as unknown as AuthMethod;
  const d = buildAuthDescriptor(legacy, SPAWN);
  assert.equal(d.type, "agent");
  if (d.type !== "agent") return;
  assert.equal(d.expectsMeta, false);
  assert.equal(d.interactive, true);
});

test("buildAuthDescriptors maps a mixed method list in order", () => {
  const methods: AuthMethod[] = [
    { id: "gateway", name: "Gateway", _meta: { gateway: { protocol: "test" } } },
    { id: "api-key", name: "API Key", _meta: { "api-key": { provider: "openai" } } },
    { id: "login", name: "Login", type: "terminal" },
  ];
  const ds = buildAuthDescriptors(methods, SPAWN);
  assert.deepEqual(
    ds.map((d) => d.type),
    ["agent", "agent", "terminal"],
  );
});

test("Pi's single advertised auth method becomes one ambient agent descriptor (ACP 1.21.0 removed env_var)", () => {
  const methods: AuthMethod[] = [{ id: "pi-stored-credentials", name: "pi stored credentials" }];

  const descriptors = buildAuthDescriptors(methods, SPAWN);
  assert.deepEqual(descriptors.map(({ id, type }) => [id, type]), [["pi-stored-credentials", "agent"]]);
  assert.deepEqual(descriptors[0], {
    type: "agent",
    id: "pi-stored-credentials",
    name: "pi stored credentials",
    expectsMeta: false,
    interactive: true,
  });
});
