/**
 * The top-level-await instrumenter — the guest-side half of the eval-break
 * targeting discipline (the `interrupt` tool's no-id arm): the broker
 * rewrites `await <expr>` into `await this["__replAwait"](<expr>, TOKEN)`
 * for every TOP-LEVEL await of an eval, where `TOKEN` is the eval's own
 * continuation token.
 *
 * The guest library's `__replAwait(value, token)` WRAPS the awaited value
 * in a fresh promise whose settling reaction — the job that runs
 * IMMEDIATELY BEFORE the eval's continuation segment — sets the
 * CONTINUATION LEASE to the eval's token (see `guest-library.ts`). The
 * broker's drain loop reads the lease between jobs: a job that starts
 * with a lease set IS the armed eval's continuation, so the eval-break
 * interrupt fires only while THAT execution runs. This is the armed
 * target's genuine CONTINUATION IDENTITY (phase-E review rejection round
 * 5): not the calls the eval awaited, not the calls it created — the
 * execution itself.
 *
 * Consequences, pinned by regressions:
 *
 * - an eval that awaits a call it created (`const c1 = agent(...); await
 *   c1`) is targetable — the wrap's reaction is queued on c1's promise;
 * - an eval that awaits an EARLIER eval's binding (`await p` where `p`
 *   was created by a previous eval) is targetable the same way — the
 *   wrap does not care where the promise came from;
 * - an UNAWAITED sibling reaction registered BEFORE the await
 *   (`q.then(sibling)` then `await q`) runs FIRST in the settlement
 *   drain — before the lease-setting reaction — so the sibling job can
 *   neither fire the signal nor consume it; the armed state survives
 *   and the target's own continuation (the job after the lease-setting
 *   reaction) is the one broken mid-run (the carried review defect: the
 *   signal was keyed to settled call ids, so the sibling job consumed
 *   it and the target ran later unbroken);
 * - INDIRECT awaits are targetable: `await Promise.all([q])` wraps the
 *   combinator's promise, whose settlement queues the eval's
 *   continuation exactly like a direct call's — the identity is the
 *   promise graph, not a logged call-id list (the carried review
 *   defect: the 0.2.0 log-based targeting refused indirect waits).
 *
 * ## Hygiene (phase-E review rejection round 5)
 *
 * The injected code must never change the guest program's semantics. The
 * 0.2.0 instrumenter inserted the guest-resolvable identifier
 * `__replAwait` at every site, so a guest lexical declaration shadowed
 * it: `{ const __replAwait = () => 7; globalThis.seen = await
 * Promise.resolve(42); }` yielded 7 instead of 42. The 0.3.0 transform
 * is hygienic by construction:
 *
 * - the injected base is the `this` KEYWORD at the eval's top level —
 *   the engine invokes the script's async wrapper with the realm's
 *   global object as its `this` (verified against the shipped binary),
 *   so `this["__replAwait"]` resolves the library's global without
 *   naming any identifier the guest could shadow; `this` is a keyword —
 *   no declaration, in any scope, can shadow it;
 * - no capture line and no helper binding are injected: a top-level
 *   `const` in an eval persists in the realm's global lexical record,
 *   so a helper declaration would (a) redeclare on the loop idiom
 *   (re-running identical code — `SyntaxError: redeclaration`) and (b)
 *   leak a binding into the workspace manifest. The direct
 *   `this["__replAwait"]` form injects nothing but the call sites.
 *
 * The rewrite is restricted to awaits in the eval'd script's TOP-LEVEL
 * body — the engine evaluates the script with top-level-await semantics
 * (see vm.ts), so only awaits directly in that body queue THE EVAL's
 * continuation. Awaits inside NESTED function bodies (a `.map(async x =>
 * await ...)` callback, a `parallel()` thunk, a `for await` inside a
 * helper) belong to their own continuations: wrapping them would
 * attribute the wrong execution and let the signal break an unrelated
 * one — the exact false positive the discipline forbids. The library's
 * own combinators are deliberately NOT wrapped: an eval that awaits
 * `parallel([...])` awaits the combinator's RESULT promise, and the wrap
 * rides that promise's settlement like any other — the combinator's
 * internals need no special handling.
 *
 * The instrumenter is a pure source transform driven by acorn (already a
 * monorepo dependency — mcp-server and workflow-engine use it): parse the
 * script, walk the AST, collect `(argument.start, node.end)` pairs of
 * every top-level AwaitExpression (plus the iterable of every top-level
 * `for await`), and splice the call at those exact AST boundaries.
 * Boundaries are tokenization-safe by construction: the original parse
 * already resolved every `await` expression's extent, so no token can be
 * split. A parse failure returns the code UNCHANGED — the VM reports the
 * syntax error with the original source (positions preserved; the
 * instrumenter never shifts lines).
 *
 * The broker gates the instrumenter on the workspace's library carrying
 * the 0.3.0 continuation-lease surface (`surface.supportsContinuation
 * Lease`): a restored snapshot with the 0.1.0/0.2.0 library is served
 * as-is and simply gets no instrumentation (the eval-break interrupt
 * degrades to the honest refusal — the 0.2.0 log-only targeting is the
 * rejected settled-call-ids identity). The for-await ITERABLE sites are
 * gated separately on the 0.3.1 iterable-lease surface
 * (`surface.supportsIterableLease` — `instrumentTopLevelAwaits`'s
 * `wrapIterables` option): a 0.3.0 snapshot's for-await wrap returned a
 * promise (breaking every `for await` loop), so those sites are left
 * UNWRAPPED on a 0.3.0 copy — the loop runs natively, and only the
 * loop's mid-iteration eval-break targeting is lost (the honest
 * degradation). `for await (... of await y)` needs no iterable wrap at
 * all: the right expression's own top-level await is instrumented
 * normally (the loop iterates the unwrapped value), so the site is
 * skipped — wrapping the AwaitExpression itself would hand the
 * iterable wrap a promise.
 */

