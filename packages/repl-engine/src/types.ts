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
