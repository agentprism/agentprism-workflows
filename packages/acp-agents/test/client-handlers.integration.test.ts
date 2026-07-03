// End-to-end client-side fs/terminal interposition against the MOCK ACP agent. The fake agent
// calls the client's fs/terminal methods during a prompt turn over the real SDK connection; tests
// assert initialize advertisement, routed per-session context, returned responses, and
// structured JSON-RPC errors for unadvertised methods.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import {
  AcpAgentRunner,
  clientCapabilitiesFor,
  type AcpSessionContext,
  type ClientHandlers,
  type TerminalHandlers,
} from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

const TEST_ENV_VARS = [
  "AGENTPRISM_CLAUDE_ACP_CMD",
  "AGENTPRISM_CLAUDE_ACP_ARGS",
  "AGENTPRISM_CODEX_ACP_CMD",
  "AGENTPRISM_CODEX_ACP_ARGS",
  "AGENTPRISM_FAKE_LOG",
  "AGENTPRISM_FAKE_SCENARIO",
];

interface LogEntry {
  method: string;
  clientMethod?: string;
  response?: unknown;
  error?: { name?: string; message?: string; code?: number; data?: unknown };
  params?: {
    clientCapabilities?: {
      fs?: { readTextFile?: boolean; writeTextFile?: boolean };
      terminal?: boolean;
    };
  };
}

const runners: AcpAgentRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()));
  for (const key of TEST_ENV_VARS) delete process.env[key];
});

function configure(scenario: unknown): { cwd: string; readLog: () => LogEntry[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-client-handlers-it-"));
  const log = path.join(dir, "log.jsonl");
  process.env.AGENTPRISM_CLAUDE_ACP_CMD = process.execPath;
  process.env.AGENTPRISM_CLAUDE_ACP_ARGS = FIXTURE;
  process.env.AGENTPRISM_CODEX_ACP_CMD = process.execPath;
  process.env.AGENTPRISM_CODEX_ACP_ARGS = FIXTURE;
  process.env.AGENTPRISM_FAKE_LOG = log;
  process.env.AGENTPRISM_FAKE_SCENARIO = JSON.stringify(scenario);
  return {
    cwd: dir,
    readLog: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as LogEntry)
        : [],
  };
}

function makeRunner(clientHandlers?: ClientHandlers): AcpAgentRunner {
  const runner = new AcpAgentRunner({ clientHandlers });
  runners.push(runner);
  return runner;
}

function advertisedTrueCapabilities(log: LogEntry[]): ClientCapabilities {
  const caps = log.find((entry) => entry.method === "initialize")?.params?.clientCapabilities;
  const advertised: ClientCapabilities = {};
  const fs: NonNullable<ClientCapabilities["fs"]> = {};
  if (caps?.fs?.readTextFile === true) fs.readTextFile = true;
  if (caps?.fs?.writeTextFile === true) fs.writeTextFile = true;
  if (Object.keys(fs).length > 0) advertised.fs = fs;
  if (caps?.terminal === true) advertised.terminal = true;
  return advertised;
}

function clientCall(log: LogEntry[], method: string, label?: string): LogEntry | undefined {
  return log.find(
    (entry) =>
      entry.method === "clientCall" &&
      entry.clientMethod === method &&
      (label === undefined || (entry as { label?: string }).label === label),
  );
}

test("fs/read_text_file is advertised and routes with the session cwd", async () => {
  const { cwd, readLog } = configure({
    turns: [
      {
        clientCalls: [
          {
            method: "fs/read_text_file",
            label: "read",
            params: { path: "/workspace/file.txt", line: 2, limit: 3 },
          },
        ],
        text: "ok",
      },
    ],
  });
  const seen: Array<{ path: string; ctx: AcpSessionContext }> = [];
  const handlers: ClientHandlers = {
    fs: {
      readTextFile: (params, ctx) => {
        seen.push({ path: params.path, ctx });
        return { content: `content:${ctx.cwd}:${params.path}` };
      },
    },
  };

  const out = await makeRunner(handlers).run("hi", {
    model: "codex",
    cwd,
    label: "fs-run",
    runId: "run-ctx-1",
  });

  assert.equal(out, "ok");
  assert.deepEqual(advertisedTrueCapabilities(readLog()), clientCapabilitiesFor(handlers));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, "/workspace/file.txt");
  assert.equal(seen[0].ctx.cwd, cwd);
  assert.equal(seen[0].ctx.label, "fs-run");
  assert.equal(seen[0].ctx.runId, "run-ctx-1");
  assert.deepEqual(clientCall(readLog(), "fs/read_text_file", "read")?.response, {
    content: `content:${cwd}:/workspace/file.txt`,
  });
});

