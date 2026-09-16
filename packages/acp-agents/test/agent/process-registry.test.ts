// The module-level process-exit registry (src/agent/process-registry.ts): exactly one `exit`
// listener shared by every dedicated AcpAgent connection, installed with the first and removed
// with the last.
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AcpAgent } from "../../src/index.js";
import { liveConnectionCount } from "../../src/agent/process-registry.js";
import { createFakeAgentHarness, trackAgent, waitFor } from "../helpers/fake-agent.js";

const harness = createFakeAgentHarness({ prefix: "acp-agent-registry-it-", backends: ["claude"] });

afterEach(async () => {
  await harness.cleanup();
});

after(async () => {
  await waitFor(() => liveConnectionCount() === 0);
  assert.equal(liveConnectionCount(), 0);
});

test("agents share exactly one process exit listener that is removed with the last connection", async () => {
  const baseline = process.listenerCount("exit");
  assert.equal(liveConnectionCount(), 0);
  const { cwd } = harness.configure({ turns: [{ text: "ok" }] });

  const agents = [1, 2, 3].map(() => trackAgent(harness, new AcpAgent({ cwd, model: "claude" })));
  assert.equal(process.listenerCount("exit"), baseline, "the lazy constructor installs nothing");
  await Promise.all(agents.map((agent) => agent.ready()));
  assert.equal(process.listenerCount("exit"), baseline + 1, "one listener for three live connections");
  assert.equal(liveConnectionCount(), 3);

  await agents[0]!.close();
  assert.equal(process.listenerCount("exit"), baseline + 1, "still installed while any connection lives");
  assert.equal(liveConnectionCount(), 2);

  await Promise.all(agents.slice(1).map((agent) => agent.close()));
  assert.equal(process.listenerCount("exit"), baseline, "removed with the last connection");
  assert.equal(liveConnectionCount(), 0);

  // A later agent re-installs it, and a probe's dedicated connections count too.
  const again = trackAgent(harness, await AcpAgent.open({ cwd, model: "claude" }));
  assert.equal(process.listenerCount("exit"), baseline + 1);
  assert.equal(liveConnectionCount(), 1);
  await again.close();
  assert.equal(process.listenerCount("exit"), baseline);
});
