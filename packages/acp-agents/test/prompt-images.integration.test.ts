// End-to-end image prompt blocks against the fake ACP agent. The fixture records every
// session/prompt request, so these assertions pin the exact wire content after negotiation.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

interface LogEntry {
  method: string;
  params?: {
    prompt?: ContentBlock[];
  };
}

const harness = createFakeAgentHarness({ prefix: "acp-image-it-" });
const { makeRunner } = harness;
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

function promptBlocks(log: LogEntry[]): ContentBlock[] {
  return log.find((e) => e.method === "prompt")?.params?.prompt ?? [];
}

afterEach(async () => {
  await harness.cleanup();
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
