// Cold-process journal replay + ACP session continuation against the real Pi adapter/provider.
// The model work is intentionally trivial: two exact-sentinel prompts and one continuation turn.
// A wrapper injects the usage-limit boundary only after the real tail turn has created and retained
// a reopenable session; everything being asserted (persistence, replay, resume/load, and the final
// provider turn) runs through production machinery.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TSchema } from "typebox";
import {
  createAcpRunner,
  WorkflowError,
  WorkflowErrorCode,
  WorkflowManager,
  type AgentResult,
  type AgentRunner,
  type RunOptions,
  type WorkflowCallRecord,
} from "../src/index.js";

const LIVE = process.env.AGENTPRISM_LIVE_E2E === "1";
const CONFIGURED_MODEL = process.env.AGENTPRISM_PI_E2E_MODEL;
const HAS_PROVIDER_KEY = Boolean(
  process.env.ANTHROPIC_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.XAI_API_KEY ||
  process.env.OPENROUTER_API_KEY,
);
const LOAD_ONLY_BACKEND = "pi-load-only-live";
const PI_ENTRY = new URL("../../pi-acp/dist/index.js", import.meta.url).pathname;
const LOAD_ONLY_PROXY = new URL("./fixtures/load-only-acp-proxy.mjs", import.meta.url).pathname;

type ReattachMethod = "resume" | "load";
type OwnedRunner = AgentRunner & { dispose(): Promise<void> };

class PauseAfterRealTail implements AgentRunner {
  private armed: boolean;

  constructor(
    private readonly live: AgentRunner,
    armed: boolean,
  ) {
    this.armed = armed;
  }

  async run<S extends TSchema | undefined = undefined>(
    prompt: string,
    options: RunOptions<S> = {},
  ): Promise<AgentResult<S>> {
    const result = await this.live.run(prompt, options);
    if (this.armed && options.label === "tail" && options.continueFromSession === undefined) {
      this.armed = false;
      throw new WorkflowError(
        "controlled live-e2e usage boundary",
        WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
        { recoverable: false, agentLabel: options.label },
      );
    }
    return result;
  }
}

function requireLiveConfiguration(): string {
  assert.ok(CONFIGURED_MODEL, "AGENTPRISM_LIVE_E2E=1 requires AGENTPRISM_PI_E2E_MODEL");
  assert.ok(HAS_PROVIDER_KEY, "AGENTPRISM_LIVE_E2E=1 requires the selected Pi provider key");
  return CONFIGURED_MODEL.startsWith("pi/") ? CONFIGURED_MODEL.slice("pi/".length) : CONFIGURED_MODEL;
}

function makeRunner(method: ReattachMethod): OwnedRunner {
  if (method === "resume") return createAcpRunner();
  return createAcpRunner({
    backends: {
      [LOAD_ONLY_BACKEND]: {
        command: process.execPath,
        args: [LOAD_ONLY_PROXY, PI_ENTRY],
      },
    },
  });
}

function workflow(model: string): string {
  return `export const meta = { name: "continuation-live", description: "minimal live continuation" }
const prefix = await agent(
  "Reply with exactly PREFIX_OK and nothing else.",
  { label: "prefix", model: ${JSON.stringify(model)}, retries: 0, timeoutMs: null },
)
const tail = await agent(
  "Reply with exactly TAIL_OK and nothing else. If asked to continue, reply with exactly TAIL_RESUMED_OK.",
  { label: "tail", model: ${JSON.stringify(model)}, keepSession: true, retries: 0, timeoutMs: null },
)
return { prefix, tail }`;
}

