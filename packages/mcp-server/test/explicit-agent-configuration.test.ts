import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { connect, makeRunner, persistedRunFile, runAndObserve, structured, textOf, waitForRun } from "./_harness.js";
import { connectHttp, makeProjectDir, startDaemon } from "./_http-harness.js";

for (const protocolMode of ["legacy", "modern"] as const) {
  test(`${protocolMode}: a missing route fails with live discovery, without elicitation or ambient selection`, async () => {
    let dispatches = 0;
    const runner = Object.assign(makeRunner(() => { dispatches++; return "unexpected"; }), {
      listBackends: () => ["claude", "codex"],
      defaultBackendId: () => { throw new Error("ambient default must not be consulted"); },
      async probeConfigOptions(spec?: string) {
        if (spec === "claude") throw new Error("Claude unavailable");
        return { backendId: "codex", modes: null, options: [{ id: "model", name: "Model", type: "select" as const,
          currentValue: "ready", options: [{ value: "ready", name: "Ready" }] }] };
      },
    });
    const daemon = await startDaemon(runner);
    const connected = await connectHttp(daemon.url, { protocolMode, listTools: true, uiCapability: "matching", elicit: () => ({ action: "decline" }) });
    const previousDefault = process.env.AGENTPRISM_DEFAULT_BACKEND;
    process.env.AGENTPRISM_DEFAULT_BACKEND = "codex";
    try {
      const result = await connected.client.callTool({ name: "workflow", arguments: {
        action: "run", projectDir: makeProjectDir(`explicit-routing-${protocolMode}`),
        script: 'export const meta = { name:"missing-route", description:"explicit routing", phases:[{title:"Review"}] }; phase("Review"); return agent("work", {label:"reviewer"});',
      } });
      assert.equal(result.isError, true, "a missing route is rejected before any run exists");
      assert.equal(structured(result)?.runId, undefined);
      assert.match(textOf(result), /reviewer/);
      assert.match(textOf(result), /Review/);
      assert.match(textOf(result), /no configured model route/);
      assert.match(textOf(result), /codex\/ready/);
      assert.match(textOf(result), /Claude unavailable/);
      assert.match(textOf(result), /modelSpecs/);
      assert.equal(dispatches, 0);
      assert.deepEqual(connected.elicitations, []);
    } finally {
      if (previousDefault === undefined) delete process.env.AGENTPRISM_DEFAULT_BACKEND;
      else process.env.AGENTPRISM_DEFAULT_BACKEND = previousDefault;
      await connected.dispose();
      await daemon.close();
    }
  });

  test(`${protocolMode}: backend-only routes run without configuration forms and persist authored admission`, async () => {
    const seen: string[] = [];
    const daemon = await startDaemon(makeRunner((_prompt, options) => { seen.push(options.model!); return "ok"; }));
    const connected = await connectHttp(daemon.url, { protocolMode, listTools: true, uiCapability: "matching", elicit: () => ({ action: "decline" }) });
    try {
      const result = await runAndObserve(connected.client, {
        projectDir: makeProjectDir(`backend-only-${protocolMode}`),
        script: 'export const meta = { name:"backend-only", description:"intentional backend defaults", model:"codex" }; return agent("work");',
      });
      assert.equal(structured(result)?.status, "completed", textOf(result));
      assert.deepEqual(seen, ["codex"]);
      assert.deepEqual(connected.elicitations, []);
      const admission = JSON.parse(readFileSync(persistedRunFile(String(structured(result)?.runId))!, "utf8")).admission;
      assert.equal(admission.format, 3);
      assert.equal(admission.strict, true);
      assert.ok(admission.routingSnapshot);
      assert.match(admission.routingHash, /^[a-f0-9]{64}$/);
      assert.equal(admission.defaultModel, undefined);
      assert.equal(admission.agentConfigurations, undefined);
    } finally { await connected.dispose(); await daemon.close(); }
  });
}

test("a configured live branch preserves its provider when the mock branch used another provider", async () => {
  const seen: Array<{ label?: string; model?: string }> = [];
  const { client, dispose } = await connect(makeRunner((_prompt, options) => {
    seen.push({ label: options.label, model: options.model });
    return options.label === "decision" ? "live" : "done";
  }), { listTools: true, uiCapability: "matching" });
  try {
    const result = await runAndObserve(client, { script: `
      export const meta = { name: "branch-provider", description: "Configured branches" };
      const decision = await agent("Choose branch", { label: "decision", model: "claude" });
      if (decision === "live") return agent("Live branch", { label: "live-codex", model: "codex" });
      return agent("Mock branch", { label: "mock-claude", model: "claude" });
    ` });
    assert.equal(structured(result)?.status, "completed", textOf(result));
    assert.deepEqual(seen, [{ label: "decision", model: "claude" }, { label: "live-codex", model: "codex" }]);
  } finally { await dispose(); }
});

