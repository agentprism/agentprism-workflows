import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { META_KEYS } from "@automatalabs/shared-types";
import { OpenCodeBackend } from "../src/index.js";
import type { StructuredSource } from "../src/index.js";

const SCHEMA = Type.Object({ city: Type.String({ minLength: 1 }), hot: Type.Boolean() });
const ENV_KEYS = [
  "AGENTPRISM_OPENCODE_ACP_CMD",
  "AGENTPRISM_OPENCODE_ACP_ARGS",
  "AGENTPRISM_OPENCODE_DATA_ROOT",
  "OPENCODE_DB",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_DISABLE_AUTOUPDATE",
] as const;

function source(text: string, finalText = text): StructuredSource {
  return { currentTurnText: () => text, finalMessageText: () => finalText, rawStructuredOutput: () => undefined };
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) prev[key] = process.env[key];
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test("OpenCodeBackend exposes its id and generic structured-output flags", () => {
  const backend = new OpenCodeBackend();
  assert.equal(backend.id, "opencode");
  assert.equal(backend.embedSchemaInPrompt, true);
  assert.equal(backend.injectStructuredOutputTool, true);
});

test("OpenCodeBackend.spawnConfig: CMD override wins and argv comes only from _ARGS", () => {
  withEnv({ AGENTPRISM_OPENCODE_ACP_CMD: "/custom/opencode", AGENTPRISM_OPENCODE_ACP_ARGS: "--stdio  --x y" }, () => {
    const cfg = new OpenCodeBackend().spawnConfig();
    assert.equal(cfg.command, "/custom/opencode");
    assert.deepEqual(cfg.args, ["--stdio", "--x", "y"]);
    assert.equal(cfg.env.AGENTPRISM_OPENCODE_ACP_CMD, "/custom/opencode");
  });
});

test("OpenCodeBackend.spawnConfig: every spawn uses the SAME stable XDG data/state/cache trees (phase-D re-attach)", () => {
  // The data root is STABLE per user+host so agent-persisted sessions survive pool recycles
  // and daemon restarts (phase-D review: a random tmpdir per spawn made cross-process
  // session/load fall back to a fresh session — re-attachment was not real for opencode).
  // The test pins the stable root under an explicit override so it never touches the user's
  // real home, and asserts the exact layout.
  const stableRoot = mkdtempSync(join(tmpdir(), "oc-stable-root-"));
  try {
    withEnv({ AGENTPRISM_OPENCODE_DATA_ROOT: stableRoot }, () => {
      const backend = new OpenCodeBackend();
      const first = backend.spawnConfig().env;
      const second = backend.spawnConfig().env;
      assert.ok(first.XDG_DATA_HOME && second.XDG_DATA_HOME, "each spawn env carries a dedicated XDG_DATA_HOME");
      assert.equal(first.XDG_DATA_HOME, second.XDG_DATA_HOME, "the data tree is STABLE across spawns (sessions persist)");
      assert.equal(first.XDG_STATE_HOME, second.XDG_STATE_HOME, "the state tree is stable across spawns");
      assert.equal(first.XDG_CACHE_HOME, second.XDG_CACHE_HOME, "the cache tree is stable across spawns");
      assert.equal(first.XDG_DATA_HOME, join(stableRoot, "data"), "the stable root's data dir is used");
      assert.match(first.XDG_STATE_HOME ?? "", /[/\\]state$/);
      assert.match(first.XDG_CACHE_HOME ?? "", /[/\\]cache$/);
      assert.equal(first.OPENCODE_DISABLE_AUTOUPDATE, "1");
      assert.equal(first.XDG_CONFIG_HOME, process.env.XDG_CONFIG_HOME, "user config stays shared");
      assert.ok(existsSync(join(first.XDG_DATA_HOME!, "opencode")), "the data dir is pre-created");
    });
  } finally {
    rmSync(stableRoot, { recursive: true, force: true });
  }
});

