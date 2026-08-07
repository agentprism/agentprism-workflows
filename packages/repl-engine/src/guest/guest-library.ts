/**
 * The REPL orchestrator's guest-side library — a fresh TypeScript-authored
 * implementation of the sandbox vocabulary (NOT a vendor of the harness's
 * `guest/dsl.js`; the harness's evolution disciplines are the model).
 *
 * `GUEST_LIBRARY_SOURCE` is a plain script evaluated exactly ONCE at VM
 * creation, inside the capability-free QuickJS realm — no modules, no
 * imports, no host assumptions beyond the four documented `__host_*`
 * functions (see the package README's "Guest library ⇄ host contract").
 * After the first snapshot this library travels INSIDE the snapshot: it is
 * versioned with the workspace, not with the host, and a host must accept
 * snapshots carrying an older copy than the one it ships.
 *
 * What it defines in the realm (the roadmap doc's DSL split — only the
 * sliver that needs host effects calls out; everything else is pure JS):
 *
 *   - `agent(modelSpec, task, options?)` → Promise (host effect). `modelSpec`
 *     is the backend-routing spec (`"pi/deepseek-v4-flash-max"`, per the
 *     roadmap doc's own example); `task` the worker's prompt; `options`
 *     (structured-output schema, cwd, backend config) cross the bridge as
 *     JSON. The returned promise IS the live handle: started-not-awaited
 *     handles come free with top-level await, and the doc's handle methods
 *     ride it — `followUp(prompt, opts?)` / `steer(prompt, opts?)` /
 *     `cancel()` — each resolving with what actually happened (the host
 *     settles with the steering outcome, mirroring the outcome values
 *     acp-agents surfaces in its steering events). `id` carries the stable
 *     call id (`"c1"`, …) used by `status`/`interrupt`.
 *   - `checkpoint(question, options?)` → Promise (host effect), and
 *     `checkpoint.answer(callId, value)` → boolean — answer delivery
 *     through the same host function's trailing-argument mode.
 *   - `console.{log,info,warn,error,debug}` — the bridge: every argument
 *     is frozen (structuredClone, with an iterative marker-copy fallback)
 *     into a real `$N` global, then forwarded to `__host_console`.
 *   - `parallel` / `pipeline` / `verify` / `judgePanel` / `gate` /
 *     `retry` / `loopUntilDry` — pure JavaScript layered on `agent()`,
 *     following `packages/workflows/src/dsl.d.ts` semantics.
 *   - `__REPL_GUEST_VERSION` — the version marker global.
 *   - `globalThis[Symbol.for("repl.guest")]` — the frozen reconciliation
 *     surface (version / pending / settle / stats) the host uses after a
 *     snapshot restore.
 *
 * Deleted vocabulary, per the roadmap doc: `phase()` (it presupposes "a
 * run" that no longer exists) and the whole budget surface — no `budget()`
 * global, no ledger, no caps vocabulary. Resource limits are server
 * configuration, invisible to the guest; the host signals non-recoverable
 * failures exclusively through `recoverable: false` on rejections (the
 * harness's reserved `BUDGET_EXHAUSTED`/`AGENT_LIMIT_EXCEEDED` codes have
 * no counterpart here).
 *
 * The pending-call registry (callId → { resolve, reject, kind, detail,
 * optionsJson, createdAt, sessionId, modelSpec }) lives in the library's
 * closure, so the table of in-flight host calls travels inside the snapshot
 * itself. Every entry records the id the host addresses the call by
 * (`sessionId` — the founding session id for steering calls, the call's own
 * id otherwise), so a pending steer survives a restore with full
 * correlation: the host can settle it by its registry id and re-issue it
 * to the session it steers. The host settles calls by callId — through the
 * Deferred it returned from a `__host_*` function in a live session, or
 * through the reconciliation surface after a restore. Both routes converge
 * on the same idempotent settlement function; the first settlement wins.
 */

/** The guest library's version (the `__REPL_GUEST_VERSION` marker value).
 *  0.2.0 adds the eval-await tracking surface: '__replAwait' (the global
 *  the host's top-level-await instrumenter inserts), the registry
 *  entries' 'promise' field (which promise each pending call's
 *  settlement resolves — the await-attribution look-up), the 'awaitLog'
 *  (the chronological record of awaited call ids), and the surface's
 *  'supportsAwaitTracking'/'awaitLogTake' members.
 *  0.3.0 replaces the LOG-based targeting with a genuine per-eval
 *  CONTINUATION IDENTITY: '__replAwait(value, token)' now WRAPS the
 *  awaited value in a fresh promise whose settling reaction — the job
 *  that runs IMMEDIATELY BEFORE the eval's continuation segment — sets
 *  the CONTINUATION LEASE to the eval's token (the writable
 *  '__replLease' accessor global). The host's drain loop reads the
 *  lease between jobs: a job that starts with a lease set IS the armed
 *  eval's continuation, so the interrupt fires only while THAT
 *  execution runs (an unawaited sibling `.then` job — which runs
 *  before the lease-setting reaction — can neither fire nor consume
 *  the signal), and the lease is cleared after the segment ends. The
 *  wrap also makes INDIRECT awaits targetable: `await
 *  Promise.all([q])` wraps the combinator promise, whose settlement
 *  queues the eval's continuation exactly like a direct call's — the
 *  eval's identity is the promise graph, not a logged call-id list.
 *  The surface gains 'supportsContinuationLease'; the 0.2.0 log
 *  surface stays (an older host may still drive it). A snapshot
 *  carrying 0.1.0 is served as-is (the doc's rule: the host serves
 *  snapshots carrying older library versions) — the host degrades by
 *  not instrumenting awaits on it (no eval-break targeting, honest
 *  refusal).
 *  0.3.1 fixes two continuation-lease defects (phase-E review rejection
 *  round 6): the lease-setting reaction moved from the awaited VALUE's
 *  settlement onto the WRAPPER itself (registered before the await
 *  machinery's own reaction), so a sibling `q.then(...)` registered
 *  after the eval started awaiting `q` can no longer run with the
 *  lease set — the lease is associated with the actual continuation
 *  job; and the for-await ITERABLE wrap became a real async-iterable
 *  (`__replAwaitIterable` — the 0.3.0 instrumenter wrapped `for await`
 *  iterables in `__replAwait`, whose promise result made every `for
 *  await` loop throw `TypeError: not a function`). The surface gains
 *  'supportsIterableLease'; a 0.3.0 snapshot is served as-is — its
 *  for-await sites are left unwrapped by the instrumenter (native
 *  semantics, no mid-loop targeting) while its awaits stay instrumented
 *  (the 0.3.0 lease-set defect is the older copy's own, never
 *  re-injected).
 *
 *  The 0.3.1 copy also hardens the instrumentation surface (phase-E
 *  review rejection round 7, same version — nothing shipped between):
 *  the await/iterable helpers run on the CAPTURED pristine Promise
 *  intrinsics (a guest that replaces 'Promise.prototype.then', overwrites
 *  'Promise.resolve' or shadows 'Promise' lexically cannot change
 *  instrumentation semantics — the instrumented 'await 40' stays '40'
 *  and the continuation lease is still set); the for-await iterable wrap
 *  propagates ACQUISITION errors exactly once (an observable/throwing
 *  'Symbol.asyncIterator' getter runs a single time and reports its
 *  original error — the old degrade-to-unwrapped made the machinery
 *  acquire the iterable a second time and could surface 'boom2' instead
 *  of native 'boom1'); and a SYNC iterator's results pass through
 *  AsyncFromSyncIteratorContinuation semantics (the result VALUE is
 *  awaited and unwrapped — 'for await (const x of
 *  [Promise.resolve(1)])' yields '1', never the promise object).
 *  The provenance registry reads descriptors off the CAPTURED global
 *  object too (a top-level lexical 'const globalThis = 7' no longer
 *  blanks every binding's provenance).
 *
 *  HOST GATE: the broker's continuation-lease availability check is
 *  VERSION-GATED on >= 0.3.1 — a restored snapshot carrying the 0.3.0
 *  library (whose lease-setting reaction still runs on the awaited
 *  VALUE's settlement — the sibling-reaction interrupt-targeting defect)
 *  reports 'supportsContinuationLease: true' but is served WITHOUT
 *  instrumentation: no eval-break targeting, honest refusal (phase-E
 *  review rejection round 7: the flag alone re-armed the original
 *  defect on a supported older snapshot). */
export const GUEST_LIBRARY_VERSION = '0.3.1';

/** `Symbol.for` key of the reconciliation surface on `globalThis`. */
export const GUEST_SURFACE_KEY = 'repl.guest';

/** `Symbol.for` key of the per-binding provenance registry on
 *  `globalThis` (the workspace manifest's provenance seam — which eval
 *  created/rebound a binding, or which worker call's settlement produced
 *  it; metadata only, travels inside snapshots). The registry is HOST
 *  policy, not guest injection: the workspace layer's bootstrap installs
 *  it (with the fresh-realm baseline as its `known` set) on fresh and
 *  restored workspaces alike — the harness manifest's own placement — so
 *  the library source itself never grows the realm's baseline.
 */
export const GUEST_PROVENANCE_KEY = 'repl.provenance';

/**
 * The provenance registry factory (see `provenance.ts`): evaluated by
 * the host bootstrap on every workspace start (fresh installs and
 * pre-provenance restores), so all installers produce a byte-identical
 * registry. Captures its own intrinsics at evaluation time (install-time
 * captures are pristine — the bootstrap runs before any guest code on a
 * fresh workspace; a bootstrap over a hostile pre-provenance snapshot
 * degrades to no provenance, never to content, via the record/read
 * try/catch). `names` is the fresh-realm baseline key set (the 'known'
 * skip set for GLOBAL-OBJECT properties), plus two newer optional
 * arguments the bootstrap passes: the baseline TYPE TOKENS (name →
 * fresh-realm typeof token — a known name whose token changes has been
 * REBOUND by user code and is attributed like any other rebinding) and
 * the LEXICAL baseline key set (the fresh realm's own top-level
 * let/const/class bindings — the lexical pass skips THESE instead of
 * the known set, because a lexical declaration shadows a same-named
 * baseline global and is always the user's). A factory invoked without
 * them (an older host) keeps the pure known-set skip.
 */
