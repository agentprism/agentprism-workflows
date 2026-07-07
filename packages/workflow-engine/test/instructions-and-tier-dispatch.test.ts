import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentDefinition, AgentRegistry } from "../src/agent-registry.js";
import { runWorkflow } from "../src/workflow.js";

const MODEL_TIERS_FILE = ".agentprism/workflows/model-tiers.json";

function capturingRunner(capture: (options: Record<string, unknown>) => void) {
  return {
    async run(_prompt: string, options: Record<string, unknown>) {
      capture(options);
      return "ok";
    },
  };
}

async function withModelTiers<T>(
  tiers: Record<string, string>,
  fn: (configPath: string) => Promise<T>,
): Promise<T> {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "agentprism-tier-home-"));
  const configPath = join(home, MODEL_TIERS_FILE);
  mkdirSync(join(home, ".agentprism", "workflows"), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ tiers }), "utf-8");
  process.env.HOME = home;
  try {
    return await fn(configPath);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test("run-level instructions are prepended to composed subagent instructions", async () => {
  const seen: string[] = [];
  const registry: AgentRegistry = new Map([
    [
      "reviewer",
      {
        name: "reviewer",
        prompt: "Act as the reviewer.",
        source: "project",
      } as AgentDefinition,
    ],
  ]);
  const script = `export const meta = { name: 'i', description: 'instructions' }
phase('Review')
return await agent('check', { label: 'a', agentType: 'reviewer' })`;

  await runWorkflow(script, {
    agent: capturingRunner((options) => seen.push(String(options.instructions))),
    agentRegistry: registry,
    instructions: "Run-level guidance.",
    persistLogs: false,
  });

  assert.equal(seen.length, 1);
  assert.ok(
    seen[0].startsWith("Run-level guidance.\n\nAct as the reviewer."),
    "run instructions should be prepended before agentType guidance",
  );
  assert.ok(seen[0].includes("Workflow phase: Review"), "existing composed instructions are preserved");
});

test("unset run-level instructions leave an otherwise plain agent with no instructions", async () => {
  let instructions: unknown = "sentinel";
  await runWorkflow(
    `export const meta = { name: 'i2', description: 'instructions' }
return await agent('plain', { label: 'a' })`,
    {
      agent: capturingRunner((options) => {
        instructions = options.instructions;
      }),
      persistLogs: false,
    },
  );

  assert.equal(instructions, undefined);
});

test("agent tier resolves to the configured model before phase routing", async () => {
  await withModelTiers({ small: "vendor/small-model" }, async () => {
    const seen: Array<{ model?: string; tier?: string }> = [];
    const script = `export const meta = {
  name: 'tiered', description: 'tiered', phases: [{ title: 'A', model: 'phase/model' }]
}
phase('A')
await agent('tier beats phase', { label: 'tiered', tier: 'small' })
await agent('explicit beats tier', { label: 'explicit', tier: 'small', model: 'explicit/model' })
return {}`;

    await runWorkflow(script, {
      agent: capturingRunner((options) =>
        seen.push({ model: options.model as string | undefined, tier: options.tier as string | undefined }),
      ),
      persistLogs: false,
    });

    assert.deepEqual(seen[0], { model: "vendor/small-model", tier: "small" });
    assert.deepEqual(seen[1], { model: "explicit/model", tier: "small" });
  });
});

test("unresolved tier falls back to mainModel before runner default behavior", async () => {
  await withModelTiers({ medium: "vendor/medium-model" }, async () => {
    const seen: Array<{ model?: string; tier?: string }> = [];
    await runWorkflow(
      `export const meta = { name: 'tier-main', description: 'tier main fallback' }
return await agent('work', { label: 'a', tier: 'small' })`,
      {
        agent: capturingRunner((options) =>
          seen.push({ model: options.model as string | undefined, tier: options.tier as string | undefined }),
        ),
        mainModel: "session/main-model",
        persistLogs: false,
      },
    );

    assert.deepEqual(seen, [{ model: "session/main-model", tier: "small" }]);
  });
});

test("model tier config is loaded once per workflow run", async () => {
  await withModelTiers({ small: "vendor/initial-small" }, async (configPath) => {
    const seen: Array<string | undefined> = [];
    let calls = 0;
    const script = `export const meta = { name: 'tier-once', description: 'tier config snapshot' }
await agent('first', { label: 'a', tier: 'small' })
await agent('second', { label: 'b', tier: 'small' })
return {}`;

    await runWorkflow(script, {
      agent: capturingRunner((options) => {
        calls++;
        seen.push(options.model as string | undefined);
        if (calls === 1) {
          writeFileSync(configPath, JSON.stringify({ tiers: { small: "vendor/changed-small" } }), "utf-8");
        }
      }),
      persistLogs: false,
    });

    assert.deepEqual(seen, ["vendor/initial-small", "vendor/initial-small"]);
  });
});
