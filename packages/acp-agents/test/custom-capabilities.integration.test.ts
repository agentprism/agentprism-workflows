// End-to-end custom-capability gating for CUSTOM backends. The fake ACP agent advertises
// scenario-specific agentCapabilities._meta blocks; the runner gates only the namespace declared
// by the selected backend, and an undeclared custom backend never inherits Codex's contract.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Type } from "typebox";
import { CODEX_CUSTOM_CAPABILITY_NAMESPACE, META_KEYS } from "@automatalabs/shared-types";
import { AcpAgentRunner, type CustomBackendConfig } from "../src/index.js";
import { createFakeAgentHarness, FAKE_AGENT_FIXTURE, readLog as readLogFile } from "./helpers/fake-agent.js";

const EXAMPLE_NAMESPACE = "@example/img-acp";
const EXAMPLE_CUSTOM_CAPABILITIES = { namespace: EXAMPLE_NAMESPACE, gatedKeys: ["renderTarget"] } as const;
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
  const dir = mkdtempSync(path.join(tmpdir(), "acp-custom-cap-it-"));
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

function makeRunner(backends: Record<string, CustomBackendConfig>): AcpAgentRunner {
  return harness.makeRunner({ backends });
}

function initializeWithMeta(meta?: Record<string, unknown>): unknown {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      sessionCapabilities: { close: {} },
      ...(meta ? { _meta: meta } : {}),
    },
  };
}

function promptMeta(log: LogEntry[]): Record<string, unknown> {
  return (log.find((entry) => entry.method === "prompt")?.params?._meta ?? {}) as Record<string, unknown>;
}

test("custom backend declaration: renderTarget false suppresses only that key", async () => {
  const { config, cwd, readLog } = fakeBackend(
    {
      initialize: initializeWithMeta({ [EXAMPLE_NAMESPACE]: { renderTarget: false } }),
      turns: [{ text: "ok" }],
    },
    { customCapabilities: EXAMPLE_CUSTOM_CAPABILITIES },
  );
  await makeRunner({ image: config }).run("render", {
    model: "image",
    cwd,
    promptMeta: { renderTarget: "image/png", passthrough: "kept" },
  });

  const meta = promptMeta(readLog());
  assert.equal("renderTarget" in meta, false, "advertised false => suppressed");
  assert.equal(meta.passthrough, "kept", "undeclared keys still pass");
});

test("custom backend declaration: renderTarget true passes the key", async () => {
  const { config, cwd, readLog } = fakeBackend(
    {
      initialize: initializeWithMeta({ [EXAMPLE_NAMESPACE]: { renderTarget: true } }),
      turns: [{ text: "ok" }],
    },
    { customCapabilities: EXAMPLE_CUSTOM_CAPABILITIES },
  );
  await makeRunner({ image: config }).run("render", {
    model: "image",
    cwd,
    promptMeta: { renderTarget: "image/png" },
  });

  assert.equal(promptMeta(readLog()).renderTarget, "image/png", "advertised true => sent");
});

test("custom backend declaration: no namespace advertisement is legacy passthrough", async () => {
  const { config, cwd, readLog } = fakeBackend(
    { initialize: initializeWithMeta(), turns: [{ text: "ok" }] },
    { customCapabilities: EXAMPLE_CUSTOM_CAPABILITIES },
  );
  await makeRunner({ image: config }).run("render", {
    model: "image",
    cwd,
    promptMeta: { renderTarget: "image/png" },
  });

  assert.equal(promptMeta(readLog()).renderTarget, "image/png", "no advertisement => legacy passthrough");
});

test("custom backend without declaration ignores the advertised Codex namespace", async () => {
  const { config, cwd, readLog } = fakeBackend({
    initialize: initializeWithMeta({
      [CODEX_CUSTOM_CAPABILITY_NAMESPACE]: { [META_KEYS.outputSchema]: false },
    }),
    turns: [{ text: '{"city":"Oslo","hot":false}' }],
  });
  const out = await makeRunner({ image: config }).run("classify", {
    model: "image",
    cwd,
    schema: SCHEMA,
  });

  assert.deepEqual(out, { city: "Oslo", hot: false });
  assert.ok(promptMeta(readLog())[META_KEYS.outputSchema], "no backend declaration => no custom gating");
});