export const PROVENANCE_FACTORY = `(function (names, typeToks, lexKnownArr) {
  var gOPN = Object.getOwnPropertyNames;
  var gOPD = Object.getOwnPropertyDescriptor;
  var hasOwnProp = Object.prototype.hasOwnProperty;
  var jparse = JSON.parse;
  // Captured at CREATION (the bootstrap runs before any user eval, so
  // the realm is pristine): the pass's own code must keep working when
  // user code SHADOWS a baseline global — 'const Math = 42' is a
  // legitimate user program, and the lexical binding shadows the
  // factory's free-variable Math/Object references at call time
  // (phase-E review round 5: the pass threw on Math.max under a
  // lexical Math shadow, swallowing every attribution).
  var jmax = Math.max;
  var jcreate = Object.create;
  // The realm's global object, captured when the factory runs (before
  // any user code on a fresh workspace): the pass's own code must keep
  // working when user code SHADOWS a baseline global — 'const
  // globalThis = …' is a legitimate user program, and the lexical
  // binding would shadow the factory's free-variable globalThis at
  // call time (the same discipline as the captured Math/Object
  // intrinsics above).
  var g = globalThis;
  var reg = {
    evalSeq: 0,
    origins: Object.create(null),
    prev: Object.create(null),
    // The lexical pass's value tracker (see record): the CURRENT value
    // of each global lexical binding (top-level let/const/class), by
    // name — the SameValue comparison base for re-attribution. The
    // guest cannot read lexical bindings (the global declarative record
    // is non-reflectable), so the HOST passes the values in; this map
    // is where the registry keeps them (a strong reference, exactly
    // like the property pass's prev values).
    lexPrev: Object.create(null),
    known: Object.create(null),
    // The ORIGINAL baseline VALUES of the known names (see the
    // typeToks loop below): NEVER updated on attribution — the
    // manifest's "changed from the baseline" comparison needs the
    // pristine value forever.
    baseVal: Object.create(null),
    // The LAST-ATTRIBUTED value of each known name (initialized to the
    // baseline value): the record pass's SameValue rebind detector — a
    // SECOND rebind re-attributes to its own eval, and a restored
    // registry's last-attributed values survive the snapshot (a
    // pre-snapshot rebind is not re-attributed by the first
    // post-restore pass).
    knownPrev: Object.create(null),
  };
  // The fresh-realm BASELINE TYPE TOKENS (name -> typeof token of the
  // pristine value, captured by the host in a throwaway realm): a KNOWN
  // (baseline) name whose current token differs has been REBOUND by
  // user code — 'Math = 42' overwrites the built-in — and is
  // attributed like any other rebinding (phase-E review rejection: the
  // known-set skip made overwritten built-ins invisible to the
  // manifest). SameValue against the throwaway realm's baseline VALUE
  // is impossible (different realm), so the tokens are the host-side
  // change detector, while the registry's OWN baseline values
  // (reg.baseVal, captured below) extend it to SAME-TYPE replacements
  // ('Math = { userOwned: true }' — the token cannot see those; the
  // value identity can, within this realm). The token observed at each
  // pass is remembered (reg.baseTok), so an untouched builtin is a
  // no-op forever and a SECOND rebind re-attributes to its own eval.
  // The tokens are CONSTANT per registry lifetime (the baseline never
  // changes), so they arrive at factory creation.
  reg.baseTok = Object.create(null);
  if (typeof typeToks === 'string') {
    try { typeToks = jparse(typeToks); } catch (e) { typeToks = null; }
  }
  if (typeToks !== null && typeToks !== undefined && typeof typeToks === 'object') {
    for (var tk in typeToks) {
      if (typeof typeToks[tk] === 'string') {
        reg.baseTok[tk] = typeToks[tk];
        // The ORIGINAL baseline VALUE of the known name (descriptor
        // read, never a [[Get]] — the pass's discipline): captured when
        // the factory runs. On a fresh workspace the realm is pristine
        // (the bootstrap runs before any user code), so this is the
        // true baseline; a restored registry carries the references
        // inside the snapshot. The values are NEVER updated on
        // attribution: the manifest's same-type-replacement detector
        // ('Math = { userOwned: true }' keeps the 'object' type token)
        // compares the CURRENT value against the ORIGINAL baseline —
        // value identity is the only detector a type token cannot
        // provide (phase-E review rejection round 6). A pre-provenance
        // restore runs the factory over the restored (dirty) realm —
        // the captured values may be user-rebound; the type-token
        // detector still catches token-changing overwrites there (the
        // same corner the bootstrap accepts).
        var bd = gOPD(g, tk);
        var bv;
        if (bd !== undefined && hasOwnProp.call(bd, 'value')) bv = bd.value;
        else if (bd !== undefined && hasOwnProp.call(bd, 'get')) bv = bd.get;
        reg.baseVal[tk] = bv;
        reg.knownPrev[tk] = bv;
      }
    }
  }
  // The LEXICAL baseline key set (the fresh realm's own top-level
  // let/const/class bindings — empty on the shipped library; a future
  // library that declared lexically would otherwise be attributed as
  // user bindings). The lexical pass skips THESE names instead of the
  // global baseline's: a lexical declaration SHADOWS a same-named
  // baseline global, and the shadowing binding is the user's — it must
  // be attributed (phase-E review rejection: the known-set skip made
  // 'const Math = 42' invisible to the manifest). Also constant per
  // registry lifetime.
  reg.lexKnown = Object.create(null);
  if (typeof lexKnownArr === 'string') {
    try { lexKnownArr = jparse(lexKnownArr); } catch (e) { lexKnownArr = null; }
  }
  if (lexKnownArr !== null && lexKnownArr !== undefined && typeof lexKnownArr.length === 'number') {
    for (var lk0 = 0; lk0 < lexKnownArr.length; lk0++) {
      if (typeof lexKnownArr[lk0] === 'string') reg.lexKnown[lexKnownArr[lk0]] = true;
    }
  }
  function record(label, atMs) {
    try {
      if (label === null || label === undefined) {
        reg.evalSeq = (reg.evalSeq | 0) + 1;
        label = 'eval ' + reg.evalSeq;
      }
      // The global LEXICAL bindings first (top-level let/const/class —
      // the roadmap's canonical 'const research = agent(...)' state):
      // they are not global-object properties and cannot be enumerated
      // guest-side (ECMAScript's global declarative record is
      // non-reflectable), so the HOST enumerates them through the
      // engine's internal global-var object (see global-lexical.ts) and
      // passes the names as this pass's THIRD argument (a JSON array
      // string). A lexical binding SHADOWS a same-named global-object
      // property for identifier resolution, and the manifest displays
      // the binding code sees — the lexical one — so names in the
      // lexical set are SKIPPED by the property pass below (one binding
      // per name, the lexical view authoritative). A pass without the
      // argument (an older host, or a registry snapshot whose record
      // closure predates the feature) skips the merge.
      //
      // The pass's FOURTH+ arguments carry the CURRENT lexical VALUES,
      // one realm value per name in the names array's order (the host
      // reads them through the internal global-var object — the same
      // host-driven channel as the names; a guest can never forge the
      // values). With the values the registry can detect a CHANGE
      // (SameValue) and RE-ATTRIBUTE: a 'let' binding assigned a worker
      // result, or a suspended 'const finding = await research' whose
      // continuation assigned the settled value, re-attributes to the
      // settlement's 'worker cN' label — the manifest then reports
      // WHICH subagent produced the current value, from what task, when
      // (phase-E review rejection: the lexical entry was recorded on
      // first sight only, so a value the worker settlement produced
      // kept the declaring eval's label with no task). Without the
      // values (an older host) the pass degrades to first-sight-only
      // attribution, the pre-feature behavior.
      var lexNames = null;
      try {
        if (arguments.length >= 3 && typeof arguments[2] === 'string' && arguments[2].length > 0) {
          lexNames = jparse(arguments[2]);
        }
      } catch (e) { lexNames = null; }
      var lexValueCount = jmax(0, arguments.length - 3);
      var lexSet = jcreate(null);
      if (lexNames !== null && typeof lexNames.length === 'number') {
        for (var li = 0; li < lexNames.length; li++) {
          var lk = lexNames[li];
          if (typeof lk === 'string') lexSet[lk] = true;
        }
      }
      var names_ = gOPN(g);
      var seen = jcreate(null);
      for (var i = 0; i < names_.length; i++) {
        var k = names_[i];
        // Descriptor read, never a [[Get]]: a binding rebound to an
        // accessor must not have its getter fired by host bookkeeping.
        // The getter FUNCTION serves as the rebind-detection identity for
        // accessor bindings. Read from the CAPTURED global object 'g' —
        // never the free variable globalThis: a top-level lexical 'const
        // globalThis = 7' is a legitimate user program, and the lexical
        // binding shadows the factory's free-variable globalThis at call
        // time, so gOPD(globalThis, k) read descriptors off the NUMBER
        // (throwing in QuickJS) and the pass's catch swallowed the whole
        // attribution — every subsequent binding reached the manifest
        // with null provenance (phase-E review rejection round 7: 'var
        // userValue = 42' appeared without producer/task/time metadata
        // after a 'const globalThis' shadow).
        var d = gOPD(g, k);
        var v = undefined;
        if (d !== undefined) {
          if (hasOwnProp.call(d, 'value')) v = d.value;
          else if (hasOwnProp.call(d, 'get')) v = d.get;
        }
        if (reg.known[k]) {
          // A KNOWN baseline name (a builtin or a library global):
          // attribute only when user code REBOUND it — the current type
          // token differs from the fresh-realm baseline token ('Math =
          // 42', 'globalThis.JSON = "x"' — the phase-E review
          // rejection: the baseline filter hid overwritten built-ins
          // from the manifest), OR the current value is no longer
          // SameValue to the last-attributed value — a SAME-TYPE
          // replacement ('Math = { userOwned: true }' keeps the
          // 'object' token; phase-E review rejection round 6: the
          // token-only detector missed same-type overwrites entirely,
          // leaving them absent from the manifest with no provenance).
          // The token and the value are remembered per pass
          // (reg.baseTok / reg.knownPrev), so an untouched builtin is a
          // no-op forever and a SECOND rebind re-attributes to its own
          // eval. The name is present (it is in the property list), so
          // it is marked seen — an attributed rebinding must never be
          // swept by the gone pass in the same sweep.
          seen[k] = true;
          if (reg.baseTok && typeof reg.baseTok[k] === 'string') {
            var tok = hasOwnProp.call(d, 'value') ? typeof d.value : 'accessor';
            var rebound = tok !== reg.baseTok[k];
            if (!rebound && reg.knownPrev && hasOwnProp.call(reg.knownPrev, k)) {
              var prevV = reg.knownPrev[k];
              // SameValue semantics (NaN-stable), like the pass's other
              // value comparisons.
              rebound = prevV !== v && !(prevV !== prevV && v !== v);
            }
            if (rebound) {
              reg.origins[k] = { via: label, at: atMs };
              reg.prev[k] = v;
              reg.baseTok[k] = tok;
              reg.knownPrev[k] = v;
            }
          }
          continue;
        }
        if (lexSet[k]) { seen[k] = true; continue; }
        seen[k] = true;
        var tracked = reg.origins[k] !== undefined;
        var same = tracked && (reg.prev[k] === v || (reg.prev[k] !== reg.prev[k] && v !== v));
        if (!same) {
          reg.origins[k] = { via: label, at: atMs };
          reg.prev[k] = v;
        }
      }
      // The lexical pass: attribute on first sight; with the host's
      // VALUE arguments, RE-ATTRIBUTE on a value change (SameValue —
      // the current label produced the current value: a 'let' assigned
      // a worker result, or a suspended 'const finding = await
      // research' whose continuation assigned the settled value,
      // re-attributes to the settlement's 'worker cN' label). A name
      // first attributed as a global PROPERTY and later shadowed by a
      // lexical declaration is re-attributed when the lexical binding
      // appears — the property path stored the property VALUE in
      // prev[k], and a stored value is the pass's marker that the name
      // predates the lexical binding (after re-attribution prev[k] is
      // undefined and stays; the corner where the property value itself
      // was literally undefined is accepted — orientation metadata).
      if (lexNames !== null && typeof lexNames.length === 'number') {
        for (var li2 = 0; li2 < lexNames.length; li2++) {
          var lk2 = lexNames[li2];
          if (typeof lk2 !== 'string') continue;
          // Only the LEXICAL baseline is skipped: a lexical declaration
          // always comes from user code, and it SHADOWS a same-named
          // baseline global — 'const Math = 42' is a user binding even
          // though the name is in the known set (phase-E review
          // rejection: the known-set skip hid it from the manifest).
          if (reg.lexKnown[lk2]) continue;
          seen[lk2] = true;
          if (lexValueCount > 0) {
            var cur = arguments[3 + li2];
            if (!hasOwnProp.call(reg.lexPrev, lk2)) {
              reg.origins[lk2] = { via: label, at: atMs };
              reg.lexPrev[lk2] = cur;
            } else if (reg.lexPrev[lk2] !== cur && !(reg.lexPrev[lk2] !== reg.lexPrev[lk2] && cur !== cur)) {
              reg.origins[lk2] = { via: label, at: atMs };
              reg.lexPrev[lk2] = cur;
            }
          } else {
            if (reg.origins[lk2] === undefined || reg.prev[lk2] !== undefined) {
              reg.origins[lk2] = { via: label, at: atMs };
              reg.prev[lk2] = undefined;
            }
          }
        }
      }
      for (var gone in reg.origins) {
        if (!seen[gone]) { delete reg.origins[gone]; delete reg.prev[gone]; delete reg.lexPrev[gone]; }
      }
    } catch (e) {}
  }
  function read() {
    try {
      var out = jcreate(null);
      for (var k in reg.origins) {
        var o = reg.origins[k];
        out[k] = { via: o.via, at: o.at };
      }
      // The KNOWN names whose CURRENT value is no longer the baseline:
      // the type token differs from the pristine token, OR the value is
      // no longer SameValue to the ORIGINAL baseline value (reg.baseVal
      // — never updated on attribution) — the manifest's
      // changed-binding detector for overwritten built-ins. A SAME-TYPE
      // overwrite ('Math = { userOwned: true }') is caught by the value
      // identity, which the type token alone cannot see (phase-E review
      // rejection round 6). Computed at READ time (the manifest is
      // rendered under the operation chain), descriptor-based and
      // trap-free like the record pass: an accessor-rebound name is
      // detected through its getter function identity, never invoked.
      var changed = [];
      for (var ck in reg.baseTok) {
        if (!reg.known[ck]) continue;
        var cd;
        try {
          cd = gOPD(g, ck);
        } catch (e) {
          continue;
        }
        if (cd === undefined) continue;
        var cv = hasOwnProp.call(cd, 'value')
          ? cd.value
          : hasOwnProp.call(cd, 'get')
            ? cd.get
            : undefined;
        var ctok = hasOwnProp.call(cd, 'value') ? typeof cd.value : 'accessor';
        var cchanged = ctok !== reg.baseTok[ck];
        if (!cchanged && reg.baseVal && hasOwnProp.call(reg.baseVal, ck)) {
          var cbv = reg.baseVal[ck];
          // SameValue semantics (NaN-stable).
          cchanged = cbv !== cv && !(cbv !== cbv && cv !== cv);
        }
        if (cchanged) changed.push(ck);
      }
      return { evalSeq: reg.evalSeq, origins: out, changed: changed };
    } catch (e) {
      return { evalSeq: 0, origins: Object.create(null), changed: [] };
    }
  }
  reg.record = record;
  reg.read = read;
  if (names !== undefined && names !== null) {
    for (var n = 0; n < names.length; n++) reg.known[names[n]] = true;
  }
  return reg;
})`;

