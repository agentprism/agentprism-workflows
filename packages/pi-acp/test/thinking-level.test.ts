import assert from "node:assert/strict";
import test from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import {
  applyConfig,
  CONFIG_OPTION_META_NAMESPACE,
  RECOGNIZED_THINKING_LEVELS,
  thinkingLevelOption,
} from "../src/config.js";
import { fakeSession } from "./helpers/fakes.js";

function model(
  id: string,
  reasoning: boolean,
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"],
): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "test",
    baseUrl: "https://example.invalid/v1",
    reasoning,
    thinkingLevelMap,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
}

function advertisedValues(session: ReturnType<typeof fakeSession>["session"]): string[] {
  const option = thinkingLevelOption(session);
  assert.equal(option.type, "select");
  return option.options.map((entry) => "options" in entry ? entry.options : [entry]).flat().map(({ value }) => value);
}

function runtimeWith(selected: Model<Api>): ModelRuntime {
  return { async getAvailable() { return [selected]; } } as unknown as ModelRuntime;
}

// pi 0.82.0 reshaped builtin kimi thinking domains (opencode-go/kimi-k3 is max-only now),
// so the capped fixture is synthetic: reasoning with no explicit xhigh/max support yields
// the ladder through "high" regardless of catalog drift.
const cappedAtHigh = model("capped-at-high", true);
const sparseKimi = getBuiltinModel("moonshotai", "kimi-k3");
const fullLadder = getBuiltinModel("amazon-bedrock", "anthropic.claude-opus-4-7");
const nonReasoning = getBuiltinModel("amazon-bedrock", "amazon.nova-lite-v1:0");
const interiorGap = model("interior-gap", true, { low: null, xhigh: null, max: null });

test("thinking-level advertisement is the ordered subset for the selected model", () => {
  const highSession = fakeSession({ model: cappedAtHigh });
  const throughHigh = RECOGNIZED_THINKING_LEVELS.slice(
    0,
    RECOGNIZED_THINKING_LEVELS.indexOf("high") + 1,
  );
  assert.deepEqual(advertisedValues(highSession.session), throughHigh);
  assert.equal(advertisedValues(highSession.session).includes("xhigh"), false);
  assert.equal(advertisedValues(highSession.session).includes("max"), false);

  const fullSession = fakeSession({ model: fullLadder });
  assert.equal(RECOGNIZED_THINKING_LEVELS.length, 7);
  assert.deepEqual(advertisedValues(fullSession.session), RECOGNIZED_THINKING_LEVELS);

  const sparseSession = fakeSession({ model: sparseKimi });
  assert.deepEqual(advertisedValues(sparseSession.session), ["low", "high", "max"]);

  const offSession = fakeSession({ model: nonReasoning });
  assert.deepEqual(advertisedValues(offSession.session), ["off"]);

  const unknownSession = fakeSession({});
  assert.deepEqual(advertisedValues(unknownSession.session), RECOGNIZED_THINKING_LEVELS);
});

test("advertisement exposes the supported subset and pi-derived recognized domain additively", () => {
  const session = fakeSession({ model: cappedAtHigh });
  const option = thinkingLevelOption(session.session);
  assert.equal(option.type, "select");
  assert.deepEqual(option.options.map(({ value }) => value), getSupportedThinkingLevels(cappedAtHigh));
  assert.deepEqual(option._meta, {
    [CONFIG_OPTION_META_NAMESPACE]: {
      recognizedValues: RECOGNIZED_THINKING_LEVELS,
    },
  });
});

test("recognized ladder is derived from pi once and covers every built-in catalog model", () => {
  const allSupportingModel = {
    reasoning: {},
    thinkingLevelMap: new Proxy({}, {
      get: (_target, property) => typeof property === "string" ? property : undefined,
    }),
  } as unknown as Model<Api>;
  const piDerivedExpectation = getSupportedThinkingLevels(allSupportingModel);
  assert.deepEqual(RECOGNIZED_THINKING_LEVELS, piDerivedExpectation);
  assert.equal(Object.isFrozen(RECOGNIZED_THINKING_LEVELS), true);

  const recognized = new Set<ModelThinkingLevel>(RECOGNIZED_THINKING_LEVELS);
  for (const provider of getBuiltinProviders()) {
    for (const catalogModel of getBuiltinModels(provider)) {
      for (const level of getSupportedThinkingLevels(catalogModel)) {
        assert.equal(
          recognized.has(level),
          true,
          `${catalogModel.provider}/${catalogModel.id} exposed unrecognized thinking level ${level}`,
        );
      }
    }
  }
});

test("applyConfig rejects garbage loudly and never accepts pi's lowest-level fallback", async () => {
  const session = fakeSession({ model: cappedAtHigh, thinkingLevel: "medium" });
  await assert.rejects(
    applyConfig(session.session, runtimeWith(cappedAtHigh), [cappedAtHigh], "thinkingLevel", "ultrahigh"),
    (error: unknown) =>
      error instanceof RequestError &&
      (error.data as { errorKind?: unknown } | undefined)?.errorKind === "invalid_config_value",
  );
  assert.equal(session.session.thinkingLevel, "medium");
  assert.notEqual(session.session.thinkingLevel, "off");
});

test("applyConfig clamps only unsupported recognized levels and echoes the effective value", async () => {
  const cappedSession = fakeSession({ model: cappedAtHigh });
  const capped = await applyConfig(
    cappedSession.session,
    runtimeWith(cappedAtHigh),
    [cappedAtHigh],
    "thinkingLevel",
    "xhigh",
  );
  assert.equal(cappedSession.session.thinkingLevel, "high");
  assert.equal(capped.configOptions[0]?.currentValue, "high");

  const gapSession = fakeSession({ model: interiorGap });
  const gap = await applyConfig(
    gapSession.session,
    runtimeWith(interiorGap),
    [interiorGap],
    "thinkingLevel",
    "low",
  );
  assert.equal(gapSession.session.thinkingLevel, "medium");
  assert.equal(gap.configOptions[0]?.currentValue, "medium");

  const sparseSession = fakeSession({ model: sparseKimi });
  const sparse = await applyConfig(
    sparseSession.session,
    runtimeWith(sparseKimi),
    [sparseKimi],
    "thinkingLevel",
    "xhigh",
  );
  assert.equal(sparseSession.session.thinkingLevel, "max");
  assert.equal(sparse.configOptions[0]?.currentValue, "max");

  const supportedSession = fakeSession({ model: cappedAtHigh });
  const supported = await applyConfig(
    supportedSession.session,
    runtimeWith(cappedAtHigh),
    [cappedAtHigh],
    "thinkingLevel",
    "minimal",
  );
  assert.equal(supportedSession.session.thinkingLevel, "minimal");
  assert.equal(supported.configOptions[0]?.currentValue, "minimal");
});
