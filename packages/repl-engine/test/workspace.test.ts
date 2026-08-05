/**
 * Workspace-layer tests: one VM per workspace, the workspace owning the
 * VM lifecycle (create, eval, drain, dispose), and the registry's
 * project-keyed one-workspace invariant — the seam the `repl` MCP tool
 * (a later phase) addresses workspaces through.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DrainJobError, Workspace, WorkspaceRegistry, loadShippedWasm } from '../src/index.js';

async function workspace(options?: Parameters<typeof Workspace.create>[1]): Promise<Workspace> {
  return Workspace.create('/tmp/repl-test-project', options);
}

test('workspace lifecycle: create → eval → drain → dispose', async () => {
  const ws = await workspace();
  assert.equal(ws.isDisposed, false);
  assert.equal(ws.projectDir, '/tmp/repl-test-project');

  const outcome = await ws.eval('6 * 7');
  assert.equal(outcome.kind, 'value');
  if (outcome.kind === 'value') assert.equal(outcome.value, 42);

  assert.equal(ws.drainJobs(), 0);

  ws.dispose();
  assert.equal(ws.isDisposed, true);
  // `eval`/`drainJobs` refuse use synchronously after dispose.
  assert.throws(() => ws.eval('1'), /disposed/);
  assert.throws(() => ws.drainJobs(), /disposed/);
  ws.dispose(); // idempotent
});

test('workspace state persists across evals (the REPL property)', async () => {
  const ws = await workspace();
  await ws.eval('let findings = ["a", "b", "c"]; let notes = { depth: 3 }');
  const outcome = await ws.eval('findings.length + notes.depth');
  assert.equal(outcome.kind, 'value');
  if (outcome.kind === 'value') assert.equal(outcome.value, 6);
  ws.dispose();
});

test('workspaces are isolated: one VM per workspace, no cross-workspace state', async () => {
  const a = await Workspace.create('/tmp/repl-test-a');
  const b = await Workspace.create('/tmp/repl-test-b');
  await a.eval('let secret = "only-in-a"');
  const bOutcome = await b.eval('typeof secret');
  assert.equal(bOutcome.kind, 'value');
  if (bOutcome.kind === 'value') assert.equal(bOutcome.value, 'undefined');
  a.dispose();
  b.dispose();
});

test('per-workspace memory limits are independent', async () => {
  const tight = await Workspace.create('/tmp/repl-test-tight', { memoryLimit: 1024 * 1024 });
  const loose = await Workspace.create('/tmp/repl-test-loose', { memoryLimit: 256 * 1024 * 1024 });
  const tightOutcome = await tight.eval("'z'.repeat(64 * 1024 * 1024)");
  assert.equal(tightOutcome.kind, 'error');
  if (tightOutcome.kind === 'error') assert.equal(tightOutcome.error.outOfMemory, true);
  const looseOutcome = await loose.eval("'z'.repeat(64 * 1024 * 1024).length");
  assert.equal(looseOutcome.kind, 'value');
  if (looseOutcome.kind === 'value') assert.equal(looseOutcome.value, 64 * 1024 * 1024);
  tight.dispose();
  loose.dispose();
});

test('registry: get-or-create returns the same workspace (and VM) per project dir', async () => {
  const registry = new WorkspaceRegistry();
  const first = await registry.get('/tmp/repl-project-1');
  const second = await registry.get('/tmp/repl-project-1');
  assert.equal(first, second, 'one workspace per project directory');
  assert.equal(registry.size, 1);
  assert.equal(registry.has('/tmp/repl-project-1'), true);
  first.dispose();
  second.dispose();
  registry.disposeAll();
});

test('registry: distinct project dirs get distinct workspaces and VMs', async () => {
  const registry = new WorkspaceRegistry();
  const a = await registry.get('/tmp/repl-project-a');
  const b = await registry.get('/tmp/repl-project-b');
  assert.notEqual(a, b);
  assert.equal(registry.size, 2);
  await a.eval('let marker = "a"');
  const bOutcome = await b.eval('typeof marker');
  assert.equal(bOutcome.kind, 'value');
  if (bOutcome.kind === 'value') assert.equal(bOutcome.value, 'undefined');
  registry.disposeAll();
  assert.equal(registry.size, 0);
});

test('registry: dispose drops the workspace; the next get creates a fresh one', async () => {
  const registry = new WorkspaceRegistry();
  const first = await registry.get('/tmp/repl-project-3');
  await first.eval('let counter = 41');
  assert.equal(registry.dispose('/tmp/repl-project-3'), true);
  assert.equal(registry.dispose('/tmp/repl-project-3'), false, 'second dispose is a miss');
  assert.equal(registry.has('/tmp/repl-project-3'), false);
  assert.equal(first.isDisposed, true);

  const fresh = await registry.get('/tmp/repl-project-3');
  assert.notEqual(fresh, first);
  const outcome = await fresh.eval('typeof counter');
  assert.equal(outcome.kind, 'value');
  if (outcome.kind === 'value') assert.equal(outcome.value, 'undefined');
  registry.disposeAll();
});

test('registry: concurrent first-touches create exactly one VM', async () => {
  // Review regression: two concurrent `get('/same')` calls each ran a full
  // `Workspace.create` (two VM instantiations for one project) before the
  // loser was disposed. The registry must deduplicate the in-flight
  // creation promise, not merely the completed result — the wasm getter
  // counts how many creations actually started.
  let creations = 0;
  const wasm = await loadShippedWasm();
  const registry = new WorkspaceRegistry({
    get wasm() {
      creations++;
      return wasm;
    },
  });
  const [a, b] = await Promise.all([
    registry.get('/tmp/repl-project-race2'),
    registry.get('/tmp/repl-project-race2'),
  ]);
  assert.equal(creations, 1, 'exactly one VM was created for one project');
  assert.equal(a, b);
  assert.equal(registry.size, 1);
  assert.equal(a.isDisposed, false);
  registry.disposeAll();
});

test('registry: dispose during an in-flight create cancels it; a later get creates fresh', async () => {
  // `Workspace.create` resolves asynchronously (wasm instantiation), so a
  // synchronous `dispose` right after `get` lands mid-creation. The
  // registry must not materialize a workspace after dispose: the created
  // VM is torn down, the waiting caller's promise rejects, and a later
  // `get` starts fresh.
  const registry = new WorkspaceRegistry();
  const first = registry.get('/tmp/repl-project-cancel');
  assert.equal(registry.dispose('/tmp/repl-project-cancel'), false, 'no live workspace yet');
  await assert.rejects(first, /creation cancelled by dispose/);
  assert.equal(registry.size, 0);
  assert.equal(registry.has('/tmp/repl-project-cancel'), false);

  const fresh = await registry.get('/tmp/repl-project-cancel');
  assert.equal(fresh.isDisposed, false);
  const outcome = await fresh.eval('6 * 7');
  assert.equal(outcome.kind, 'value');
  if (outcome.kind === 'value') assert.equal(outcome.value, 42);
  registry.disposeAll();
});

test('standalone drains accept a per-drain interrupt handler through the workspace', async () => {
  // The settlement drain's interrupt signal is a workspace-level concern:
  // `Workspace.drainJobs` must forward the per-drain handler (a suspended
  // eval's handler is no longer armed once the eval returned).
  const ws = await workspace();
  // `> 3` (not `() => true`): the interrupt must fire inside a drained job,
  // leaving a runaway continuation queued for the later drain — an
  // immediate `true` would abort the script itself, queueing nothing.
  let evalChecks = 0;
  const outcome = await ws.eval(
    `
      for (let k = 0; k < 2; k++) {
        (async () => { let i = 0; while (true) { i++; await 0 } })();
      }
      'queued';
    `,
    { interruptHandler: () => ++evalChecks > 3 },
  );
  assert.equal(outcome.kind, 'error');
  if (outcome.kind === 'error') assert.equal(outcome.error.interrupted, true);

  let drainChecks = 0;
  let interruptedDrains = 0;
  for (;;) {
    let n = 0;
    try {
      n = ws.drainJobs({ interruptHandler: () => ++drainChecks > 1 });
    } catch (err) {
      assert.ok(err instanceof DrainJobError);
      assert.equal(err.info.interrupted, true);
      interruptedDrains++;
      continue;
    }
    if (n === 0) break;
  }
  assert.ok(interruptedDrains >= 1, 'leftover runaway continuation was interrupted');
  ws.dispose();
});

test('registry: default memory limit flows to created workspaces', async () => {
  const registry = new WorkspaceRegistry({ memoryLimit: 1024 * 1024 });
  const ws = await registry.get('/tmp/repl-project-limit');
  assert.equal(ws.memoryLimit, 1024 * 1024);
  const outcome = await ws.eval("'w'.repeat(64 * 1024 * 1024)");
  assert.equal(outcome.kind, 'error');
  if (outcome.kind === 'error') assert.equal(outcome.error.outOfMemory, true);
  registry.disposeAll();
});
