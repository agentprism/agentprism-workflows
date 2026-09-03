import assert from "node:assert/strict";
import test from "node:test";

import {
  connect,
  makeRunner,
  persistedRunFile,
  structured,
  textOf,
} from "./_harness.js";

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

const RECOVERABLE_SCRIPT = `export const meta = { name: "same-run", description: "resume the exact run" };
const a = await agent("alpha", { label: "alpha", model: "claude" });
const b = await agent("beta", { label: "beta", model: "claude" });
if (b === null) throw new Error("beta must succeed");
return { a, b, original: args.value };`;

test("action resume continues the exact run with persisted inputs and admitted configuration", async () => {
  const prompts: string[] = [];
  let failBeta = true;
  const runner = makeRunner((prompt) => {
    prompts.push(prompt);
    if (prompt === "beta" && failBeta) {
      failBeta = false;
      throw new Error("first beta failed");
    }
    return `ok:${prompt}`;
  });
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const first = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script: RECOVERABLE_SCRIPT, args: { value: "kept" } },
    });
    const failed = structured(first);
    assert.equal(failed?.status, "failed");
    const runId = String(failed?.runId);
    assert.deepEqual(prompts, ["alpha", "beta"]);

    const file = persistedRunFile(runId);
    assert.ok(file);
    const admitted = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8"));
    assert.equal(admitted.admission.format, 1);
    assert.equal(admitted.admission.strict, true);
    assert.equal(admitted.admission.agentConfigurations["0"].model, "claude");
    assert.equal(admitted.admission.agentConfigurations["1"].model, "claude");
    assert.match(admitted.admission.selectionHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(admitted.admission), /agent_0_model|agent_1_model/);

    const second = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId },
    });
    const completed = structured(second);
    assert.equal(second.isError, false);
    assert.equal(completed?.runId, runId);
    assert.equal(completed?.status, "completed");
    assert.equal(field(completed?.result, "original"), "kept");
    assert.equal(field(completed?.result, "a"), "ok:alpha");
    assert.equal(field(completed?.result, "b"), "ok:beta");
    assert.deepEqual(prompts, ["alpha", "beta", "beta"], "the exact journal prefix replays");
  } finally {
    await dispose();
  }
});

test("resume rejects fields outside its exact public branch", async () => {
  const { client, dispose } = await connect(makeRunner(() => "ok"), { listTools: true });
  try {
    for (const arguments_ of [
      { action: "resume", runId: "source-1", script: RECOVERABLE_SCRIPT },
      { action: "resume", runId: "source-1", offset: 0 },
      { action: "status", runId: "source-1", checkpointReplies: { "0": true } },
    ]) {
      const result = await client.callTool({ name: "workflow", arguments: arguments_ });
      assert.equal(result.isError, true, JSON.stringify(arguments_));
      assert.match(textOf(result), /Invalid (arguments|workflow tool input)|validation error/i);
    }
  } finally {
    await dispose();
  }
});

test("old persisted runs without canonical admission remain observable but require a fresh run", async () => {
  const { client, dispose } = await connect(makeRunner((prompt) => {
    if (prompt === "beta") throw new Error("leave resumable");
    return "ok";
  }), { listTools: true });
  try {
    const first = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script: RECOVERABLE_SCRIPT, args: { value: "legacy" } },
    });
    const runId = String(structured(first)?.runId);
    const file = persistedRunFile(runId);
    assert.ok(file);
    const fs = await import("node:fs/promises");
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    delete state.admission;
    await fs.writeFile(file, JSON.stringify(state), "utf8");
    await fs.writeFile(`${file}.bak`, JSON.stringify(state), "utf8");

    const status = await client.callTool({
      name: "workflow",
      arguments: { action: "status", runId },
    });
    assert.equal(status.isError, false);
    assert.equal(structured(status)?.runId, runId);

    const resumed = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId },
    });
    assert.equal(resumed.isError, true);
    assert.match(textOf(resumed), /admission-missing/);
    assert.match(textOf(resumed), /start a fresh run/);
  } finally {
    await dispose();
  }
});

test("corrupt canonical admission metadata fails closed without provider re-elicitation", async () => {
  const { client, dispose } = await connect(makeRunner((prompt) => {
    if (prompt === "beta") throw new Error("leave resumable");
    return "ok";
  }), { listTools: true });
  try {
    const first = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script: RECOVERABLE_SCRIPT, args: { value: "corrupt" } },
    });
    const runId = String(structured(first)?.runId);
    const file = persistedRunFile(runId);
    assert.ok(file);
    const fs = await import("node:fs/promises");
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    state.admission.selectionHash = "not-a-canonical-hash";
    await fs.writeFile(file, JSON.stringify(state), "utf8");
    await fs.writeFile(`${file}.bak`, JSON.stringify(state), "utf8");

    const resumed = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId },
    });
    assert.equal(resumed.isError, true);
    assert.match(textOf(resumed), /admission-invalid/);
    assert.match(textOf(resumed), /start a fresh run/);
  } finally {
    await dispose();
  }
});