/** Format 1 included retry/timeout controls. Object keys are already canonical-order here. */
function legacyInputsHash(call: WorkflowCallRecord): string {
  const canonical = JSON.stringify({
    backends: null,
    cwd: null,
    images: null,
    isolation: null,
    keepSession: call.label === "tail",
    label: call.label,
    mcpServers: null,
    meta: null,
    promptMeta: null,
    retries: 0,
    timeoutMs: null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

async function runColdContinuation(method: ReattachMethod): Promise<void> {
  const modelId = requireLiveConfiguration();
  const model = method === "resume" ? `pi/${modelId}` : `${LOAD_ONLY_BACKEND}/${modelId}`;
  const temp = mkdtempSync(join(tmpdir(), `agentprism-${method}-continuation-live-`));
  const cwd = join(temp, "workspace");
  const persistenceRoot = join(temp, "state");
  mkdirSync(cwd, { recursive: true });

  let sourceRunner: OwnedRunner | undefined = makeRunner(method);
  let resumedRunner: OwnedRunner | undefined;
  let sourceManager: WorkflowManager | undefined = new WorkflowManager({
    cwd,
    persistenceRoot,
    agent: new PauseAfterRealTail(sourceRunner, true),
  });
  let resumedManager: WorkflowManager | undefined;

  try {
    const paused = await sourceManager.runSync(workflow(model), undefined, {
      concurrency: 1,
      agentRetries: 0,
      agentTimeoutMs: null,
    });
    assert.equal(paused.status, "paused");

    const persisted = sourceManager.getPersistence().load(paused.runId);
    assert.ok(persisted?.runtime);
    assert.equal(persisted.pauseReason, "usage_limit");
    const prefix = persisted.calls?.find((call) => call.label === "prefix");
    const interrupted = persisted.calls?.find((call) => call.label === "tail");
    const recordedSession = persisted.agents.find((agent) =>
      agent.label === "tail" && agent.status === "error" && agent.session !== undefined
    )?.session;
    assert.ok(prefix && interrupted && recordedSession);
    assert.equal(prefix.outcome, "result");
    assert.equal(interrupted.outcome, "error");
    assert.equal(recordedSession.keptOpen, true);
    assert.equal(recordedSession.reopen.resume, method === "resume");
    assert.equal(recordedSession.reopen.load, true);

    // Exercise the compatibility bridge with a self-consistent format-1 recording, matching the
    // real customer artifacts that predate format 2's removal of retry/timeout from this hash.
    persisted.runtime.inputsFormat = 1;
    for (const call of persisted.calls ?? []) {
      if (call.kind === "agent") call.inputsHash = legacyInputsHash(call);
    }
    sourceManager.getPersistence().save(persisted);

    // Tear down the originating manager and ACP process. Reattachment must work from disk through
    // a newly constructed runner; an in-memory session cannot accidentally satisfy this test.
    sourceManager.dispose();
    sourceManager = undefined;
    await sourceRunner.dispose();
    sourceRunner = undefined;

    resumedRunner = makeRunner(method);
    resumedManager = new WorkflowManager({
      cwd,
      persistenceRoot,
      agent: new PauseAfterRealTail(resumedRunner, false),
    });
    const resumed = await resumedManager.resumeInBackground(paused.runId);
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("the persisted paused run should be resumable");
    const result = await resumed.promise;

    assert.equal(result.status, "completed");
    assert.deepEqual(
      result.fallbacks?.find((entry) => entry.kind === "continuation")?.continuation,
      { outcome: "reattached", method },
    );
    assert.ok((result.tokenUsage?.total ?? 0) > 0, "the live continuation has a positive debit");
    assert.equal(
      result.agentSessions?.find((session) => session.callIndex === interrupted.index)?.sessionId,
      recordedSession.sessionId,
      "the cold runner reopened the exact persisted session",
    );

    const replayedPrefix = result.calls?.find((call) => call.index === prefix.index);
    assert.equal(replayedPrefix?.hash, prefix.hash);
    assert.equal(replayedPrefix?.origin, "journal-replay");
    assert.equal(replayedPrefix?.budgetDebit, 0);
    const continuedTail = result.calls?.find((call) => call.index === interrupted.index);
    assert.deepEqual(continuedTail?.provenance, {
      source: "live",
      continuation: { reattached: true, method },
    });

    const value = result.result as { prefix?: unknown; tail?: unknown } | undefined;
    assert.equal(value?.prefix, persisted.journal?.find((entry) => entry.index === prefix.index)?.result);
    assert.equal(typeof value?.tail, "string");
    assert.ok((value?.tail as string).length > 0);
  } finally {
    sourceManager?.dispose();
    resumedManager?.dispose();
    if (sourceRunner) await sourceRunner.dispose();
    if (resumedRunner) await resumedRunner.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
}

for (const method of ["resume", "load"] as const) {
  test(
    `real Pi session cold-reattaches via ${method} after replaying its journal prefix`,
    {
      skip: LIVE ? false : "gated live continuation e2e — set AGENTPRISM_LIVE_E2E=1 with Pi credentials",
      timeout: 240_000,
    },
    async () => runColdContinuation(method),
  );
}
