// Real first-class steering smoke. This is deliberately separate from the fake-wire contract
// suite: it proves the installed Claude and workspace Codex adapters advertise and accept their
// native extension through the public held-open session API.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAcpRunner } from "../src/index.js";

const LIVE = process.env.AGENTPRISM_LIVE_E2E === "1";
const SKIP: string | false = LIVE
  ? false
  : "gated live steering e2e — set AGENTPRISM_LIVE_E2E=1 with Claude and Codex credentials";

const OUTCOMES = ["injected", "startedNewTurn", "failed", "promptRequired"] as const;

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The Claude adapter validates `model` against the SESSION's selectable option list — the CLI's
// model picker for this working directory — not the Anthropic model catalog. Each leg runs in a
// fresh temp cwd, so no project settings apply and the picker is whatever the environment says:
// ANTHROPIC_DEFAULT_OPUS_MODEL (exported by .githooks/pre-push) is what makes this model
// selectable. Naming it explicitly keeps the gate honest — if it ever stops being selectable the
// leg fails with "Invalid value for config option model" instead of quietly steering a different
// model than the one we intend to gate on.
const BACKEND_MODEL: Record<"claude" | "codex", string> = {
  claude: process.env.AGENTPRISM_CLAUDE_E2E_MODEL ?? "claude/claude-opus-4-8",
  codex: "codex",
};

async function steerLiveBackend(backend: "claude" | "codex"): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), `agentprism-${backend}-steering-live-`));
  const runner = createAcpRunner();
  try {
    const session = await runner.openSession({ model: BACKEND_MODEL[backend], cwd });
    try {
      const initializeMeta = session.capabilities?.initializeMeta;
      assert.ok(isPlainObject(initializeMeta));
      assert.ok(isPlainObject(initializeMeta.steering));
      assert.equal(initializeMeta.steering.supported, true);

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

        const response = await session.steer("Keep the answer concise after your current reasoning.");
        assert.ok(isPlainObject(response), `${backend} returned a non-object steering response`);
        assert.equal(typeof response.outcome, "string");
        assert.ok(
          OUTCOMES.includes(response.outcome as (typeof OUTCOMES)[number]),
          `${backend} returned an unknown steering outcome: ${String(response.outcome)}`,
        );
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
