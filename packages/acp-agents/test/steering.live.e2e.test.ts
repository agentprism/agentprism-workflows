// Real first-class steering smoke. This is deliberately separate from the fake-wire contract
// suite: it proves the installed Claude and workspace Codex adapters advertise and accept their
// native extension through the public held-open session API.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAcpRunner, type SteeringOutcome } from "../src/index.js";

const LIVE = process.env.AGENTPRISM_LIVE_E2E === "1";
const SKIP: string | false = LIVE
  ? false
  : "gated live steering e2e — set AGENTPRISM_LIVE_E2E=1 with Claude and Codex credentials";

const OUTCOMES: readonly SteeringOutcome[] = ["injected", "startedNewTurn", "failed"];

async function steerLiveBackend(backend: "claude" | "codex"): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), `agentprism-${backend}-steering-live-`));
  const runner = createAcpRunner();
  try {
    const session = await runner.openSession({ model: backend, cwd });
    try {
      assert.equal(
        session.capabilities?.supportsSteering,
        true,
        `${backend} must advertise top-level InitializeResponse._meta.steering.supported`,
      );

      let sawProgress = false;
      const offText = session.on("agent_message_chunk", () => { sawProgress = true; });
      const offThought = session.on("agent_thought_chunk", () => { sawProgress = true; });
      try {
        const prompt = session.prompt(
          "Work through this carefully and explain the answer in several short steps: what is 17 + 25?",
        );
        const deadline = Date.now() + 30_000;
        while (!sawProgress && Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(sawProgress, true, `${backend} prompt must still stream before steering`);

        const outcome = await session.steer("Keep the answer concise after your current reasoning.");
        assert.ok(OUTCOMES.includes(outcome), `${backend} returned an unknown steering outcome: ${outcome}`);
        await prompt;
      } finally {
        offText();
        offThought();
      }
    } finally {
      await session.release();
    }
  } finally {
    await runner.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("live steering e2e: Claude advertises and accepts native session steering", {
  skip: SKIP,
  timeout: 90_000,
}, () => steerLiveBackend("claude"));

test("live steering e2e: Codex advertises and accepts native session steering", {
  skip: SKIP,
  timeout: 90_000,
}, () => steerLiveBackend("codex"));
