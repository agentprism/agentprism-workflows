import assert from "node:assert/strict";
import test from "node:test";

import {
  connect,
  makeRunner,
  persistedRunFile,
  runAndObserve,
  structured,
  textOf,
  waitForRun,
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
    const first = await runAndObserve(client, {
      script: RECOVERABLE_SCRIPT, args: { value: "kept" },
    });
    const failed = structured(first);
    assert.equal(failed?.status, "failed");
    const runId = String(failed?.runId);
    assert.deepEqual(prompts, ["alpha", "beta"]);

    const file = persistedRunFile(runId);
    assert.ok(file);
    const admitted = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8"));
    assert.equal(admitted.admission.format, 3);
    assert.equal(admitted.admission.strict, true);
    assert.ok(admitted.admission.routingSnapshot);
    assert.equal(admitted.admission.agentConfigurations, undefined);
    assert.match(admitted.admission.routingHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(admitted.admission), /agent_0_model|agent_1_model/);

    const second = await client.callTool({
      name: "workflow",
      arguments: { action: "resume", runId },
    });
    assert.equal(second.isError, false);
    assert.equal(structured(second)?.accepted, true);
    assert.equal(structured(second)?.runId, runId);
    const completed = structured(await waitForRun(client, runId));
    assert.equal(completed?.runId, runId);
    assert.equal(completed?.status, "completed");
    const result = field(completed?.outcome, "result");
    assert.equal(field(result, "original"), "kept");
    assert.equal(field(result, "a"), "ok:alpha");
    assert.equal(field(result, "b"), "ok:beta");
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
    const first = await runAndObserve(client, {
      script: RECOVERABLE_SCRIPT, args: { value: "legacy" },
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
    const first = await runAndObserve(client, {
      script: RECOVERABLE_SCRIPT, args: { value: "corrupt" },
    });
    const runId = String(structured(first)?.runId);
    const file = persistedRunFile(runId);
    assert.ok(file);
    const fs = await import("node:fs/promises");
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    state.admission.routingHash = "not-a-canonical-hash";
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

test("old positional admission remains inspectable but cannot authorize continuation", async () => {
  const { client, dispose } = await connect(makeRunner((prompt) => {
    if (prompt === "beta") throw new Error("leave resumable");
    return "ok";
  }), { listTools: true });
  try {
    const first = await runAndObserve(client, {script:RECOVERABLE_SCRIPT, args:{value:"old admission"}});
    const runId = String(structured(first)?.runId);
    const file = persistedRunFile(runId)!;
    const fs = await import("node:fs/promises");
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    state.admission = {format:2, strict:true, source:"mcp-routing", agentConfigurations:{0:{model:"claude"}, 1:{model:"claude"}}, selectionHash:"0".repeat(64), recordedAt:new Date().toISOString()};
    await fs.writeFile(file, JSON.stringify(state), "utf8");
    await fs.writeFile(`${file}.bak`, JSON.stringify(state), "utf8");
    const inspected = await client.callTool({name:"workflow", arguments:{action:"status", runId}});
    assert.equal(inspected.isError, false, textOf(inspected));
    const resumed = await client.callTool({name:"workflow", arguments:{action:"resume", runId}});
    assert.equal(resumed.isError, true, textOf(resumed));
    assert.match(textOf(resumed), /admission-invalid/);
    assert.match(textOf(resumed), /fresh run/);
  } finally { await dispose(); }
});