test("OpenCodeBackend.spawnConfig: the stable root lives under the user's data home by default (agentprism/opencode)", () => {
  // Without an override the root derives from the user's XDG_DATA_HOME (or ~/.local/share),
  // as a SIBLING of the real opencode dir — the daemon's instances never overlap the user's
  // own TUI store, and the root is stable across processes.
  const fixtureData = mkdtempSync(join(tmpdir(), "oc-default-root-"));
  try {
    withEnv({ XDG_DATA_HOME: fixtureData }, () => {
      const env = new OpenCodeBackend().spawnConfig().env;
      assert.equal(env.XDG_DATA_HOME, join(fixtureData, "agentprism", "opencode", "data"));
      assert.equal(env.XDG_STATE_HOME, join(fixtureData, "agentprism", "opencode", "state"));
      assert.equal(env.XDG_CACHE_HOME, join(fixtureData, "agentprism", "opencode", "cache"));
      assert.ok(existsSync(join(fixtureData, "agentprism", "opencode", "data", "opencode")), "the data dir is pre-created");
    });
  } finally {
    rmSync(fixtureData, { recursive: true, force: true });
  }
});

test("OpenCodeBackend.spawnConfig: seeds credentials from the real data dir into the stable tree", () => {
  const fixtureData = mkdtempSync(join(tmpdir(), "oc-auth-fixture-"));
  mkdirSync(join(fixtureData, "opencode"), { recursive: true });
  writeFileSync(join(fixtureData, "opencode", "auth.json"), '{"fixture":true}');
  try {
    withEnv({ XDG_DATA_HOME: fixtureData }, () => {
      const env = new OpenCodeBackend().spawnConfig().env;
      const seeded = join(env.XDG_DATA_HOME!, "opencode", "auth.json");
      assert.ok(existsSync(seeded), "auth.json is seeded into the stable data dir");
      assert.equal(readFileSync(seeded, "utf8"), '{"fixture":true}');
    });
  } finally {
    rmSync(fixtureData, { recursive: true, force: true });
  }
});

test("OpenCodeBackend.spawnConfig: an explicitly exported OPENCODE_DB passes through untouched", () => {
  withEnv({ OPENCODE_DB: "/explicit/opencode.db" }, () => {
    const cfg = new OpenCodeBackend().spawnConfig();
    assert.equal(cfg.env.OPENCODE_DB, "/explicit/opencode.db");
  });
});

test("OpenCodeBackend.spawnConfig: CMD with no _ARGS yields an empty argv", () => {
  withEnv({ AGENTPRISM_OPENCODE_ACP_CMD: "/custom/opencode" }, () => {
    const cfg = new OpenCodeBackend().spawnConfig();
    assert.equal(cfg.command, "/custom/opencode");
    assert.deepEqual(cfg.args, []);
  });
});

test("OpenCodeBackend.spawnConfig: default falls back to opencode acp on PATH", () => {
  withEnv({ AGENTPRISM_OPENCODE_ACP_ARGS: "--ignored-without-cmd" }, () => {
    const cfg = new OpenCodeBackend().spawnConfig();
    assert.equal(cfg.command, "opencode");
    assert.deepEqual(cfg.args, ["acp"]);
    assert.equal(cfg.env.PATH, process.env.PATH);
  });
});

test("OpenCodeBackend: schema uses generic prompt _meta; session _meta is empty", () => {
  const backend = new OpenCodeBackend();
  assert.equal(backend.sessionMeta(SCHEMA), undefined);
  assert.equal(backend.promptMeta(undefined), undefined);

  const meta = backend.promptMeta(SCHEMA) as Record<string, Record<string, unknown>>;
  const schema = meta[META_KEYS.outputSchema];
  assert.ok(schema, "outputSchema forwarded on the turn");
  assert.equal((schema.properties as Record<string, Record<string, unknown>>).city.minLength, 1);
  assert.equal("additionalProperties" in schema, false);
});

test("OpenCodeBackend.nativeStructured parses final text JSON", () => {
  const backend = new OpenCodeBackend();
  assert.deepEqual(backend.nativeStructured(source('{"city":"LA","hot":false}')), {
    city: "LA",
    hot: false,
  });
  assert.deepEqual(backend.nativeStructured(source('Here:\n```json\n{"city":"SF","hot":true}\n```')), {
    city: "SF",
    hot: true,
  });
  assert.equal(backend.nativeStructured(source("no json")), undefined);
});