test("an extra configured live call is allowed beyond mock coverage", async () => {
  const seen: string[] = [];
  const { client, dispose } = await connect(makeRunner((_prompt, options) => {
    seen.push(options.model!);
    return "live";
  }), { listTools: true });
  try {
    const result = await runAndObserve(client, { script: `
      export const meta = { name: "extra-configured", description: "Configured dynamic call" };
      const decision = await agent("Choose branch", { label: "decision", model: "claude" });
      if (decision === "live") return agent("Live branch", { label: "live-codex", model: "codex" });
      return "finished";
    ` });
    assert.equal(structured(result)?.status, "completed", textOf(result));
    assert.deepEqual(seen, ["claude", "codex"]);
  } finally { await dispose(); }
});

test("reversed parallel completion preserves each actual call's provider", async () => {
  const seen: Array<{ label?: string; model?: string }> = [];
  const { client, dispose } = await connect(makeRunner(async (_prompt, options) => {
    seen.push({ label: options.label, model: options.model });
    if (options.label === "slow") await new Promise(resolve => setTimeout(resolve, 80));
    return "done";
  }), { listTools: true });
  try {
    const result = await runAndObserve(client, { concurrency: 4, script: `
      export const meta = { name: "parallel-provider", description: "Configured parallel paths" };
      return parallel([
        async () => { await agent("slow", { label: "slow", model: "claude" }); return agent("after slow", { label: "after-slow", model: "claude" }); },
        async () => { await agent("fast", { label: "fast", model: "codex" }); return agent("after fast", { label: "after-fast", model: "codex" }); }
      ]);
    ` });
    assert.equal(structured(result)?.status, "completed", textOf(result));
    assert.equal(seen.find(call => call.label === "after-fast")?.model, "codex");
    assert.equal(seen.find(call => call.label === "after-slow")?.model, "claude");
  } finally { await dispose(); }
});

test("a missing route on an unseen live branch fails before dispatch and includes discovery", async () => {
  const seen: string[] = [];
  const runner = Object.assign(makeRunner((_prompt, options) => { seen.push(options.label!); return "live"; }), {
    listBackends: () => ["codex"],
    async probeConfigOptions() {
      return { backendId: "codex", modes: null, options: [{ id: "model", name: "Model", type: "select" as const,
        currentValue: "ready", options: [{ value: "ready", name: "Ready" }] }] };
    },
  });
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const result = await runAndObserve(client, { script: `
      export const meta = { name:"unseen-missing", description:"runtime routing", phases:[{title:"Review"}] };
      const decision = await agent("Choose branch", { label:"decision", model:"codex" });
      if (decision === "live") { phase("Review"); return agent("Live branch", { label:"unseen" }); }
      return "finished";
    ` });
    assert.equal(structured(result)?.status, "failed", textOf(result));
    assert.deepEqual(seen, ["decision"]);
    assert.match(textOf(result), /unseen/);
    assert.match(textOf(result), /Review/);
    assert.match(textOf(result), /codex\/ready/);
    assert.match(textOf(result), /modelSpecs/);
  } finally { await dispose(); }
});

test("authored options are validated against the exact selected model before admission", async () => {
  let dispatches = 0;
  const probes: string[] = [];
  const runner = Object.assign(makeRunner(() => { dispatches++; return "done"; }), {
    listBackends: () => ["codex"],
    async probeConfigOptions(spec?: string) {
      probes.push(spec!);
      return { backendId: "codex", modes: null, options: [
        { id:"model", name:"Model", type:"select" as const, currentValue: spec === "codex/b" ? "b" : "a",
          options: [{value:"a", name:"A"}, {value:"b", name:"B"}] },
        { id:"strategy", name:"Strategy", type:"select" as const, currentValue: spec === "codex/b" ? "b-only" : "a-only",
          options:[{value:spec === "codex/b" ? "b-only" : "a-only", name:"Strategy"}] },
      ] };
    },
  });
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const script = (strategy: string) => `export const meta = {name:"exact-model", description:"model-specific options"}; return agent("work", {model:"codex/b", configOptions:{strategy:"${strategy}"}});`;
    const rejected = await client.callTool({ name: "workflow", arguments: { action: "run", script: script("a-only") } });
    assert.equal(rejected.isError, true, "an option the selected model does not advertise is rejected before admission");
    assert.match(textOf(rejected), /a-only/);
    const result = await runAndObserve(client, { script: script("b-only") });
    assert.equal(structured(result)?.status, "completed", textOf(result));
    assert.equal(dispatches, 1);
    assert.ok(probes.includes("codex/b"));
  } finally { await dispose(); }
});

