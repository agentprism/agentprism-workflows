/**
 * Workspace-layer tests: one VM per workspace, the workspace owning the
 * VM lifecycle (create, eval, drain, dispose), and the registry's
 * project-keyed one-workspace invariant — the seam the `repl` MCP tool
 * (a later phase) addresses workspaces through.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Workspace, WorkspaceRegistry } from '../src/index.js';

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

test('registry: concurrent first-touches of one key still yield one live VM', async () => {
  const registry = new WorkspaceRegistry();
  const [a, b] = await Promise.all([
    registry.get('/tmp/repl-project-race'),
    registry.get('/tmp/repl-project-race'),
  ]);
  // The registry dedupes concurrent creates: both callers get the same
  // workspace, the duplicate VM was disposed, and only one stays live.
  assert.equal(a, b);
  assert.equal(registry.size, 1);
  assert.equal(a.isDisposed, false);
  const outcome = await a.eval('1 + 1');
  assert.equal(outcome.kind, 'value');
  if (outcome.kind === 'value') assert.equal(outcome.value, 2);
  registry.disposeAll();
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
