/**
 * Self-contained public types for the engine's WebAssembly surface.
 *
 * The repo's tsconfig has no DOM lib (`lib: ["ES2022", "ESNext.Disposable"]`),
 * and a consumer may have the same. In that configuration neither the
 * `BufferSource` type nor the `WebAssembly` namespace is declared, and the
 * ambient declarations this package compiles against
 * (`wasm-ambient.d.ts`) are source-only — TypeScript does not emit input
 * `.d.ts` files, so they are absent from the published package (which
 * ships `dist` only). The public options therefore use the types below,
 * which are fully self-contained:
 *
 * - `ArrayBuffer` / `ArrayBufferView` come from `lib.es5` — always
 *   present.
 * - `WasmModule` is an **opaque** stand-in for `WebAssembly.Module`
 *   (see below).
 *
 * The published declaration graph (dist/vm.d.ts, dist/workspace.d.ts)
 * references only these types plus `lib.es5` names, so a consumer with a
 * non-DOM lib and `skipLibCheck: false` type-checks the package cleanly.
 */

/**
 * Opaque brand carried by `WasmModule`. Declared as a private unique
 * symbol, never exported and never assigned at runtime: it exists purely
 * so that no accidental value satisfies the type. A reviewer's negative
 * probe proved the necessity: with `WasmModule` as an empty interface,
 * `{ wasm: 42 }` type-checked (every non-null value satisfies an empty
 * interface) and failed only at runtime.
 */
declare const wasmModuleBrand: unique symbol;

/**
 * A compiled WebAssembly module — the engine's opaque stand-in for
 * `WebAssembly.Module`, declared locally so the published type graph does
 * not depend on the consumer's lib.
 *
 * The type is branded, so the only way to obtain a `WasmModule` value is
 * `loadShippedWasm()` (the engine compiles the shipped `quickjs.wasm`
 * binary and brands the real `WebAssembly.Module` at that single
 * boundary). Custom WASM is accepted as raw bytes instead:
 * `ArrayBuffer | ArrayBufferView` satisfies `WasmInput` directly.
 */
export interface WasmModule {
  /** @internal Opaque brand — never construct `WasmModule` values yourself. */
  readonly [wasmModuleBrand]: void;
}

/**
 * What the engine accepts wherever a WebAssembly binary or pre-compiled
 * module is needed: raw bytes (the shipped `quickjs.wasm`), a view over
 * bytes, or a compiled module (from `loadShippedWasm`).
 */
export type WasmInput = ArrayBuffer | ArrayBufferView | WasmModule;

/**
 * An extension record in a snapshot's metadata (name, memory/table base,
 * init function) — the engine's self-contained stand-in for the shim's
 * `SnapshotExtension`, kept in lockstep with quickjs-wasi's shape so a
 * snapshot taken through the shim round-trips without conversion.
 */
export interface ReplSnapshotExtension {
  /** Extension name as passed at create/restore time (e.g. `structured-clone`). */
  name: string;
  /** Allocated base offset in linear memory for this extension's static data. */
  memoryBase: number;
  /** Allocated base offset in the indirect function table. */
  tableBase: number;
  /** Name of the init function exported by the extension. */
  initFn: string;
}

/**
 * A snapshot of a VM's full state (raw WASM linear memory plus runtime
 * pointers) — the engine's self-contained stand-in for the shim's
 * `Snapshot` type, so `ReplVm.restore` can be declared without naming
 * quickjs-wasi types (a consumer with a non-DOM lib and `skipLibCheck:
 * false` must type-check the published declarations cleanly).
 *
 * Structurally identical to the shim's `Snapshot`, so a snapshot produced
 * through the shim (`vm.snapshot()`) satisfies it directly.
 */
export interface ReplSnapshot {
  /** The raw WASM linear memory contents. */
  memory: Uint8Array;
  /** The stack pointer value at snapshot time. */
  stackPointer: number;
  /** Pointer to the JSRuntime in WASM memory. */
  runtimePtr: number;
  /** Pointer to the JSContext in WASM memory. */
  contextPtr: number;
  /** Metadata about loaded extensions (empty if none). */
  extensions: ReplSnapshotExtension[];
}
