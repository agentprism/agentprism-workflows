// `AcpAgent.probe` (src/agent/probe.ts): the no-prompt catalog over one disposed dedicated
// process per target, exact-model probes with the MCP `action:"config"` missing-catalog
// re-probe, per-harness failures that never throw, the per-probe timeout, and the pre-spawn
// TypeError for a bad modelFilter.
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AcpAgent, BUILTIN_BACKEND_IDS } from "../../src/index.js";
import { liveConnectionCount } from "../../src/agent/process-registry.js";
import { createFakeAgentHarness, waitFor } from "../helpers/fake-agent.js";

interface LogEntry {
  method: string;
  params?: { configId?: string; value?: string | boolean };
}

const harness = createFakeAgentHarness({ prefix: "acp-agent-probe-it-" });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);
const count = (log: LogEntry[], method: string): number => log.filter((entry) => entry.method === method).length;

afterEach(async () => {
  await harness.cleanup();
});

after(async () => {
  await waitFor(() => liveConnectionCount() === 0);
  assert.equal(liveConnectionCount(), 0);
});

test("probe() returns the report plus models, targets every built-in by default, and uses one disposed process per target", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "never" }] });
  const catalog = await AcpAgent.probe({ cwd });
  assert.deepEqual(catalog.harnessOptions.map((harnessEntry) => harnessEntry.backendId), [...BUILTIN_BACKEND_IDS]);
  assert.equal(catalog.ok, true);
  assert.equal(catalog.exitCode, 0);
  assert.equal(catalog.models.length, 4);
  assert.equal(catalog.models[0]!.hasModelOption, true);
  assert.ok(catalog.models[0]!.groups && catalog.models[0]!.groups.length > 0, "grouped model choices");
  assert.ok(catalog.harnessOptions.every((harnessEntry) => harnessEntry.probed && (harnessEntry.options?.length ?? 0) > 0));
  assert.equal(catalog.harnessOptions.find((entry) => entry.backendId === "claude")?.defaultModeId, "auto");
  assert.equal(catalog.harnessOptions.find((entry) => entry.backendId === "pi")?.defaultModeId, undefined);
  await waitFor(() => count(readLog(), "__exit") === 4);
  assert.equal(count(readLog(), "prompt"), 0, "no prompt ever");
  assert.equal(count(readLog(), "__start"), 4);
  assert.equal(count(readLog(), "__exit"), 4);
  assert.equal(count(readLog(), "newSession"), 4);
  await waitFor(() => liveConnectionCount() === 0);
  assert.equal(liveConnectionCount(), 0);
});

test("probe({ model }) selects the model first and reports the model-specific catalog; modelFilter narrows to matches", async () => {
  const { cwd, readLog } = configure({});
  const catalog = await AcpAgent.probe({ model: "claude/gpt-5.6-luna[high]", modelFilter: "luna", cwd });
  assert.equal(catalog.ok, true);
  const select = readLog().find((entry) => entry.method === "setSessionConfigOption");
  assert.equal(select?.params?.configId, "model");
  assert.equal(select?.params?.value, "gpt-5.6-luna[high]");
  assert.equal(catalog.harnessOptions.length, 1);
  assert.equal(catalog.harnessOptions[0]!.model, "claude/gpt-5.6-luna[high]");
  assert.equal(catalog.harnessOptions[0]!.backendId, "claude");
  assert.equal(catalog.harnessOptions[0]!.options?.find((option) => option.id === "model")?.currentValue, "gpt-5.6-luna[high]");
  assert.deepEqual(catalog.models[0]!.matches, ["gpt-5.6-luna[high]"]);
  assert.equal(catalog.models[0]!.filter, "luna");
  assert.equal(count(readLog(), "prompt"), 0);
  await waitFor(() => count(readLog(), "__exit") === 1);
});

test("a failing exact-model probe still returns the bare harness catalog (the MCP action:\"config\" fallback)", async () => {
  const { cwd, readLog } = configure({ setConfigOptionError: "unknown model" });
  const catalog = await AcpAgent.probe({ model: "claude/typo", cwd });
  assert.equal(catalog.ok, false);
  assert.equal(catalog.exitCode, 1);
  assert.equal(catalog.harnessOptions.length, 2);
  const [failed, bare] = catalog.harnessOptions;
  assert.equal(failed!.backendId, "claude");
  assert.equal(failed!.model, "claude/typo");
  assert.equal(failed!.probed, false);
  assert.match(failed!.error ?? "", /unknown model/);
  assert.equal(bare!.backendId, "claude");
  assert.equal(bare!.model, undefined);
  assert.equal(bare!.probed, true);
  assert.ok((bare!.options?.length ?? 0) > 0);
  // The models view mirrors harnessOptions order: the failed exact probe, then the bare catalog.
  assert.equal(catalog.models[0]!.probed, false);
  assert.equal(catalog.models[0]!.hasModelOption, false);
  assert.equal(catalog.models[1]!.hasModelOption, true);
  await waitFor(() => count(readLog(), "__exit") === 2);
  assert.equal(count(readLog(), "newSession"), 2);
  assert.equal(count(readLog(), "__start"), 2);
});

test("a failing harness reports probed:false without throwing", async () => {
  const { cwd, readLog } = configure({});
  const catalog = await AcpAgent.probe({
    cwd,
    harnesses: ["claude", "bad"],
    backends: { bad: { command: join(cwd, "missing-binary") } },
  });
  assert.equal(catalog.ok, false);
  assert.equal(catalog.exitCode, 1);
  assert.deepEqual(catalog.harnessOptions.map((entry) => [entry.backendId, entry.probed]), [["claude", true], ["bad", false]]);
  assert.equal(typeof catalog.harnessOptions[1]!.error, "string");
  assert.ok(catalog.harnessOptions[1]!.error!.length > 0);
  assert.equal(catalog.models[1]!.probed, false);
  assert.equal(catalog.models[1]!.hasModelOption, false);
  await waitFor(() => count(readLog(), "__exit") === 1);
  await waitFor(() => liveConnectionCount() === 0);
});

test("probe honors the per-probe timeout and cleans up", async () => {
  const { cwd } = configure({ initializeDelayMs: 500 });
  const catalog = await AcpAgent.probe({ cwd, harnesses: ["claude"], probeTimeoutMs: 50 });
  assert.equal(catalog.ok, false);
  assert.equal(catalog.harnessOptions[0]!.probed, false);
  assert.match(catalog.harnessOptions[0]!.error ?? "", /timed out after 50ms/);
  await waitFor(() => liveConnectionCount() === 0);
  assert.equal(liveConnectionCount(), 0);
});

test("a bad modelFilter throws a TypeError before any spawn", async () => {
  const { cwd, readLog } = configure({});
  await assert.rejects(AcpAgent.probe({ cwd, modelFilter: "/(/" }), TypeError);
  await assert.rejects(AcpAgent.probe({ cwd, probeTimeoutMs: 0 }), TypeError);
  await assert.rejects(AcpAgent.probe({ cwd, backends: { bad: {} as never } }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "SCRIPT_VALIDATION_ERROR");
    return true;
  });
  assert.deepEqual(readLog(), []);
  assert.equal(liveConnectionCount(), 0);
});
