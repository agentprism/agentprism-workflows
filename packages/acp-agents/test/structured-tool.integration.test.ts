import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import {
  isWorkflowError,
  WorkflowErrorCode,
  type McpServerConfig,
} from "@automatalabs/shared-types";
import { AcpAgentRunner, type CustomBackendConfig } from "../src/index.js";
import { createFakeAgentHarness, FAKE_AGENT_FIXTURE, readLog as readLogFile } from "./helpers/fake-agent.js";

const SCHEMA = Type.Object(
  {
    city: Type.String({ minLength: 2 }),
    hot: Type.Boolean(),
  },
  { additionalProperties: false },
);

interface LogEntry {
  method: string;
  label?: string;
  serverName?: string;
  response?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  params?: {
    mcpServers?: McpServerConfig[];
    prompt?: Array<{ type: string; text?: string }>;
  };
}

const harness = createFakeAgentHarness({ prefix: "acp-structured-tool-it-" });

afterEach(async () => {
  await harness.cleanup();
});

function fakeBackend(scenario: unknown, extra?: Partial<CustomBackendConfig>): {
  config: CustomBackendConfig;
  cwd: string;
  readLog: () => LogEntry[];
} {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-structured-tool-it-"));
  const log = path.join(dir, "log.jsonl");
  return {
    config: {
      command: process.execPath,
      args: [FAKE_AGENT_FIXTURE],
      env: {
        AGENTPRISM_FAKE_SCENARIO: JSON.stringify(scenario),
        AGENTPRISM_FAKE_LOG: log,
      },
      ...extra,
    },
    cwd: dir,
    readLog: () => readLogFile<LogEntry>(log),
  };
}

function makeRunner(backends: Record<string, CustomBackendConfig>): AcpAgentRunner {
  return harness.makeRunner({ backends });
}

function promptText(entry: LogEntry | undefined): string {
  return (entry?.params?.prompt ?? []).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

function firstToolText(entry: LogEntry | undefined): string {
  return entry?.response?.content?.find((block) => block.type === "text")?.text ?? "";
}

function newSessionServers(log: LogEntry[]): McpServerConfig[] {
  return log.find((entry) => entry.method === "newSession")?.params?.mcpServers ?? [];
}

test("custom HTTP-MCP agent captures valid StructuredOutput args over the injected tool", async () => {
  const { config, cwd } = fakeBackend({
    mcpHttpSupport: true,
    turns: [
      {
        structuredToolCall: { label: "valid", arguments: { city: "Oslo", hot: false } },
        text: "irrelevant prose",
      },
    ],
  });

  const out = await makeRunner({ fake: config }).run("classify", { model: "fake", cwd, schema: SCHEMA });

  assert.deepEqual(out, { city: "Oslo", hot: false });
});

test("custom HTTP-MCP agent can repair an invalid StructuredOutput call and then resolve", async () => {
  const { config, cwd, readLog } = fakeBackend({
    mcpHttpSupport: true,
    turns: [
      {
        structuredToolCalls: [
          { label: "invalid", arguments: { city: "", hot: false } },
          { label: "valid", arguments: { city: "Oslo", hot: false } },
        ],
        text: "done",
      },
    ],
  });

  const out = await makeRunner({ fake: config }).run("classify", { model: "fake", cwd, schema: SCHEMA });

  assert.deepEqual(out, { city: "Oslo", hot: false });
  const rejected = readLog().find((entry) => entry.method === "structuredToolCall" && entry.label === "invalid");
  assert.equal(rejected?.response?.isError, true);
  assert.match(firstToolText(rejected), /Structured output rejected/);
  assert.match(firstToolText(rejected), /\/city|Expected/);
});

test("custom HTTP-MCP agent degrades to final-text JSON when it never calls the tool", async () => {
  const { config, cwd } = fakeBackend({
    mcpHttpSupport: true,
    turns: [{ text: '{"city":"Oslo","hot":false}' }],
  });

  const out = await makeRunner({ fake: config }).run("classify", { model: "fake", cwd, schema: SCHEMA });

  assert.deepEqual(out, { city: "Oslo", hot: false });
});

test("custom HTTP-MCP agent receives a StructuredOutput repair prompt and then resolves", async () => {
  const { config, cwd, readLog } = fakeBackend({
    mcpHttpSupport: true,
    turns: [
      { text: "plain prose" },
      { structuredToolCall: { label: "repair", arguments: { city: "Oslo", hot: false } } },
    ],
  });

  const out = await makeRunner({ fake: config }).run("classify", { model: "fake", cwd, schema: SCHEMA });

  assert.deepEqual(out, { city: "Oslo", hot: false });
  const prompts = readLog().filter((entry) => entry.method === "prompt");
  assert.match(promptText(prompts[1]), /StructuredOutput/);
});

test("custom HTTP-MCP agent that never complies fails with SCHEMA_NONCOMPLIANCE", async () => {
  const { config, cwd } = fakeBackend({
    mcpHttpSupport: true,
    turns: [{ text: "plain prose" }, { text: "still prose" }],
  });

  await assert.rejects(
    () => makeRunner({ fake: config }).run("classify", { model: "fake", cwd, schema: SCHEMA, maxSchemaRetries: 1 }),
    (error) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
      return true;
    },
  );
});

