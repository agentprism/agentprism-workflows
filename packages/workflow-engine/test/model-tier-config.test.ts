/**
 * Tests for model-tier-config.ts
 *
 * Covers:
 * 1. buildDefaultTierConfig — all tiers default to a single resolved model. The
 *    available-model list is now INJECTED (sourced from the host's ACP configOptions,
 *    not Pi's ModelRegistry); an empty list yields empty tier specs (session default
 *    applies downstream).
 * 2. resolveTierModel logic
 * 3. save/load round-trip + all validation/error paths (scoped to a temp dir)
 * 4. sortedTierNames helper
 *
 * All tier configs are single-model-per-tier (Record<string, string>).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

async function loadModule() {
  return await import("../src/model-tier-config.js");
}

describe("model-tier-config", () => {
  describe("buildDefaultTierConfig", () => {
    it("sets every tier to the provided current model", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("openai/gpt-4.1");
      assert.deepEqual(cfg.tiers, {
        small: "openai/gpt-4.1",
        medium: "openai/gpt-4.1",
        big: "openai/gpt-4.1",
      });
    });

    it("each tier holds a single string", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("openai/gpt-4.1");
      for (const [name, model] of Object.entries(cfg.tiers)) {
        assert.equal(typeof model, "string", `${name} tier should hold a string`);
      }
    });

    it("always produces the three standard tiers", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("openai/gpt-4.1");
      assert.deepEqual(Object.keys(cfg.tiers).sort(), ["big", "medium", "small"]);
    });

    it("falls back to the first INJECTED available model when no current model is given", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig(undefined, ["openai/gpt-4.1", "anthropic/claude-sonnet"]);
      assert.deepEqual(cfg.tiers, {
        small: "openai/gpt-4.1",
        medium: "openai/gpt-4.1",
        big: "openai/gpt-4.1",
      });
    });

    it("prefers the current model over the injected available list", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("explicit/model", ["openai/gpt-4.1", "anthropic/claude-sonnet"]);
      for (const model of Object.values(cfg.tiers)) {
        assert.equal(model, "explicit/model", "current model wins over availableModels[0]");
      }
    });

    it("yields empty tier specs when no current model and an empty available list (=> session default)", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      // The engine carries no provider registry: an empty availableModels list means
      // every tier is "" so the session default is what applies downstream.
      const cfgEmptyList = buildDefaultTierConfig(undefined, []);
      assert.deepEqual(cfgEmptyList.tiers, { small: "", medium: "", big: "" });
      // The default arg is the same empty list.
      const cfgNoArgs = buildDefaultTierConfig();
      assert.deepEqual(cfgNoArgs.tiers, { small: "", medium: "", big: "" });
    });
  });

  describe("resolveTierModel", () => {
    it("returns the model for a valid tier", async () => {
      const { resolveTierModel } = await loadModule();
      const config = {
        tiers: { small: "openai/gpt-4.1-mini", medium: "openai/gpt-4.1", big: "openai/gpt-5.6-luna" },
      };
      assert.equal(resolveTierModel("small", config), "openai/gpt-4.1-mini");
      assert.equal(resolveTierModel("medium", config), "openai/gpt-4.1");
      assert.equal(resolveTierModel("big", config), "openai/gpt-5.6-luna");
    });

    it("returns undefined for unknown tier name", async () => {
      const { resolveTierModel } = await loadModule();
      assert.equal(resolveTierModel("nonexistent", { tiers: { small: "gpt-4.1-mini" } }), undefined);
    });

    it("returns empty string when tier exists but no model is assigned", async () => {
      const { resolveTierModel } = await loadModule();
      assert.equal(resolveTierModel("medium", { tiers: { small: "gpt-4.1-mini", medium: "" } }), "");
    });
  });

  describe("loadModelTierConfig / saveModelTierConfig (scoped to tmpdir)", () => {
    it("round-trips a valid config through disk", async () => {
      const { loadModelTierConfig, saveModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      const config = {
        tiers: { small: "gpt-4.1-mini", medium: "gpt-4.1", big: "gpt-5.6-luna" },
      };
      saveModelTierConfig(config, cfgPath);
      const loaded = loadModelTierConfig(cfgPath);
      assert.deepEqual(loaded, config);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when file does not exist", async () => {
      const { loadModelTierConfig } = await loadModule();
      assert.equal(loadModelTierConfig(join(tmpdir(), "nonexistent-test-file.json")), null);
    });

    it("returns null for corrupted JSON", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, "{invalid json", "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null for non-object JSON", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '"just a string"', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when tiers is not an object", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": "not-an-object"}', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when a tier value is not a string", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": {"small": ["gpt-4.1-mini"]}}', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null, "array values should be rejected");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("accepts a config where a tier value is a valid string", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": {"small": "gpt-4.1-mini"}}', "utf-8");
      const result = loadModelTierConfig(cfgPath);
      assert.equal(result?.tiers.small, "gpt-4.1-mini");
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("sortedTierNames", () => {
    it("returns names sorted: small < medium < big", async () => {
      const { sortedTierNames } = await loadModule();
      const config = { tiers: { big: "gpt-5.6-luna", small: "gpt-4.1-mini", medium: "gpt-4.1" } };
      assert.deepEqual(sortedTierNames(config), ["small", "medium", "big"]);
    });

    it("places custom tier names alphabetically after the standard ones", async () => {
      const { sortedTierNames } = await loadModule();
      const config = { tiers: { xlarge: "gpt-5.6-luna", medium: "gpt-4.1", small: "gpt-4.1-mini" } };
      assert.deepEqual(sortedTierNames(config), ["small", "medium", "xlarge"]);
    });
  });
});
