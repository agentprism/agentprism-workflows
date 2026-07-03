// End-to-end image prompt blocks against the fake ACP agent. The fixture records every
// session/prompt request, so these assertions pin the exact wire content after negotiation.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { AcpAgentRunner } from "../src/index.js";

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
  params?: {
    prompt?: ContentBlock[];
  };
}

const runners: AcpAgentRunner[] = [];
function makeRunner(): AcpAgentRunner {
  const runner = new AcpAgentRunner();
  runners.push(runner);
  return runner;
}

function configure(scenario: unknown): { cwd: string; readLog: () => LogEntry[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-image-it-"));
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

function promptBlocks(log: LogEntry[]): ContentBlock[] {
  return log.find((e) => e.method === "prompt")?.params?.prompt ?? [];
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()));
  for (const key of TEST_ENV_VARS) delete process.env[key];
});

test("promptCapabilities.image:true sends text plus the verbatim image block", async () => {
  const image = { data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png", uri: "file:///tmp/pic.png" };
  const { cwd, readLog } = configure({
    initialize: {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { sessionCapabilities: { close: {} }, promptCapabilities: { image: true } },
    },
    turns: [{ text: "ok" }],
  });

  await makeRunner().run("describe it", { model: "codex", cwd, images: [image] });

  assert.deepEqual(promptBlocks(readLog()), [
    { type: "text", text: "describe it" },
    { type: "image", ...image },
  ]);
});

test("agent with no promptCapabilities receives a degraded image note and no image block", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  await makeRunner().run("describe it", {
    model: "codex",
    cwd,
    images: [{ data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png", uri: "file:///tmp/pic.png" }],
  });

  const blocks = promptBlocks(readLog());
  assert.deepEqual(blocks, [
    { type: "text", text: "describe it" },
    {
      type: "text",
      text: "[image omitted: image/png; uri=file:///tmp/pic.png — the codex agent does not advertise promptCapabilities.image]",
    },
  ]);
  assert.equal(blocks.some((block) => block.type === "image"), false);
});

test("run without images still sends exactly one text prompt block", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  await makeRunner().run("plain text", { model: "codex", cwd });

  assert.deepEqual(promptBlocks(readLog()), [{ type: "text", text: "plain text" }]);
});