test("custom agent without HTTP MCP support keeps the existing embedded-schema fallback", async () => {
  const { config, cwd, readLog } = fakeBackend({
    turns: [{ text: '{"city":"Oslo","hot":false}' }],
  });

  const out = await makeRunner({ fake: config }).run("classify", { model: "fake", cwd, schema: SCHEMA });

  assert.deepEqual(out, { city: "Oslo", hot: false });
  assert.deepEqual(newSessionServers(readLog()), []);
  const prompt = promptText(readLog().find((entry) => entry.method === "prompt"));
  assert.match(prompt, /required output schema \(JSON Schema\)/i);
  assert.ok(prompt.includes('"city"') && prompt.includes('"hot"'));
});

test("injected server is appended after user MCP servers and avoids structured_output name collision", async () => {
  const userServer: McpServerConfig = {
    type: "http",
    name: "structured_output",
    url: "http://127.0.0.1:9/not-used",
    headers: [],
  };
  const { config, cwd, readLog } = fakeBackend({
    mcpHttpSupport: true,
    turns: [{ structuredToolCall: { label: "valid", arguments: { city: "Oslo", hot: false } } }],
  });

  const out = await makeRunner({ fake: config }).run("classify", {
    model: "fake",
    cwd,
    schema: SCHEMA,
    mcpServers: [userServer],
  });

  assert.deepEqual(out, { city: "Oslo", hot: false });
  const servers = newSessionServers(readLog());
  assert.equal(servers.length, 2);
  assert.deepEqual(servers[0], userServer);
  assert.equal(servers[1]?.name, "structured_output_2");
  const injected = servers[1];
  assert.ok(injected && "type" in injected && injected.type === "http");
  assert.match(injected.url, /^http:\/\/127\.0\.0\.1:\d+\//);
});

test("concurrent schema runs on one connection SERIALIZE and keep captures isolated", async () => {
  const { config, cwd, readLog } = fakeBackend({
    mcpHttpSupport: true,
    turns: [
      { structuredToolCall: { label: "first", arguments: { city: "Oslo", hot: false } } },
      { structuredToolCall: { label: "second", arguments: { city: "Lima", hot: true } } },
    ],
  });
  const runner = makeRunner({ fake: config });

  const [a, b] = await Promise.all([
    runner.run("classify one", { model: "fake", cwd, schema: SCHEMA, label: "one" }),
    runner.run("classify two", { model: "fake", cwd, schema: SCHEMA, label: "two" }),
  ]);

  // Isolation: each run resolves to its own turn's capture — never a blend or a duplicate.
  assert.deepEqual([a, b].toSorted((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))), [
    { city: "Lima", hot: true },
    { city: "Oslo", hot: false },
  ]);

  // Serialization: agents with instance-global name-keyed MCP registries (OpenCode) expose
  // every registered tool to every live session, so the runner must never overlap two
  // injected sessions on one connection — the second session/new comes only after the first
  // run fully releases (same constant server name = replacement, single live registration).
  const wire = readLog().map((entry) => entry.method);
  const firstClose = wire.indexOf("closeSession");
  const secondNew = wire.indexOf("newSession", wire.indexOf("newSession") + 1);
  assert.ok(firstClose !== -1 && secondNew !== -1, `expected two sessions on the wire: ${wire.join(",")}`);
  assert.ok(secondNew > firstClose, `second newSession must follow first closeSession: ${wire.join(",")}`);
});

test("structuredOutputTool false in the registry disables injection even with HTTP MCP support", async () => {
  const { config, cwd, readLog } = fakeBackend(
    {
      mcpHttpSupport: true,
      turns: [{ text: '{"city":"Oslo","hot":false}' }],
    },
    { structuredOutputTool: false },
  );

  const out = await makeRunner({ fake: config }).run("classify", { model: "fake", cwd, schema: SCHEMA });

  assert.deepEqual(out, { city: "Oslo", hot: false });
  assert.deepEqual(newSessionServers(readLog()), []);
  assert.match(promptText(readLog().find((entry) => entry.method === "prompt")), /required output schema \(JSON Schema\)/i);
});
