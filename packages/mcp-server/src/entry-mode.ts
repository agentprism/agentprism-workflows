/**
 * Evaluated before index.ts wherever entry.ts is the module graph's root (static import
 * order). Its one job: tell index.ts that an argv dispatcher owns process startup, so
 * index.ts's own run-if-entry side effect (kept for the documented `node dist/index.js`
 * registration path) must stay dormant. In the esbuild bundle everything shares one
 * import.meta.url, so index.ts cannot tell itself apart from the entry by path alone.
 */
export const ENTRY_DISPATCH_FLAG = "__agentprismEntryDispatch";

(globalThis as Record<string, unknown>)[ENTRY_DISPATCH_FLAG] = true;
