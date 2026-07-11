// Durable (runner-lifetime) provider-routing intents, keyed by pool key — the providers/* sibling
// of the AuthStore lifecycle spine. Agents may keep client-configured provider routing as pure
// in-process state (codex-acp does for its custom gateway), so a bare `providers/set` on a
// dispose-after-use dedicated connection would configure a throwaway process and leave every
// pooled run un-routed — the same failure class as the dispose-after-authenticate bug (§2.5,
// gap 3). The fix is identical in shape: the runner records the intent HERE on a successful
// `providers/set`, every fresh connection replays the recorded intents at the end of its
// `initialize` handshake, and the pool recycles connections whose replayed generation is stale.
//
// SECRETS DISCIPLINE (Principle 9): `ProviderIntent.headers` is credential material (gateway
// Authorization headers). It lives only in this in-memory store and on the wire request; it is
// never logged, journaled, or surfaced through any read API other than `intentsFor` (consumed
// exclusively by the connection replay).
import type { SetProviderRequest } from "@agentclientprotocol/sdk";

/** One recorded `providers/set` — the full replacement configuration for one provider. The
 *  request-scoped `_meta` passthrough is deliberately NOT recorded: it rides the immediate wire
 *  call only, while the intent captures the durable routing config. */
export interface ProviderIntent {
  providerId: SetProviderRequest["providerId"];
  apiType: SetProviderRequest["apiType"];
  baseUrl: SetProviderRequest["baseUrl"];
  /** SECRET gateway headers, replayed verbatim and never surfaced anywhere else. */
  headers?: SetProviderRequest["headers"];
}

interface PoolEntry {
  /** Advances on every record/remove; connections stamp the generation they replayed so the pool
   *  can recycle processes still running under older routing. Starts at 1 (a pool with no entry
   *  reads as generation 0), so pre-provider connections turn stale on the first record. */
  generation: number;
  /** Insertion-ordered latest intent per providerId (providers/set is a full replacement). */
  intents: Map<string, ProviderIntent>;
}

/** The runner's single in-memory provider-intent store. Default-OFF by construction: until the
 *  first successful `setProvider`, no entry exists, `isStale` is always false, and replay is a
 *  no-op — byte-identical to the pre-provider baseline. */
export class ProviderStore {
  private readonly byPool = new Map<string, PoolEntry>();

  /** Record the full replacement configuration for one provider and advance the generation. The
   *  stored copy is store-owned, so a superseded copy's header values are zeroized (§2.14-style
   *  hygiene) before it is replaced. */
  record(poolKey: string, intent: ProviderIntent): void {
    let entry = this.byPool.get(poolKey);
    if (!entry) {
      entry = { generation: 0, intents: new Map() };
      this.byPool.set(poolKey, entry);
    }
    zeroizeHeaders(entry.intents.get(intent.providerId));
    entry.intents.set(intent.providerId, { ...intent, ...(intent.headers ? { headers: { ...intent.headers } } : {}) });
    entry.generation += 1;
  }

  /** Drop the recorded intent for one provider (after a successful `providers/disable`) —
   *  zeroizing its stored header values — and advance the generation so routed processes recycle.
   *  Removing an unrecorded id still advances — disable is idempotent agent-side and an extra
   *  recycle is harmless. */
  remove(poolKey: string, providerId: string): void {
    const entry = this.byPool.get(poolKey);
    if (!entry) return; // nothing recorded => nothing to replay or recycle
    zeroizeHeaders(entry.intents.get(providerId));
    entry.intents.delete(providerId);
    entry.generation += 1;
  }

  /** The recorded intents for one pool key, in insertion order (replay order). */
  intentsFor(poolKey: string): ProviderIntent[] {
    const entry = this.byPool.get(poolKey);
    return entry ? [...entry.intents.values()] : [];
  }

  /** The current generation for one pool key; 0 when nothing was ever recorded. */
  generation(poolKey: string): number {
    return this.byPool.get(poolKey)?.generation ?? 0;
  }

  /** True when a connection stamped at `stamp` no longer reflects the recorded routing. A pool
   *  key with no entry is never stale (the default-OFF baseline). */
  isStale(poolKey: string, stamp: number): boolean {
    const entry = this.byPool.get(poolKey);
    return entry !== undefined && stamp < entry.generation;
  }
}

/** Overwrite a store-owned intent copy's SECRET header values before dropping the reference. */
function zeroizeHeaders(intent: ProviderIntent | undefined): void {
  if (!intent?.headers) return;
  for (const key of Object.keys(intent.headers)) intent.headers[key] = "";
}
