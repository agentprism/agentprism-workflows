/**
 * Minimal ambient types for the WebAssembly surface this package's type
 * graph touches. The repo's base tsconfig lib is `ES2022 +
 * ESNext.Disposable` (no DOM), so the global `WebAssembly` namespace is
 * not declared. This package typechecks `@automatalabs/repl-engine`'s
 * source (its `types` field points at `src/index.ts`, the repo's
 * workspace convention), whose `loadShippedWasm` calls
 * `WebAssembly.compile`; the engine declares its own ambient
 * (`packages/repl-engine/src/wasm-ambient.d.ts`) for ITS compilation,
 * which is not visible to this package's program — hence this mirror.
 * At runtime the `WebAssembly` global is provided by Node.
 */

type BufferSource = ArrayBufferView | ArrayBuffer;

declare namespace WebAssembly {
  interface Module {}
  function compile(bytes: BufferSource): Promise<Module>;
}
