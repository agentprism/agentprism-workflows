import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

// hashAgentCall() is module-private, but every live agent() emits its call hash on the
// JournalEntry (workflow.ts: onAgentJournal({ index, hash, result })). The resume
// contract is "replay a cached result iff cached.hash === hash", so this hash is the
// load-bearing resume key: it MUST be byte-stable for a fixed call identity and MUST
// change when any identity input (prompt / model / mode-when-set / tier / phase / agentType / agentDef
// / schema) changes. These tests pin that through the observable journal.

const echo = {
  async run(prompt: string) {
    return `ran:${prompt}`;
  },
};

/** Run a script with the echo agent and return its journal entries in index order. */
async function journalOf(script: string): Promise<JournalEntry[]> {
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    agent: echo,
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
