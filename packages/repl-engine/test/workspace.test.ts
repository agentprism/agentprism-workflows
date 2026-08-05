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

test('the guest bridge is installed at VM creation: DSL globals, console bridge, parked calls, surface', async () => {
  // Review rejection: a production Workspace exposed agent/checkpoint/
  // combinators as undefined because creation never installed the bridge.
  // The injection happens at creation now — the doc's discipline.
  const ws = await workspace();
  // The DSL vocabulary is live from the first eval.
  const globals = await ws.eval(`({
    agent: typeof agent, checkpoint: typeof checkpoint,
    answer: typeof checkpoint.answer, parallel: typeof parallel,
    console: typeof console, marker: typeof globalThis.__REPL_GUEST_VERSION,
    phase: typeof phase, budget: typeof budget,
  })`);
  assert.equal(globals.kind, 'value');
  if (globals.kind === 'value') {
    assert.deepEqual(globals.value, {
      agent: 'function',
      checkpoint: 'function',
      answer: 'function',
      parallel: 'function',
      console: 'object',
      marker: 'string',
      phase: 'undefined',
      budget: 'undefined',
    });
  }

  // The console bridge accumulates events on the default parking bridge.
  const logged = await ws.eval('console.log({ a: 1 }, "text"); "done"');
  assert.equal(logged.kind, 'value');
  const events = ws.consoleEvents();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].refs, ['$1', '$2']);
  // The rendered line is the previewer seam the tool layer uses.
  assert.match(ws.renderRef('$1'), /^\[\$1 · object · \d+B\] \{a: 1\}$/);
  assert.equal(ws.renderRef('$2'), '[$2 · string · 4B] "text"');

  // The default parking bridge parks agent calls (honest no-backend state:
  // nothing is fabricated, the calls pend until a later phase attaches
  // backends) and the reconciliation surface sees them.
  const started = await ws.eval('const research = agent("pi/deepseek-v4-flash-max", "research X"); "started"');
  assert.equal(started.kind, 'value');
  const surface = ws.surface();
  assert.ok(surface !== undefined, 'the guest surface is reachable from the workspace');
  const pending = surface!.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'agent');
  assert.equal(pending[0].modelSpec, 'pi/deepseek-v4-flash-max');
  assert.equal(pending[0].sessionId, 'c1');
  assert.equal(ws.parkedCalls().size, 1);
  // The parked call can be settled through the surface, exactly like the
  // post-restore reconciliation route.
  assert.equal(surface!.settle('c1', 'resolve', { ok: true }), true);
  ws.drainJobs();
  const settled = await ws.eval('await research');
  assert.equal(settled.kind, 'value');
  if (settled.kind === 'value') assert.deepEqual(settled.value, { ok: true });
  // The parked record remains (the surface route settled the GUEST
  // registry, not the live deferred); the registry itself is empty — the
  // honest "no pending work" signal.
  assert.equal(surface!.pending().length, 0);

  // inspectBinding is the manifest seam (name, type, size — never content).
  await ws.eval('globalThis.notes = { depth: 3 }; "ok"');
  const meta = ws.inspectBinding('notes');
  assert.equal(meta.kind, 'data');
  assert.equal(meta.label, 'object');
  assert.ok(meta.sizeBytes > 0);
  ws.dispose();
});

test('custom bridge handlers passed to create override the parking bridge', async () => {
  const calls: Array<{ callId: string; modelSpec: string; task: string }> = [];
  const ws = await Workspace.create('/tmp/repl-test-custom-bridge', {
    handlers: {
      agent: (call, callId, modelSpec, task) => {
        calls.push({ callId, modelSpec, task });
        call.resolve('custom handled');
      },
      checkpoint: () => undefined,
      steer: () => undefined,
      console: () => undefined,
    },
  });
  const out = await ws.eval('await agent("pi/custom", "do it")');
  assert.equal(out.kind, 'value');
  if (out.kind === 'value') assert.equal(out.value, 'custom handled');
  assert.deepEqual(calls, [{ callId: 'c1', modelSpec: 'pi/custom', task: 'do it' }]);
  // Custom handlers own their events: the workspace buffer stays empty.
  assert.equal(ws.consoleEvents().length, 0);
  ws.dispose();
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
