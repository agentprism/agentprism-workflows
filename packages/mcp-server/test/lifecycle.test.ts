import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { AgentRunner } from "@automatalabs/shared-types";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import { installMcpServerLifecycle } from "../src/lifecycle.js";
import { createWorkflowServer } from "../src/server.js";

class FakeProcess extends EventEmitter {
  readonly stdin = new EventEmitter();
  readonly exitCodes: number[] = [];

  exit(code?: number): void {
    this.exitCodes.push(code ?? 0);
  }
}

function disposableRunner(dispose: () => Promise<void>, forceKill?: () => void): AgentRunner {
  return {
    run: async () => "unused",
    dispose,
    ...(forceKill ? { forceKill } : {}),
  } as AgentRunner;
}

function fakeTransport(): Transport {
  return {
    start: async () => {},
    send: async () => {},
    close: async () => {},
  };
}

function setup() {
  const processHandle = new FakeProcess();
  const exits: number[] = processHandle.exitCodes;
  let disposeCalls = 0;
  let stopCalls = 0;
  const transport = fakeTransport();
  const lifecycle = installMcpServerLifecycle({
    runner: disposableRunner(async () => {
      disposeCalls++;
    }),
    server: { stopAcceptingWork: () => { stopCalls++; } },
    transport,
    process: processHandle,
    deadlineMs: 100,
  });
  return {
    processHandle,
    transport,
    lifecycle,
    disposeCalls: () => disposeCalls,
    stopCalls: () => stopCalls,
    exits,
  };
}

test("SIGTERM disposes the runner, closes admission, and exits with the conventional status", async () => {
  const fixture = setup();
  fixture.processHandle.emit("SIGTERM");
  await fixture.lifecycle.shutdown("SIGTERM");

  assert.equal(fixture.stopCalls(), 1);
  assert.equal(fixture.disposeCalls(), 1);
  assert.deepEqual(fixture.exits, [143]);
});

test("SIGINT disposes the runner and exits with the conventional status", async () => {
  const fixture = setup();
  fixture.processHandle.emit("SIGINT");
  await fixture.lifecycle.shutdown("SIGINT");

  assert.equal(fixture.stopCalls(), 1);
  assert.equal(fixture.disposeCalls(), 1);
  assert.deepEqual(fixture.exits, [130]);
});

for (const event of ["close", "end"] as const) {
  test(`stdin ${event} disposes the runner and exits cleanly`, async () => {
    const fixture = setup();
    fixture.processHandle.stdin.emit(event);
    await fixture.lifecycle.shutdown(`stdin-${event}`);

    assert.equal(fixture.stopCalls(), 1);
    assert.equal(fixture.disposeCalls(), 1);
    assert.deepEqual(fixture.exits, [0]);
  });
}

test("transport close preserves its existing hook and triggers shutdown", async () => {
  const transport = fakeTransport();
  let previousCloseCalls = 0;
  transport.onclose = () => { previousCloseCalls++; };
  const processHandle = new FakeProcess();
  let disposeCalls = 0;
  let stopCalls = 0;
  const lifecycle = installMcpServerLifecycle({
    runner: disposableRunner(async () => { disposeCalls++; }),
    server: { stopAcceptingWork: () => { stopCalls++; } },
    transport,
    process: processHandle,
    deadlineMs: 100,
  });
  transport.onclose?.();
  await lifecycle.shutdown("transport-close");

  assert.equal(previousCloseCalls, 1);
  assert.equal(stopCalls, 1);
  assert.equal(disposeCalls, 1);
  assert.deepEqual(processHandle.exitCodes, [0]);
});

test("a stalled runner dispose reaches the hard exit deadline", async () => {
  const processHandle = new FakeProcess();
  let stopCalls = 0;
  const lifecycle = installMcpServerLifecycle({
    runner: disposableRunner(async () => await new Promise<void>(() => {})),
    server: { stopAcceptingWork: () => { stopCalls++; } },
    transport: fakeTransport(),
    process: processHandle,
    deadlineMs: 1,
  });

  await lifecycle.shutdown("stdin-close");
  assert.equal(stopCalls, 1);
  assert.deepEqual(processHandle.exitCodes, [0]);
});

test("a stalled force-killable runner is force-killed before the hard exit deadline", async () => {
  const processHandle = new FakeProcess();
  let forceKills = 0;
  const lifecycle = installMcpServerLifecycle({
    runner: disposableRunner(async () => await new Promise<void>(() => {}), () => { forceKills++; }),
    server: { stopAcceptingWork: () => {} },
    transport: fakeTransport(),
    process: processHandle,
    deadlineMs: 1,
  });

  await lifecycle.shutdown("stdin-close");
  assert.equal(forceKills, 1);
  assert.deepEqual(processHandle.exitCodes, [0]);
});

test("repeated shutdown triggers share one disposal and one exit", async () => {
  const fixture = setup();
  fixture.processHandle.emit("SIGTERM");
  fixture.processHandle.emit("SIGINT");
  fixture.processHandle.stdin.emit("close");
  fixture.transport.onclose?.();
  await fixture.lifecycle.shutdown("SIGTERM");

  assert.equal(fixture.stopCalls(), 1);
  assert.equal(fixture.disposeCalls(), 1);
  assert.deepEqual(fixture.exits, [143]);
});

test("shutdown admission control rejects every new workflow tool call", async () => {
  const server = createWorkflowServer(disposableRunner(async () => {}));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lifecycle-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    server.stopAcceptingWork();
    const result = await client.callTool({ name: "workflow", arguments: { action: "config" } });
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /shutting down/);
  } finally {
    await client.close();
    await server.close();
  }
});