test("continuation preserves routing without repeating discovery or consulting a changed default", async () => {
  let probes = 0;
  const seen: string[] = [];
  const runner = Object.assign(makeRunner((_prompt, options) => { seen.push(options.model!); return "done"; }), {
    async probeConfigOptions() { probes++; return {backendId:"codex", modes:null, options:[]}; },
  });
  const { client, dispose } = await connect(runner, {listTools:true});
  try {
    const result = await runAndObserve(client, {script: 'export const meta = {name:"continue-route", description:"durable route", model:"codex"}; await agent("before"); await checkpoint("Continue?"); return agent("after");'});
    assert.equal(structured(result)?.status, "paused", textOf(result));
    const probeCount = probes;
    runner.probeConfigOptions = async () => { throw new Error("continuation must not discover"); };
    const runId = String(structured(result)?.runId);
    const resumed = await client.callTool({name:"workflow", arguments:{action:"resume", runId, checkpointReplies:{1:true}}});
    assert.equal(resumed.isError, false, textOf(resumed));
    const completed = await waitForRun(client, runId);
    assert.equal(structured(completed)?.status, "completed", textOf(completed));
    assert.deepEqual(seen, ["codex", "codex"]);
    assert.equal(probes, probeCount);
  } finally { await dispose(); }
});

test("missing-route discovery probes concurrently, aborts unavailable backends, and retains the healthy catalog", async () => {
  const probes: string[] = [];
  const aborted: string[] = [];
  let healthyEntered!: () => void;
  const healthy = new Promise<void>(resolve => { healthyEntered = resolve; });
  const runner = Object.assign(makeRunner(() => assert.fail("missing route must not dispatch")), {
    listBackends: () => ["claude", "codex", "pi"],
    async probeConfigOptions(spec?: string, options?: {signal?:AbortSignal}) {
      probes.push(spec!);
      if (spec !== "pi") return new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => { aborted.push(spec!); reject(new Error("offline")); }, {once:true});
      });
      healthyEntered();
      return {backendId:"pi", modes:null, options:[{id:"model", name:"Model", type:"select" as const,
        currentValue:"direct/ready", options:[{value:"direct/ready", name:"Ready"}],
        _meta:{"@automatalabs/agentprism.modelDiscovery":{source:"enabledModels", preferred:["direct/ready"], unmatched:[]}},
      }]};
    },
  });
  const {client, dispose} = await connect(runner, {listTools:true});
  try {
    const pending = client.callTool({name:"workflow", arguments:{action:"run",
      script:'export const meta = {name:"partial-discovery", description:"one healthy backend"}; return agent("work", {label:"missing"});'}});
    await Promise.race([healthy, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("healthy backend was queued behind a stalled backend")), 1_000);
      timer.unref();
    })]);
    assert.deepEqual(probes, ["claude", "codex", "pi"]);
    const result = await pending;
    assert.equal(result.isError, true, "a missing route is rejected before any run exists");
    assert.match(textOf(result), /pi\/direct\/ready/);
    assert.match(textOf(result), /timed out|timeout/i);
    assert.deepEqual(aborted.sort(), ["claude", "codex"]);
  } finally { await dispose(); }
});

test("wildcard discovery selectors cannot dispatch as model routes", async () => {
  let dispatches = 0;
  const {client, dispose} = await connect(makeRunner(() => {dispatches++; return "unexpected";}));
  try {
    const result = await client.callTool({ name: "workflow", arguments: { action: "run", script: 'export const meta = {name:"wildcard", description:"browse selectors"}; return agent("work", {model:"opencode/openrouter/*"});' } });
    assert.equal(result.isError, true, "a wildcard selector is rejected before any run exists");
    assert.match(textOf(result), /discovery selector/);
    assert.match(textOf(result), /exact model route/);
    assert.equal(dispatches, 0);
  } finally { await dispose(); }
});

test("missing-route diagnostics are bounded, come from live discovery, and leave no run behind", async () => {
  let probes = 0;
  const runner = Object.assign(makeRunner(() => assert.fail("missing route must not dispatch")), {
    listBackends: () => ["codex"],
    async probeConfigOptions() {
      probes++;
      return {backendId:"codex", modes:null, options:[{id:"model", name:"Model", type:"select" as const,
        currentValue:"ready", options:[{value:"ready", name:"Ready"}]}]};
    },
  });
  const script = 'export const meta = {name:"cold-missing", description:"durable diagnostics"}; return agent("work", {label:"cold-worker"});';
  const {client, dispose} = await connect(runner, {listTools:true});
  try {
    const result = await client.callTool({name:"workflow", arguments:{action:"run", script}});
    assert.equal(result.isError, true, "a missing route is rejected before any run exists");
    assert.equal(structured(result)?.runId, undefined);
    assert.match(textOf(result), /cold-worker/);
    assert.match(textOf(result), /codex\/ready/);
    assert.match(textOf(result), /modelSpecs/);
    assert.ok(probes >= 1);
    assert.ok(Buffer.byteLength(textOf(result), "utf8") <= 8_192);
    const probesBefore = probes;
    runner.probeConfigOptions = async () => { throw new Error("discovery offline"); };
    const again = await client.callTool({name:"workflow", arguments:{action:"run", script}});
    assert.equal(again.isError, true);
    assert.equal(probes, probesBefore, "a rejected preparation retains nothing a later attempt could reuse");
    assert.match(textOf(again), /discovery offline/);
  } finally { await dispose(); }
});
