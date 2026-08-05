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
 * - `WasmModule` is a structural stand-in for `WebAssembly.Module`.
 *   Every lib that declares `WebAssembly.Module` declares it as an empty
 *   interface, so the two are mutually assignable without ever naming the
 *   global — a real `WebAssembly.Module` (from `WebAssembly.compile` or
 *   `loadShippedWasm`) satisfies `WasmModule`, and `WasmModule` satisfies
 *   quickjs-wasi's `QuickJSOptions.wasm`.
 *
 * The published declaration graph (dist/vm.d.ts, dist/workspace.d.ts)
 * references only these types plus `lib.es5` names, so a consumer with a
 * non-DOM lib and `skipLibCheck: false` type-checks the package cleanly.
 */

/** A compiled WebAssembly module — structural stand-in for `WebAssembly.Module`. */
export interface WasmModule {}

/**
 * What the engine accepts wherever a WebAssembly binary or pre-compiled
 * module is needed: raw bytes (the shipped `quickjs.wasm`), a view over
 * bytes, or a compiled module.
 */
export type WasmInput = ArrayBuffer | ArrayBufferView | WasmModule;