test("concurrent sessions each receive their own cwd in handler context", async () => {
  const { readLog } = configure({
    turns: [
      {
        clientCalls: [{ method: "fs/read_text_file", params: { path: "/workspace/file.txt" } }],
        text: "ok",
      },
    ],
  });
  const cwdA = mkdtempSync(path.join(tmpdir(), "acp-client-a-"));
  const cwdB = mkdtempSync(path.join(tmpdir(), "acp-client-b-"));
  const seen: string[] = [];
  const handlers: ClientHandlers = {
    fs: {
      readTextFile: (_params, ctx) => {
        seen.push(ctx.cwd);
        return { content: ctx.cwd };
      },
    },
  };

  const runner = makeRunner(handlers);
  await Promise.all([
    runner.run("one", { model: "codex", cwd: cwdA }),
    runner.run("two", { model: "codex", cwd: cwdB }),
  ]);

  assert.deepEqual(new Set(seen), new Set([cwdA, cwdB]));
  const responses = readLog()
    .filter((entry) => entry.method === "clientCall" && entry.clientMethod === "fs/read_text_file")
    .map((entry) => (entry.response as { content?: string } | undefined)?.content);
  assert.deepEqual(new Set(responses), new Set([cwdA, cwdB]));
});

test("unregistered fs/read_text_file returns a JSON-RPC error, not an empty object", async () => {
  const { cwd, readLog } = configure({
    turns: [
      {
        clientCalls: [{ method: "fs/read_text_file", label: "read", params: { path: "/workspace/file.txt" } }],
        text: "ok",
      },
    ],
  });

  const out = await makeRunner().run("hi", { model: "codex", cwd });

  assert.equal(out, "ok");
  assert.deepEqual(advertisedTrueCapabilities(readLog()), {});
  const call = clientCall(readLog(), "fs/read_text_file", "read");
  assert.equal(call?.response, undefined);
  assert.equal(call?.error?.name, "RequestError");
  assert.equal(call?.error?.code, -32601);
  assert.match(call?.error?.message ?? "", /fs\/read_text_file.+not advertised by this client/);
});

test("terminal handlers advertise terminal:true and route createTerminal with context", async () => {
  const { cwd, readLog } = configure({
    turns: [
      {
        clientCalls: [
          {
            method: "terminal/create",
            label: "term",
            params: { command: "echo", args: ["hi"], cwd: "/tmp" },
          },
        ],
        text: "ok",
      },
    ],
  });
  const seen: Array<{ command: string; ctx: AcpSessionContext }> = [];
  const terminalHandlers: TerminalHandlers = {
    createTerminal: (params, ctx) => {
      seen.push({ command: params.command, ctx });
      return { terminalId: `term:${ctx.sessionId}` };
    },
    terminalOutput: () => ({ output: "", truncated: false }),
    waitForTerminalExit: () => ({ exitCode: 0 }),
    killTerminal: () => undefined,
    releaseTerminal: () => undefined,
  };
  const handlers: ClientHandlers = { terminal: terminalHandlers };

  await makeRunner(handlers).run("hi", { model: "codex", cwd, label: "term-run" });

  assert.deepEqual(advertisedTrueCapabilities(readLog()), clientCapabilitiesFor(handlers));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, "echo");
  assert.equal(seen[0].ctx.cwd, cwd);
  assert.equal(seen[0].ctx.label, "term-run");
  assert.deepEqual(clientCall(readLog(), "terminal/create", "term")?.response, {
    terminalId: `term:${seen[0].ctx.sessionId}`,
  });
});
