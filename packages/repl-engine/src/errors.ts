/**
 * Error reporting for failed evals.
 *
 * Error info is plain data, not an `Error` subclass, because it crosses the
 * MCP tool boundary: the `repl` tool must return eval failures as part of
 * its result payload, never by throwing across the transport.
 */

/**
 * Structured information about a failed eval, safe to ship to an MCP client.
 *
 * `name`/`message`/`stack` are read from the guest error **trap-free**
 * (own-data-property descriptor reads only — guest getters are never
 * invoked while rendering error state; see the roadmap doc's transfer
 * lesson R69). When the guest threw a primitive, `name` is `"Error"` and
 * `message` is the native string conversion.
 */
export interface EvalErrorInfo {
  /** Error constructor name as seen in the guest (e.g. `SyntaxError`, `TypeError`, `InternalError`). */
  name: string;
  /** Human-readable message. */
  message: string;
  /** Guest stack trace when it is available as an own data property. */
  stack?: string;
  /**
   * True when the per-eval `interruptHandler` fired, aborting execution
   * with quickjs's `InternalError: interrupted` (or the drain threw the
   * same as a job error). This is how `interrupt` breaks runaway evals.
   */
  interrupted: boolean;
  /**
   * True when the per-VM `memoryLimit` was exceeded (quickjs's
   * `InternalError: out of memory`). The limit is a malloc cap on live
   * allocations; after the failed eval the VM stays usable.
   */
  outOfMemory: boolean;
}

/**
 * Classify a (name, message) pair captured from the guest into the
 * engine-level flags the tool layer needs. The quickjs interrupt and
 * malloc-limit failures are the only engine-injected errors; everything
 * else is guest-authored, so classification matches the exact built-in
 * message strings and nothing fuzzier.
 */
export function classifyError(name: string, message: string, stack?: string): EvalErrorInfo {
  return {
    name,
    message,
    stack,
    interrupted: name === 'InternalError' && message === 'interrupted',
    outOfMemory: name === 'InternalError' && message === 'out of memory',
  };
}
