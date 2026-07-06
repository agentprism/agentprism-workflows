/**
 * Run-scoped unhandled-rejection containment (the WE-3 embedding-safety ask).
 *
 * A workflow script can float a promise (an un-awaited `agent()` call, a bare
 * `Promise.reject(...)`, a `.then()` chain nobody awaits). Without containment, that
 * rejection escapes the engine as a process-level `unhandledRejection` and crashes the
 * HOST embedding the SDK — the one failure mode an uncaught script fault must never
 * produce. The tripwire turns it into a failed run instead.
 *
 * Attribution is by REALM IDENTITY: every workflow script executes in its own `node:vm`
 * context, so every promise the script can float carries that realm's `Promise`
 * intrinsic on its prototype chain — script-created promises natively, engine-returned
 * promises because the engine adopts them into the realm at the context boundary (see
 * the `tracked()` wrapper in workflow.ts), and `.then()` derivatives of either because
 * species lookup walks the same realm constructor. `promise instanceof realmPromise`
 * therefore attributes a rejection to exactly one run, with no false positives on the
 * host's own promises.
 *
 * ONE process listener is shared by all active runs (installed on the first register,
 * removed when the last retired entry is released). A rejection that no active realm
 * owns preserves the platform default: if the host installed its own
 * `unhandledRejection` listener it has already observed the event and stays in charge;
 * when this tripwire is the ONLY listener, the reason is rethrown so the process still
 * fails loudly exactly as it would have without the tripwire. Note for hosts WITH a
 * listener: Node invokes every listener, so a contained script float is still visible
 * to the host's listener — the run fails with SCRIPT_ERROR either way.
 */
import { errorMessage, WorkflowError, WorkflowErrorCode } from "./errors.js";

interface TripwireEntry {
  owns(candidate: unknown): boolean;
  trip(reason: unknown): void;
  /** A retired entry swallows its realm's LATE floats instead of failing anything. */
  retired: boolean;
}

/** How long a settled run's realm stays guarded. A tripped script may still be unwinding
 *  (its in-flight agents were abort-cancelled and reject shortly after), and a completed
 *  script may have left a pending float behind; both must not crash the host just because
 *  the run already returned. After the grace window the realm is released (memory). */
const RETIRED_GRACE_MS = 60_000;

const entries = new Set<TripwireEntry>();
let processListener: ((reason: unknown, promise: Promise<unknown>) => void) | undefined;

function onUnhandledRejection(reason: unknown, promise: Promise<unknown>): void {
  for (const entry of entries) {
    if (entry.owns(promise)) {
      if (!entry.retired) entry.trip(reason);
      return;
    }
  }
  // Not provably from any workflow realm — preserve platform semantics (see module doc).
  if (process.listenerCount("unhandledRejection") === 1) throw reason;
}

function addEntry(entry: TripwireEntry): void {
  entries.add(entry);
  if (!processListener) {
    processListener = onUnhandledRejection;
    process.on("unhandledRejection", processListener);
  }
}

function removeEntry(entry: TripwireEntry): void {
  entries.delete(entry);
  if (entries.size === 0 && processListener) {
    process.off("unhandledRejection", processListener);
    processListener = undefined;
  }
}

export interface RunRejectionTripwire {
  /** Rejects with a SCRIPT_ERROR WorkflowError when a script-owned rejection trips the
   *  run. Race the script's completion against this. */
  readonly tripped: Promise<never>;
  /** One macrotask hop AFTER the script settles: Node reports a rejection as unhandled
   *  only at the end of the turn it became unhandled in, so a float created by the
   *  script's final microtasks is only attributable after this hop. Throws the tripped
   *  error if the hop surfaced one. */
  drain(): Promise<void>;
  /** The run settled (either way). Demotes the entry to swallow-mode for the grace
   *  window, then releases it. Idempotent. */
  retire(): void;
}

export function registerRunTripwire(opts: {
  /** The script realm's Promise intrinsic (ownership test — see module doc). */
  realmPromise: PromiseConstructor;
  /** Fired once on trip, BEFORE `tripped` rejects — used to abort the run's in-flight
   *  agents so a zombie script stops spending tokens. */
  onTrip?: (reason: unknown) => void;
}): RunRejectionTripwire {
  let rejectTripped!: (error: WorkflowError) => void;
  let trippedError: WorkflowError | undefined;
  const tripped = new Promise<never>((_, reject) => {
    rejectTripped = reject;
  });
  // The tripwire channel itself must never read as an unhandled rejection (it is only
  // observed while the caller's race is in flight).
  tripped.catch(() => {});

  const entry: TripwireEntry = {
    retired: false,
    owns: (candidate) => candidate instanceof opts.realmPromise,
    trip: (reason) => {
      if (trippedError) return;
      trippedError = new WorkflowError(
        `Unhandled promise rejection in workflow script: ${errorMessage(reason)}`,
        WorkflowErrorCode.SCRIPT_ERROR,
        { recoverable: false },
      );
      opts.onTrip?.(reason);
      rejectTripped(trippedError);
    },
  };
  addEntry(entry);

  return {
    tripped,
    async drain(): Promise<void> {
      await new Promise((resolve) => setImmediate(resolve));
      if (trippedError) throw trippedError;
    },
    retire(): void {
      if (entry.retired) return;
      entry.retired = true;
      const timer = setTimeout(() => removeEntry(entry), RETIRED_GRACE_MS);
      // Never hold the process open just to guard a dead realm.
      timer.unref?.();
    },
  };
}