import { parse } from 'acorn';

/** How many distinct source strings the transform cache holds (evals
 *  re-run identical code — the workspace's loop idiom — so caching the
 *  parse is a real win; the bound keeps a pathological caller from
 *  growing the cache unboundedly). */
const INSTRUMENT_CACHE_MAX = 256;

/** One source's cached parse plan: the await sites are token- and
 *  eval-independent — only the per-eval TOKEN varies, so the splice is
 *  re-derived per call from this plan. */
interface InstrumentPlan {
  sites: AwaitSite[];
}

const cache = new Map<string, InstrumentPlan | typeof MISS>();

/** Cache sentinel for an un-instrumentable source (a parse failure, or a
 *  script with no top-level await). */
const MISS = Symbol('instrument-miss');

/** Function-like AST nodes whose bodies own their continuations: the
 *  instrumenter never descends into them (an await inside one is not a
 *  top-level await — see the module docs). */
const FUNCTION_NODE_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'StaticBlock',
]);

/**
 * Rewrite every TOP-LEVEL `await <expr>` of the script into
 * `await this["__replAwait"](<expr>, TOKEN)` (and every top-level
 * `for await (... of <iterable>)` into
 * `for await (... of this["__replAwaitIterable"](<iterable>, TOKEN))` —
 * the iterable wrap is the 0.3.1 surface and is applied only when
 * `opts.wrapIterables` is set (the broker gates it on the resident
 * library's `supportsIterableLease`; a 0.3.0 snapshot's for-await sites
 * stay unwrapped — native semantics, the honest degradation). Returns
 * the original code unchanged when there is nothing to rewrite or the
 * code does not parse (the VM reports the syntax error).
 */
export function instrumentTopLevelAwaits(
  code: string,
  token: string,
  opts: { wrapIterables?: boolean } = {},
): string {
  const plan = planFor(code);
  if (plan === undefined || plan.sites.length === 0) return code;
  const enabled = opts.wrapIterables ? plan.sites : plan.sites.filter((site) => site.kind === 'await');
  if (enabled.length === 0) return code;
  const tokenJson = JSON.stringify(token);
  // All insertions, applied right-to-left by position: sites NEST (an
  // outer await's range contains its argument's awaits — `await (await
  // a, await b)`), so a range-splice of the outer site would cut
  // through the already-shifted interior. Point insertions at exact AST
  // boundaries are position-safe at any nesting depth (each site's
  // `start` and `end` are distinct positions; when two sites share a
  // position — `for await (const x of a ?? await y)` — the doubled
  // insertion is harmless: both wrappers still surround their
  // expression, and the shared-position close order (inner first in
  // the text — the inner close is applied last at the position) keeps
  // the outer wrap's argument an EXPRESSION, evaluated before the outer
  // call: `__replAwaitIterable(a ?? await __replAwait(y, T), T)`). The
  // one shape this cannot express — `for await (const x of await y)`,
  // where the iterable IS the awaited expression — is skipped at
  // collection time (see `findAwaitSites`).
  const insertions: Array<{ pos: number; text: string }> = [];
  for (const site of enabled) {
    insertions.push({
      pos: site.start,
      text: site.kind === 'iterable' ? 'this["__replAwaitIterable"](' : 'this["__replAwait"](',
    });
    insertions.push({ pos: site.end, text: `, ${tokenJson})` });
  }
  insertions.sort((a, b) => b.pos - a.pos);
  let out = code;
  for (const insertion of insertions) {
    out = out.slice(0, insertion.pos) + insertion.text + out.slice(insertion.pos);
  }
  return out;
}

