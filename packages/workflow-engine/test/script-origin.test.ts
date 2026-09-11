import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunner } from "@automatalabs/shared-types";
import { WorkflowErrorCode } from "../src/errors.js";
import { createRunPersistence, inlineScriptFile, type PersistedRunState, type RunPersistence } from "../src/run-persistence.js";
import { withRunEvents } from "../src/run-event-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";

const runner: AgentRunner = { async run() { return "unused"; } };
const script = (name: string) => `export const meta = { name: '${name}', description: 'script origin' }\nreturn 42`;

async function inStore(fn: (paths: { cwd: string; persistenceRoot: string; root: string }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "workflow-script-origin-"));
  try {
    await fn({ cwd: root, persistenceRoot: join(root, "storage"), root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a journaled run keeps an editable inline copy of its script next to its record", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    const source = script("inline");
    const run = await manager.runSync(source);
    const persistence = manager.getPersistence();
    const location = inlineScriptFile(persistence.getRunsDir(), run.runId);
    assert.deepEqual(persistence.load(run.runId)?.scriptOrigin, { kind: "inline" }, "journaled runs default to an inline origin");
    assert.equal(persistence.scriptLocation?.(run.runId), location);
    assert.equal(readFileSync(location, "utf8"), source);
    assert.equal(persistence.readScript?.(run.runId), source);
    assert.equal(persistence.scriptLocation?.("no-such-run"), undefined);
    assert.throws(() => persistence.readScript?.("no-such-run"), (error: unknown) => (error as { code?: string }).code === WorkflowErrorCode.PERSISTENCE_ERROR);

    // The copy is the editable working surface: a later edit is what readScript reports, while the
    // record keeps the admitted text until a continuation admits the edit.
    writeFileSync(location, `${source}\n// edited`);
    assert.equal(persistence.readScript?.(run.runId), `${source}\n// edited`);
    assert.equal(persistence.load(run.runId)?.script, source);

    assert.equal(manager.deleteRun(run.runId), true);
    assert.equal(existsSync(location), false, "deleting the run removes its inline copy");
  });
});

test("a path origin records the caller's file, writes no copy, and reads the file's current text", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    const scriptPath = join(paths.root, "flow.workflow.js");
    const source = script("path");
    writeFileSync(scriptPath, source);
    const run = await manager.runSync(source, undefined, { scriptOrigin: { kind: "path", path: scriptPath } });
    const persistence = manager.getPersistence();
    assert.deepEqual(persistence.load(run.runId)?.scriptOrigin, { kind: "path", path: scriptPath });
    assert.equal(persistence.scriptLocation?.(run.runId), scriptPath);
    assert.equal(existsSync(inlineScriptFile(persistence.getRunsDir(), run.runId)), false, "a path run has no store copy");
    assert.equal(persistence.readScript?.(run.runId), source);
    writeFileSync(scriptPath, `${source}\n// edited in place`);
    assert.equal(persistence.readScript?.(run.runId), `${source}\n// edited in place`);
    assert.equal(persistence.load(run.runId)?.script, source, "the admitted record is untouched by the edit");

    rmSync(scriptPath);
    assert.throws(() => persistence.readScript?.(run.runId), /unavailable/);
    mkdirSync(scriptPath);
    assert.throws(() => persistence.readScript?.(run.runId), /not a regular file/);
    rmSync(scriptPath, { recursive: true });
    writeFileSync(scriptPath, "x".repeat(1_048_577));
    assert.throws(() => persistence.readScript?.(run.runId), /exceeds 1048576 bytes/);
    assert.equal(manager.deleteRun(run.runId), true);
    assert.equal(existsSync(scriptPath), true, "deleting the run never touches the caller's file");
  });
});

test("a script origin must be inline or an absolute path, and no copy is written without journaling", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    for (const origin of [
      { kind: "path", path: "relative/flow.js" },
      { kind: "url", path: "/abs" },
      { kind: "inline", path: "/abs" },
      { kind: "path" },
    ]) {
      await assert.rejects(
        manager.runSync(script("bad"), undefined, { scriptOrigin: origin as never }),
        (error: unknown) => (error as { code?: string }).code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      );
    }
    const unjournaled = await manager.runSync(script("ephemeral"), undefined, { journaling: false });
    assert.equal(unjournaled.status, "completed");
    assert.equal(existsSync(inlineScriptFile(manager.getPersistence().getRunsDir(), unjournaled.runId)), false);
  });
});

test("a failed initial save discards the orphaned inline copy", async () => {
  await inStore(async (paths) => {
    const disk = createRunPersistence(paths.cwd, undefined, { persistenceRoot: paths.persistenceRoot });
    let failSave = true;
    const manager = new WorkflowManager({
      ...paths,
      agent: runner,
      persistence: { ...disk, save(state) { if (failSave) throw new Error("disk unavailable"); disk.save(state); } },
    });
    await assert.rejects(manager.runSync(script("orphan"), undefined, { requireAgentConfiguration: true }), /failed to persist/);
    const copies = existsSync(disk.getRunsDir()) ? (await import("node:fs")).readdirSync(disk.getRunsDir()).filter((name) => name.endsWith(".script.js")) : [];
    assert.deepEqual(copies, [], "no script copy survives a run that was never recorded");
    failSave = false;
    const run = await manager.runSync(script("recorded"));
    assert.equal(readFileSync(inlineScriptFile(disk.getRunsDir(), run.runId), "utf8"), script("recorded"));
  });
});

test("a persistence without script-file operations has no script file, and the manager still runs", async () => {
  await inStore(async (paths) => {
    const records = new Map<string, PersistedRunState>();
    const custom: RunPersistence = {
      save(state) { records.set(state.runId, structuredClone(state)); },
      load(runId) { const state = records.get(runId); return state ? structuredClone(state) : null; },
      list() { return [...records.values()]; },
      delete(runId) { return records.delete(runId); },
      acquireRunLease(runId) { return { runId, token: runId }; },
      releaseRunLease() {},
      getRunsDir() { return join(paths.root, "never-created"); },
    };
    const wrapped = withRunEvents(custom);
    assert.equal(wrapped.scriptLocation, undefined, "no seam is synthesized for a store without one");
    assert.equal(wrapped.writeInlineScript, undefined);
    assert.equal(wrapped.discardInlineScript, undefined);
    assert.equal(wrapped.readScript, undefined);

    const manager = new WorkflowManager({ agent: runner, persistence: custom, journaling: true });
    const { promise, runId } = manager.startInBackground(script("memory"), undefined, {});
    await promise;
    assert.equal(records.get(runId)?.status, "completed");
    assert.deepEqual(records.get(runId)?.scriptOrigin, { kind: "inline" }, "the origin is recorded without a copy");
    assert.equal(existsSync(join(paths.root, "never-created")), false, "nothing touches the real filesystem");
  });
});
