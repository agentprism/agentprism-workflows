import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { AgentRunner, AgentSessionRef, RunOptions } from "@automatalabs/shared-types";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

// hashAgentCall() is module-private, but every live agent() emits its call hash on the
// JournalEntry (workflow.ts: onAgentJournal({ index, hash, result })). The resume
// contract is "replay a cached result iff cached.hash === hash", so this hash is the
// load-bearing resume key: it MUST be byte-stable for a fixed call identity and MUST
// change when any identity input (prompt / model / mode-when-set / configOptions-when-non-empty /
// tier / phase / agentType / agentDef / schema) changes. These tests pin that through the
// observable journal.

const echo = {
  async run(prompt: string) {
    return `ran:${prompt}`;
  },
};

/** Run a script with the echo agent and return its journal entries in index order. */
async function journalOf(script: string, args?: unknown): Promise<JournalEntry[]> {
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    agent: echo,
    args,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  return journal.sort((a, b) => a.index - b.index);
}

const singleCall = `export const meta = { name: 'h', description: 'hash' }
const a = await agent('only', { label: 'a' })
return a`;

describe("journal hash (hashAgentCall byte-stability)", () => {
  it("emits a sha256 hex digest as the resume key", async () => {
    const [entry] = await journalOf(singleCall);
    assert.equal(entry.index, 0);
    assert.match(entry.hash, /^[a-f0-9]{64}$/, "hash is a lowercase sha256 hex digest");
  });

  it("pins the exact identity serialization (byte layout is load-bearing)", async () => {
    // This is the strongest guard: it reconstructs the EXACT JSON the engine hashes,
    // in the EXACT field order, with the EXACT null-mapping for absent inputs. A
    // call `agent('only', { label: 'a' })` in a script with no meta.model / no phases
    // resolves every identity input but the prompt to null. If anyone reorders the
    // fields or changes how an absent input is encoded, resume keys shift under old
    // journals and this assertion fails.
    // NOTE deliberately NO `mode` key here: mode joins the identity ONLY when set, so
    // journals written before session modes existed keep replaying for mode-less calls.
    // The resolved `agentDef` is still an identity field even when its value is null.
    const expectedIdentity = JSON.stringify({
      prompt: "only",
      model: null,
      tier: null,
      phase: null,
      agentType: null,
      agentDef: null,
      schema: null,
    });
    const expected = createHash("sha256").update(expectedIdentity).digest("hex");

    const [entry] = await journalOf(singleCall);
    assert.equal(entry.hash, "2aa09c56e72fb040ff729ab7ada54158759da157dd048aecd467867debc30e99");
    assert.equal(entry.hash, expected, "journal hash equals sha256 of the canonical identity JSON");
  });

  it("is byte-identical across independent runs of the same script", async () => {
    const a = await journalOf(singleCall);
    const b = await journalOf(singleCall);
    assert.deepEqual(
      a.map((e) => e.hash),
      b.map((e) => e.hash),
      "the same call identity hashes to the same bytes every run (resume depends on it)",
    );
  });

  it("keeps call and input hash fixtures unchanged by continuation-adjacent metadata", async () => {
    const sessionRef: AgentSessionRef = {
      sessionId: "continuation-session",
      backendId: "codex",
      poolKey: "codex",
      initializeMeta: { vendor: "hash-neutral", nested: { stable: true } },
      cwd: "/workspace/project",
      reopen: { load: true, resume: true, list: false, fork: false },
    };
    const run = async (withContinuationMetadata: boolean) => {
      const journal: JournalEntry[] = [];
      let inputsHash: string | undefined;
      const runner = {
        async run(prompt: string, options?: RunOptions) {
          inputsHash = options?.callInputsHash;
          if (withContinuationMetadata) {
            const directive: RunOptions = { ...options, continueFromSession: sessionRef };
            assert.deepEqual(directive.continueFromSession, sessionRef);
            options?.onSessionOpen?.(sessionRef);
            options?.onResultProvenance?.({
              source: "live",
              continuation: { reattached: true, method: "resume" },
            });
          }
          return `ran:${prompt}`;
        },
      } as AgentRunner;
      const result = await runWorkflow(singleCall, {
        agent: runner,
        persistLogs: false,
        onAgentJournal: (entry) => journal.push(entry),
      });
      return { entry: journal[0], inputsHash, result };
    };

    const plain = await run(false);
    const adjacent = await run(true);
    const expectedInputs = createHash("sha256")
      .update(
        JSON.stringify({
          backends: null,
          cwd: null,
          images: null,
          isolation: null,
          keepSession: false,
          label: "a",
          mcpServers: null,
          meta: null,
          promptMeta: null,
        }),
      )
      .digest("hex");
    const markedEntry: JournalEntry = {
      ...adjacent.entry,
      call: { kind: "agent", label: "a", continuation: { method: "resume" } },
    };

    assert.equal(plain.entry.hash, "2aa09c56e72fb040ff729ab7ada54158759da157dd048aecd467867debc30e99");
    assert.equal(adjacent.entry.hash, plain.entry.hash);
    assert.equal(markedEntry.hash, plain.entry.hash);
    assert.equal(plain.inputsHash, expectedInputs);
    assert.equal(adjacent.inputsHash, expectedInputs);
    assert.equal(adjacent.entry.session?.poolKey, "codex");
    assert.deepEqual(adjacent.entry.session?.initializeMeta, sessionRef.initializeMeta);
    assert.deepEqual(adjacent.result.agentSessions?.[0]?.initializeMeta, sessionRef.initializeMeta);
    const roundTrippedSession = JSON.parse(JSON.stringify(adjacent.entry.session));
    assert.deepEqual(roundTrippedSession.initializeMeta, sessionRef.initializeMeta);
    assert.equal(roundTrippedSession.sessionId, sessionRef.sessionId);
    assert.deepEqual(adjacent.result.calls?.[0]?.provenance, {
      source: "live",
      continuation: { reattached: true, method: "resume" },
    });
  });

  it("is byte-identical when args change but the call identity does not", async () => {
    const [first] = await journalOf(singleCall, { maxRounds: 6 });
    const [second] = await journalOf(singleCall, { maxRounds: 8 });

    assert.equal(first.hash, second.hash, "args are not serialized into the agent call identity");
  });

  it("changes only the edited call's hash and keeps earlier indices byte-stable", async () => {
    const base = `export const meta = { name: 'h2', description: 'hash' }
const a = await agent('alpha', { label: 'a' })
const b = await agent('beta', { label: 'b' })
return { a, b }`;
    const edited = base.replace("'beta'", "'beta-edited'");

    const before = await journalOf(base);
    const after = await journalOf(edited);

    assert.equal(before[0].hash, after[0].hash, "index 0 (unchanged prompt) keeps an identical hash");
    assert.notEqual(before[1].hash, after[1].hash, "index 1 (changed prompt) gets a different hash");
  });

  it("folds tier into the identity (tier change => different hash, same prompt/index)", async () => {
    const noTier = `export const meta = { name: 'h3', description: 'hash' }
const a = await agent('same', { label: 'a' })
return a`;
    const withTier = `export const meta = { name: 'h3', description: 'hash' }
const a = await agent('same', { label: 'a', tier: 'small' })
return a`;

    const [plain] = await journalOf(noTier);
    const [tiered] = await journalOf(withTier);
    assert.notEqual(plain.hash, tiered.hash, "adding a tier changes the resume key even for an identical prompt");
  });

  it("folds mode into the identity (mode change => different hash, same prompt/index)", async () => {
    const noMode = `export const meta = { name: 'h-mode', description: 'hash' }
const a = await agent('same', { label: 'a' })
return a`;
    const withMode = `export const meta = { name: 'h-mode', description: 'hash' }
const a = await agent('same', { label: 'a', mode: 'read-only' })
return a`;

    const [plain] = await journalOf(noMode);
    const [mode] = await journalOf(withMode);
    assert.notEqual(plain.hash, mode.hash, "adding a mode changes the resume key even for an identical prompt");
  });

  it("folds sorted configOptions into identity while omitting unset and empty maps", async () => {
    const absent = `export const meta = { name: 'h-config-absent', description: 'hash' }
return agent('same', { label: 'a' })`;
    const empty = `export const meta = { name: 'h-config-empty', description: 'hash' }
return agent('same', { label: 'a', configOptions: {} })`;
    const firstOrder = `export const meta = { name: 'h-config-first', description: 'hash' }
return agent('same', { label: 'a', configOptions: { zeta: 'last', alpha: true } })`;
    const reverseOrder = `export const meta = { name: 'h-config-reverse', description: 'hash' }
return agent('same', { label: 'a', configOptions: { alpha: true, zeta: 'last' } })`;
    const changed = `export const meta = { name: 'h-config-changed', description: 'hash' }
return agent('same', { label: 'a', configOptions: { alpha: false, zeta: 'last' } })`;

    const [[plain], [emptyMap], [ordered], [reordered], [different]] = await Promise.all([
      journalOf(absent),
      journalOf(empty),
      journalOf(firstOrder),
      journalOf(reverseOrder),
      journalOf(changed),
    ]);
    assert.equal(emptyMap.hash, plain.hash, "empty configOptions is omitted from old journal bytes");
    assert.equal(reordered.hash, ordered.hash, "authored key order cannot change replay identity");
    assert.notEqual(ordered.hash, plain.hash, "adding configOptions changes replay identity");
    assert.notEqual(different.hash, ordered.hash, "changing a configOptions value changes replay identity");
  });

  it("serializes integer-like option ids in lexicographic rather than numeric key order", async () => {
    const source = `export const meta = { name: 'h-config-integer-ids', description: 'hash' }
return agent('same', { label: 'a', configOptions: { '2': 'two', '10': 'ten' } })`;
    const [entry] = await journalOf(source);
    const expectedIdentity =
      '{"prompt":"same","model":null,"configOptions":{"10":"ten","2":"two"},"tier":null,"phase":null,"agentType":null,"agentDef":null,"schema":null}';
    assert.equal(entry.hash, createHash("sha256").update(expectedIdentity).digest("hex"));
  });

  it("replays reordered configOptions and cache-misses when a value changes", async () => {
    const source = `export const meta = { name: 'h-config-replay', description: 'hash' }
return agent('same', { label: 'a', configOptions: { zeta: 'last', alpha: true } })`;
    const reordered = source.replace("zeta: 'last', alpha: true", "alpha: true, zeta: 'last'");
    const changed = source.replace("alpha: true", "alpha: false");
    const journal = await journalOf(source);
    const resumeJournal = new Map(journal.map((entry) => [entry.index, entry]));
    let calls = 0;
    const runner = {
      async run() {
        calls++;
        return "live";
      },
    };

    const replayed = await runWorkflow(reordered, {
      agent: runner,
      persistLogs: false,
      resumeJournal,
      resumeFromRunId: "source",
    });
    assert.equal(replayed.result, "ran:same");
    assert.equal(calls, 0, "sorted-key equivalent options replay from the journal");

    const missed = await runWorkflow(changed, {
      agent: runner,
      persistLogs: false,
      resumeJournal,
      resumeFromRunId: "source",
    });
    assert.equal(missed.result, "live");
    assert.equal(calls, 1, "changed option value runs live");
  });

  it("folds phase into the identity (phase change => different hash)", async () => {
    const phaseA = `export const meta = { name: 'h4', description: 'hash', phases: [{ title: 'A' }, { title: 'B' }] }
phase('A')
const a = await agent('same', { label: 'a' })
return a`;
    const phaseB = `export const meta = { name: 'h4', description: 'hash', phases: [{ title: 'A' }, { title: 'B' }] }
phase('B')
const a = await agent('same', { label: 'a' })
return a`;

    const [a] = await journalOf(phaseA);
    const [b] = await journalOf(phaseB);
    assert.notEqual(a.hash, b.hash, "the active phase is part of the call identity");
  });
});
