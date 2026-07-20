import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { AgentSessionRef } from "@automatalabs/shared-types";
import type { AcpEventContext } from "../src/index.js";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

interface LogEntry {
  method: string;
  params?: Record<string, unknown>;
}

const harness = createFakeAgentHarness({
  prefix: "acp-initialize-meta-",
  backends: ["claude"],
});

afterEach(async () => {
  await harness.cleanup();
});

function initializeResponse(meta: unknown, include = true): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { close: {}, resume: {}, list: {}, fork: {} },
    },
    ...(include ? { _meta: meta } : {}),
  };
}

test("fresh, load, resume, and fork refs share recursively frozen per-session metadata", async () => {
  const metadata = {
    vendor: "example",
    nested: { flags: [true, false], object: { count: 2 } },
  };
  const { cwd } = harness.configure({
    initialize: initializeResponse(metadata),
    turns: [{ text: "fresh" }],
  });
  const runner = harness.makeRunner();
  const opened: AcpEventContext[] = [];
  runner.on("session_open", (event) => opened.push(event));

  let freshRef: AgentSessionRef | undefined;
  await runner.run("fresh", {
    model: "claude",
    cwd,
    keepSession: true,
    onSessionOpen: (ref) => (freshRef = ref),
  });
  assert.ok(freshRef?.initializeMeta);
  const refAndOpenEvents: Array<[AgentSessionRef, AcpEventContext]> = [
    [freshRef, opened.at(-1)!],
  ];

  const load = await runner.loadSession({ sessionId: freshRef.sessionId, model: "claude", cwd });
  refAndOpenEvents.push([load.sessionRef, opened.at(-1)!]);
  const resume = await runner.resumeSession({ sessionId: freshRef.sessionId, model: "claude", cwd });
  refAndOpenEvents.push([resume.sessionRef, opened.at(-1)!]);
  const fork = await runner.forkSession({ sessionId: freshRef.sessionId, model: "claude", cwd });
  refAndOpenEvents.push([fork.sessionRef, opened.at(-1)!]);
  try {
    for (const [ref, openEvent] of refAndOpenEvents) {
      assert.deepEqual(ref.initializeMeta, metadata);
      assert.ok(Object.isFrozen(ref.initializeMeta));
      assert.ok(Object.isFrozen((ref.initializeMeta as any).nested));
      assert.ok(Object.isFrozen((ref.initializeMeta as any).nested.flags));
      assert.ok(Object.isFrozen((ref.initializeMeta as any).nested.object));
      assert.equal(openEvent.sessionId, ref.sessionId);
      assert.strictEqual(openEvent.initializeMeta, ref.initializeMeta);
      assert.deepEqual(JSON.parse(JSON.stringify(ref)), ref);
    }

    const snapshot = freshRef.initializeMeta as any;
    assert.throws(() => snapshot.nested.flags.push(true), TypeError);
    assert.throws(() => {
      snapshot.nested.object.count = 99;
    }, TypeError);
    assert.deepEqual(freshRef.initializeMeta, metadata);
    assert.deepEqual(refAndOpenEvents[0]![1].initializeMeta, metadata);
  } finally {
    await Promise.all([load.release(), resume.release(), fork.release()]);
  }
});

test("absent and null metadata omit initializeMeta while an empty object remains present", async () => {
  for (const fixture of [
    { response: initializeResponse(undefined, false), expected: false },
    { response: initializeResponse(null), expected: false },
    { response: initializeResponse({}), expected: true },
  ]) {
    const { cwd } = harness.configure({ initialize: fixture.response, turns: [{ text: "ok" }] });
    const runner = harness.makeRunner();
    let ref: AgentSessionRef | undefined;
    await runner.run("check", {
      model: "claude",
      cwd,
      onSessionOpen: (value) => (ref = value),
    });
    assert.ok(ref);
    assert.equal("initializeMeta" in ref, fixture.expected);
    if (fixture.expected) assert.deepEqual(ref.initializeMeta, {});
    await harness.cleanup();
  }
});

test("initialize metadata changes only post-readiness projections, never wire traffic or capabilities", async () => {
  const run = async (withMeta: boolean) => {
    const marker = "metadata-must-not-be-logged";
    const { cwd, readLog } = harness.configure<LogEntry>({
      initialize: initializeResponse({ marker, nested: { ok: true } }, withMeta),
      turns: [{ text: "ok" }],
    });
    const runner = harness.makeRunner();
    const session = await runner.openSession({ model: "claude", cwd });
    const capabilities = session.capabilities;
    const ref = session.sessionRef;
    await session.release();
    const log = readLog();
    return { capabilities, ref, log, marker };
  };

  const absent = await run(false);
  await harness.cleanup();
  const present = await run(true);

  const withoutInitializeMeta = (value: Record<string, unknown> | undefined) => {
    if (!value) return value;
    const { initializeMeta: _ignored, ...rest } = value;
    return rest;
  };
  const withoutAcquisitionIdentity = (value: Record<string, unknown>) => {
    const { sessionId: _sessionId, cwd: _cwd, ...rest } = value;
    return rest;
  };
  assert.deepEqual(
    withoutInitializeMeta(present.capabilities as unknown as Record<string, unknown>),
    withoutInitializeMeta(absent.capabilities as unknown as Record<string, unknown>),
  );
  assert.equal(
    present.log.filter((entry) => entry.method === "initialize").length,
    absent.log.filter((entry) => entry.method === "initialize").length,
  );
  assert.deepEqual(
    present.log.find((entry) => entry.method === "initialize")?.params,
    absent.log.find((entry) => entry.method === "initialize")?.params,
  );
  assert.deepEqual(
    withoutAcquisitionIdentity(withoutInitializeMeta(present.ref)!),
    withoutAcquisitionIdentity(absent.ref as unknown as Record<string, unknown>),
  );
  assert.equal(JSON.stringify(present.log).includes(present.marker), false);
  assert.equal("initializeMeta" in absent.ref, false);
  assert.deepEqual(present.ref.initializeMeta, {
    marker: present.marker,
    nested: { ok: true },
  });
  assert.deepEqual(present.capabilities?.initializeMeta, present.ref.initializeMeta);
  assert.notStrictEqual(present.capabilities?.initializeMeta, present.ref.initializeMeta);
  assert.equal(Object.isFrozen(present.capabilities?.initializeMeta), false);
});
