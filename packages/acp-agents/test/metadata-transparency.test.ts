// Removal locks for the retired backend-declared metadata gate. Vendor metadata is now transport
// data: neither built-in/backend configuration nor negotiated capabilities interpret it.
import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
  BACKENDS_ENV,
  CodexBackend,
  CustomAcpBackend,
  negotiateCapabilities,
  registryWithRunBackends,
  resolveBackendRegistry,
} from "../src/index.js";

const retiredDeclaration = {
  namespace: "@example/img-acp",
  gatedKeys: ["renderTarget"],
};

function legacyConfig(value: unknown): never {
  return { command: "img-acp", customCapabilities: value } as never;
}

test("built-in and custom backend instances expose no custom metadata capability declaration", () => {
  const codex = new CodexBackend();
  const custom = new CustomAcpBackend({ name: "image", command: "img-acp" });
  assert.equal(Object.hasOwn(codex, "customCapabilities"), false);
  assert.equal(Object.hasOwn(custom, "customCapabilities"), false);
});

test("negotiation preserves agent capability metadata without projecting vendor gates", () => {
  const agentMeta = {
    "@example/img-acp": {
      renderTarget: false,
      nested: { flags: [false, { future: "untouched" }] },
    },
  };
  const negotiated = negotiateCapabilities({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { _meta: agentMeta },
  });

  assert.strictEqual(negotiated.agent._meta, agentMeta);
  assert.equal("customMetaSupport" in negotiated, false);
  assert.equal("gatedKeys" in negotiated, false);
});

test("registry no longer validates or retains the retired declaration from untyped JSON", () => {
  const optionRegistry = resolveBackendRegistry({ image: legacyConfig(retiredDeclaration) });
  assert.deepEqual(optionRegistry.get("image"), { name: "image", command: "img-acp" });

  const envRegistry = resolveBackendRegistry(undefined, {
    [BACKENDS_ENV]: JSON.stringify({
      image: { command: "img-acp", customCapabilities: { malformed: [1, 2, 3] } },
    }),
  });
  assert.deepEqual(envRegistry.get("image"), { name: "image", command: "img-acp" });

  const runRegistry = registryWithRunBackends(
    resolveBackendRegistry(),
    { image: legacyConfig(null) },
  );
  assert.deepEqual(runRegistry.get("image"), { name: "image", command: "img-acp" });
});