/** The cached parse plan for a source (see `InstrumentPlan`). Returns
 *  undefined when the source does not parse or has no top-level await. */
function planFor(code: string): InstrumentPlan | undefined {
  const cached = cache.get(code);
  if (cached !== undefined) return cached === MISS ? undefined : cached;

  let plan: InstrumentPlan | undefined;
  try {
    const sites = findAwaitSites(code);
    if (sites.length > 0) plan = { sites };
  } catch {
    // Parse failure — the engine reports the syntax error; never
    // instrument what we cannot parse (a half-rewritten script would
    // produce a confusing double error).
    plan = undefined;
  }

  if (cache.size >= INSTRUMENT_CACHE_MAX) cache.clear();
  cache.set(code, plan === undefined ? MISS : plan);
  return plan;
}

/** Parse the script and collect every top-level await site (see the
 *  module docs for the top-level rule). */
function findAwaitSites(code: string): AwaitSite[] {
  // `allowAwaitOutsideFunction` matches the engine's top-level-await
  // semantics: `await` is the await OPERATOR everywhere in the script,
  // exactly as the VM treats it.
  const ast = parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowAwaitOutsideFunction: true,
  }) as unknown as AcornNode;

  const sites: AwaitSite[] = [];
  visit(ast, false, sites);
  return sites;
}

/** Recursive AST walk collecting await sites. `inFunction` is true
 *  inside any nested function body — awaits there are skipped entirely
 *  (their continuations are not the eval's). */
function visit(node: AcornNode | null | undefined, inFunction: boolean, sites: AwaitSite[]): void {
  if (node === null || node === undefined || typeof node !== 'object' || typeof node.type !== 'string') return;

  if (node.type === 'AwaitExpression') {
    if (!inFunction && node.argument !== null && typeof node.argument === 'object') {
      sites.push({ start: node.argument.start, end: node.end, kind: 'await' });
    }
    visit(node.argument, inFunction, sites);
    return;
  }
  if (node.type === 'ForOfStatement') {
    // `for await (const x of y)`: the eval suspends on the ITERABLE's
    // iterator — wrapping the iterable rides the iteration's first
    // suspension like any other awaited value. The wrap must preserve
    // the iterable protocol (the 0.3.1 `__replAwaitIterable` returns an
    // ASYNC-ITERABLE, never a promise — phase-E review rejection round
    // 6: the 0.3.0 `__replAwait` wrap made `for await (const x of [1,
    // 2])` throw `TypeError: not a function`). When the iterable IS an
    // AwaitExpression (`for await (const x of await y)`), the site is
    // SKIPPED: the right expression's own top-level await is
    // instrumented separately (the loop then iterates the unwrapped
    // value, exactly like the un-instrumented program) — wrapping the
    // awaited expression itself would hand the iterable wrap a promise
    // (the machinery evaluates the instrumented `await` BEFORE the
    // wrapper call only when the await sits INSIDE the argument, which
    // a top-level AwaitExpression right cannot be).
    if (node.await === true && node.right !== null && typeof node.right === 'object') {
      if (node.right.type !== 'AwaitExpression') {
        sites.push({ start: node.right.start, end: node.right.end, kind: 'iterable' });
      }
    }
    visit(node.left, inFunction, sites);
    visit(node.right, inFunction, sites);
    return;
  }
  if (FUNCTION_NODE_TYPES.has(node.type)) return;

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        visit(item as AcornNode, inFunction, sites);
      }
    } else if (child !== null && typeof child === 'object' && typeof (child as AcornNode).type === 'string') {
      visit(child as AcornNode, inFunction, sites);
    }
  }
}

interface AwaitSite {
  /** Where to insert the wrap call's open (the awaited expression's
   *  start). */
  start: number;
  /** Where to insert `, "TOKEN")` (the awaited expression's end). */
  end: number;
  /** Which seam the site rides: a top-level `await` (the `__replAwait`
   *  promise wrap) or a `for await` ITERABLE (the `__replAwaitIterable`
   *  async-iterable wrap — gated on the 0.3.1 iterable-lease surface). */
  kind: 'await' | 'iterable';
}

/** The acorn AST node shape the walker needs (a structural subset). */
interface AcornNode {
  type: string;
  start: number;
  end: number;
  await?: boolean;
  argument?: AcornNode | null;
  left?: AcornNode | null;
  right?: AcornNode | null;
}
