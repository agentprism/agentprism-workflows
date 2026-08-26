// End-to-end metadata transparency for custom backends. Agent capability metadata is deliberately
// hostile-looking: it must never filter session/new or session/prompt request metadata.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Type } from "typebox";
import { META_KEYS, type AgentSessionRef } from "@automatalabs/shared-types";
import { AcpAgentRunner, type CustomBackendConfig } from "../src/index.js";
import { createFakeAgentHarness, FAKE_AGENT_FIXTURE, readLog as readLogFile } from "./helpers/fake-agent.js";

const SCHEMA = Type.Object({ city: Type.String(), hot: Type.Boolean() });

interface LogEntry {
  method: string;
  params?: {
    _meta?: Record<string, unknown> | null;
  };
}

const harness = createFakeAgentHarness();

afterEach(async () => {
  await harness.cleanup();
});

function fakeBackend(scenario: unknown, extra?: Partial<CustomBackendConfig>): {
  config: CustomBackendConfig;
  cwd: string;
  readLog: () => LogEntry[];
} {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-meta-transparency-"));
  const log = path.join(dir, "log.jsonl");
  return {
    config: {
      command: process.execPath,
      args: [FAKE_AGENT_FIXTURE],
      env: {
        AGENTPRISM_FAKE_SCENARIO: JSON.stringify(scenario),
        AGENTPRISM_FAKE_LOG: log,
      },
      ...extra,
    },
    cwd: dir,
    readLog: () => readLogFile<LogEntry>(log),
  };
}

test("arbitrary nested initialize, session/new, and prompt metadata survives with documented collision winners", async () => {
  const initializeMeta = {
    steering: { supported: true, protocol: { version: 7, modes: ["strict", { future: true }] } },
    vendor: { arrays: [1, null, { deep: [false, "value"] }] },
  };
  const { config, cwd, readLog } = fakeBackend(
    {
      initialize: {
        protocolVersion: PROTOCOL_VERSION,
        _meta: initializeMeta,
        agentCapabilities: {
          sessionCapabilities: { close: {} },
          _meta: {
            "@example/legacy-gate": {
              renderTarget: false,
              outputSchema: false,
              arbitraryNested: false,
            },
          },
        },
      },
      turns: [{ text: '{"city":"Oslo","hot":false}' }],
    },
    {
      sessionMeta: {
        defaultOnly: { nested: ["kept"] },
        collision: "backend-default",
      },
    },
  );
  const runner = harness.makeRunner({ backends: { image: config } });
  let sessionRef: AgentSessionRef | undefined;
  const callerSchemaCollision = { caller: "must lose only this direct collision" };

  const result = await runner.run("classify", {
    model: "image",
    cwd,
    schema: SCHEMA,
    runId: "host-run-id",
    meta: {
      collision: "caller-wins-over-default",
      runId: "caller-run-id",
      sessionNested: { untouched: [{ key: "value" }] },
    },
    promptMeta: {
      renderTarget: "image/png",
      arbitraryNested: { list: [true, { deep: "prompt" }] },
      [META_KEYS.outputSchema]: callerSchemaCollision,
    },
    onSessionOpen: (ref) => {
      sessionRef = ref;
    },
  });

  assert.deepEqual(result, { city: "Oslo", hot: false });
  assert.deepEqual(sessionRef?.initializeMeta, initializeMeta);

  const newSessionMeta = readLog().find((entry) => entry.method === "newSession")?.params?._meta;
  assert.deepEqual(newSessionMeta, {
    defaultOnly: { nested: ["kept"] },
    collision: "caller-wins-over-default",
    runId: "host-run-id",
    sessionNested: { untouched: [{ key: "value" }] },
  });

  const promptMeta = readLog().find((entry) => entry.method === "prompt")?.params?._meta;
  assert.equal(promptMeta?.renderTarget, "image/png", "false vendor flags do not filter caller metadata");
  assert.deepEqual(promptMeta?.arbitraryNested, { list: [true, { deep: "prompt" }] });
  assert.notDeepEqual(promptMeta?.[META_KEYS.outputSchema], callerSchemaCollision);
  assert.deepEqual(
    (promptMeta?.[META_KEYS.outputSchema] as { properties?: unknown }).properties,
    SCHEMA.properties,
    "backend-computed structured-output schema wins its direct collision",
  );
});
