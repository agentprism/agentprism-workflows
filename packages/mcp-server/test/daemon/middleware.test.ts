// validateRequest: the spec-mandated Origin validation (403 on invalid) plus Host-header
// DNS-rebinding defense. Pure function — no HTTP server involved.
import assert from "node:assert/strict";
import { test } from "node:test";

import { validateRequest } from "../../src/daemon/middleware.js";

const PORT = 29888;

function verdict(headers: Record<string, string | undefined>, env: Record<string, string | undefined> = {}) {
  return validateRequest(headers, PORT, env);
}

test("loopback Host with the bound port and no Origin is allowed (shim/Codex/Claude path)", () => {
  assert.deepEqual(verdict({ host: `127.0.0.1:${PORT}` }), { ok: true });
  assert.deepEqual(verdict({ host: `localhost:${PORT}` }), { ok: true });
  assert.deepEqual(verdict({ host: `[::1]:${PORT}` }), { ok: true });
});

test("missing, non-loopback, or wrong-port Host is 403 (DNS rebinding guard)", () => {
  for (const host of [undefined, `evil.example:${PORT}`, "127.0.0.1:9999", "127.0.0.1", `10.0.0.5:${PORT}`]) {
    const result = verdict({ host });
    assert.equal(result.ok, false, `host=${host} should be rejected`);
    if (!result.ok) assert.equal(result.status, 403);
  }
});

test("loopback http Origins are allowed on any port", () => {
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:8080", "http://[::1]:3000", "http://localhost"]) {
    assert.deepEqual(verdict({ host: `127.0.0.1:${PORT}`, origin }), { ok: true }, `origin=${origin}`);
  }
});

test("non-loopback, opaque, or https Origins are 403", () => {
  for (const origin of ["https://evil.example", "null", "http://attacker.test:80", "https://localhost:5173", "not a url"]) {
    const result = verdict({ host: `127.0.0.1:${PORT}`, origin });
    assert.equal(result.ok, false, `origin=${origin} should be rejected`);
    if (!result.ok) assert.equal(result.status, 403);
  }
});

test("AGENTPRISM_DAEMON_ALLOWED_ORIGINS entries are exact-match allowed", () => {
  const env = { AGENTPRISM_DAEMON_ALLOWED_ORIGINS: "https://apps.example.com, https://other.example" };
  assert.deepEqual(verdict({ host: `127.0.0.1:${PORT}`, origin: "https://apps.example.com" }, env), { ok: true });
  assert.deepEqual(verdict({ host: `127.0.0.1:${PORT}`, origin: "https://other.example" }, env), { ok: true });
  const denied = verdict({ host: `127.0.0.1:${PORT}`, origin: "https://apps.example.com.evil.tld" }, env);
  assert.equal(denied.ok, false);
});
