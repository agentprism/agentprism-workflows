/**
 * Workspace-layer tests: one VM per workspace, the workspace owning the
 * VM lifecycle (create, eval, drain, dispose), and the registry's
 * project-keyed one-workspace invariant — the seam the `repl` MCP tool
 * (a later phase) addresses workspaces through.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Broker, DrainJobError, Workspace, WorkspaceRegistry, loadShippedWasm } from '../src/index.js';

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
  // The §4.4 one-line repr (guest-rendered): args joined with one space.
  assert.equal(events[0].level, 'log');
  assert.equal(events[0].line, '{a: 1} text');

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

test('parking bridge: agents() serves the REAL model spec and task of parked agent calls (§4.5 plain-value shape — never fabricated empties)', async () => {
  const ws = await workspace();
  await ws.eval('const research = agent("pi/deepseek-v4-flash-max", "research X"); "started"');
  const out = await ws.eval('agents()');
  assert.equal(out.kind, 'value');
  if (out.kind === 'value') {
    const agents = out.value as Array<{ callId: string; modelSpec: string; task: string; state: string; supportsSteering: boolean; queuedTurns: number }>;
    assert.equal(agents.length, 1);
    assert.equal(agents[0].callId, 'c1');
    assert.equal(agents[0].modelSpec, 'pi/deepseek-v4-flash-max', 'the real model spec, never ""');
    assert.equal(agents[0].task, 'research X', 'the real task, never ""');
    assert.equal(agents[0].queuedTurns, 0);
  }
  ws.dispose();
});

test('workspace-level evals maintain the §4.4 `_` result history — resolved, LATE (settled at the drain), and empty-poll evals', async () => {
  const ws = await workspace();
  await ws.eval('40 + 2');
  const first = await ws.eval('_');
  assert.equal(first.kind, 'value');
  if (first.kind === 'value') assert.equal(first.value, 42);
  // A suspended eval's completion value becomes `_` once its
  // continuation settles at the drain (the parking bridge's sleep timer).
  const suspended = await ws.eval('await sleep(10); "late"');
  assert.equal(suspended.kind, 'pending');
  await new Promise((resolve) => setTimeout(resolve, 50));
  ws.drainJobs();
  const second = await ws.eval('_');
  assert.equal(second.kind, 'value');
  if (second.kind === 'value') assert.equal(second.value, 'late');
  // An empty poll (eval "") COMPLETES with undefined — `_` becomes
  // undefined: the previous eval's completion value IS undefined (the
  // review probe: `42`, then an empty eval, then `_` must read
  // undefined, never the stale 42).
  await ws.eval('"kept"');
  await ws.eval('');
  const third = await ws.eval('_');
  assert.equal(third.kind, 'value');
  if (third.kind === 'value') assert.equal(third.value, undefined);
  ws.dispose();
});

test('parking bridge: reset() in a SUSPENDED eval tears the workspace down after the continuation completes — the workspace stays alive while the eval is in flight', async () => {
  const ws = await workspace();
  const out = await ws.eval('reset(); await sleep(30); "finished"');
  assert.equal(out.kind, 'pending');
  assert.equal(ws.isDisposed, false, 'the workspace is ALIVE while the reset eval is suspended');
  await new Promise((resolve) => setTimeout(resolve, 80));
  ws.drainJobs();
  assert.equal(ws.isDisposed, true, 'the teardown ran after the eval completed (the continuation settled at the drain)');
});

test('parking bridge: reset() called after a suspended eval resumes is attributed to that eval and tears down in the completing drain', async () => {
  const ws = await workspace();
  const out = await ws.eval('await sleep(30); reset(); 42');
  assert.equal(out.kind, 'pending');
  assert.equal(ws.isDisposed, false, 'the workspace stays alive until the reset-calling eval resumes');
  await new Promise((resolve) => setTimeout(resolve, 80));
  ws.drainJobs();
  assert.equal(ws.isDisposed, true, 'the drain that completed the reset-calling eval performed teardown');
});

test('parking bridge: a completed drain cannot misattribute a later plain reset() to an eval still suspended mid-continuation', async () => {
  const ws = await workspace();
  const first = await ws.eval('await sleep(20); await agent("pi/x", "hold"); 1');
  assert.equal(first.kind, 'pending');
  await new Promise((resolve) => setTimeout(resolve, 60));
  ws.drainJobs();
  assert.equal(ws.isDisposed, false, 'the first eval remains suspended on its parked agent');

  const reset = await ws.eval('reset(); 2');
  assert.equal(reset.kind, 'value');
  if (reset.kind === 'value') assert.equal(reset.value, 2);
  assert.equal(ws.isDisposed, true, 'the plain reset belongs to the eval that called it');
});

test('default parking bridge: workspace() checkpoint questions and agents() tasks retain their 200-character metadata previews', async () => {
  const ws = await workspace();
  const out = await ws.eval(`
    checkpoint("q".repeat(300));
    agent("pi/x", "t".repeat(300));
    const question = workspace().checkpoints[0].question;
    const task = agents()[0].task;
    ({ question, task });
  `);
  assert.equal(out.kind, 'value');
  if (out.kind === 'value') {
    const value = out.value as { question: string; task: string };
    assert.ok(value.question.length < 300, 'the raw checkpoint question is not exposed');
    assert.ok(value.question.includes('chars elided'), value.question);
    assert.equal(value.task.length, 200, 'the parked agent task uses the engine\'s 200-character preview');
    assert.equal(value.task, `${'t'.repeat(99)}…${'t'.repeat(100)}`);
  }
  ws.dispose();
});

test('default parking bridge: checkpoint.answer settles the parked checkpoint (first-wins)', async () => {
  // Review rejection: the parking bridge's answer mode returned `false`
  // for every checkpoint.answer, so the original promise stayed pending
  // forever — the data plane could never interrupt the intent plane on
  // a default workspace. The bridge now tracks parked checkpoint calls
  // separately, parses the answer, and settles the matching call.
  const ws = await workspace();
  const asked = await ws.eval('const q = checkpoint("proceed?"); "asked"');
  assert.equal(asked.kind, 'value');
  // The parked checkpoint is visible through the parked-calls surface.
  assert.equal(ws.parkedCalls().size, 1);

  // The orchestrator delivers the answer in a later eval; the bridge
  // reports delivery truthfully.
  const delivered = await ws.eval('checkpoint.answer("c1", { yes: true, note: "go" }); "delivered"');
  assert.equal(delivered.kind, 'value');
  if (delivered.kind === 'value') assert.equal(delivered.value, 'delivered');
  // Delivery consumed the parked record.
  assert.equal(ws.parkedCalls().size, 0);
  // The checkpoint promise resolved with the ANSWER (not `false`), during
  // the delivering eval's own job drain.
  const settled = await ws.eval('await q');
  assert.equal(settled.kind, 'value');
  if (settled.kind === 'value') assert.deepEqual(settled.value, { yes: true, note: 'go' });

  // Unknown and already-answered ids report false and pend nothing new.
  const unknown = await ws.eval('checkpoint.answer("c99", 1)');
  assert.equal(unknown.kind, 'value');
  if (unknown.kind === 'value') assert.equal(unknown.value, false);
  const again = await ws.eval('checkpoint.answer("c1", 2)');
  assert.equal(again.kind, 'value');
  if (again.kind === 'value') assert.equal(again.value, false);
  ws.dispose();
});

test('default parking bridge: checkpoint.answer never settles a parked agent call', async () => {
  // The bridge tracks parked CHECKPOINT calls separately from parked
  // agent/steer calls: an answer addressed at an agent call's id must
  // report false and leave the agent call parked (ids share one space).
  const ws = await workspace();
  await ws.eval('const research = agent("pi/deepseek-v4-flash-max", "research X"); const q = checkpoint("q?"); "started"');
  assert.equal(ws.parkedCalls().size, 2);

  // c1 is the AGENT call — answering it must not settle it.
  const wrong = await ws.eval('checkpoint.answer("c1", "nope")');
  assert.equal(wrong.kind, 'value');
  if (wrong.kind === 'value') assert.equal(wrong.value, false);
  assert.equal(ws.parkedCalls().size, 2, 'the agent call is still parked');

  // The checkpoint (c2) answers normally, leaving only the agent parked.
  const ok = await ws.eval('checkpoint.answer("c2", "yes")');
  assert.equal(ok.kind, 'value');
  if (ok.kind === 'value') assert.equal(ok.value, true);
  assert.equal(ws.parkedCalls().size, 1);
  const qOutcome = await ws.eval('await q');
  assert.equal(qOutcome.kind, 'value');
  if (qOutcome.kind === 'value') assert.equal(qOutcome.value, 'yes');
  // The agent call is untouched by all of it.
  assert.equal(ws.surface()!.pending().length, 1);
  assert.equal(ws.surface()!.pending()[0].kind, 'agent');
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
      queue: () => undefined,
      steer: () => undefined,
      cancelSession: () => undefined,
      cancelQueue: () => undefined,
      console: () => undefined,
      sleep: () => undefined,
      workspace: () => '{}',
      agents: () => '[]',
      reset: () => undefined,
      defaultBackend: () => undefined,
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

test('manifest: user bindings that SHADOW or OVERWRITE baseline globals are enumerated with complete metadata and provenance (phase-E review round 5: the baseline filter removed `const Math = 42` entirely and the provenance registry\'s known-set skip suppressed its origin)', async () => {
  // The provenance pass is broker-driven (each eval's maintenance pass
  // attributes new/rebound bindings), so the test drives the workspace
  // through a broker, exactly like the review suites.
  const ws = await Workspace.create('/tmp/repl-shadow-project');
  const broker = await Broker.attach(ws, { evalTimeoutMs: 0 });
  try {
    // A LEXICAL shadow of a baseline global: `const Math = 42` — the
    // binding the orchestrator's code sees is the user's (identifier
    // resolution prefers the lexical binding), so the manifest lists it
    // with the lexical value's metadata and the declaring eval's
    // provenance.
    const r = await broker.eval('const Math = 42; Math');
    assert.equal(r.result, '42');
    let manifest = broker.workspaceManifest();
    let byName = new Map(manifest.bindings.map((b) => [b.name, b]));
    const math = byName.get('Math');
    assert.ok(math, `Math is listed: ${[...byName.keys()].join(', ')}`);
    assert.equal(math!.token, 'number \u00b7 8B');
    assert.equal(math!.type, 'number');
    assert.equal(math!.sizeBytes, 8);
    assert.equal(math!.provenance, 'eval 1', 'the shadowing binding is attributed to its declaring eval');
    assert.ok(typeof math!.provenanceAtMs === 'number' && math!.provenanceAtMs! > 0);
    assert.equal(math!.handleCallId, null);
    assert.equal(math!.handleStatus, null);
    // Exactly one Math binding (the lexical view wins over the global
    // property — the same one-binding-per-name rule).
    assert.equal(manifest.bindings.filter((b) => b.name === 'Math').length, 1);
    // A GLOBAL PROPERTY overwrite of a baseline builtin: `JSON = "x"`
    // (sloppy assignment rebinds the global property). The value's type
    // token changed from the fresh-realm baseline — the manifest lists
    // the overwrite with its provenance.
    await broker.eval('JSON = "x"; 1');
    manifest = broker.workspaceManifest();
    byName = new Map(manifest.bindings.map((b) => [b.name, b]));
    const json = byName.get('JSON');
    assert.ok(json, `JSON is listed: ${[...byName.keys()].join(', ')}`);
    assert.equal(json!.token, 'string \u00b7 1B');
    assert.equal(json!.type, 'string');
    assert.equal(json!.provenance, 'eval 2', 'the overwrite is attributed to its eval');
    // Untouched baseline globals stay hidden (no noise), and the shadow
    // survives later evals (a stable attribution).
    await broker.eval('1 + 1');
    manifest = broker.workspaceManifest();
    byName = new Map(manifest.bindings.map((b) => [b.name, b]));
    assert.ok(byName.has('Math') && !byName.has('Number'), 'shadow listed, untouched builtins still hidden');
    assert.equal(byName.get('Math')!.provenance, 'eval 1', 'the shadow attribution is stable');
    assert.equal(byName.get('JSON')!.provenance, 'eval 2', 'the overwrite attribution is stable');
    // The workspace keeps working: the guest sees the shadowed values.
    const live = await broker.eval('Math');
    assert.equal(live.result, '42');
  } finally {
    await broker.dispose();
    ws.dispose();
  }
});

test('manifest: a top-level LEXICAL `const globalThis = 7` (a legitimate user program) does not blank the provenance pass — a later `var userValue = 42` is enumerated with producer/task/time metadata (phase-E review rejection round 7: the pass read descriptors off the free variable globalThis, which the lexical binding shadows, so every descriptor read hit the NUMBER and the pass\'s catch swallowed the whole attribution — userValue appeared in the manifest with null provenance)', async () => {
  const ws = await Workspace.create('/tmp/repl-globalthis-shadow-project');
  const broker = await Broker.attach(ws, { evalTimeoutMs: 0 });
  try {
    // `const globalThis = 7` shadows the realm's global object for
    // identifier resolution; `var userValue = 42` is a global-object
    // property the manifest must attribute to this eval.
    const r = await broker.eval('const globalThis = 7; var userValue = 42; userValue');
    assert.equal(r.result, '42');
    const manifest = broker.workspaceManifest();
    const byName = new Map(manifest.bindings.map((b) => [b.name, b]));
    const userValue = byName.get('userValue');
    assert.ok(userValue, `userValue is listed: ${[...byName.keys()].join(', ')}`);
    assert.equal(userValue!.token, 'number \u00b7 8B');
    assert.equal(userValue!.type, 'number');
    assert.equal(userValue!.provenance, 'eval 1', 'the pass read descriptors off the CAPTURED global object — provenance survives the lexical shadow');
    assert.ok(typeof userValue!.provenanceAtMs === 'number' && userValue!.provenanceAtMs! > 0, 'the attribution carries its timestamp');
    // The workspace keeps working after the shadow (the library's own
    // internal references use the captured global too): a fresh eval
    // still reaches host functions and the realm globals.
    const live = await broker.eval('typeof console.log');
    assert.equal(live.result, 'function', 'the library internals are immune to the globalThis shadow');
  } finally {
    await broker.dispose();
    ws.dispose();
  }
});

test('manifest: a SAME-TYPE overwrite of a baseline global (`Math = { userOwned: true }`) is enumerated with complete metadata and provenance — the type token cannot see it (both values are objects), the value identity can (phase-E review rejection round 6: the token-only detector missed same-type replacements entirely, leaving them absent from the manifest with no provenance)', async () => {
  const ws = await Workspace.create('/tmp/repl-same-type-project');
  const broker = await Broker.attach(ws, { evalTimeoutMs: 0 });
  try {
    // `Math = { userOwned: true }` (sloppy assignment rebinds the
    // global property): the value's trap-free type token is `object` —
    // the same as the pristine baseline Math — so the token-only
    // detector saw no change. The registry's baseline-VALUE identity
    // (SameValue against the ORIGINAL baseline value, captured when the
    // registry was created in the pristine realm) is the detector that
    // catches it: the manifest lists the overwrite with its provenance.
    const r = await broker.eval('Math = { userOwned: true }; "rebound"');
    assert.equal(r.result, 'rebound');
    let manifest = broker.workspaceManifest();
    let byName = new Map(manifest.bindings.map((b) => [b.name, b]));
    const math = byName.get('Math');
    assert.ok(math, `the same-type overwrite of Math is listed: ${[...byName.keys()].join(', ')}`);
    assert.equal(math!.type, 'object', 'the overwriting value is reported as an object');
    assert.ok(typeof math!.sizeBytes === 'number' && math!.sizeBytes >= 0);
    assert.equal(math!.provenance, 'eval 1', 'the same-type overwrite is attributed to its declaring eval');
    assert.ok(typeof math!.provenanceAtMs === 'number' && math!.provenanceAtMs! > 0);
    // Untouched baseline globals stay hidden (no noise).
    assert.ok(!byName.has('JSON'), 'an untouched baseline builtin stays hidden');
    // A SECOND same-type rebind re-attributes to its own eval (the
    // last-attributed value is the comparison base — a pre-snapshot
    // rebind is never re-attributed by a later pass either), and
    // IN-PLACE mutation of the rebound value deliberately does NOT
    // re-attribute (the binding still refers to the value its recorded
    // origin produced — the manifest's documented stance).
    await broker.eval('Math = { other: 1 }; 1');
    manifest = broker.workspaceManifest();
    byName = new Map(manifest.bindings.map((b) => [b.name, b]));
    assert.equal(byName.get('Math')!.provenance, 'eval 2', 'a second same-type rebind re-attributes to its own eval');
    await broker.eval('Math.other = 2; 1');
    manifest = broker.workspaceManifest();
    byName = new Map(manifest.bindings.map((b) => [b.name, b]));
    assert.equal(byName.get('Math')!.provenance, 'eval 2', 'in-place mutation of the rebound value does not re-attribute');
    assert.ok(byName.has('Math'), 'the overwritten binding stays listed');
    // The workspace keeps working: the guest sees the overwritten values.
    const live = await broker.eval('Math.userOwned === undefined && Math.other === 2');
    assert.equal(live.result, 'true', 'the guest sees the overwritten binding');
  } finally {
    await broker.dispose();
    ws.dispose();
  }
});
