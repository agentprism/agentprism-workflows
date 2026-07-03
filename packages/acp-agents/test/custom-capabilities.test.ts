// Backend-declared custom-capability contracts: the Codex built-in declares the legacy fork
// namespace, custom registry entries may declare their own namespace + gated bare `_meta` keys,
// and no declaration means no custom `_meta` gating at all.
import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { CODEX_CUSTOM_CAPABILITY_NAMESPACE, META_KEYS } from "@automatalabs/shared-types";
import {
  BACKENDS_ENV,
  CodexBackend,
  CustomAcpBackend,
  GATED_CUSTOM_META_KEYS,
  gateCustomMeta,
  negotiateCapabilities,
  registryWithRunBackends,
  resolveBackendRegistry,
} from "../src/index.js";

const EXAMPLE_CUSTOM_CAPABILITIES = {
  namespace: "@example/img-acp",
  gatedKeys: ["renderTarget"],
} as const;

function configWith(customCapabilities: unknown): never {
  return { command: "img-acp", customCapabilities } as never;
}

test("CodexBackend declares the fork custom-capability contract from GATED_CUSTOM_META_KEYS", () => {
  const backend = new CodexBackend();
  assert.equal(backend.customCapabilities.namespace, CODEX_CUSTOM_CAPABILITY_NAMESPACE);
  assert.equal(backend.customCapabilities.gatedKeys, GATED_CUSTOM_META_KEYS);
});

test("negotiateCapabilities reads only the backend-declared namespace", () => {
  const negotiated = negotiateCapabilities(
    {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        _meta: {
          [CODEX_CUSTOM_CAPABILITY_NAMESPACE]: { [META_KEYS.outputSchema]: false },
          [EXAMPLE_CUSTOM_CAPABILITIES.namespace]: { renderTarget: true },
        },
      },
    },
    EXAMPLE_CUSTOM_CAPABILITIES,
  );
  assert.deepEqual(negotiated.customMetaSupport, { renderTarget: true });
  assert.deepEqual(negotiated.gatedKeys, ["renderTarget"]);
});

test("gateCustomMeta accepts backend-specific gated keys", () => {
  const meta = { renderTarget: "image/png", [META_KEYS.outputSchema]: { type: "object" }, passthrough: true };
  assert.deepEqual(gateCustomMeta(meta, { renderTarget: false }, EXAMPLE_CUSTOM_CAPABILITIES.gatedKeys), {
    [META_KEYS.outputSchema]: { type: "object" },
    passthrough: true,
  });
  assert.deepEqual(gateCustomMeta(meta, { renderTarget: true }, EXAMPLE_CUSTOM_CAPABILITIES.gatedKeys), meta);
});

test("registry accepts customCapabilities from options and AGENTPRISM_BACKENDS", () => {
  const optionRegistry = resolveBackendRegistry({
    image: { command: "img-acp", customCapabilities: EXAMPLE_CUSTOM_CAPABILITIES },
  });
  assert.deepEqual(optionRegistry.get("image")?.customCapabilities, EXAMPLE_CUSTOM_CAPABILITIES);
  assert.deepEqual(new CustomAcpBackend(optionRegistry.get("image")!).customCapabilities, EXAMPLE_CUSTOM_CAPABILITIES);

  const envRegistry = resolveBackendRegistry(
    undefined,
    {
      [BACKENDS_ENV]: JSON.stringify({
        image: { command: "img-acp", customCapabilities: EXAMPLE_CUSTOM_CAPABILITIES },
      }),
    },
  );
  assert.deepEqual(envRegistry.get("image")?.customCapabilities, EXAMPLE_CUSTOM_CAPABILITIES);
});

test("registry rejects malformed customCapabilities shapes", () => {
  assert.throws(() => resolveBackendRegistry({ image: configWith(null) }), /"customCapabilities" must be an object/);
  assert.throws(() => resolveBackendRegistry({ image: configWith([]) }), /"customCapabilities" must be an object/);
  assert.throws(
    () => resolveBackendRegistry({ image: configWith({ namespace: "", gatedKeys: ["renderTarget"] }) }),
    /"customCapabilities\.namespace" must be a non-empty string/,
  );
  assert.throws(
    () => resolveBackendRegistry({ image: configWith({ namespace: "img" }) }),
    /"customCapabilities\.gatedKeys" must be a non-empty array of non-empty strings/,
  );
  assert.throws(
    () => resolveBackendRegistry({ image: configWith({ namespace: "img", gatedKeys: "renderTarget" }) }),
    /"customCapabilities\.gatedKeys" must be a non-empty array of non-empty strings/,
  );
  assert.throws(
    () => resolveBackendRegistry({ image: configWith({ namespace: "img", gatedKeys: [] }) }),
    /"customCapabilities\.gatedKeys" must be a non-empty array of non-empty strings/,
  );
  assert.throws(
    () => resolveBackendRegistry({ image: configWith({ namespace: "img", gatedKeys: [""] }) }),
    /"customCapabilities\.gatedKeys" must be a non-empty array of non-empty strings/,
  );
  assert.throws(
    () => registryWithRunBackends(resolveBackendRegistry(), { image: configWith({ namespace: "img", gatedKeys: [1] }) }),
    /script backends \(meta\.backends\): backend "image" "customCapabilities\.gatedKeys"/,
  );
});
