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

test("env_var descriptor applies SDK defaults: secret=true, optional=false, and carries link + per-var meta", () => {
  const method: AuthMethod = {
    id: "api-key",
    name: "API Key",
    type: "env_var",
    link: "https://example.test/keys",
    vars: [
      { name: "OPENAI_API_KEY", label: "OpenAI key" }, // no secret/optional -> defaults
      { name: "ORG", secret: false, optional: true, _meta: { hint: "org id" } },
    ],
  };
  const d = buildAuthDescriptor(method, SPAWN);
  assert.equal(d.type, "env_var");
  if (d.type !== "env_var") return;
  assert.equal(d.link, "https://example.test/keys");
  assert.deepEqual(d.vars[0], { name: "OPENAI_API_KEY", label: "OpenAI key", secret: true, optional: false });
  assert.deepEqual(d.vars[1], { name: "ORG", secret: false, optional: true, meta: { hint: "org id" } });
});

test("buildAuthDescriptors maps a mixed method list in order", () => {
  const methods: AuthMethod[] = [
    { id: "gateway", name: "Gateway", _meta: { gateway: { protocol: "test" } } },
    { id: "api-key", name: "API Key", type: "env_var", vars: [{ name: "K" }] },
    { id: "login", name: "Login", type: "terminal" },
  ];
  const ds = buildAuthDescriptors(methods, SPAWN);
  assert.deepEqual(
    ds.map((d) => d.type),
    ["agent", "env_var", "terminal"],
  );
});