/** Name of the version-marker global the library installs. */
export const GUEST_VERSION_GLOBAL = '__REPL_GUEST_VERSION';

/** Host-callback names the guest library calls (the whole effect surface). */
export const HOST_AGENT = '__host_agent';
export const HOST_CHECKPOINT = '__host_checkpoint';
export const HOST_CONSOLE = '__host_console';
export const HOST_STEER = '__host_agent_steer';

/**
 * Build the injectable library script. `version` is substituted into the
 * source so the version marker and the exported constant can never drift.
 */
export function buildGuestLibrarySource(version: string = GUEST_LIBRARY_VERSION): string {
  return GUEST_LIBRARY_SOURCE.replaceAll('__REPL_GUEST_VERSION__', JSON.stringify(version));
}

/**
 * The library as a plain script (ES2017-level JavaScript, evaluated in the
 * realm with no module system). Written as a single template literal with
 * no interpolation: the guest code is deliberately plain JS (string
 * concatenation, no backticks) so the source is exactly what the VM
 * evaluates. All `\\` escapes below are doubled so the guest code receives
 * the literal escape sequences (`\\n` in the guest source → the guest's
 * `\n`).
 */
const GUEST_LIBRARY_SOURCE = `/*
 * REPL orchestrator guest-side library, version __REPL_GUEST_VERSION__.
 * Evaluated exactly ONCE at VM creation; travels inside snapshots. The
 * four __host_* functions below are the realm's entire effect surface.
 */
(function () {
  'use strict';

  // The realm's REAL global object, captured when the library is
  // evaluated (before any user code runs): the library's own code must
  // keep working when user code SHADOWS a baseline global — a top-level
  // lexical 'const globalThis = 7' is a legitimate user program, and the
  // lexical binding shadows the library's free-variable globalThis at
  // call time, breaking every internal reference (the provenance
  // registry's descriptor reads, the host-function lookups, the $N
  // store, the global installs). Everything below that means "the realm's
  // global object" reads 'g' — the same discipline as the provenance
  // factory's capture (phase-E review rejection round 7).
  var g = globalThis;

  // ────────────────────────────────────────────────────────────────────────
  // Identity and idempotence
  // ────────────────────────────────────────────────────────────────────────

  var VERSION = __REPL_GUEST_VERSION__;
  var SURFACE_KEY = 'repl.guest';
  var VERSION_GLOBAL = '__REPL_GUEST_VERSION';

  // Evaluating this script twice in one realm (e.g. a host bug that
  // re-injects it into a restored snapshot) must never wipe the live
  // registry or the $N counter. If the surface is already installed, this
  // evaluation is a no-op.
  if (g[Symbol.for(SURFACE_KEY)]) return;

  // ────────────────────────────────────────────────────────────────────────
  // Tunables (payload best-effort encoding; the $N store is never truncated)
  // ────────────────────────────────────────────────────────────────────────

  var PAYLOAD_STRING_LIMIT = 4096; // chars per string in the console payload
  var PAYLOAD_ARRAY_LIMIT = 256;   // elements per array in the console payload
  var PAYLOAD_OBJECT_LIMIT = 256;  // keys per object in the console payload
  var PAYLOAD_ENTRY_LIMIT = 64;    // entries per Map/Set in the console payload
  var PAYLOAD_DEPTH_LIMIT = 8;     // nesting depth in the console payload
  var CLONE_DEPTH_LIMIT = 512;     // structuredClone pre-flight nesting bound

  // ────────────────────────────────────────────────────────────────────────
  // Internal state — all of it lives in this closure, so all of it travels
  // inside the snapshot.
  // ────────────────────────────────────────────────────────────────────────

  var state = {
    callSeq: 0,          // monotonic call-id counter ("c1", "c2", ...)
    logSeq: 0,           // monotonic $N counter
    registry: new Map(), // callId -> { id, kind, detail, optionsJson, createdAt, resolve, reject }
    // The eval-await tracking surface (version 0.2.0): the registry
    // entries' 'promise' field maps every registry promise
    // (agent/checkpoint/steer) to its call id — the look-up table
    // '__replAwait' resolves an awaited value against; 'awaitLog' is
    // the chronological record of awaited call
    // ids (the host's top-level-await instrumenter rewrites 'await x'
    // into 'await __replAwait(x)', and the library logs every awaited
    // value that IS one of its registry promises). The log is the
    // 0.2.0-era targeting seam; the 0.3.0 library keeps it for older
    // hosts (surface.awaitLogTake) while the broker's targeting rides
    // the CONTINUATION LEASE (see '__replLease' below).
    awaitLog: [],
    // The CONTINUATION LEASE (version 0.3.0): the token of the eval
    // whose continuation is about to run (set by '__replAwait''s
    // wrap-settling reaction — the job immediately before the eval's
    // continuation segment — and cleared by the host's drain loop
    // after the segment ends). The host reads it between jobs; a job
    // that starts with a lease set IS the armed eval's continuation —
    // the eval-break interrupt's genuine per-eval identity (phase-E
    // review rejection round 5: the signal used to be keyed to settled
    // call ids, so an unawaited sibling '.then' job running before the
    // target's continuation consumed it). Exposed as the writable
    // '__replLease' accessor global (its getter/setter are this
    // closure's — trusted host-installed code, never guest-authored).
    continuationLease: undefined,
  };

  // Captured intrinsics: the registry is the host's settlement table, so
  // its operations must stay immune to guest Map.prototype pollution (a
  // guest that replaces Map.prototype.set must not be able to break
  // settlement or the host's post-restore reconciliation reads).
  var registryGet = Map.prototype.get;
  var registrySet = Map.prototype.set;
  var registryDelete = Map.prototype.delete;
  var registryForEach = Map.prototype.forEach;
  var registrySize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;

  // Captured intrinsics for the $N freeze path and the argument gatherers.
  // This library is evaluated exactly once, at VM creation, BEFORE any
  // guest code runs — so everything captured here is pristine, and a guest
  // that later pollutes a realm global or prototype cannot change what the
  // captured functions do:
  //
  // - nativeStructuredClone is the structured-clone extension's native
  //   function. The $N freezing discipline is what-you-saw-is-what-you-
  //   have: mutation after a log must never change $N. Reading the global
  //   at USE time would let a guest replace it with an aliasing function
  //   (structuredClone = v => v), making $N hold LIVE references instead
  //   of frozen copies (review regression, pinned by test).
  // - arraySlice is a BOUND copy of Array.prototype.slice (created via
  //   Function.prototype.call.bind at installation — both pristine).
  //   console.* and pipeline() gather their arguments through it; a guest
  //   that replaces Array.prototype.slice or Function.prototype.call with
  //   a throwing function must not make console.log (or pipeline) throw —
  //   console.* NEVER throws by contract (review regression, pinned by
  //   test). A bound function performs no property lookups at call time,
  //   so neither replacement can reach it.
  var nativeStructuredClone = g.structuredClone;
  var arraySlice = Function.prototype.call.bind(Array.prototype.slice);

  // The continuation-lease instrumentation's pristine PROMISE intrinsics
  // (phase-E review rejection round 7): \`__replAwait\` /
  // \`__replAwaitIterable\` mirror the awaited value through the realm's
  // ORIGINAL Promise machinery — the captured constructor, the captured
  // bound statics, and the captured \`then\` function value — never the
  // guest-resolvable \`Promise\` global / \`Promise.resolve\` / public
  // \`.then\`. A guest that REPLACES \`Promise.prototype.then\` (the
  // reviewer's repro: the instrumented \`await 40\` returned \`99\` where
  // the native evaluation returned \`40\`) or overwrites \`Promise.resolve\`
  // itself, or SHADOWS \`Promise\` with a top-level lexical, must not
  // change the instrumentation's semantics: the wrapped value mirrors
  // natively and the continuation lease is still set. \`P\` is the SAME
  // object as the realm's \`globalThis.Promise\`, so the statics are bound
  // and the instance method captured as the bare function value at
  // installation — later property replacement cannot reach them.
  var P = Promise;
  var PResolve = P.resolve.bind(P);
  var PReject = P.reject.bind(P);
  var pThen = P.prototype.then;

  // ────────────────────────────────────────────────────────────────────────
  // Small utilities
  // ────────────────────────────────────────────────────────────────────────

  function safeString(value) {
    try {
      return String(value);
    } catch (_err) {
      // String() throws for e.g. objects with a throwing toString/Symbol.toPrimitive.
    }
    try {
      return Object.prototype.toString.call(value);
    } catch (_err) {
      // Even the brand fallback can throw (revoked proxies, all-trap proxies).
    }
    return '[unstringifiable]';
  }

  /**
   * Normalize an arbitrary rejection value into an Error. Hosts may reject
   * with a realm Error, a host Error marshalled into the realm, or a plain
   * { name?, message, code?, recoverable? } object; all of them come out as
   * an Error carrying code/recoverable when present.
   */
  function toError(value) {
    if (value instanceof Error) return value;
    if (value && typeof value === 'object') {
      var err = new Error(typeof value.message === 'string' ? value.message : safeString(value));
      if (typeof value.name === 'string') err.name = value.name;
      if (typeof value.stack === 'string') err.stack = value.stack;
      if (value.code !== undefined) err.code = value.code;
      if (value.recoverable !== undefined) err.recoverable = !!value.recoverable;
      return err;
    }
    return new Error(safeString(value));
  }

  /**
   * A failure is recoverable unless the host said otherwise. Recoverable
   * failures become null slots in parallel()/pipeline(); non-recoverable
   * ones (recoverable: false) propagate and halt the surrounding
   * orchestration. There is NO budget vocabulary in this guest (the
   * roadmap doc deletes it): the recoverable flag is the only signal.
   */
  function isRecoverable(err) {
    return !(err && err.recoverable === false);
  }

  // ────────────────────────────────────────────────────────────────────────
  // The pending-call registry and settlement
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Settle a pending call by id. Idempotent: the first settlement wins; a
   * second settlement of the same id (e.g. the live deferred resolving
   * after the reconciliation surface already settled it, or vice versa)
   * returns false and does nothing. Returns true iff a pending entry was
   * settled.
   */
  function settleCall(callId, outcome, value) {
    var entry = registryGet.call(state.registry, callId);
    if (!entry) return false;
    registryDelete.call(state.registry, callId);
    if (outcome === 'resolve') entry.resolve(value);
    else entry.reject(toError(value));
    return true;
  }

  /**
   * Issue a host call: mint a call id, park {resolve, reject} in the
   * registry, and invoke the host function. The host function may return a
   * thenable (the quickjs-wasi Deferred idiom) — if it does, its settlement
   * is forwarded into the registry. It may also return undefined and settle
   * later purely through the reconciliation surface; both routes are always
   * valid and converge on settleCall.
   *
   * 'detail' is kept VERBATIM in the registry entry (the prompt for agent
   * calls, the question for checkpoints, the action for steering): after a
   * restore the host may need it to re-issue work it lost track of, so it
   * must not be truncated. 'sessionId' is the id the HOST addresses the
   * call by — the founding call id for steering calls (the session being
   * steered), the call's own id otherwise — and 'modelSpec' the agent
   * call's backend-routing spec (null otherwise); both are recorded in the
   * entry so a pending call survives a snapshot/restore with full
   * correlation.
   *
   * 'hostArgs' builds the actual host invocation (each __host_* function
   * has its own argument layout): it receives the host function and the
   * freshly minted id and returns the host result.
   */
  function issueCall(kind, hostFnName, detail, optionsJson, sessionId, modelSpec, hostArgs) {
    var hostFn = g[hostFnName];
    if (typeof hostFn !== 'function') {
      throw new Error(
        hostFnName + ' is not installed — the host must register it before evaluating ' +
          'guest code (and re-register it by name after every snapshot restore)',
      );
    }
    var id = 'c' + ++state.callSeq;
    var resolveFn;
    var rejectFn;
    var promise = new Promise(function (resolve, reject) {
      resolveFn = resolve;
      rejectFn = reject;
    });
    registrySet.call(state.registry, id, {
      id: id,
      kind: kind,
      detail: detail,
      optionsJson: optionsJson === undefined ? null : optionsJson,
      createdAt: Date.now(),
      // The id the host addresses this call by: the founding session id for
      // steering calls, this call's own id for everything else. Recorded so
      // the pending-call manifest never omits the correlation the host
      // needs to settle or re-issue a pending steer after a restore.
      sessionId: sessionId === undefined ? id : sessionId,
      modelSpec: modelSpec === undefined ? null : modelSpec,
      resolve: resolveFn,
      reject: rejectFn,
      // Track the promise for the eval-await attribution ('__replAwait'):
      // the registry entry carries the exact promise the settlement
      // resolves, so awaiting THIS promise (or awaiting it again from a
      // later eval — the "running eval awaiting an earlier binding"
      // case) is attributable by identity. The 'promise' field is never
      // exposed by the pending() manifest (it builds explicit fields) —
      // it is closure-internal bookkeeping.
      promise: promise,
    });
    var returned;
    try {
      returned = hostArgs(hostFn, id);
    } catch (err) {
      // Synchronous host refusal (e.g. a per-call cap enforced at dispatch).
      settleCall(id, 'reject', err);
      return { id: id, promise: promise };
    }
    if (returned && typeof returned.then === 'function') {
      // Adopt the host-returned thenable (the quickjs-wasi Deferred
      // idiom) through the CAPTURED pristine Promise surface
      // ('PResolve'/'pThen' — phase-E review rejection round 7): the
      // guest-visible 'Promise.resolve(returned).then(...)' broke under
      // a replaced 'Promise.prototype.then' — the reactions were never
      // registered, so a settled host call NEVER reached the registry
      // and the awaiting eval stayed pending forever (the reviewer's
      // repro: replacing 'Promise.prototype.then' made the
      // instrumented 'await 40' return '99'; the SAME mutation also
      // silently killed every settlement through this forwarding).
      pThen.call(
        PResolve(returned),
        function (value) { settleCall(id, 'resolve', value); },
        function (err) { settleCall(id, 'reject', err); },
      );
    }
    return { id: id, promise: promise };
  }

  // ────────────────────────────────────────────────────────────────────────
  // agent() — the delegation primitive, and the live handle
  // ────────────────────────────────────────────────────────────────────────

  /** Shallow-copy options (plain data by construction — they cross the
   *  bridge as JSON). */
  function normalizeAgentOptions(options) {
    if (options === undefined || options === null) return undefined;
    if (typeof options !== 'object') {
      throw new TypeError('agent options must be an object');
    }
    var out = {};
    var keys = Object.keys(options);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = options[keys[i]];
    return out;
  }

  function issueAgentCall(modelSpec, task, options) {
    if (typeof modelSpec !== 'string') {
      throw new TypeError(
        'agent(modelSpec, task, options?) needs a model spec string (e.g. "pi/deepseek-v4-flash-max")',
      );
    }
    if (typeof task !== 'string') {
      throw new TypeError('agent(modelSpec, task, options?) needs a task string');
    }
    var normalized = normalizeAgentOptions(options);
    // Options cross the bridge as JSON: plain data by construction, one
    // flat, unambiguous decoding host-side (functions or cycles in options
    // would be meaningless host-side).
    var optionsJson = normalized === undefined ? undefined : JSON.stringify(normalized);
    // The registry entry records the model spec verbatim so a restore can
    // re-issue the call against the same backend routing. The host
    // receives (callId, modelSpec, task, optionsJson).
    return issueCall('agent', '__host_agent', task, optionsJson, undefined, modelSpec, function (hostFn, id) {
      return hostFn(id, modelSpec, task, optionsJson);
    });
  }

  /**
   * A steering operation on a live agent handle: mint a registry entry
   * (kind "steer") and call __host_agent_steer. The returned promise
   * resolves with what actually happened — the host settles with the
   * steering outcome (live injection where the backend supports the
   * _session/steering extension, queued-for-next-turn delivery where it
   * doesn't), mirroring the outcome values acp-agents surfaces in its
   * steering events. Nothing is hidden and nothing hard-errors: the
   * orchestrator can tell urgency delivery from queued delivery and adapt.
   *
   * The registry entry is keyed by THIS call's own minted id (the
   * settlement key), while 'sessionId' records the FOUNDING call id — the
   * session being steered — so a pending steer is snapshot-reconcilable:
   * the host sees both ids at dispatch and the pending manifest reports
   * both, letting it durably settle (by registry id) or re-issue (to the
   * session) a steer after a restore.
   */
  function steerCall(foundingCallId, action, prompt, options) {
    try {
      var payloadJson;
      if (action === 'cancel') {
        payloadJson = null;
      } else {
        if (typeof prompt !== 'string') {
          throw new TypeError('handle.' + action + '(prompt, options?) needs a prompt string');
        }
        var normalized = normalizeAgentOptions(options);
        payloadJson = JSON.stringify({ prompt: prompt, options: normalized === undefined ? {} : normalized });
      }
      return issueCall('steer', '__host_agent_steer', action, payloadJson, foundingCallId, null, function (hostFn, id) {
        // The host receives BOTH ids: the operation's own registry id (the
        // settlement key — the host's live bookkeeping keys by it) and the
        // founding call id (the session being steered — the dispatch and
        // post-restore re-issue target).
        return hostFn(id, foundingCallId, action, payloadJson);
      }).promise;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * Run one worker agent to completion and resolve with its result (final
   * text, or the schema-validated object when options.schema is given —
   * result shaping is host policy). 'modelSpec' is the backend-routing
   * spec ("pi/deepseek-v4-flash-max"); 'task' is the worker's prompt;
   * 'options' (structured-output schema, cwd, backend config) cross the
   * bridge as JSON. Recoverable worker failures reject with an Error
   * whose recoverable is not false.
   *
   * The returned promise IS the live handle: it may sit in a REPL variable
   * across turns (and across snapshot/restore) and be awaited, or driven
   * with the handle methods followUp/steer/cancel (own, non-enumerable
   * properties of the promise; 'id' carries the stable call id).
   */
  function agent(modelSpec, task, options) {
    try {
      var call = issueAgentCall(modelSpec, task, options);
      var handle = call.promise;
      Object.defineProperties(handle, {
        id: {
          value: call.id,
          writable: false,
          enumerable: false,
          configurable: false,
        },
        followUp: {
          value: function (nextPrompt, nextOptions) {
            return steerCall(call.id, 'followUp', nextPrompt, nextOptions);
          },
          writable: false,
          enumerable: false,
          configurable: false,
        },
        steer: {
          value: function (nextPrompt, nextOptions) {
            return steerCall(call.id, 'steer', nextPrompt, nextOptions);
          },
          writable: false,
          enumerable: false,
          configurable: false,
        },
        cancel: {
          value: function () {
            return steerCall(call.id, 'cancel', undefined, undefined);
          },
          writable: false,
          enumerable: false,
          configurable: false,
        },
      });
      return handle;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // checkpoint() — the data plane interrupting the intent plane
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Raise a question from a running orchestration up into the
   * conversation. The returned promise resolves with the user's answer,
   * delivered by the host whenever it arrives — possibly turns later,
   * possibly after a snapshot/restore cycle (the pending entry travels in
   * the registry like any agent call). 'options' (e.g. { choices, default })
   * are host policy, passed through as JSON.
   */
  function checkpoint(question, options) {
    try {
      if (typeof question !== 'string') {
        throw new TypeError('checkpoint(question, options?) needs a question string');
      }
      var optionsJson =
        options === undefined || options === null ? undefined : JSON.stringify(options);
      return issueCall('checkpoint', '__host_checkpoint', question, optionsJson, undefined, null, function (hostFn, id) {
        return hostFn(id, question, optionsJson);
      }).promise;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * Deliver the user's answer for a pending checkpoint, by call id — the
   * orchestrator calls this from an eval after the user replies in the
   * conversation. Answering is a root-mediated act: the host never captures
   * user text as an answer; the answer enters the data plane only through
   * this call (the __host_checkpoint answer mode: the same host function
   * the question left through, with the JSON-encoded answer as a fourth
   * argument).
   *
   * Returns true iff a checkpoint with that id was pending when the call
   * was made; false for unknown or already-answered ids. Delivery is
   * first-wins idempotent (the settlement rule every call follows), and
   * the checkpoint's promise resolves with 'value' during the same
   * evaluation's settlement flush. No registry entry is minted: nothing
   * new pends, and a snapshot can never capture an answer in flight.
   */
  checkpoint.answer = function answer(callId, value) {
    if (typeof callId !== 'string' || callId.length === 0) {
      throw new TypeError('checkpoint.answer(callId, value) needs a call id string (e.g. "c3")');
    }
    if (typeof g.__host_checkpoint !== 'function') {
      throw new Error(
        '__host_checkpoint is not installed — the host must register it before evaluating ' +
          'guest code (and re-register it by name after every snapshot restore)',
      );
    }
    // The answer crosses the bridge as JSON (plain data by construction);
    // undefined normalizes to null so the mode marker — a PRESENT fourth
    // argument — is unambiguous.
    var answerJson;
    try {
      answerJson = JSON.stringify(value === undefined ? null : value);
    } catch (_err) {
      throw new TypeError(
        'checkpoint.answer(callId, value): value must be JSON-serializable',
      );
    }
    return !!g.__host_checkpoint(callId, undefined, undefined, answerJson);
  };

  // ────────────────────────────────────────────────────────────────────────
  // Combinators — pure JavaScript over agent(). No host effects of their
  // own; every one of them bottoms out in agent() (or in caller-supplied
  // thunks). Semantics follow packages/workflows/src/dsl.d.ts, adapted for
  // the persistent REPL (no run, no journal, no phases).
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Run an array of THUNKS concurrently; resolve to their results in input
   * order. Pass functions, not promises: parallel([() => agent("a"), ...]).
   * A recoverable failure becomes null in its slot (reported via
   * console.warn); a non-recoverable one rejects the whole parallel().
   */
  async function parallel(thunks) {
    if (!Array.isArray(thunks)) {
      throw new TypeError('parallel() expects an array of functions');
    }
    if (thunks.some(function (t) { return typeof t !== 'function'; })) {
      throw new TypeError(
        'parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)',
      );
    }
    return Promise.all(
      thunks.map(async function (thunk, index) {
        try {
          return await thunk();
        } catch (error) {
          var err = toError(error);
          if (!isRecoverable(err)) throw err;
          // Closure-internal reference (not the global): sabotaging
          // console.warn must not be able to alter parallel()'s semantics.
          consoleObject.warn('parallel[' + index + '] failed: ' + err.message);
          return null;
        }
      }),
    );
  }

  /**
   * Map 'items' through one or more sequential async 'stages', concurrently
   * across items. Each stage receives (prev, original, index). Resolves to
   * the final value per item; a recoverable per-item failure yields null
   * for that item, a non-recoverable one rejects the whole pipeline().
   */
  async function pipeline(items) {
    // Captured intrinsic (see the captured-intrinsics note): guest
    // pollution of Array.prototype.slice / Function.prototype.call must
    // not be able to break the combinators.
    var stages = arraySlice(arguments, 1);
    if (!Array.isArray(items)) {
      throw new TypeError('pipeline() expects an array as the first argument');
    }
    if (stages.some(function (s) { return typeof s !== 'function'; })) {
      throw new TypeError(
        'pipeline() stages must be functions: pipeline(items, item => ..., result => ...)',
      );
    }
    return Promise.all(
      items.map(async function (item, index) {
        var value = item;
        for (var i = 0; i < stages.length; i++) {
          try {
            value = await stages[i](value, item, index);
          } catch (error) {
            var err = toError(error);
            if (!isRecoverable(err)) throw err;
            consoleObject.warn('pipeline[' + index + '] failed: ' + err.message);
            return null;
          }
        }
        return value;
      }),
    );
  }

  var VERIFY_SCHEMA = {
    type: 'object',
    properties: { real: { type: 'boolean' }, reason: { type: 'string' } },
    required: ['real'],
  };

  /**
   * Adversarial verification panel: 'reviewers' workers vote on whether
   * 'item' is real/correct; passes when the share voting real meets
   * 'threshold'. Reviewers that fail recoverably are dropped from the vote
   * (they are neither yes nor no).
   *
   * The DSL options are EXACTLY { reviewers, threshold, lens }
   * (packages/workflows/src/dsl.d.ts) — there is no per-call model option
   * (an invented opts.model was removed in review; the dsl.d.ts verify
   * lets reviewers inherit the run's default model, so the spawned
   * reviewers always route through the reserved ''default'' sentinel,
   * which host policy routes to its configured default backend).
   */
  async function verify(item, opts) {
    opts = opts || {};
    var reviewers = Math.max(1, opts.reviewers !== undefined ? opts.reviewers : 2);
    var threshold = opts.threshold !== undefined ? opts.threshold : 0.5;
    var lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : [];
    var modelSpec = 'default';
    var claim;
    if (typeof item === 'string') {
      claim = item;
    } else {
      try {
        claim = JSON.stringify(item);
      } catch (_err) {
        // Non-serializable item (circular, hostile) — degrade to a safe
        // string rather than failing the whole panel.
        claim = safeString(item);
      }
    }
    var votes = (
      await parallel(
        Array.from({ length: reviewers }, function (_v, i) {
          return function () {
            return agent(
              modelSpec,
              'Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.' +
                (lenses.length ? ' Focus lens: ' + lenses[i % lenses.length] + '.' : '') +
                '\\n\\n' + claim,
              { label: 'verify ' + (i + 1), schema: VERIFY_SCHEMA },
            );
          };
        }),
      )
    ).filter(Boolean);
    var realCount = votes.filter(function (v) { return v && v.real; }).length;
    return {
      real: votes.length > 0 && realCount / votes.length >= threshold,
      realCount: realCount,
      total: votes.length,
      votes: votes,
    };
  }

  var JUDGE_SCHEMA = {
    type: 'object',
    properties: { score: { type: 'number' }, reason: { type: 'string' } },
    required: ['score'],
  };

  /**
   * LLM-judge panel: score each candidate in 'attempts' with 'judges'
   * graders against 'rubric' and return the highest mean-scoring candidate
   * as { index, attempt, score, judgments } (stable tie-break by index).
   * The DSL options are EXACTLY { judges, rubric }
   * (packages/workflows/src/dsl.d.ts) — no per-call model option; the
   * spawned graders route through the reserved ''default'' sentinel
   * (host-routed, same decision as verify).
   */
  async function judgePanel(attempts, opts) {
    opts = opts || {};
    var judges = Math.max(1, opts.judges !== undefined ? opts.judges : 3);
    var rubric = opts.rubric !== undefined ? opts.rubric : 'overall quality and correctness';
    var modelSpec = 'default';
    var scored = (
      await parallel(
        (Array.isArray(attempts) ? attempts : []).map(function (att, idx) {
          return async function () {
            var text = typeof att === 'string' ? att : JSON.stringify(att);
            var js = (
              await parallel(
                Array.from({ length: judges }, function (_v, j) {
                  return function () {
                    return agent(
                      modelSpec,
                      'Score this candidate from 0 to 1 on: ' + rubric +
                        '. Reply with the score.\\n\\nCandidate:\\n' + text,
                      { label: 'judge ' + (idx + 1) + '.' + (j + 1), schema: JUDGE_SCHEMA },
                    );
                  };
                }),
              )
            ).filter(Boolean);
            var score = js.length
              ? js.reduce(function (s, v) { return s + (Number(v && v.score) || 0); }, 0) / js.length
              : 0;
            return { index: idx, attempt: att, score: score, judgments: js };
          };
        }),
      )
    ).filter(Boolean);
    // Highest mean score; stable tie-break by input index.
    var best = scored[0];
    for (var i = 0; i < scored.length; i++) {
      var s = scored[i];
      if (s.score > best.score || (s.score === best.score && s.index < best.index)) best = s;
    }
    return best;
  }

  /** Dedupe key default: JSON identity, degrading to a safe string for
   *  non-serializable items (a circular item must not kill the loop). */
  function defaultKey(x) {
    try {
      return JSON.stringify(x);
    } catch (_err) {
      return safeString(x);
    }
  }

  /**
   * Repeatedly invoke round(i), collecting fresh (deduped by 'key') items
   * until it yields nothing 'consecutiveEmpty' rounds in a row (or
   * 'maxRounds' is hit). Returns every unique item gathered. Round
   * failures propagate (recoverable ones are not nulled — a round is the
   * loop's contract, not a slot).
   */
  async function loopUntilDry(opts) {
    if (!opts || typeof opts.round !== 'function') {
      throw new TypeError('loopUntilDry requires { round: (i) => items[] }');
    }
    var key = opts.key || defaultKey;
    var consecutiveEmpty = Math.max(1, opts.consecutiveEmpty !== undefined ? opts.consecutiveEmpty : 2);
    var maxRounds = opts.maxRounds !== undefined ? opts.maxRounds : 50;
    var seen = new Set();
    var all = [];
    var dry = 0;
    for (var r = 0; r < maxRounds && dry < consecutiveEmpty; r++) {
      var items = (await opts.round(r)) || [];
      var fresh = (Array.isArray(items) ? items : []).filter(function (x) {
        return x !== null && x !== undefined && !seen.has(key(x));
      });
      if (!fresh.length) {
        dry++;
        continue;
      }
      dry = 0;
      for (var i = 0; i < fresh.length; i++) {
        var k = key(fresh[i]);
        if (seen.has(k)) continue; // within-round duplicates stay deduped
        seen.add(k);
        all.push(fresh[i]);
      }
    }
    return all;
  }

  /**
   * Bounded retry: call thunk(attempt) up to 'attempts' times, stopping
   * early once until(result) holds. Without 'until' the FIRST result is
   * accepted — exactly the repository DSL behavior
   * (workflow-engine/src/workflow.ts: if (!opts.until || opts.until(last))
   * return last); the final return last only runs when an 'until'
   * predicate was given and never held (attempts exhausted — the caller
   * inspects the last result). No backoff: there is no timer in the realm
   * and delegation retries gain nothing from delay.
   */
  async function retry(thunk, opts) {
    opts = opts || {};
    var attempts = Math.max(1, opts.attempts !== undefined ? opts.attempts : 3);
    var last;
    for (var i = 0; i < attempts; i++) {
      last = await thunk(i);
      if (!opts.until || opts.until(last)) return last;
    }
    return last;
  }

  /**
   * Validation gate: call thunk(feedback, attempt), validate the result,
   * and feed the validator's feedback into the next attempt until it
   * passes or 'attempts' run out. The verdict may be a boolean or
   * { ok, feedback? }. Returns { ok, value, verdict, attempts }.
   */
  async function gate(thunk, validator, opts) {
    opts = opts || {};
    var attempts = Math.max(1, opts.attempts !== undefined ? opts.attempts : 3);
    var feedback;
    var last;
    var lastVerdict = null;
    for (var i = 0; i < attempts; i++) {
      last = await thunk(feedback, i);
      lastVerdict = await validator(last);
      var accepted =
        typeof lastVerdict === 'boolean' ? lastVerdict : Boolean(lastVerdict && lastVerdict.ok);
      if (accepted) {
        return {
          ok: true,
          value: last,
          verdict: lastVerdict === undefined ? null : lastVerdict,
          attempts: i + 1,
        };
      }
      feedback =
        typeof lastVerdict === 'boolean'
          ? undefined
          : lastVerdict
            ? lastVerdict.feedback
            : undefined; // fed into the next attempt
    }
    return {
      ok: false,
      value: last,
      verdict: lastVerdict === undefined ? null : lastVerdict,
      attempts: attempts,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // The bridge: console -> $N store -> __host_console
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Freeze a copy of a logged value into the $N store: what-you-saw-is-
   * what-you-have. Prefers structuredClone — the quickjs-wasi prebuilt
   * extension's native function, CAPTURED at installation (a guest that
   * replaces the globalThis binding with an aliasing function must not
   * make $N hold live references; see the captured-intrinsics note) —
   * and falls back to a guest-side deep copy that substitutes typed
   * markers for non-cloneables instead of throwing.
   *
   * DEPTH SAFETY: on WASI, deep recursion is a fatal wasm trap, not a
   * catchable exception (agentprism/quickjs-wasi#2) — and that applies to
   * the native structuredClone's own C recursion too (observed hard-crash
   * around 10k nesting). So the fallback copy is fully ITERATIVE
   * (explicit-stack, no recursion at any depth), and structuredClone is
   * only attempted after an iterative pre-flight confirms the graph's
   * first-visit nesting stays within CLONE_DEPTH_LIMIT — far below the
   * observed native crash threshold. Deeper (or hostile, or non-cloneable)
   * graphs take the iterative fallback, which has NO depth bound of its
   * own (it is bounded only by VM memory; an allocation failure surfaces
   * as an "unfreezable" marker, never a throw).
   */
  /**
   * Values the structured-clone algorithm cannot carry. Checked by the
   * clone PRE-FLIGHT on every reachable node of the logged graph, not
   * just the root: the extension's clone silently normalizes weak
   * collections to empty plain objects at ANY depth, but the $N store
   * must keep typed markers for them (what-you-saw-is-what-you-have — an
   * orchestrator must be able to tell a WeakMap from a deleted property,
   * even nested inside an object, array, or Map/Set). Functions, symbols
   * and promises throw in structuredClone anyway; the marker fallback
   * handles them identically.
   */
  function isUncloneable(value) {
    var t = typeof value;
    if (t === 'function' || t === 'symbol') return true;
    if (t !== 'object' || value === null) return false;
    try {
      if (value instanceof Promise) return true;
      if (value instanceof WeakMap) return true;
      if (value instanceof WeakSet) return true;
      if (typeof WeakRef === 'function' && value instanceof WeakRef) return true;
    } catch (_err) {
      // instanceof probing threw (revoked/all-trap proxy) — treat as
      // uncloneable; the fallback's own guards produce a marker.
      return true;
    }
    return false;
  }

  function freezeValue(value) {
    if (
      typeof nativeStructuredClone === 'function' &&
      clonePreflight(value, CLONE_DEPTH_LIMIT)
    ) {
      try {
        return nativeStructuredClone(value);
      } catch (_err) {
        // Graph contains a non-cloneable — fall through to the marker copy.
      }
    }
    try {
      return safeDeepCopy(value);
    } catch (_err) {
      return unclonableMarker('unfreezable', safeString(value));
    }
  }

  /** Typed marker stored in place of a value that cannot be copied. */
  function unclonableMarker(type, description) {
    var m = { __unclonable__: type };
    if (description !== undefined) m.description = description;
    return m;
  }

  /**
   * Iterative (explicit-stack) pre-flight that answers the two questions
   * structuredClone cannot answer safely, in one walk over the reachable
   * graph: is the first-visit nesting within 'limit', AND does the graph
   * contain ANY uncloneable value (function, symbol, promise, weak
   * collection) anywhere — root or nested? A 'false' routes the value to
   * the marker-copy fallback, which substitutes typed markers at every
   * depth instead of normalizing (or throwing). Cycles/shared refs are
   * handled with a visited set — which also mirrors structuredClone's own
   * memoization, so this bounds ITS recursion depth. Any throw during
   * traversal (revoked or all-trap proxies, hostile getters) means "not
   * structuredClone-safe".
   */
  function clonePreflight(root, limit) {
    try {
      if (root === null || typeof root !== 'object') return true;
      var visited = new Set();
      var stack = [{ v: root, d: 1 }];
      while (stack.length) {
        var frame = stack.pop();
        if (frame.d > limit) return false;
        var v = frame.v;
        if (visited.has(v)) continue;
        visited.add(v);
        // Nested uncloneables — including weak collections — route the
        // whole graph to the marker-copy fallback: the clone extension
        // silently normalizes them to {} at any depth (review
        // regression: the root-only check let nested WeakMap/WeakSet/
        // WeakRef through as empty plain objects).
        if (isUncloneable(v)) return false;
        var children = [];
        if (v instanceof Date || v instanceof RegExp ||
            v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
          continue; // leaves
        } else if (v instanceof Map) {
          v.forEach(function (val, key) { children.push(key, val); });
        } else if (v instanceof Set) {
          v.forEach(function (val) { children.push(val); });
        } else if (Array.isArray(v)) {
          for (var i = 0; i < v.length; i++) children.push(v[i]);
        } else {
          var ks = Object.keys(v);
          for (var j = 0; j < ks.length; j++) children.push(v[ks[j]]);
        }
        for (var c = 0; c < children.length; c++) {
          var child = children[c];
          if (child !== null && typeof child === 'object' && !visited.has(child)) {
            stack.push({ v: child, d: frame.d + 1 });
          }
        }
      }
      return true;
    } catch (_err) {
      return false;
    }
  }

  /**
   * Deep-copy fallback for freezeValue — ITERATIVE, driven by an explicit
   * task stack, so arbitrary nesting depth cannot touch the (fatal-on-WASI)
   * call stack. Preserves cycles and shared references (via 'seen'), copies
   * Date/RegExp/Map/Set/Error/ArrayBuffer/typed arrays structurally, keeps
   * own enumerable string-keyed properties of plain objects (matching
   * structuredClone's property selection), and substitutes typed markers
   * for functions, promises, symbols, and weak collections. Hostile
   * getters/proxies cannot make it throw: every property read and every
   * container fill is individually guarded.
   */
  function copyNode(value, tasks, seen) {
    if (value === null) return value;
    var t = typeof value;
    if (t === 'number' || t === 'string' || t === 'boolean' ||
        t === 'undefined' || t === 'bigint') {
      return value;
    }
    if (t === 'symbol') {
      return unclonableMarker('symbol', safeString(value.description));
    }
    if (t === 'function') {
      var fnName = '(anonymous)';
      try {
        fnName = value.name || '(anonymous)';
      } catch (_err) {
        // A proxy-of-function with a throwing get trap.
      }
      return unclonableMarker('function', fnName);
    }
    // Objects: shared references and cycles map to the same copy.
    if (seen.has(value)) return seen.get(value);
    try {
      if (value instanceof Promise) return unclonableMarker('promise');
      if (value instanceof WeakMap) return unclonableMarker('weakmap');
      if (value instanceof WeakSet) return unclonableMarker('weakset');
      if (typeof WeakRef === 'function' && value instanceof WeakRef) {
        return unclonableMarker('weakref');
      }
      if (value instanceof Date) return new Date(value.getTime());
      if (value instanceof RegExp) return new RegExp(value.source, value.flags);
      if (value instanceof ArrayBuffer) return value.slice(0);
      if (ArrayBuffer.isView(value)) {
        if (value instanceof DataView) {
          return new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength);
        }
        return value.slice(); // typed arrays: slice() copies
      }
      var shell;
      if (value instanceof Error) {
        shell = new Error(value.message);
        shell.name = value.name;
        if (typeof value.stack === 'string') shell.stack = value.stack;
        seen.set(value, shell);
        tasks.push({ kind: 'props', src: value, dst: shell });
        return shell;
      }
      if (value instanceof Map) {
        shell = new Map();
        seen.set(value, shell);
        tasks.push({ kind: 'map', src: value, dst: shell });
        return shell;
      }
      if (value instanceof Set) {
        shell = new Set();
        seen.set(value, shell);
        tasks.push({ kind: 'set', src: value, dst: shell });
        return shell;
      }
      if (Array.isArray(value)) {
        shell = new Array(value.length);
        seen.set(value, shell);
        tasks.push({ kind: 'array', src: value, dst: shell });
        return shell;
      }
      // Anything else (plain objects, class instances, proxies): copy own
      // enumerable string-keyed properties onto a plain object. Prototypes
      // are not preserved — the same normalization structuredClone applies.
      shell = {};
      seen.set(value, shell);
      tasks.push({ kind: 'props', src: value, dst: shell });
      return shell;
    } catch (err) {
      // instanceof / brand probing threw (revoked or all-trap proxy).
      return unclonableMarker('unfreezable', safeString(err));
    }
  }

  function fillTask(task, tasks, seen) {
    var src = task.src;
    var dst = task.dst;
    if (task.kind === 'map') {
      src.forEach(function (v, k) {
        dst.set(copyNode(k, tasks, seen), copyNode(v, tasks, seen));
      });
      return;
    }
    if (task.kind === 'set') {
      src.forEach(function (v) {
        dst.add(copyNode(v, tasks, seen));
      });
      return;
    }
    if (task.kind === 'array') {
      for (var i = 0; i < src.length; i++) {
        try {
          dst[i] = copyNode(src[i], tasks, seen);
        } catch (err) {
          dst[i] = unclonableMarker('thrown', safeString(err));
        }
      }
      return;
    }
    // "props"
    var keys;
    try {
      keys = Object.keys(src);
    } catch (err) {
      // A proxy's ownKeys trap threw — record the fact instead of failing.
      dst.__unclonable__ = 'thrown';
      dst.description = safeString(err);
      return;
    }
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      try {
        dst[k] = copyNode(src[k], tasks, seen);
      } catch (err) {
        // A getter (or proxy get trap) threw.
        dst[k] = unclonableMarker('thrown', safeString(err));
      }
    }
  }

  function safeDeepCopy(root) {
    var seen = new Map();
    var tasks = [];
    var result = copyNode(root, tasks, seen);
    while (tasks.length) {
      var task = tasks.pop();
      try {
        fillTask(task, tasks, seen);
      } catch (err) {
        // Container enumeration itself threw mid-fill (hostile iterator,
        // fake Map/Set brand): record on the partial copy and move on.
        try {
          task.dst.__unclonable__ = 'thrown';
          task.dst.description = safeString(err);
        } catch (_err) {
          // dst not expando-able — nothing more to record.
        }
      }
    }
    return result;
  }

  /**
   * Best-effort JSON-safe encoding of a (frozen) value for the console
   * payload. This is a CONVENIENCE channel for hosts without a previewer —
   * the authoritative channel is the '$N' refs, which the host previews via
   * trap-free introspection. Strings/arrays/objects are capped (the full
   * value always lives untruncated in $N); non-JSON values become tagged
   * wrappers: { __undefined__ }, { __bigint__ }, { __nonfinite__ },
   * { __date__ }, { __regexp__ }, { __error__ }, { __map__ }, { __set__ },
   * { __binary__ }, { __cycle__ }, { __depth__ }.
   */
  function jsonSafe(value, depth, seen) {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.length > PAYLOAD_STRING_LIMIT) {
        return value.slice(0, PAYLOAD_STRING_LIMIT) +
          '…[+' + (value.length - PAYLOAD_STRING_LIMIT) + ' chars; full value in $N]';
      }
      return value;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : { __nonfinite__: String(value) };
    }
    if (typeof value === 'bigint') return { __bigint__: value.toString() };
    if (typeof value === 'undefined') return { __undefined__: true };
    // DEFENSIVE ONLY — unreachable in practice: jsonSafe consumes freezeValue
    // output, where symbols/functions/promises were already replaced by
    // { __unclonable__ } markers. Kept so a future caller of jsonSafe on
    // unfrozen values cannot make it throw.
    if (typeof value === 'symbol') return { __symbol__: safeString(value.description) };
    if (typeof value === 'function') return { __function__: value.name || '(anonymous)' };
    // Objects.
    if (seen.has(value)) return { __cycle__: true };
    if (depth >= PAYLOAD_DEPTH_LIMIT) return { __depth__: true };
    seen.add(value);
    try {
      if (value instanceof Date) return { __date__: value.toISOString() };
      if (value instanceof RegExp) return { __regexp__: String(value) };
      // DEFENSIVE ONLY — see the symbol/function note above.
      if (value instanceof Promise) return { __promise__: true };
      if (value instanceof Error) {
        return {
          __error__: true,
          name: value.name,
          message: jsonSafe(value.message, depth + 1, seen),
        };
      }
      if (value instanceof ArrayBuffer) {
        return { __binary__: 'ArrayBuffer', byteLength: value.byteLength };
      }
      if (ArrayBuffer.isView(value)) {
        return {
          __binary__: value.constructor && value.constructor.name ? value.constructor.name : 'TypedArray',
          byteLength: value.byteLength,
        };
      }
      if (value instanceof Map) {
        var mapEntries = [];
        var mTruncated = 0;
        value.forEach(function (v, k) {
          if (mapEntries.length < PAYLOAD_ENTRY_LIMIT) {
            mapEntries.push([jsonSafe(k, depth + 1, seen), jsonSafe(v, depth + 1, seen)]);
          } else {
            mTruncated++;
          }
        });
        var mapOut = { __map__: mapEntries };
        if (mTruncated) mapOut.__truncated__ = mTruncated;
        return mapOut;
      }
      if (value instanceof Set) {
        var setEntries = [];
        var sTruncated = 0;
        value.forEach(function (v) {
          if (setEntries.length < PAYLOAD_ENTRY_LIMIT) {
            setEntries.push(jsonSafe(v, depth + 1, seen));
          } else {
            sTruncated++;
          }
        });
        var setOut = { __set__: setEntries };
        if (sTruncated) setOut.__truncated__ = sTruncated;
        return setOut;
      }
      if (Array.isArray(value)) {
        var n = Math.min(value.length, PAYLOAD_ARRAY_LIMIT);
        var arrOut = new Array(n);
        for (var i = 0; i < n; i++) arrOut[i] = jsonSafe(value[i], depth + 1, seen);
        if (value.length > n) arrOut.push({ __truncated__: value.length - n });
        return arrOut;
      }
      var objOut = {};
      var keys = Object.keys(value);
      var kn = Math.min(keys.length, PAYLOAD_OBJECT_LIMIT);
      for (var j = 0; j < kn; j++) objOut[keys[j]] = jsonSafe(value[keys[j]], depth + 1, seen);
      if (keys.length > kn) objOut.__truncated_keys__ = keys.length - kn;
      return objOut;
    } finally {
      seen.delete(value);
    }
  }

  /**
   * The guest half of the bridge. For every argument: freeze a copy, store
   * it as the next real '$N' global, and forward
   * { refs: ["$14", ...], args: [<json-safe best effort>, ...] } to
   * __host_console as a JSON string. console.* NEVER throws — a broken
   * value or a missing/failing host sink must not take down guest code.
   */
  function emitLog(level, args) {
    try {
      var refs = [];
      var payloadArgs = [];
      // Every argument is processed under its OWN guard: one hostile value
      // must never drop the whole log call, orphan sibling $N slots, or
      // suppress the host event — it degrades to a typed marker instead.
      for (var i = 0; i < args.length; i++) {
        var frozen;
        try {
          frozen = freezeValue(args[i]);
        } catch (_err) {
          frozen = unclonableMarker('unfreezable', '[unstringifiable]');
        }
        var n = ++state.logSeq;
        // Real realm globals, writable: the $N store is the agent's own
        // workspace — it may slice, transform, or delete entries.
        g['$' + n] = frozen;
        refs.push('$' + n);
        var encoded;
        try {
          encoded = jsonSafe(frozen, 0, new Set());
        } catch (_err) {
          encoded = unclonableMarker('unfreezable');
        }
        payloadArgs.push(encoded);
      }
      if (typeof g.__host_console === 'function') {
        g.__host_console(level, JSON.stringify({ refs: refs, args: payloadArgs }));
      }
    } catch (_err) {
      // Deliberately swallowed: the bridge is best-effort by contract.
    }
  }

  var consoleObject = {};
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    consoleObject[level] = function () {
      // Captured intrinsic (see the captured-intrinsics note): the
      // bridge contract is console.* NEVER throws, and a guest that
      // replaces Array.prototype.slice (or Function.prototype.call) with
      // a throwing function must not be able to break it (review
      // regression, pinned by test).
      emitLog(level, arraySlice(arguments));
    };
  });
  // Method-level sabotage protection: the console global is non-writable
  // (installGlobal), and the OBJECT is frozen so its methods cannot be
  // reassigned or deleted either — combinator diagnostics (parallel/
  // pipeline warn on swallowed failures) always reach the bridge.
  Object.freeze(consoleObject);

  // ────────────────────────────────────────────────────────────────────────
  // The eval-await tracking: '__replAwait' — the global the host's
  // top-level-await instrumenter inserts around every top-level 'await'
  // ('await x' → 'await __replAwait(x, TOKEN)' — the 0.3.0 form; the
  // 0.2.0 host inserted no token). With a TOKEN the awaited value is
  // WRAPPED in a fresh promise: the wrap's settling reaction — the job
  // that runs IMMEDIATELY BEFORE the eval's continuation segment (the
  // reaction is registered at the await, so earlier-registered
  // reactions — an unawaited sibling's '.then' — run first) — sets the
  // CONTINUATION LEASE to the eval's token. The host's drain loop reads
  // the lease between jobs: the segment starts with the lease set (the
  // eval-break interrupt's genuine continuation identity — it can only
  // fire while THIS eval's continuation executes) and the host clears
  // it after the segment ends. The wrap also makes INDIRECT awaits
  // targetable — 'await Promise.all([q])' wraps the combinator's
  // promise, and its settlement queues the eval's continuation exactly
  // like a direct call's: the identity is the promise graph, not a
  // logged call-id list (phase-E review rejection round 5: the 0.2.0
  // log refused indirect waits). The 0.2.0 no-token form passes the
  // value through and logs registry promises (an older host still
  // drives the log). NEVER throws: a wrap failure (guest promise
  // sabotage) degrades to the unwrapped value, so guest semantics are
  // preserved either way.
  // ────────────────────────────────────────────────────────────────────────

  function setContinuationLease(token) {
    state.continuationLease = token;
  }

  function replAwait(value, token) {
    try {
      if (typeof token === 'string' && token.length > 0) {
        // The 0.3.0 continuation-lease form: wrap the awaited value in
        // a fresh promise. The CONTINUATION LEASE is set by a reaction
        // registered on the WRAPPER itself — BEFORE the await machinery
        // registers its own reaction on the wrapper (the machinery's
        // registration happens at the await site, after this function
        // returns). The wrapper's settlement therefore queues the
        // lease-setting job IMMEDIATELY BEFORE the machinery job that
        // runs the eval's continuation segment: the job after the
        // lease-setting reaction IS the segment, and NO job queued
        // between the awaited value's settlement and the wrapper's
        // settlement can run with the lease set (phase-E review
        // rejection round 6: the 0.3.0 reaction set the lease inside
        // the job that resolved the wrapper — the job right after the
        // awaited value's settlement — so a sibling \`q.then(...)\`
        // registered AFTER the eval started awaiting \`q\` ran between
        // the lease set and the continuation, consumed the armed
        // signal, and the target's continuation ran later unprotected;
        // the lease is now associated with the actual continuation
        // job, not with whichever job runs next). The wrapper mirrors
        // the value (identity for the resolution value, same rejection
        // value) — the async machinery sees exactly what it would have
        // seen. The mirroring machinery is the CAPTURED pristine
        // Promise surface ('P'/'PResolve'/'pThen' — see the captures at
        // the top of the library): a guest that replaces
        // 'Promise.prototype.then' or overwrites 'Promise.resolve' (or
        // shadows 'Promise' with a top-level lexical) must not change
        // the instrumentation's semantics — the reviewer's repro:
        // replacing 'Promise.prototype.then' made the instrumented
        // 'await 40' return '99' while the native evaluation returned
        // '40' (phase-E review rejection round 7). The wrapper is
        // adopted by the guest's own await machinery through its
        // INTERNAL promise reactions, so the guest-visible prototype
        // cannot intercept the continuation either way; the lease-
        // setting reaction rides the pristine 'then' function value, so
        // a replaced prototype cannot skip it.
        var wrapper = new P(function (resolve, reject) {
          try {
            pThen.call(PResolve(value), resolve, reject);
          } catch (e) {
            reject(e);
          }
        });
        pThen.call(
          wrapper,
          function () {
            try {
              setContinuationLease(token);
            } catch (_e) {}
          },
          function () {
            try {
              setContinuationLease(token);
            } catch (_e) {}
          },
        );
        return wrapper;
      }
      // The 0.2.0 form (no token): record the awaited call id when the
      // awaited value is one of this library's registry promises and
      // otherwise pass the value through untouched.
      if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
        // Identity scan of the registry (see the state note): the
        // awaited value is one of this library's promises iff it is
        // some pending entry's 'promise'. A guest cannot forge an
        // entry (the registry is closure-private), so attribution is
        // precise: only values the LIBRARY minted are logged.
        var found = null;
        registryForEach.call(state.registry, function (entry) {
          if (found === null && entry.promise === value) found = entry.id;
        });
        if (found !== null) state.awaitLog.push(found);
      }
    } catch (_err) {
      // Never throws by contract: a broken value must not take down
      // guest code (the bridge's stance, mirrored here); a wrap
      // failure degrades to the unwrapped value below.
    }
    return value;
  }

  /**
   * The for-await ITERABLE wrap (version 0.3.1): the instrumenter
   * rewrites every top-level \`for await (... of <iterable>)\` iterable
   * into \`this["__replAwaitIterable"](<iterable>, TOKEN)\` — the same
   * continuation-lease discipline as \`__replAwait\`, WITHOUT breaking the
   * iterable protocol (phase-E review rejection round 6: the 0.3.0
   * instrumenter wrapped for-await iterables in \`__replAwait\`, whose
   * promise result made \`for await (const x of [1, 2])\` throw
   * \`TypeError: not a function\` instead of iterating — the eval's
   * continuation is queued by the loop's \`next()\`-result awaits, so the
   * wrap must RIDE those promises, not replace the iterable with one).
   *
   * The returned object is an ASYNC-ITERABLE wrapper over the
   * underlying iterable, resolved exactly like \`for await\` resolves one:
   * \`@@asyncIterator\` first, then \`@@iterator\` (a plain array iterates
   * synchronously; a promise is not iterable and throws the same
   * TypeError the un-instrumented loop throws). Every \`next()\` (and
   * \`return()\`/\`throw()\` — an abrupt completion must never leak the
   * underlying iterator without its cleanup) returns a FRESH promise
   * whose settling reaction — registered BEFORE the for-await machinery
   * registers its own on the same promise (the machinery awaits the
   * \`next()\` result — its registration happens after this function
   * returns) — sets the continuation lease to the eval's token: the job
   * after the lease-setting reaction IS the loop segment's continuation,
   * so the eval-break interrupt can break a runaway for-await loop
   * mid-iteration, exactly like any other awaited segment.
   *
   * ACQUISITION errors PROPAGATE (phase-E review rejection round 7):
   * resolving the underlying iterator — the \`@@asyncIterator\`/
   * \`@@iterator\` property reads (guest accessors can throw) and the
   * method calls — must run exactly ONCE and report exactly what the
   * un-instrumented loop reports. The old implementation caught
   * acquisition failures and returned the UNWRAPPED iterable, so the
   * for-await machinery acquired it a SECOND time: an observable or
   * throwing \`Symbol.asyncIterator\` getter ran twice and could produce
   * a different error (\`boom2\` instead of native \`boom1\`). The wrap
   * also follows GetMethod semantics: a present-but-not-callable
   * \`@@asyncIterator\` is a TypeError, never a silent fallback to
   * \`@@iterator\`.
   *
   * A SYNC iterator's results pass through AsyncFromSyncIterator-
   * CONTINUATION semantics (phase-E review rejection round 7): the raw
   * result's VALUE is awaited and unwrapped, so \`for await (const x of
   * [Promise.resolve(1)])\` yields \`1\`, never the promise object — the
   * old wrapper resolved with the RAW iterator result, and because the
   * wrapper is an ASYNC iterable, the machinery used the value as-is
   * (the promise object leaked through). An ASYNC iterator's results
   * pass through untouched (its \`value\` is used as-is — native async
   * iteration semantics).
   *
   * Never throws AFTER acquisition: a broken iterator's per-step
   * failures (a throwing \`next()\`, a non-object result, a hostile
   * result value) surface as REJECTED result promises — the loop
   * observes the same rejection it would have observed unwrapped. The
   * mirroring machinery is the CAPTURED pristine Promise surface
   * ('P'/'PResolve'/'PReject'/'pThen') like \`__replAwait\` — a guest
   * that replaces 'Promise.prototype.then' or shadows 'Promise' must
   * not change the wrap's semantics.
   */
  function replAwaitIterable(iterable, token) {
    if (typeof token !== 'string' || token.length === 0) return iterable;
    // ACQUISITION (GetIterator/GetMethod semantics): \`@@asyncIterator\`
    // first — present-but-not-callable is a TypeError, never a fallback
    // to \`@@iterator\` — then \`@@iterator\`; both absent is the same
    // TypeError the un-instrumented loop throws. Property reads and
    // method calls can throw (guest accessors); they PROPAGATE — the
    // machinery must observe the exact acquisition error native \`for
    // await\` reports, and the iterable's methods must be touched
    // EXACTLY ONCE (phase-E review rejection round 7: the old catch
    // degraded to the unwrapped iterable, so an observable/throwing
    // \`@@asyncIterator\` getter ran twice and could report a different
    // error than native).
    var asyncIterMethod =
      iterable === null || iterable === undefined ? undefined : iterable[Symbol.asyncIterator];
    var isAsync = typeof asyncIterMethod === 'function';
    var syncIterMethod;
    if (!isAsync) {
      if (asyncIterMethod !== undefined) {
        throw new TypeError('Symbol.asyncIterator is not callable');
      }
      syncIterMethod =
        iterable === null || iterable === undefined ? undefined : iterable[Symbol.iterator];
      if (typeof syncIterMethod !== 'function') {
        throw new TypeError('not async iterable');
      }
    }
    var underlying = isAsync ? asyncIterMethod.call(iterable) : syncIterMethod.call(iterable);
    // One lease-wrapped iterator-result promise: the settle reaction
    // is registered on the FRESH promise before the for-await
    // machinery registers its own (the machinery awaits \`next()\`'s
    // result), so the lease-setting job runs immediately before the
    // loop segment's continuation job — the same ordering discipline
    // as \`__replAwait\` (no job in between can run with the lease
    // set). A synchronous throw from the underlying iterator is
    // converted to a rejected promise — the loop observes the same
    // rejection either way.
    var wrapLease = function () {
      try {
        setContinuationLease(token);
      } catch (_e) {}
    };
    // The result wrapper (phase-E review rejection round 7): for an
    // ASYNC underlying, the result (a promise of the iterator result)
    // is adopted and the result object passes through untouched. For a
    // SYNC underlying, the raw result object goes through the
    // AsyncFromSyncIteratorContinuation transformation: a non-object
    // result is a TypeError, and the result's VALUE is awaited and
    // unwrapped into a fresh \`{ value, done }\` object — native \`for
    // await\` over a sync iterable yields the RESOLVED value, never a
    // promise object. The lease-setting reaction rides the pristine
    // 'then' function value, so a replaced 'Promise.prototype.then'
    // cannot skip it.
    var wrapResult = isAsync
      ? function (result) {
          var p = new P(function (resolve, reject) {
            try {
              pThen.call(PResolve(result), resolve, reject);
            } catch (e) {
              reject(e);
            }
          });
          pThen.call(p, wrapLease, wrapLease);
          return p;
        }
      : function (result) {
          var p = new P(function (resolve, reject) {
            try {
              if (result === null || typeof result !== 'object') {
                throw new TypeError('iterator result is not an object');
              }
              pThen.call(
                PResolve(result.value),
                function (value) {
                  resolve({ value: value, done: result.done });
                },
                reject,
              );
            } catch (e) {
              reject(e);
            }
          });
          pThen.call(p, wrapLease, wrapLease);
          return p;
        };
    var wrapped = {};
    wrapped[Symbol.asyncIterator] = function () {
      return wrapped;
    };
    // Forward with the EXACT argument count the for-await machinery
    // uses: \`next()\` is called with NO arguments (the loop's value
    // travels through the iterator, never into \`next()\`), while
    // \`return()\`/\`throw()\` receive the completion value even when it
    // is undefined — an \`arguments.length\`-sensitive underlying
    // iterator must observe the same calls it would have observed
    // unwrapped.
    var forward = function (method, hasArg, arg) {
      var result;
      try {
        result = hasArg ? method.call(underlying, arg) : method.call(underlying);
      } catch (e) {
        return wrapResult(PReject(e));
      }
      return wrapResult(result);
    };
    wrapped.next = function () {
      return forward(underlying.next, false);
    };
    if (typeof underlying.return === 'function') {
      wrapped.return = function (value) {
        return forward(underlying.return, true, value);
      };
    }
    if (typeof underlying.throw === 'function') {
      wrapped.throw = function (value) {
        return forward(underlying.throw, true, value);
      };
    }
    return wrapped;
  }

  // ────────────────────────────────────────────────────────────────────────
  // The reconciliation surface — the host's post-restore door back into the
  // registry. Keyed by Symbol.for so it stays out of the workspace manifest
  // and out of the DSL vocabulary the orchestrator is conditioned on, while
  // remaining reachable from any host (global symbols survive snapshots and
  // round-trip through every host binding). See the package README's host
  // contract.
  // ────────────────────────────────────────────────────────────────────────

  var surface = {
    /** Guest library version (same value as __REPL_GUEST_VERSION). */
    version: VERSION,
    /** True when this library copy carries the 0.2.0 eval-await tracking
     *  surface ('__replAwait' + 'awaitLog' + the entries' 'promise'
     *  field). The host
     *  gates its top-level-await instrumenter on this: a restored
     *  snapshot carrying the 0.1.0 library is served as-is (the doc's
     *  older-library rule) and simply gets no await attribution — the
     *  eval-break interrupt degrades to the honest refusal. */
    supportsAwaitTracking: true,
    /** True when this library copy carries the 0.3.0 continuation-lease
     *  surface ('__replAwait(value, token)' + the '__replLease'
     *  accessor global): the host's drain loop reads the lease between
     *  jobs and the eval-break interrupt keys to the lease token — the
     *  armed eval's genuine continuation identity. A snapshot carrying
     *  the 0.2.0 library reports false and the host degrades: no
     *  instrumentation (the 0.2.0 log-only targeting is the rejected
     *  settled-call-ids identity), no eval-break targeting — the
     *  interrupt refuses honestly. */
    supportsContinuationLease: true,
    /** True when this library copy carries the 0.3.1 iterable-leash
     *  surface ('__replAwaitIterable' — the for-await iterable wrap
     *  that preserves the iterable protocol while setting the
     *  continuation lease per iteration). The host gates its
     *  instrumenter's for-await sites on this: a snapshot carrying the
     *  0.3.0 library (whose for-await wrap returned a promise and
     *  broke every \`for await\` loop) reports false, its for-await
     *  sites are left unwrapped, and the loops run natively (no
     *  mid-loop eval-break targeting — the honest degradation). */
    supportsIterableLease: true,
    /** The awaits logged since the host last took them, oldest first
     *  (call-id strings only — the library's own registry ids; a
     *  pathologically large log is bounded by one operation's awaits
     *  because the host takes it at every operation boundary). The
     *  returned array is a fresh copy; the log is cleared in the same
     *  call (take semantics — the host is the only consumer). Kept for
     *  older hosts; the 0.3.0 broker's targeting rides the
     *  continuation lease instead. */
    awaitLogTake: function () {
      var out = state.awaitLog;
      state.awaitLog = [];
      return out;
    },
    /**
     * JSON-safe manifest of every pending host call, oldest first:
     * [{ id, kind: "agent" | "checkpoint" | "steer", detail, optionsJson,
     * createdAt, sessionId, modelSpec }]. 'detail' is the verbatim
     * prompt/question/action, 'optionsJson' the verbatim options string
     * (or null), 'sessionId' the id the host addresses the call by (the
     * founding session id for steering calls — a pending steer is fully
     * reconcilable after a restore), 'modelSpec' the agent call's backend
     * routing spec (null otherwise) — enough for the host to re-issue
     * lost work.
     */
    pending: function () {
      var out = [];
      registryForEach.call(state.registry, function (entry) {
        out.push({
          id: entry.id,
          kind: entry.kind,
          detail: entry.detail,
          optionsJson: entry.optionsJson,
          createdAt: entry.createdAt,
          sessionId: entry.sessionId,
          modelSpec: entry.modelSpec,
        });
      });
      return out;
    },
    /**
     * Settle a pending call by id: outcome is "resolve" or "reject", value
     * is the result (or the error / { message, code?, recoverable? }
     * object). Returns true iff a pending entry was settled; false for
     * unknown or already-settled ids (idempotent — safe to call on both
     * the live path and the reconciliation path).
     */
    settle: function (callId, outcome, value) {
      if (outcome !== 'resolve' && outcome !== 'reject') {
        throw new TypeError('settle(callId, outcome, value): outcome must be "resolve" or "reject"');
      }
      return settleCall(callId, outcome, value);
    },
    /** Counters for diagnostics and the workspace manifest. */
    stats: function () {
      return {
        version: VERSION,
        callSeq: state.callSeq,
        logSeq: state.logSeq,
        pendingCalls: registrySize.call(state.registry),
      };
    },
  };
  Object.freeze(surface);

  // ────────────────────────────────────────────────────────────────────────
  // Install the globals
  // ────────────────────────────────────────────────────────────────────────

  function installGlobal(name, value) {
    try {
      Object.defineProperty(g, name, {
        value: value,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    } catch (_err) {
      // The realm predefined the name non-configurably — fall back to
      // assignment so the DSL still works.
      g[name] = value;
    }
  }

  // Freeze every installed function object so its methods and properties
  // cannot be reassigned (agent carries the handle-method factory surface;
  // checkpoint carries 'answer'; the combinators are pure functions).
  Object.freeze(agent);
  Object.freeze(checkpoint);
  Object.freeze(parallel);
  Object.freeze(pipeline);
  Object.freeze(verify);
  Object.freeze(judgePanel);
  Object.freeze(gate);
  Object.freeze(retry);
  Object.freeze(loopUntilDry);
  Object.freeze(replAwait);
  Object.freeze(replAwaitIterable);

  installGlobal('agent', agent);
  installGlobal('checkpoint', checkpoint);
  installGlobal('parallel', parallel);
  installGlobal('pipeline', pipeline);
  installGlobal('verify', verify);
  installGlobal('judgePanel', judgePanel);
  installGlobal('gate', gate);
  installGlobal('retry', retry);
  installGlobal('loopUntilDry', loopUntilDry);
  installGlobal('console', consoleObject);
  // The host's top-level-await instrumenter inserts calls to this global
  // ('await x' → 'await __replAwait(x)'); a bare VM without the library
  // never has the instrumenter applied (the broker gates on
  // 'supportsAwaitTracking').
  installGlobal('__replAwait', replAwait);
  // The for-await iterable wrap (version 0.3.1): the instrumenter
  // inserts calls to this global at every top-level \`for await\`
  // iterable ('for await (const x of y)' → 'for await (const x of
  // __replAwaitIterable(y, TOKEN))'); a bare VM without the library
  // never has the instrumenter applied (the broker gates on
  // 'supportsIterableLease').
  installGlobal('__replAwaitIterable', replAwaitIterable);

  // The continuation lease (version 0.3.0): a WRITABLE accessor whose
  // getter/setter are this closure's own (the host's drain loop reads it
  // between jobs and clears it after a lease-carrying job; the eval-break
  // targeting identity). Non-configurable and non-enumerable: guest code
  // can neither redefine the accessor nor observe it through the
  // manifest's baseline difference (it IS part of the fresh-realm
  // baseline). A guest that WRITES the lease (through the setter) is
  // sabotaging only its own interrupt targeting — the same self-
  // sabotage stance as the rest of the tracking surface.
  Object.defineProperty(g, '__replLease', {
    get: function () { return state.continuationLease; },
    set: function (v) { state.continuationLease = v; },
    enumerable: false,
    configurable: false,
  });

  // Version marker (snapshot versioning: hosts read this — or
  // surface.version — to know which guest library a restored workspace
  // carries; see the README's version-compatibility rules).
  Object.defineProperty(g, VERSION_GLOBAL, {
    value: VERSION,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  Object.defineProperty(g, Symbol.for(SURFACE_KEY), {
    value: surface,
    writable: false,
    enumerable: false,
    configurable: false,
  });
})();
`;
