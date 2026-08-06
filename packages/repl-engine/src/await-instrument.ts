/**
 * The top-level-await instrumenter — the guest-side half of the eval-break
 * targeting discipline (the `interrupt` tool's no-id arm, phase-E review
 * rejection round 4): the broker rewrites `await <expr>` into
 * `await __replAwait(<expr>)` for every TOP-LEVEL await of an eval, so the
 * guest library can record WHICH pending call's settlement queues the
 * eval's continuation. That record is the armed target's REAL resume-key
 * identity:
 *
 * - an eval that awaits a call it created (`const c1 = agent(...); await
 *   c1`) logs c1 — the settlement that queues its continuation;
 * - an eval that awaits an EARLIER eval's binding (`await p` where `p`
 *   was created by a previous eval) logs that call too — "a running eval
 *   awaiting an earlier binding must also remain targetable" (the
 *   reviewer's requirement; the pre-instrumenter model attributed only
 *   the calls an eval CREATED, so both this and the sibling case were
 *   wrong);
 * - an UNAWAITED sibling call (`const c2 = agent(...); c2.then(heavy)`)
 *   is never logged — its settlement runs c2's own `.then` continuation,
 *   NOT the eval's continuation, so the armed signal must neither fire
 *   nor be consumed by it (the carried defect: every call an eval
 *   created was a resume key, so settling the unawaited sibling
 *   interrupted its unrelated heavy `.then`, left the awaited call
 *   pending, and made the next arm refuse).
 *
 * The rewrite is restricted to awaits in the eval'd script's TOP-LEVEL
 * body — the engine wraps the script in ONE async function
 * (`JS_EVAL_FLAG_ASYNC`, see vm.ts), so only awaits directly in that
 * body queue THE EVAL's continuation. Awaits inside NESTED function
 * bodies (a `.map(async x => await ...)` callback, a `parallel()` thunk,
 * a `for await` inside a helper) belong to their own continuations:
 * wrapping them would attribute the wrong execution and let the signal
 * break an unrelated one — the exact false positive the discipline
 * forbids. The library's own combinators are deliberately NOT wrapped:
 * an eval that awaits `parallel([...])` awaits the combinator's RESULT
 * promise, whose settlement is the LAST component call's — unknowable in
 * advance — so indirect awaits degrade honestly to "not targetable"
 * (the refusal) instead of risking a false positive.
 *
 * The instrumenter is a pure source transform driven by acorn (already a
 * monorepo dependency — mcp-server and workflow-engine use it): parse the
 * script, walk the AST, collect `(argument.start, node.end)` pairs of
 * every top-level AwaitExpression (plus the iterable of every top-level
 * `for await`), and splice `__replAwait(` / `)` at those exact AST
 * boundaries. Boundaries are tokenization-safe by construction: the
 * original parse already resolved every `await` expression's extent, so
 * no token can be split. A parse failure returns the code UNCHANGED —
 * the VM reports the syntax error with the original source (positions
 * preserved; the instrumenter never shifts lines).
 *
 * The broker gates the instrumenter on the workspace's library carrying
 * the 0.2.0 tracking surface (`surface.supportsAwaitTracking`): a
 * restored snapshot with the 0.1.0 library is served as-is and simply
 * gets no attribution (the eval-break interrupt degrades to the honest
 * refusal).
 */

import { parse } from 'acorn';

/** How many distinct source strings the transform cache holds (evals
 *  re-run identical code — the workspace's loop idiom — so caching the
 *  parse is a real win; the bound keeps a pathological caller from
 *  growing the cache unboundedly). */
const INSTRUMENT_CACHE_MAX = 256;

const cache = new Map<string, string>();

/** Function-like AST nodes whose bodies own their continuations: the
 *  instrumenter never descends into them (an await inside one is not a
 *  top-level await — see the module docs). */
const FUNCTION_NODE_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'StaticBlock',
]);

interface AwaitSite {
  /** Where to insert `__replAwait(` (the awaited expression's start). */
  start: number;
  /** Where to insert `)` (the awaited expression's end). */
  end: number;
}

/**
 * Rewrite every TOP-LEVEL `await <expr>` of the script into
 * `await __replAwait(<expr>)` (and every top-level `for await (... of
 * <iterable>)` into `for await (... of __replAwait(<iterable>))`).
 * Returns the original code unchanged when there is nothing to rewrite
 * or the code does not parse (the VM reports the syntax error).
 */
export function instrumentTopLevelAwaits(code: string): string {
  const cached = cache.get(code);
  if (cached !== undefined) return cached;

  let result = code;
  try {
    const sites = findAwaitSites(code);
    if (sites.length > 0) {
      // Flatten each site into its two insertions and apply them
      // right-to-left by position: sites NEST (an outer await's range
      // contains its argument's awaits — `await (await a, await b)`),
      // so a range-splice of the outer site would cut through the
      // already-shifted interior. Point insertions at exact AST
      // boundaries are position-safe at any nesting depth (each site's
      // `start` and `end` are distinct positions; when two sites share
      // a position — `for await (const x of await y)` — the doubled
      // insertion is harmless: both wrappers still surround their
      // expression).
      const insertions: Array<{ pos: number; text: string }> = [];
      for (const site of sites) {
        insertions.push({ pos: site.start, text: '__replAwait(' });
        insertions.push({ pos: site.end, text: ')' });
      }
      insertions.sort((a, b) => b.pos - a.pos);
      let out = code;
      for (const insertion of insertions) {
        out = out.slice(0, insertion.pos) + insertion.text + out.slice(insertion.pos);
      }
      result = out;
    }
  } catch {
    // Parse failure — the engine reports the syntax error; never
    // instrument what we cannot parse (a half-rewritten script would
    // produce a confusing double error).
    result = code;
  }

  if (cache.size >= INSTRUMENT_CACHE_MAX) cache.clear();
  cache.set(code, result);
  return result;
}

/** Parse the script and collect every top-level await site (see the
 *  module docs for the top-level rule). */
function findAwaitSites(code: string): AwaitSite[] {
  // `allowAwaitOutsideFunction` matches the engine's async eval wrapper:
  // `await` is the await OPERATOR everywhere in the script, exactly as
  // the VM treats it (`JS_EVAL_FLAG_ASYNC` parses the whole script as an
  // async function body).
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
      sites.push({ start: node.argument.start, end: node.end });
    }
    visit(node.argument, inFunction, sites);
    return;
  }
  if (node.type === 'ForOfStatement') {
    // `for await (const x of y)`: the eval suspends on the ITERABLE's
    // iterator — wrapping the iterable records the awaited calls the
    // iteration resumes on (each `next()` is a continuation of the same
    // top-level loop, so the first suspension's resume keys are the
    // logged ones).
    if (node.await === true && node.right !== null && typeof node.right === 'object') {
      sites.push({ start: node.right.start, end: node.right.end });
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
